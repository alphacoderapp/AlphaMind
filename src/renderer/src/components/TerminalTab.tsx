import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { Tab } from '../types'

interface Props {
  tab: Tab
  active: boolean
  onRestart: (tabId: string) => void
}

export function TerminalTab({ tab, active, onRestart }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [ended, setEnded] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [pathExists, setPathExists] = useState<boolean | null>(null)
  const [quickExit, setQuickExit] = useState(false)
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

    const term = new Terminal({
      fontFamily: '"Geist Mono", "SF Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.3,
      letterSpacing: 0,
      theme: {
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
        termRef.current?.focus()
      } catch {
        /* noop */
      }
    }, 16)
    return () => clearTimeout(t)
  }, [active, tab.ptyId])

  const handleRestart = async () => {
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

  return (
    <div
      className="terminal-tab-wrapper"
      style={{
        visibility: active ? 'visible' : 'hidden',
        zIndex: active ? 1 : 0
      }}
    >
      <div ref={containerRef} className="terminal-tab" />
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
              {!pathMissing && (
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
              )}
              <button
                type="button"
                className="terminal-ended-secondary"
                onClick={handleOpenFolder}
              >
                Open in Finder
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
