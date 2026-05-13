import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Sidebar } from './components/Sidebar'
import { TabStrip } from './components/TabStrip'
import { TerminalArea } from './components/TerminalArea'
import { StatusBar } from './components/StatusBar'
import { AddProjectDialog } from './components/AddProjectDialog'
import { MapMode } from './components/MapMode'
import { QuickSwitcher } from './components/QuickSwitcher'
import { HelpOverlay } from './components/HelpOverlay'
import { Toast, type ToastKind } from './components/Toast'
import { MasterPane } from './components/MasterPane'
import { WebPreview } from './components/WebPreview'
import { Icon } from './components/Icon'
import { Sigil } from './components/Sigil'
import { MasterThinkOrb } from './components/MasterThinkOrb'
import { useProjects } from './hooks/useProjects'
import type { Project } from './data/mockProjects'
import type { Tab } from './types'
import type { TabViewMode } from './components/TerminalTab'

interface TabState {
  lastDataAt: number
  unread: boolean
  bell: boolean
}

export interface TabActivity {
  isRunning: boolean
  hasUnread: boolean
  hasBell: boolean
}

export interface ProjectStatus {
  hasOpenTab: boolean
  hasRunning: boolean
  hasUnread: boolean
  hasBell: boolean
}

interface ToastState {
  id: number
  message: string
  kind: ToastKind
}

const RUNNING_WINDOW_MS = 2000
const STATE_SAVE_DEBOUNCE_MS = 500
const MASTER_DEFAULT_HEIGHT = 280

