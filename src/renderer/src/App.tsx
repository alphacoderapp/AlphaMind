import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { useProjects } from './hooks/useProjects'
import type { Project } from './data/mockProjects'
import type { Tab } from './types'

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
  const [masterHeight, setMasterHeight] = useState(MASTER_DEFAULT_HEIGHT)

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

  // Restore tabs from disk on first load (after projects are available)
  useEffect(() => {
    if (restoredRef.current || !projectsLoaded) return
    restoredRef.current = true

    let cancelled = false
    ;(async () => {
      const state = await window.api.state.load()
      if (cancelled || !state || !state.tabs?.length) return

      // Strict: never restore duplicate tabs for same project. Keep first only.
      const seenProjectIds = new Set<string>()
      const dedupedStored = state.tabs.filter((s) => {
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
      const state = {
        tabs: tabs.map((t) => ({ projectId: t.project.id, sessionId: t.sessionId })),
        activeIndex: activeTabId ? tabs.findIndex((t) => t.id === activeTabId) : -1
      }
      window.api.state.save(state).catch((e) => console.error('Save state failed:', e))
    }, STATE_SAVE_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [tabs, activeTabId])

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

  useEffect(() => {
    if (typeof Notification === 'undefined') return
    const prev = prevTransitionRef.current

    tabs.forEach((tab) => {
      const activity = tabActivityStates.get(tab.id)
      const isRunning = activity?.isRunning ?? false
      const hasBell = activity?.hasBell ?? false
      const wasState = prev.get(tab.id) ?? { running: false, bell: false }

      const finishedTask = wasState.running && !isRunning
      const newBell = !wasState.bell && hasBell

      const isInactive = tab.id !== activeTabId
      const isUnfocused = !document.hasFocus()

      if (isInactive && isUnfocused && (finishedTask || newBell)) {
        try {
          const title = `Simple Claude · ${tab.project.name}`
          const body = newBell ? 'Attention requested' : 'Session ready'
          const notif = new Notification(title, { body, silent: false })
          notif.onclick = () => {
            window.api.window.focus()
            setActiveTabId(tab.id)
          }
        } catch (e) {
          console.error('Notification failed:', e)
        }
      }

      prev.set(tab.id, { running: isRunning, bell: hasBell })
    })

    for (const [id] of prev) {
      if (!tabs.find((t) => t.id === id)) prev.delete(id)
    }
  }, [tabActivityStates, tabs, activeTabId])

  useEffect(() => {
    if (typeof Notification === 'undefined') return
    if (Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {})
    }
  }, [])

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
    async (project: Project, _opts: { newTab?: boolean } = {}) => {
      // Strict no-duplicate rule: one tab per project. Always reuse if exists.
      const existing = tabs.find((t) => t.project.id === project.id)
      if (existing) {
        setActiveTabId(existing.id)
        return
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
    [tabs]
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
  }, [])

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
  useEffect(() => {
    projectsRef.current = projects
  }, [projects])
  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])

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

  return (
    <div className="app">
      <header className="titlebar">
        <div className="titlebar-traffic-spacer" />
        <div className="titlebar-content">
          <span className="titlebar-mark">◆</span>
          <span>SIMPLE CLAUDE</span>
        </div>
        <div className="titlebar-traffic-spacer" />
      </header>
      <div className="body">
        <Sidebar
          projects={projects}
          activeProjectId={activeProjectId}
          projectStatus={projectStatus}
          onSelect={(id, opts) => {
            const p = projects.find((p) => p.id === id)
            if (p) openProject(p, opts)
          }}
          onResumeSession={resumeSession}
          onAdd={handleAdd}
          onRename={(id, newName) => updateProject(id, { name: newName })}
          onChangeColor={(id, color) => updateProject(id, { color })}
          onRemove={handleRemoveProject}
        />
        <main className="main">
          <TabStrip
            tabs={tabs}
            activeTabId={activeTabId}
            activityStates={tabActivityStates}
            onSelect={setActiveTabId}
            onClose={closeTab}
          />
          <TerminalArea tabs={tabs} activeTabId={activeTabId} />
          <MasterPane
            collapsed={masterCollapsed}
            onToggleCollapse={() => setMasterCollapsed((prev) => !prev)}
            height={masterHeight}
            onResize={setMasterHeight}
          />
        </main>
      </div>
      <StatusBar tab={activeTab} />
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
