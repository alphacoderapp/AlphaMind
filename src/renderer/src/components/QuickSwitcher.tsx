import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { Project } from '../data/mockProjects'
import type { ProjectStatus } from '../App'
import { Sigil } from './Sigil'

interface Props {
  projects: Project[]
  projectStatus: Map<string, ProjectStatus>
  onSelect: (project: Project) => void
  onClose: () => void
}

export function QuickSwitcher({ projects, projectStatus, onSelect, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const filtered = useMemo(() => {
    if (!query.trim()) return projects
    const q = query.toLowerCase()
    return projects.filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
  }, [projects, query])

  useEffect(() => {
    setSelectedIdx(0)
  }, [query])

  // Keep selected item in view
  useEffect(() => {
    if (!listRef.current) return
    const items = listRef.current.querySelectorAll('.quick-switcher-item')
    const target = items[selectedIdx] as HTMLElement | undefined
    target?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  const submit = () => {
    const target = filtered[selectedIdx]
    if (target) onSelect(target)
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="quick-switcher" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="quick-switcher-input"
          value={query}
          placeholder="Switch project..."
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSelectedIdx((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="quick-switcher-list" ref={listRef}>
          {filtered.length === 0 && (
            <div className="quick-switcher-empty">NO MATCHES</div>
          )}
          {filtered.map((p, i) => {
            const status = projectStatus.get(p.id)
            const isSelected = i === selectedIdx
            const dotState = status?.hasBell
              ? ' bell'
              : status?.hasUnread
                ? ' unread'
                : status?.hasRunning
                  ? ' running'
                  : status?.hasOpenTab
                    ? ' idle'
                    : ''
            return (
              <button
                key={p.id}
                type="button"
                className={`quick-switcher-item${isSelected ? ' selected' : ''}`}
                style={{ '--accent': p.color } as CSSProperties}
                onClick={() => onSelect(p)}
                onMouseEnter={() => setSelectedIdx(i)}
              >
                <Sigil name={p.name} color={p.color} size={20} />
                <span className="quick-switcher-name">{p.name}</span>
                <span className="quick-switcher-path">{p.path}</span>
                <span className={`sidebar-item-dot${dotState}`} />
              </button>
            )
          })}
        </div>
        <div className="quick-switcher-help">↑↓ NAVIGATE · ⏎ OPEN · ESC CANCEL</div>
      </div>
    </div>
  )
}
