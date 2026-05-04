import type { CSSProperties } from 'react'
import type { Project } from '../data/mockProjects'
import type { ProjectStats } from '../hooks/useProjectStats'

interface Props {
  project: Project
  stats: ProjectStats | null
  pinned: boolean
  onOpen: () => void
  onOpenInFinder: () => void
  onCopyPath: () => void
  onClose: () => void
}

function formatRecency(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  const hour = Math.floor(diff / 3600000)
  const day = Math.floor(diff / 86400000)
  const week = Math.floor(day / 7)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  if (hour < 24) return `${hour}h ago`
  if (day < 14) return `${day}d ago`
  if (day < 365) return `${week}w ago`
  return `${Math.floor(day / 365)}y ago`
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '...'
}

export function MapHoverPanel({
  project,
  stats,
  pinned,
  onOpen,
  onOpenInFinder,
  onCopyPath,
  onClose
}: Props) {
  return (
    <div
      className={`map-hover-panel${pinned ? ' pinned' : ''}`}
      style={{ '--accent': project.color } as CSSProperties}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="map-hover-header">
        <div className="map-hover-title">{project.name}</div>
        <div className="map-hover-path">{project.path}</div>
        {stats?.lastActivityTimestamp && (
          <div className="map-hover-activity">
            <span className="map-hover-activity-dot" />
            <span>Last activity {formatRecency(stats.lastActivityTimestamp)}</span>
          </div>
        )}
      </div>

      {stats?.git?.isGitRepo ? (
        <div className="map-hover-section">
          <div className="map-hover-section-title">GIT</div>
          <div className="map-hover-row">
            <span className="map-hover-label">Branch</span>
            <span className="map-hover-value">
              {stats.git.branch ?? '—'}
              {stats.git.hasUncommittedChanges && (
                <span
                  className="dirty-marker"
                  title={`${stats.git.changedFiles ?? 0} uncommitted file(s)`}
                >
                  ●
                </span>
              )}
            </span>
          </div>
          {stats.git.hasUpstream && (
            <div className="map-hover-row">
              <span className="map-hover-label">Sync</span>
              <span className="map-hover-value">
                {stats.git.ahead ? `+${stats.git.ahead} ` : ''}
                {stats.git.behind ? `-${stats.git.behind}` : ''}
                {!stats.git.ahead && !stats.git.behind ? 'in sync' : ''}
              </span>
            </div>
          )}
          <div className="map-hover-row">
            <span className="map-hover-label">7d / 30d</span>
            <span className="map-hover-value">
              {stats.git.commitsLast7Days ?? 0} / {stats.git.commitsLast30Days ?? 0} commits
            </span>
          </div>
          {stats.git.changedFiles !== undefined && stats.git.changedFiles > 0 && (
            <div className="map-hover-row">
              <span className="map-hover-label">Uncommitted</span>
              <span className="map-hover-value">{stats.git.changedFiles} files</span>
            </div>
          )}
        </div>
      ) : stats ? (
        <div className="map-hover-section">
          <div className="map-hover-section-title">GIT</div>
          <div className="map-hover-empty">Not a git repository</div>
        </div>
      ) : null}

      {stats?.git?.recentCommits && stats.git.recentCommits.length > 0 && (
        <div className="map-hover-section">
          <div className="map-hover-section-title">RECENT COMMITS</div>
          <div className="map-hover-list">
            {stats.git.recentCommits.map((c) => (
              <div key={c.hash} className="map-hover-list-item">
                <span className="map-hover-time">{formatRecency(c.timestamp)}</span>
                <span className="map-hover-message">{truncate(c.message, 64)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {stats?.recentSessions && stats.recentSessions.length > 0 && (
        <div className="map-hover-section">
          <div className="map-hover-section-title">
            RECENT SESSIONS · {stats.sessionsLast7Days}/wk · {stats.sessionsLast30Days}/mo
          </div>
          <div className="map-hover-list">
            {stats.recentSessions.slice(0, 4).map((s) => (
              <div key={s.id} className="map-hover-list-item">
                <span className="map-hover-time">{formatRecency(s.lastTimestamp)}</span>
                <span className="map-hover-message">{truncate(s.firstMessage, 64)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {!stats && (
        <div className="map-hover-section">
          <div className="map-hover-empty">Loading stats...</div>
        </div>
      )}

      <div className="map-hover-actions">
        <button type="button" onClick={onOpen} className="map-hover-btn primary">
          OPEN
        </button>
        <button type="button" onClick={onOpenInFinder} className="map-hover-btn">
          FINDER
        </button>
        <button type="button" onClick={onCopyPath} className="map-hover-btn">
          COPY PATH
        </button>
      </div>

      {pinned && (
        <button type="button" className="map-hover-close" onClick={onClose} title="Unpin (Esc)">
          ×
        </button>
      )}
    </div>
  )
}
