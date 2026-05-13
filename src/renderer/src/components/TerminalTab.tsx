import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { Tab } from '../types'
import { ChatLayer, type ChatAttachment } from './ChatLayer'

export type TabViewMode = 'terminal' | 'chat'

// ULM grid layout: every worker tab in the active ULM project renders as a
// live mini-window in a grid filling the terminal area. Hovering a cell grows
// it to ~85% of the area (others stay in place underneath); leaving shrinks
// it back. The hovered cell becomes the dispatch target.
//
// `cellStyle` carries the inline transform/positioning the parent computed
// per-cell (and re-computes per hover). `hovered` is true for the cell that
// is currently grown.
export interface UlmLayout {
  role: 'cell'
  cellStyle?: CSSProperties
  hovered?: boolean
  onCellHover?: () => void
  onCellUnhover?: () => void
  swarmActive?: boolean
}

interface Props {
  tab: Tab
  active: boolean
  viewMode: TabViewMode
  onViewModeChange: (tabId: string, mode: TabViewMode) => void
  onRestart: (tabId: string) => void
  onRepath: (tabId: string) => void
  onRemoveProject: (projectId: string) => void
  ulmLayout?: UlmLayout
}

export function TerminalTab({
  tab,
  active,
  viewMode,
  onViewModeChange,
  onRestart,
  onRepath,
  onRemoveProject,
  ulmLayout
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [terminalReady, setTerminalReady] = useState(false)
  const [ended, setEnded] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [pathExists, setPathExists] = useState<boolean | null>(null)
  const [quickExit, setQuickExit] = useState(false)
  // Chat draft survives mode toggles. ChatLayer is unmounted in terminal mode,
  // so ownership of input + attachments lives here on the parent.
  const [chatInput, setChatInput] = useState('')
  const [chatAttachments, setChatAttachments] = useState<ChatAttachment[]>([])
  const mountedAtRef = useRef<number>(Date.now())

  useEffect(() => {
    setEnded(false)
    setRestarting(false)
    setQuickExit(false)
    mountedAtRef.current = Date.now()
    let cancelled = false
    window.api.path
      .exists(tab.project.path)
      .then((ok) => {
        if (!cancelled) setPathExists(ok)
      })
      .catch(() => {
        if (!cancelled) setPathExists(null)
      })
    return () => {
      cancelled = true
    }
  }, [tab.ptyId, tab.project.path])

  useEffect(() => {
    if (!containerRef.current) return

    const isCream = document.documentElement.dataset.theme === 'cream'
    const term = new Terminal({
      fontFamily: '"Geist Mono", "SF Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.3,
      letterSpacing: 0,
      theme: isCream
        ? {
            background: '#ffffff',
            foreground: '#171717',
            cursor: tab.project.color,
            cursorAccent: '#ffffff',
            selectionBackground: '#0e749044',
            black: '#171717',
            red: '#b91c1c',
            green: '#047857',
            yellow: '#b45309',
            blue: '#1d4ed8',
            magenta: '#a21caf',
            cyan: '#0e7490',
            white: '#525252',
            brightBlack: '#a3a3a3',
            brightRed: '#dc2626',
            brightGreen: '#059669',
            brightYellow: '#d97706',
            brightBlue: '#2563eb',
            brightMagenta: '#c026d3',
            brightCyan: '#0891b2',
            brightWhite: '#171717'
          }
        : {
            background: '#050507',
            foreground: '#e8e8ec',
            cursor: tab.project.color,
            cursorAccent: '#050507',
            selectionBackground: '#22d3ee44',
            black: '#08080b',
            red: '#ef4444',
            green: '#34d399',
            yellow: '#fbbf24',
            blue: '#60a5fa',
            magenta: '#e879f9',
            cyan: '#22d3ee',
            white: '#e8e8ec',
            brightBlack: '#46464f',
            brightRed: '#fca5a5',
            brightGreen: '#6ee7b7',
            brightYellow: '#fcd34d',
            brightBlue: '#93c5fd',
            brightMagenta: '#f0abfc',
            brightCyan: '#67e8f9',
            brightWhite: '#ffffff'
          },
      scrollback: 10000,
      cursorBlink: true,
      allowProposedApi: true
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    try {
      fit.fit()
    } catch {
      /* container not ready */
    }

    termRef.current = term
    fitRef.current = fit
    setTerminalReady(true)

    const writeDisp = term.onData((data) => {
      window.api.pty.write(tab.ptyId, data)
    })

    const dataUnsub = window.api.pty.onData((id, data) => {
      if (id === tab.ptyId && termRef.current) {
        termRef.current.write(data)
      }
    })

    const exitUnsub = window.api.pty.onExit((id) => {
      if (id === tab.ptyId) {
        const elapsed = Date.now() - mountedAtRef.current
        setQuickExit(elapsed < 3000)
        setEnded(true)
      }
    })

    try {
      const dim = fit.proposeDimensions()
      if (dim) window.api.pty.resize(tab.ptyId, dim.cols, dim.rows)
    } catch {
      /* noop */
    }

    return () => {
      writeDisp.dispose()
      dataUnsub()
      exitUnsub()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      setTerminalReady(false)
    }
  }, [tab.ptyId, tab.project.color])

  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(() => {
      if (!fitRef.current || !termRef.current) return
      try {
        fitRef.current.fit()
        const dim = fitRef.current.proposeDimensions()
        if (dim) window.api.pty.resize(tab.ptyId, dim.cols, dim.rows)
      } catch {
        /* noop */
      }
    })
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [tab.ptyId])

  useEffect(() => {
    if (!active) return
    const t = setTimeout(() => {
      try {
        fitRef.current?.fit()
        const dim = fitRef.current?.proposeDimensions()
        if (dim) window.api.pty.resize(tab.ptyId, dim.cols, dim.rows)
        if (viewMode === 'terminal') termRef.current?.focus()
      } catch {
        /* noop */
      }
    }, 16)
    return () => clearTimeout(t)
  }, [active, tab.ptyId, viewMode])

  // Update xterm theme on app theme change without recreating the terminal
  // (preserves scrollback / cursor / state).
  useEffect(() => {
    const apply = (): void => {
      const term = termRef.current
      if (!term) return
      const isCream = document.documentElement.dataset.theme === 'cream'
      term.options.theme = isCream
        ? {
            background: '#ffffff',
            foreground: '#171717',
            cursor: tab.project.color,
            cursorAccent: '#ffffff',
            selectionBackground: '#0e749044',
            black: '#171717',
            red: '#b91c1c',
            green: '#047857',
            yellow: '#b45309',
            blue: '#1d4ed8',
            magenta: '#a21caf',
            cyan: '#0e7490',
            white: '#525252',
            brightBlack: '#a3a3a3',
            brightRed: '#dc2626',
            brightGreen: '#059669',
            brightYellow: '#d97706',
            brightBlue: '#2563eb',
            brightMagenta: '#c026d3',
            brightCyan: '#0891b2',
            brightWhite: '#171717'
          }
        : {
            background: '#050507',
            foreground: '#e8e8ec',
            cursor: tab.project.color,
            cursorAccent: '#050507',
            selectionBackground: '#22d3ee44',
            black: '#08080b',
            red: '#ef4444',
            green: '#34d399',
            yellow: '#fbbf24',
            blue: '#60a5fa',
            magenta: '#e879f9',
            cyan: '#22d3ee',
            white: '#e8e8ec',
            brightBlack: '#46464f',
            brightRed: '#fca5a5',
            brightGreen: '#6ee7b7',
            brightYellow: '#fcd34d',
            brightBlue: '#93c5fd',
            brightMagenta: '#f0abfc',
            brightCyan: '#67e8f9',
            brightWhite: '#ffffff'
          }
    }
    const obs = new MutationObserver(apply)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [tab.project.color])

  const handleRestart = async (): Promise<void> => {
    if (restarting) return
    setRestarting(true)
    try {
      await onRestart(tab.id)
    } finally {
      // Reset by useEffect on ptyId change; this is a fallback if restart errored
      setTimeout(() => setRestarting(false), 1500)
    }
  }

  const handleOpenFolder = (): void => {
    window.api.shell.openPath(tab.project.path)
  }

  const pathMissing = pathExists === false
  const failedToStart = quickExit && !pathMissing
  const inChatMode = viewMode === 'chat'

  // When the parent renders this in a ULM grid, every wrapper is visible
  // (each in its own cell slot, scaled to fit). Otherwise default behaviour:
  // only the active tab is visible, all others are kept mounted but hidden.
  const ulmClass = ulmLayout
    ? ` terminal-tab-wrapper--ulm-cell${
        ulmLayout.hovered ? ' terminal-tab-wrapper--ulm-cell-hovered' : ''
      }${ulmLayout.swarmActive ? ' terminal-tab-wrapper--ulm-swarm' : ''}`
    : ''
  const wrapperStyle: CSSProperties = ulmLayout
    ? { ...(ulmLayout.cellStyle ?? {}) }
    : {
        visibility: active ? 'visible' : 'hidden',
        zIndex: active ? 1 : 0
      }

  return (
    <div
      className={`terminal-tab-wrapper${inChatMode ? ' terminal-tab-wrapper-chat' : ''}${ulmClass}`}
      style={wrapperStyle}
      onMouseEnter={ulmLayout ? ulmLayout.onCellHover : undefined}
      onMouseLeave={ulmLayout ? ulmLayout.onCellUnhover : undefined}
    >
      <div ref={containerRef} className="terminal-tab" />
      {inChatMode && terminalReady && termRef.current && (
        <ChatLayer
          ptyId={tab.ptyId}
          terminal={termRef.current}
          accent={tab.project.color}
          active={active}
          input={chatInput}
          onInputChange={setChatInput}
          attachments={chatAttachments}
          onAttachmentsChange={setChatAttachments}
        />
      )}
      <button
        type="button"
        className="terminal-view-toggle"
        onClick={() => onViewModeChange(tab.id, inChatMode ? 'terminal' : 'chat')}
        title={inChatMode ? 'Switch to terminal view' : 'Switch to chat view'}
      >
        {inChatMode ? '⌨ TERMINAL' : '✦ CHAT'}
      </button>
      {ended && (
        <div className={`terminal-ended-overlay${pathMissing || failedToStart ? ' terminal-ended-error' : ''}`}>
          <div className="terminal-ended-card">
            <div
              className="terminal-ended-mark"
              style={{
                background: pathMissing || failedToStart ? '#ef4444' : tab.project.color,
                boxShadow: `0 0 12px ${pathMissing || failedToStart ? '#ef4444' : tab.project.color}`
              }}
            />
            <div className="terminal-ended-title">
              {pathMissing
                ? 'Path not found'
                : failedToStart
                  ? 'Failed to start'
                  : 'Session ended'}
            </div>
            <div className="terminal-ended-subtitle">
              {pathMissing ? (
                <>
                  Folder does not exist:
                  <br />
                  <code className="terminal-ended-path">{tab.project.path}</code>
                  <br />
                  Update the project path or recreate the folder.
                </>
              ) : failedToStart ? (
                <>
                  Claude exited within seconds in <strong>{tab.project.name}</strong>.
                  <br />
                  Likely auth, network, or claude CLI issue.
                </>
              ) : (
                <>
                  Claude exited in <strong>{tab.project.name}</strong>. Resume picks up where you left off.
                </>
              )}
            </div>
            <div className="terminal-ended-actions">
              {pathMissing ? (
                <>
                  <button
                    type="button"
                    className="terminal-ended-restart"
                    onClick={() => onRepath(tab.id)}
                  >
                    ⌕ Pick New Folder
                  </button>
                  <button
                    type="button"
                    className="terminal-ended-secondary"
                    onClick={() => {
                      const confirmed = window.confirm(
                        `Remove "${tab.project.name}" from sidebar? This deletes only the project entry, not any files.`
                      )
                      if (confirmed) onRemoveProject(tab.project.id)
                    }}
                  >
                    Remove Project
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="terminal-ended-restart"
                    onClick={handleRestart}
                    disabled={restarting}
                  >
                    {restarting
                      ? failedToStart
                        ? 'Trying again…'
                        : 'Resuming…'
                      : failedToStart
                        ? '↻ Try Again'
                        : '↻ Resume Session'}
                  </button>
                  <button
                    type="button"
                    className="terminal-ended-secondary"
                    onClick={handleOpenFolder}
                  >
                    Open in Finder
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
