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

  useEffect(() => {
    setEnded(false)
    setRestarting(false)
  }, [tab.ptyId])

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
      onRestart(tab.id)
    } catch {
      setRestarting(false)
    }
  }

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
        <div className="terminal-ended-overlay">
          <div className="terminal-ended-card">
            <div
              className="terminal-ended-mark"
              style={{
                background: tab.project.color,
                boxShadow: `0 0 12px ${tab.project.color}`
              }}
            />
            <div className="terminal-ended-title">Session ended</div>
            <div className="terminal-ended-subtitle">
              Claude exited in <strong>{tab.project.name}</strong>. Restart to start a fresh session.
            </div>
            <button
              type="button"
              className="terminal-ended-restart"
              onClick={handleRestart}
              disabled={restarting}
            >
              {restarting ? 'Restarting…' : '↻ Restart Session'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