export default function App() {
  const { projects, loaded: projectsLoaded, addProject, removeProject, updateProject } = useProjects()
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [adding, setAdding] = useState<{ name: string; path: string } | null>(null)
  const [tabStates, setTabStates] = useState<Map<string, TabState>>(new Map())
  const [tick, setTick] = useState(0)
  const [mapOpen, setMapOpen] = useState(false)
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [masterCollapsed, setMasterCollapsed] = useState(false)
  const [miniMode, setMiniMode] = useState(false)

  const toggleMiniMode = useCallback(() => {
    setMiniMode((prev) => {
      const next = !prev
      void window.api.window.setMiniMode(next)
      if (next) setMasterCollapsed(false)
      return next
    })
  }, [])
  const [masterHeight, setMasterHeight] = useState(MASTER_DEFAULT_HEIGHT)
  const [ultimateModeProjectId, setUltimateModeProjectId] = useState<string | null>(null)
  const [tabViewModes, setTabViewModes] = useState<Map<string, TabViewMode>>(new Map())
  const [projectPreviews, setProjectPreviews] = useState<Map<string, string>>(new Map())
  const [theme, setTheme] = useState<'dark' | 'cream'>('dark')
  // ULM swarm-dispatch indicator: when Master fires a prompt at a worker tab,
  // we flash that tab's wrapper with a short glow (see TerminalTab CSS). The
  // tabId is held briefly so the CSS animation can trigger; auto-clears so a
  // future dispatch to the same tab re-arms the effect.
  const [swarmTargetTabId, setSwarmTargetTabId] = useState<string | null>(null)
  const swarmClearTimer = useRef<number | null>(null)

  const restoredRef = useRef(false)
  const prevTransitionRef = useRef<Map<string, { running: boolean; bell: boolean }>>(new Map())
  const prevTabIdsRef = useRef<Set<string>>(new Set())

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  const activeProjectId = activeTab?.project.id ?? null

  const showToast = useCallback((message: string, kind: ToastKind = 'info') => {
    setToast({ id: Date.now(), message, kind })
  }, [])

  const handleResizeImage = useCallback(async () => {
    try {
      const result = await window.api.clipboard.resizeImage()
      if (!result.hadImage) {
        showToast('No image in clipboard', 'info')
        return
      }
      if (!result.resized) {
        const o = result.original ?? { width: 0, height: 0 }
        showToast(`Already small: ${o.width}×${o.height}`, 'info')
        return
      }
      const o = result.original ?? { width: 0, height: 0 }
      const f = result.final ?? { width: 0, height: 0 }
      showToast(`Resized: ${o.width}×${o.height} → ${f.width}×${f.height}`, 'success')
    } catch (e) {
      console.error('Resize image failed:', e)
      showToast('Resize failed', 'error')
    }
  }, [showToast])

  // Listen for menu-driven actions
  useEffect(() => {
    return window.api.window.onAction((action) => {
      if (action === 'open-map') {
        setMapOpen((prev) => {
          if (prev) return false
          setQuickSwitcherOpen(false)
          setHelpOpen(false)
          return true
        })
      } else if (action === 'quick-switcher') {
        setQuickSwitcherOpen((prev) => {
          if (prev) return false
          setMapOpen(false)
          setHelpOpen(false)
          return true
        })
      } else if (action === 'help') {
        setHelpOpen((prev) => {
          if (prev) return false
          setMapOpen(false)
          setQuickSwitcherOpen(false)
          return true
        })
      } else if (action === 'resize-image') {
        handleResizeImage()
      } else if (action === 'toggle-master') {
        setMasterCollapsed((prev) => !prev)
      }
    })
  }, [handleResizeImage])

  // Sync tab registry to main process
  useEffect(() => {
    tabs.forEach((t) => {
      window.api.tabRegistry.set({
        tabId: t.id,
        ptyId: t.ptyId,
        projectId: t.project.id,
        projectName: t.project.name,
        projectPath: t.project.path,
        projectColor: t.project.color,
        sessionId: t.sessionId
      })
    })
    const currentIds = new Set(tabs.map((t) => t.id))
    for (const prevId of prevTabIdsRef.current) {
      if (!currentIds.has(prevId)) {
        window.api.tabRegistry.remove(prevId)
      }
    }
    prevTabIdsRef.current = currentIds
  }, [tabs])

  useEffect(() => {
    window.api.tabRegistry.setActive(activeTabId)
  }, [activeTabId])

  // Subscribe to Master worker-dispatch events so the renderer can paint a
  // momentary "swarm" glow on the worker tab Master just sent a prompt to.
  // We only honour `status === 'start'` — that's the actual hand-off moment;
  // `tick`/`done` are progress updates that don't need their own pulse.
  useEffect(() => {
    return window.api.master.onWorkerActivity((evt) => {
      const e = evt as { tabId?: string; status?: string } | null
      if (!e || !e.tabId || e.status !== 'start') return
      if (swarmClearTimer.current !== null) window.clearTimeout(swarmClearTimer.current)
      setSwarmTargetTabId(e.tabId)
      swarmClearTimer.current = window.setTimeout(() => {
        setSwarmTargetTabId(null)
        swarmClearTimer.current = null
      }, 1500)
    })
  }, [])

  useEffect(() => {
    return () => {
      if (swarmClearTimer.current !== null) window.clearTimeout(swarmClearTimer.current)
    }
  }, [])

  // Restore tabs from disk on first load (after projects are available)
  useEffect(() => {
    if (restoredRef.current || !projectsLoaded) return
    restoredRef.current = true

    let cancelled = false
    ;(async () => {
      const state = await window.api.state.load()
      if (cancelled || !state || !state.tabs?.length) return

      const ulmId = state.ultimateModeProjectId ?? null
      if (ulmId) setUltimateModeProjectId(ulmId)

      if (state.projectPreviews && typeof state.projectPreviews === 'object') {
        const m = new Map<string, string>()
        for (const [pid, url] of Object.entries(state.projectPreviews)) {
          if (typeof url === 'string' && url) m.set(pid, url)
        }
        if (m.size > 0) setProjectPreviews(m)
      }

      if (state.theme === 'cream' || state.theme === 'dark') {
        setTheme(state.theme)
      }

      // Dedupe by project EXCEPT in Ultimate Mode where multi-tab on the ULM
      // project is allowed (workers parallelize).
      const seenProjectIds = new Set<string>()
      const dedupedStored = state.tabs.filter((s) => {
        if (ulmId && s.projectId === ulmId) return true
        if (seenProjectIds.has(s.projectId)) return false
        seenProjectIds.add(s.projectId)
        return true
      })

      const newTabs: Tab[] = []
      for (const stored of dedupedStored) {
        const project = projects.find((p) => p.id === stored.projectId)
        if (!project) continue
        try {
          const ptyId = await window.api.pty.spawn(project.path, {
            autoRun: stored.sessionId
              ? `claude --resume ${stored.sessionId}`
              : 'claude'
          })
          newTabs.push({
            id: crypto.randomUUID(),
            ptyId,
            project,
            sessionId: stored.sessionId
          })
        } catch (e) {
          console.error('Failed to restore tab:', e)
        }
      }

      if (cancelled) return
      setTabs(newTabs)
      if (
        typeof state.activeIndex === 'number' &&
        state.activeIndex >= 0 &&
        state.activeIndex < newTabs.length
      ) {
        setActiveTabId(newTabs[state.activeIndex]!.id)
      } else if (newTabs.length > 0) {
        setActiveTabId(newTabs[0]!.id)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [projectsLoaded, projects])

  // Save state to disk on tab/active changes (debounced)
  useEffect(() => {
    if (!restoredRef.current) return
    const t = setTimeout(() => {
      const previewsObj: Record<string, string> = {}
      projectPreviews.forEach((url, pid) => {
        previewsObj[pid] = url
      })
      const state = {
        tabs: tabs.map((t) => ({ projectId: t.project.id, sessionId: t.sessionId })),
        activeIndex: activeTabId ? tabs.findIndex((t) => t.id === activeTabId) : -1,
        ultimateModeProjectId,
        projectPreviews: previewsObj,
        theme
      }
      window.api.state.save(state).catch((e) => console.error('Save state failed:', e))
    }, STATE_SAVE_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [tabs, activeTabId, ultimateModeProjectId, projectPreviews, theme])

  useEffect(() => {
    const unsub = window.api.pty.onData((ptyId, data) => {
      const tab = tabs.find((t) => t.ptyId === ptyId)
      if (!tab) return
      const isBell = data.includes('\x07')
      const isActive = tab.id === activeTabId
      setTabStates((prev) => {
        const next = new Map(prev)
        const cur = next.get(tab.id) ?? { lastDataAt: 0, unread: false, bell: false }
        next.set(tab.id, {
          lastDataAt: Date.now(),
          unread: cur.unread || !isActive,
          bell: cur.bell || (isBell && !isActive)
        })
        return next
      })
    })
    return unsub
  }, [tabs, activeTabId])

  useEffect(() => {
    const i = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(i)
  }, [])

  useEffect(() => {
    if (!activeTabId) return
    setTabStates((prev) => {
      const cur = prev.get(activeTabId)
      if (!cur || (!cur.unread && !cur.bell)) return prev
      const next = new Map(prev)
      next.set(activeTabId, { ...cur, unread: false, bell: false })
      return next
    })
  }, [activeTabId])

  const tabActivityStates = useMemo(() => {
    const map = new Map<string, TabActivity>()
    const now = Date.now()
    tabs.forEach((t) => {
      const state = tabStates.get(t.id)
      map.set(t.id, {
        isRunning: state ? now - state.lastDataAt < RUNNING_WINDOW_MS : false,
        hasUnread: state?.unread ?? false,
        hasBell: state?.bell ?? false
      })
    })
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, tabStates, tick])

  // OS notifications fully disabled. Even silent + cooldowned + bell-only,
  // the cumulative pattern (notification creation, dock interaction, web
  // permission prompt on first launch) was being perceived as the app
  // pulling itself forward. In-app status (titlebar pulse, sidebar dots,
  // tab activity glow, master pane stream) is enough — none of it touches
  // the OS window stack.
  useEffect(() => {
    const prev = prevTransitionRef.current
    tabs.forEach((tab) => {
      const activity = tabActivityStates.get(tab.id)
      prev.set(tab.id, {
        running: activity?.isRunning ?? false,
        bell: activity?.hasBell ?? false
      })
    })
    for (const [id] of prev) {
      if (!tabs.find((t) => t.id === id)) prev.delete(id)
    }
  }, [tabActivityStates, tabs])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  const projectStatus = useMemo(() => {
    const map = new Map<string, ProjectStatus>()
    tabs.forEach((t) => {
      const activity = tabActivityStates.get(t.id)
      const cur = map.get(t.project.id) ?? {
        hasOpenTab: false,
        hasRunning: false,
        hasUnread: false,
        hasBell: false
      }
      cur.hasOpenTab = true
      if (activity) {
        if (activity.isRunning) cur.hasRunning = true
        if (activity.hasUnread) cur.hasUnread = true
        if (activity.hasBell) cur.hasBell = true
      }
      map.set(t.project.id, cur)
    })
    return map
  }, [tabs, tabActivityStates])

  const openProject = useCallback(
    async (project: Project, opts: { newTab?: boolean } = {}) => {
      // ULM project: multi-tab allowed (workers parallelize). Use newTab flag.
      // Other projects: strict single-tab; always reuse.
      const isUlmProject = ultimateModeProjectId === project.id
      if (!(isUlmProject && opts.newTab)) {
        const existing = tabs.find((t) => t.project.id === project.id)
        if (existing) {
          setActiveTabId(existing.id)
          return
        }
      }
      const ptyId = await window.api.pty.spawn(project.path, { autoRun: 'claude' })
      const tab: Tab = {
        id: crypto.randomUUID(),
        ptyId,
        project
      }
      setTabs((prev) => [...prev, tab])
      setActiveTabId(tab.id)
    },
    [tabs, ultimateModeProjectId]
  )

  const toggleUltimateMode = useCallback(
    (projectId: string | null) => {
      setUltimateModeProjectId((curr) => {
        // If toggling off the same project (or off entirely)
        if (projectId === null || projectId === curr) return null
        // Switching to a new project: clear other-project tabs from view focus
        // (they stay alive, just hidden by the filter)
        return projectId
      })
    },
    []
  )

  const resumeSession = useCallback(
    async (project: Project, sessionId: string) => {
      const existing = tabs.find((t) => t.sessionId === sessionId)
      if (existing) {
        setActiveTabId(existing.id)
        return
      }
      // Strict no-duplicate rule: kill any existing project tab before resuming a session
      const projectTab = tabs.find((t) => t.project.id === project.id)
      if (projectTab) {
        window.api.pty.kill(projectTab.ptyId)
      }
      const ptyId = await window.api.pty.spawn(project.path, {
        autoRun: `claude --resume ${sessionId}`
      })
      const tab: Tab = {
        id: crypto.randomUUID(),
        ptyId,
        project,
        sessionId
      }
      setTabs((prev) => {
        const filtered = projectTab ? prev.filter((t) => t.id !== projectTab.id) : prev
        return [...filtered, tab]
      })
      setActiveTabId(tab.id)
    },
    [tabs]
  )

  const setTabViewMode = useCallback((tabId: string, mode: TabViewMode) => {
    setTabViewModes((prev) => {
      const next = new Map(prev)
      next.set(tabId, mode)
      return next
    })
  }, [])

  const closeTab = useCallback((tabId: string) => {
    setTabs((prev) => {
      const tab = prev.find((t) => t.id === tabId)
      if (tab) window.api.pty.kill(tab.ptyId)
      const next = prev.filter((t) => t.id !== tabId)
      setActiveTabId((curr) => {
        if (curr !== tabId) return curr
        return next.length > 0 ? next[next.length - 1]!.id : null
      })
      return next
    })
    setTabStates((prev) => {
      if (!prev.has(tabId)) return prev
      const next = new Map(prev)
      next.delete(tabId)
      return next
    })
    setTabViewModes((prev) => {
      if (!prev.has(tabId)) return prev
      const next = new Map(prev)
      next.delete(tabId)
      return next
    })
  }, [])

  const repathTab = useCallback(
    async (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId)
      if (!tab) return
      const newPath = await window.api.dialog.pickFolder()
      if (!newPath) return
      await updateProject(tab.project.id, { path: newPath })
      // Kill old PTY (which was failing) and spawn fresh at new path
      try {
        window.api.pty.kill(tab.ptyId)
      } catch {
        /* noop */
      }
      try {
        const newPtyId = await window.api.pty.spawn(newPath, { autoRun: 'claude' })
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId
              ? { ...t, ptyId: newPtyId, sessionId: undefined, project: { ...t.project, path: newPath } }
              : t
          )
        )
      } catch (e) {
        console.error('Repath spawn failed:', e)
      }
    },
    [tabs, updateProject]
  )

  const restartTab = useCallback(
    async (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId)
      if (!tab) return
      try {
        // Resume the most recent session for this project so context is preserved
        let sessionId: string | undefined = tab.sessionId
        if (!sessionId) {
          try {
            const sessions = await window.api.sessions.list(tab.project.path)
            if (sessions && sessions.length > 0) {
              const latest = [...sessions].sort(
                (a, b) => b.lastTimestamp - a.lastTimestamp
              )[0]
              sessionId = latest?.id
            }
          } catch {
            /* fallback to fresh claude */
          }
        }
        const autoRun = sessionId ? `claude --resume ${sessionId}` : 'claude'
        const newPtyId = await window.api.pty.spawn(tab.project.path, { autoRun })
        setTabs((prev) =>
          prev.map((t) => (t.id === tabId ? { ...t, ptyId: newPtyId, sessionId } : t))
        )
      } catch (e) {
        console.error('Restart failed:', e)
      }
    },
    [tabs]
  )

  const handleAdd = useCallback(async () => {
    const path = await window.api.dialog.pickFolder()
    if (!path) return
    const name = path.split('/').pop() || path
    setAdding({ name, path })
  }, [])

  const handleAddSubmit = useCallback(
    async (name: string, color: string) => {
      if (!adding) return
      const project: Project = {
        id: crypto.randomUUID(),
        name,
        color,
        path: adding.path
      }
      await addProject(project)
      setAdding(null)
    },
    [adding, addProject]
  )

  const handleRemoveProject = useCallback(
    async (id: string) => {
      const projectTabs = tabs.filter((t) => t.project.id === id)
      projectTabs.forEach((t) => window.api.pty.kill(t.ptyId))
      setTabs((prev) => prev.filter((t) => t.project.id !== id))
      if (activeTabId && projectTabs.some((t) => t.id === activeTabId)) {
        const remaining = tabs.filter((t) => t.project.id !== id)
        setActiveTabId(remaining.length > 0 ? remaining[remaining.length - 1]!.id : null)
      }
      await removeProject(id)
    },
    [tabs, activeTabId, removeProject]
  )

  const projectsRef = useRef(projects)
  const tabsRef = useRef(tabs)
  const ulmIdRef = useRef(ultimateModeProjectId)
  useEffect(() => {
    projectsRef.current = projects
  }, [projects])
  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])
  useEffect(() => {
    ulmIdRef.current = ultimateModeProjectId
  }, [ultimateModeProjectId])

  useEffect(() => {
    return window.api.master.onControlRequest(async (req) => {
      const respond = (
        result: { ok: true; data?: unknown } | { ok: false; error: string }
      ): void => {
        window.api.master.respondControl(req.requestId, result)
      }
      try {
        if (req.action === 'create-project') {
          const p = req.payload as { path: string; name?: string; color?: string }
          if (!p.path) return respond({ ok: false, error: 'path required' })
          if (projectsRef.current.find((x) => x.path === p.path)) {
            return respond({ ok: false, error: 'project with this path exists' })
          }
          const palette = ['#34d399', '#60a5fa', '#f59e0b', '#a78bfa', '#f87171', '#22d3ee']
          const project: Project = {
            id: crypto.randomUUID(),
            name: p.name || p.path.split('/').filter(Boolean).pop() || p.path,
            color: p.color || palette[Math.floor(Math.random() * palette.length)]!,
            path: p.path
          }
          await addProject(project)
          return respond({
            ok: true,
            data: { id: project.id, name: project.name, path: project.path, color: project.color }
          })
        }
        if (req.action === 'open-tab') {
          const p = req.payload as { projectId: string }
          const project = projectsRef.current.find((x) => x.id === p.projectId)
          if (!project) return respond({ ok: false, error: 'project not found' })
          // Reuse existing live tab for this project to avoid duplicates
          const existing = tabsRef.current.find((t) => t.project.id === project.id)
          if (existing) {
            setActiveTabId(existing.id)
            return respond({
              ok: true,
              data: {
                tabId: existing.id,
                ptyId: existing.ptyId,
                projectId: project.id,
                projectName: project.name,
                projectPath: project.path,
                reused: true
              }
            })
          }
          const ptyId = await window.api.pty.spawn(project.path, { autoRun: 'claude' })
          const tab: Tab = { id: crypto.randomUUID(), ptyId, project }
          setTabs((prev) => [...prev, tab])
          setActiveTabId(tab.id)
          return respond({
            ok: true,
            data: {
              tabId: tab.id,
              ptyId: tab.ptyId,
              projectId: project.id,
              projectName: project.name,
              projectPath: project.path,
              reused: false
            }
          })
        }
        if (req.action === 'close-tab') {
          const p = req.payload as { tabId: string }
          const tab = tabsRef.current.find((t) => t.id === p.tabId)
          if (!tab) return respond({ ok: false, error: 'tab not found' })
          window.api.pty.kill(tab.ptyId)
          setTabs((prev) => prev.filter((t) => t.id !== p.tabId))
          setActiveTabId((curr) => {
            if (curr !== p.tabId) return curr
            const rest = tabsRef.current.filter((t) => t.id !== p.tabId)
            return rest.length > 0 ? rest[rest.length - 1]!.id : null
          })
          return respond({ ok: true })
        }
        if (req.action === 'switch-tab') {
          const p = req.payload as { tabId: string }
          if (!tabsRef.current.find((t) => t.id === p.tabId)) {
            return respond({ ok: false, error: 'tab not found' })
          }
          setActiveTabId(p.tabId)
          return respond({ ok: true })
        }
        if (req.action === 'get-workspace-state') {
          const ulmId = ulmIdRef.current
          const ulmProject = ulmId
            ? projectsRef.current.find((p) => p.id === ulmId)
            : null
          const ulmTabs = ulmId
            ? tabsRef.current.filter((t) => t.project.id === ulmId)
            : []
          return respond({
            ok: true,
            data: {
              ultimateMode: ulmProject
                ? {
                    projectId: ulmProject.id,
                    projectName: ulmProject.name,
                    projectPath: ulmProject.path,
                    activeWorkerTabIds: ulmTabs.map((t) => t.id),
                    workerCount: ulmTabs.length
                  }
                : null,
              totalTabs: tabsRef.current.length,
              totalProjects: projectsRef.current.length
            }
          })
        }
        if (req.action === 'set-project-preview') {
          const p = req.payload as { projectId: string; url: string }
          if (!p.projectId || !p.url) return respond({ ok: false, error: 'projectId and url required' })
          setProjectPreviews((prev) => {
            const next = new Map(prev)
            next.set(p.projectId, p.url)
            return next
          })
          return respond({ ok: true })
        }
        if (req.action === 'set-ultimate-mode') {
          const p = req.payload as { projectId: string | null }
          if (p.projectId !== null) {
            const project = projectsRef.current.find((x) => x.id === p.projectId)
            if (!project) return respond({ ok: false, error: 'project not found' })
          }
          setUltimateModeProjectId(p.projectId)
          return respond({
            ok: true,
            data: {
              ultimateModeProjectId: p.projectId,
              status: p.projectId ? 'activated' : 'deactivated'
            }
          })
        }
        if (req.action === 'spawn-parallel-worker') {
          const p = req.payload as { projectId: string }
          const project = projectsRef.current.find((x) => x.id === p.projectId)
          if (!project) return respond({ ok: false, error: 'project not found' })
          const ulmId = ulmIdRef.current
          // Outside ULM: enforce single-tab; reuse if exists
          if (ulmId !== p.projectId) {
            const existing = tabsRef.current.find((t) => t.project.id === p.projectId)
            if (existing) {
              setActiveTabId(existing.id)
              return respond({
                ok: true,
                data: { tabId: existing.id, ptyId: existing.ptyId, reused: true, ulm: false }
              })
            }
          }
          // Spawn fresh worker (multiple allowed in ULM)
          const ptyId = await window.api.pty.spawn(project.path, { autoRun: 'claude' })
          const tab: Tab = { id: crypto.randomUUID(), ptyId, project }
          setTabs((prev) => [...prev, tab])
          setActiveTabId(tab.id)
          return respond({
            ok: true,
            data: {
              tabId: tab.id,
              ptyId: tab.ptyId,
              projectId: project.id,
              projectName: project.name,
              ulm: ulmId === p.projectId,
              reused: false
            }
          })
        }
        respond({ ok: false, error: `unknown action ${req.action}` })
      } catch (e) {
        respond({ ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    })
  }, [addProject])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return

      if (e.key === 'w' && !e.shiftKey && activeTabId) {
        e.preventDefault()
        closeTab(activeTabId)
        return
      }

      if (e.key === 't' && !e.shiftKey && activeTab) {
        e.preventDefault()
        openProject(activeTab.project, { newTab: true })
        return
      }

      if (e.key === 'j' && !e.shiftKey) {
        e.preventDefault()
        setMasterCollapsed((prev) => !prev)
        return
      }

      if (e.shiftKey && (e.key === ']' || e.key === '[')) {
        e.preventDefault()
        if (tabs.length === 0) return
        const idx = tabs.findIndex((t) => t.id === activeTabId)
        const baseIdx = idx === -1 ? 0 : idx
        const nextIdx =
          e.key === ']'
            ? (baseIdx + 1) % tabs.length
            : (baseIdx - 1 + tabs.length) % tabs.length
        setActiveTabId(tabs[nextIdx]!.id)
        return
      }

      if (!e.shiftKey && e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key, 10) - 1
        if (idx < projects.length) {
          e.preventDefault()
          const p = projects[idx]
          if (p) openProject(p)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeTabId, activeTab, tabs, projects, openProject, closeTab])

  const ulmProject = ultimateModeProjectId
    ? projects.find((p) => p.id === ultimateModeProjectId) ?? null
    : null

  return (
    <div
      className={`app${ulmProject ? ' app-ulm-active' : ''}${miniMode ? ' app-mini' : ''}`}
    >
      <header className="titlebar">
        {!miniMode && <div className="titlebar-traffic-spacer" />}
        <div className="titlebar-content">
          <span className="titlebar-mark">
            <Icon name="alphacod" size={16} strokeWidth={1.4} />
          </span>
          <span>{miniMode ? 'MINI' : 'ALPHACOD'}</span>
          {ulmProject && !miniMode && (
            <span
              className="titlebar-ulm-badge"
              style={{ '--accent': ulmProject.color } as CSSProperties}
              title={`Ultimate Developer Mode active on ${ulmProject.name}`}
            >
              <MasterThinkOrb size={8} accent={ulmProject.color} thinking />
              ULM · {ulmProject.name}
            </span>
          )}
        </div>
        <button
          type="button"
          className="titlebar-mini-toggle"
          onClick={toggleMiniMode}
          title={miniMode ? 'Exit Mini Mode' : 'Mini Mode (floating chat)'}
        >
          {miniMode ? '⤢' : '⤡'}
        </button>
        {!miniMode && <div className="titlebar-traffic-spacer" />}
      </header>
      {miniMode ? (
        <div className="body mini-body">
          <nav className="mini-rail" aria-label="Open tabs">
            {tabs.length === 0 && (
              <div className="mini-rail-empty" title="No open tabs">·</div>
            )}
            {tabs.map((tab) => {
              const activity = tabActivityStates.get(tab.id)
              const isActive = tab.id === activeTabId
              const hasBell = activity?.hasBell ?? false
              const isRunning = activity?.isRunning ?? false
              const hasUnread = activity?.hasUnread ?? false
              return (
                <button
                  key={tab.id}
                  type="button"
                  className={`mini-rail-tab${isActive ? ' active' : ''}${
                    hasBell ? ' bell' : ''
                  }${isRunning ? ' running' : ''}${hasUnread ? ' unread' : ''}`}
                  style={{ '--accent': tab.project.color } as CSSProperties}
                  onClick={() => setActiveTabId(tab.id)}
                  title={`${tab.project.name}${hasBell ? ' — vajab vastust' : isRunning ? ' — jookseb' : hasUnread ? ' — uus väljund' : ''}`}
                >
                  <span className="mini-rail-icon">
                    <Sigil name={tab.project.name} color={tab.project.color} size={26} />
                  </span>
                  <span className="mini-rail-label">{tab.project.name}</span>
                  {hasBell && <span className="mini-rail-bell" />}
                  {!hasBell && isRunning && <span className="mini-rail-pulse" />}
                  {!hasBell && !isRunning && hasUnread && (
                    <span className="mini-rail-unread" />
                  )}
                </button>
              )
            })}
          </nav>
          <div className="mini-main">
            <MasterPane
              collapsed={false}
              onToggleCollapse={toggleMiniMode}
              height={9999}
              onResize={() => {}}
            />
          </div>
        </div>
      ) : (
      <div className="body">
        <Sidebar
          projects={
            ultimateModeProjectId
              ? projects.filter((p) => p.id === ultimateModeProjectId)
              : projects
          }
          allProjectCount={projects.length}
          activeProjectId={activeProjectId}
          projectStatus={projectStatus}
          ultimateModeProjectId={ultimateModeProjectId}
          onSelect={(id, opts) => {
            const p = projects.find((p) => p.id === id)
            if (p) openProject(p, opts)
          }}
          onResumeSession={resumeSession}
          onAdd={handleAdd}
          onRename={(id, newName) => updateProject(id, { name: newName })}
          onChangeColor={(id, color) => updateProject(id, { color })}
          onRemove={handleRemoveProject}
          onToggleUltimateMode={toggleUltimateMode}
        />
        <main className="main">
          <TabStrip
            tabs={
              ultimateModeProjectId
                ? tabs.filter((t) => t.project.id === ultimateModeProjectId)
                : tabs
            }
            activeTabId={activeTabId}
            activityStates={tabActivityStates}
            onSelect={setActiveTabId}
            onClose={closeTab}
            ulmActive={ultimateModeProjectId !== null}
            ultimateModeProjectName={
              ultimateModeProjectId
                ? projects.find((p) => p.id === ultimateModeProjectId)?.name
                : undefined
            }
            onSpawnUltimateWorker={
              ultimateModeProjectId
                ? () => {
                    const p = projects.find((px) => px.id === ultimateModeProjectId)
                    if (p) openProject(p, { newTab: true })
                  }
                : undefined
            }
          />
          <TerminalArea
            tabs={tabs}
            activeTabId={activeTabId}
            ultimateModeProjectId={ultimateModeProjectId}
            onActivateTab={setActiveTabId}
            swarmTargetTabId={swarmTargetTabId}
            viewModes={tabViewModes}
            onViewModeChange={setTabViewMode}
            onRestart={restartTab}
            onRepath={repathTab}
            onRemoveProject={handleRemoveProject}
          />
          <MasterPane
            collapsed={masterCollapsed}
            onToggleCollapse={() => setMasterCollapsed((prev) => !prev)}
            height={masterHeight}
            onResize={setMasterHeight}
          />
        </main>
      </div>
      )}
      {!miniMode && (
      <>
      <WebPreview
        project={activeTab?.project ?? null}
        url={activeTab ? projectPreviews.get(activeTab.project.id) : undefined}
        onClear={() => {
          if (!activeTab) return
          setProjectPreviews((prev) => {
            const next = new Map(prev)
            next.delete(activeTab.project.id)
            return next
          })
        }}
        onStartDevServer={(p) => {
          const prompt = `Käivita "${p.name}" projekti dev server (asukoht: ${p.path}). Vaja loe package.json'i, et tuvastada õige käsk (npm/pnpm/yarn run dev, või Vite/Next.js/Astro/jms). Kui server üleval, raporteeri URL — embedded preview avaneb automaatselt.`
          window.dispatchEvent(
            new CustomEvent('master:prompt', { detail: { text: prompt } })
          )
        }}
      />
      <StatusBar
        tab={activeTab}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'cream' : 'dark'))}
      />
      </>
      )}
      {adding && (
        <AddProjectDialog
          initialName={adding.name}
          initialPath={adding.path}
          onCancel={() => setAdding(null)}
          onSubmit={handleAddSubmit}
        />
      )}
      {mapOpen && (
        <MapMode
          projects={projects}
          onSelect={(p) => {
            openProject(p)
            setMapOpen(false)
            setQuickSwitcherOpen(false)
            setHelpOpen(false)
          }}
          onClose={() => setMapOpen(false)}
        />
      )}
      {quickSwitcherOpen && (
        <QuickSwitcher
          projects={projects}
          projectStatus={projectStatus}
          onSelect={(p) => {
            openProject(p)
            setQuickSwitcherOpen(false)
          }}
          onClose={() => setQuickSwitcherOpen(false)}
        />
      )}
      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
      {toast && (
        <Toast
          key={toast.id}
          message={toast.message}
          kind={toast.kind}
          onDismiss={() => setToast(null)}
        />
      )}
    </div>
  )
}
