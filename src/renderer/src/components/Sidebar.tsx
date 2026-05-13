import { Fragment, useState } from 'react'
import type { CSSProperties } from 'react'
import type { Project } from '../data/mockProjects'
import type { ClaudeSession } from '../types'
import type { ProjectStatus } from '../App'
import { Sigil } from './Sigil'
import { ContextMenu } from './ContextMenu'
import { SessionList } from './SessionList'
import { MasterThinkOrb } from './MasterThinkOrb'

const COLORS = ['#22d3ee', '#34d399', '#e879f9', '#fbbf24', '#a78bfa', '#fb7185']

interface Props {
  projects: Project[]
  allProjectCount: number
  activeProjectId: string | null
  projectStatus: Map<string, ProjectStatus>
  ultimateModeProjectId: string | null
  onSelect: (id: string, opts: { newTab: boolean }) => void
  onResumeSession: (project: Project, sessionId: string) => void
  onAdd: () => void
  onRename: (id: string, newName: string) => void
  onChangeColor: (id: string, color: string) => void
  onRemove: (id: string) => void
  onToggleUltimateMode: (projectId: string | null) => void
}

export function Sidebar({
  projects,
  allProjectCount,
  activeProjectId,
  projectStatus,
  ultimateModeProjectId,
  onSelect,
  onResumeSession,
  onAdd,
  onRename,
  onChangeColor,
  onRemove,
  onToggleUltimateMode
}: Props) {
  const [menu, setMenu] = useState<{ project: Project; x: number; y: number } | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [sessions, setSessions] = useState<Map<string, ClaudeSession[]>>(new Map())
  const [loadingSessions, setLoadingSessions] = useState<Set<string>>(new Set())

  const startRename = (project: Project) => {
    setRenamingId(project.id)
    setRenameValue(project.name)
  }

  const commitRename = () => {
    if (renamingId && renameValue.trim()) {
      onRename(renamingId, renameValue.trim())
    }
    setRenamingId(null)
  }

  const toggleExpand = async (project: Project) => {
    const isExpanded = expanded.has(project.id)
    if (isExpanded) {
      setExpanded((prev) => {
        const next = new Set(prev)
        next.delete(project.id)
        return next
      })
      return
    }
    setExpanded((prev) => new Set(prev).add(project.id))
    if (!sessions.has(project.id)) {
      setLoadingSessions((prev) => new Set(prev).add(project.id))
      try {
        const list = await window.api.sessions.list(project.path)
        setSessions((prev) => new Map(prev).set(project.id, list))
      } finally {
        setLoadingSessions((prev) => {
          const next = new Set(prev)
          next.delete(project.id)
          return next
        })
      }
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="micro-label">Projects</span>
        <button
          className="sidebar-add"
          title="Add project"
          onClick={onAdd}
          type="button"
        >
          +
        </button>
      </div>
      {ultimateModeProjectId && (
        <div className="sidebar-ulm-banner">
          <MasterThinkOrb size={7} thinking />
          <span className="sidebar-ulm-banner-text">Ultimate mode</span>
          <button
            type="button"
            className="sidebar-ulm-banner-exit"
            onClick={() => onToggleUltimateMode(null)}
            title="Exit Ultimate Mode"
          >
            ×
          </button>
        </div>
      )}
      <div className="sidebar-list">
        {projects.length === 0 && (
          <div className="sidebar-empty">
            <span className="micro-label">No projects</span>
            <span className="sidebar-empty-hint">Click + to add one</span>
          </div>
        )}
        {projects.map((p) => {
          const isActive = activeProjectId === p.id
          const status = projectStatus.get(p.id)
          let dotClass = ''
          if (!isActive && status) {
            if (status.hasBell) dotClass = ' bell'
            else if (status.hasUnread) dotClass = ' unread'
            else if (status.hasRunning) dotClass = ' running'
            else if (status.hasOpenTab) dotClass = ' idle'
          }
          return (
            <Fragment key={p.id}>
              <div
                className={`sidebar-item${isActive ? ' active' : ''}`}
                onClick={(e) => {
                  if (renamingId === p.id) return
                  onSelect(p.id, { newTab: e.metaKey })
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ project: p, x: e.clientX, y: e.clientY })
                }}
                onKeyDown={(e) => {
                  if (renamingId === p.id) return
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelect(p.id, { newTab: e.metaKey })
                  }
                }}
                style={{ '--accent': p.color } as CSSProperties}
                role="button"
                tabIndex={0}
              >
                <Sigil name={p.name} color={p.color} size={22} />
                {renamingId === p.id ? (
                  <input
                    className="sidebar-item-rename"
                    value={renameValue}
                    autoFocus
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename()
                      if (e.key === 'Escape') setRenamingId(null)
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="sidebar-item-name">{p.name}</span>
                )}
                <button
                  type="button"
                  className={`sidebar-item-chevron${expanded.has(p.id) ? ' expanded' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleExpand(p)
                  }}
                  title={expanded.has(p.id) ? 'Collapse sessions' : 'Show sessions'}
                >
                  ›
                </button>
                <span className={`sidebar-item-orb${dotClass}`}>
                  <MasterThinkOrb
                    size={6}
                    accent={p.color}
                    thinking={!!status?.hasRunning || !!status?.hasBell}
                  />
                </span>
              </div>
              {expanded.has(p.id) && (
                <>
                  <div className="sidebar-settings-panel">
                    <button
                      type="button"
                      className={`sidebar-ulm-toggle${ultimateModeProjectId === p.id ? ' active' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        onToggleUltimateMode(
                          ultimateModeProjectId === p.id ? null : p.id
                        )
                      }}
                      style={{ '--accent': p.color } as CSSProperties}
                    >
                      <MasterThinkOrb
                        size={7}
                        accent={p.color}
                        thinking={ultimateModeProjectId === p.id}
                      />
                      <span className="sidebar-ulm-label">
                        Ultimate developer mode
                      </span>
                      <span className="sidebar-ulm-state">
                        {ultimateModeProjectId === p.id ? 'on' : 'off'}
                      </span>
                    </button>
                    {ultimateModeProjectId === p.id && (
                      <div className="sidebar-ulm-hint">
                        Multiple parallel workers allowed. Master coordinates and
                        commits centrally.
                      </div>
                    )}
                  </div>
                  <SessionList
                    sessions={sessions.get(p.id) ?? []}
                    loading={loadingSessions.has(p.id)}
                    accent={p.color}
                    onSelect={(sessionId) => onResumeSession(p, sessionId)}
                  />
                </>
              )}
            </Fragment>
          )
        })}
      </div>
      <div className="sidebar-footer">
        <span className="micro-label">
          {ultimateModeProjectId ? `1 of ${allProjectCount} (ULM)` : `${allProjectCount} total`}
        </span>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: 'Open in Finder',
              onClick: () => window.api.shell.openPath(menu.project.path)
            },
            {
              label: 'Copy Path',
              onClick: () => {
                window.api.clipboard.writeText(menu.project.path)
              }
            },
            {
              label: 'Rename',
              onClick: () => startRename(menu.project)
            },
            {
              label: 'Remove',
              destructive: true,
              onClick: () => onRemove(menu.project.id)
            }
          ]}
          extra={
            <div className="context-menu-color-row">
              <span className="context-menu-color-label">COLOR</span>
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`context-menu-color-swatch${menu.project.color === c ? ' active' : ''}`}
                  style={{ background: c, color: c }}
                  onClick={() => {
                    onChangeColor(menu.project.id, c)
                    setMenu(null)
                  }}
                />
              ))}
            </div>
          }
        />
      )}
    </aside>
  )
}
