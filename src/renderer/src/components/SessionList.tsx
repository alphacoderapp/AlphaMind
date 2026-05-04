import type { CSSProperties } from 'react'
import type { ClaudeSession } from '../types'

interface Props {
  sessions: ClaudeSession[]
  loading: boolean
  accent: string
  onSelect: (sessionId: string) => void
}

function formatTime(ts: number): string {
  const now = Date.now()
  const d = new Date(ts)
  const diffDays = Math.floor((now - ts) / (24 * 60 * 60 * 1000))
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (diffDays === 0) return `Today ${hh}:${mm}`
  if (diffDays === 1) return `Yest ${hh}:${mm}`
  if (diffDays < 7) {
    const dow = d.toLocaleDateString('en', { weekday: 'short' })
    return `${dow} ${hh}:${mm}`
  }
  if (diffDays < 365) {
    return d.toLocaleDateString('en', { day: 'numeric', month: 'short' })
  }
  return d.toLocaleDateString('en', { day: 'numeric', month: 'short', year: '2-digit' })
}

export function SessionList({ sessions, loading, accent, onSelect }: Props) {
  if (loading) {
    return (
      <div className="session-list">
        <div className="session-empty">LOADING...</div>
      </div>
    )
  }
  if (sessions.length === 0) {
    return (
      <div className="session-list">
        <div className="session-empty">NO SESSIONS YET</div>
      </div>
    )
  }
  return (
    <div className="session-list" style={{ '--accent': accent } as CSSProperties}>
      {sessions.map((s) => (
        <button
          key={s.id}
          type="button"
          className="session-item"
          onClick={() => onSelect(s.id)}
          title={s.firstMessage}
        >
          <span className="session-time">{formatTime(s.lastTimestamp)}</span>
          <span className="session-preview">{s.firstMessage}</span>
        </button>
      ))}
    </div>
  )
}
