import { useEffect, useMemo, useState } from 'react'
import type { Project } from '../data/mockProjects'
import { Sigil } from './Sigil'
import { MapHoverPanel } from './MapHoverPanel'
import { useAllProjectStats } from '../hooks/useProjectStats'

interface Props {
  projects: Project[]
  onSelect: (project: Project) => void
  onClose: () => void
}

interface NodePos {
  x: number
  y: number
}

const DAY = 24 * 60 * 60 * 1000

function djb2(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) + s.charCodeAt(i)
    h |= 0
  }
  return h >>> 0
}

function computePositions(projects: Project[], width: number, height: number): Map<string, NodePos> {
  const map = new Map<string, NodePos>()
  const cx = width / 2
  const cy = height / 2
  const baseRadius = Math.min(width, height) * 0.3
  const N = Math.max(projects.length, 1)

  projects.forEach((p, i) => {
    const angle = (i / N) * Math.PI * 2 - Math.PI / 2
    const variance = ((djb2(p.id) % 1000) / 1000) * 100 - 50
    const r = baseRadius + variance
    map.set(p.id, {
      x: cx + r * Math.cos(angle),
      y: cy + r * Math.sin(angle)
    })
  })

  return map
}

function useWindowSize(): [number, number] {
  const [size, setSize] = useState<[number, number]>([
    typeof window !== 'undefined' ? window.innerWidth : 1280,
    typeof window !== 'undefined' ? window.innerHeight : 800
  ])
  useEffect(() => {
    const onResize = () => setSize([window.innerWidth, window.innerHeight])
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return size
}

function formatShort(diffMs: number): string {
  const min = Math.floor(diffMs / 60000)
  const hour = Math.floor(diffMs / 3600000)
  const day = Math.floor(diffMs / 86400000)
  const week = Math.floor(day / 7)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  if (hour < 24) return `${hour}h`
  if (day < 14) return `${day}d`
  if (day < 365) return `${week}w`
  return `${Math.floor(day / 365)}y`
}

function activityIntensity(timestamp?: number): number {
  if (!timestamp) return 0
  const age = Date.now() - timestamp
  if (age < DAY) return 1
  if (age < 3 * DAY) return 0.7
  if (age < 7 * DAY) return 0.45
  if (age < 30 * DAY) return 0.2
  return 0.05
}

export function MapMode({ projects, onSelect, onClose }: Props) {
  const [width, height] = useWindowSize()
  const [hoveredProjectId, setHoveredProjectId] = useState<string | null>(null)
  const [pinnedProjectId, setPinnedProjectId] = useState<string | null>(null)
  const { statsMap } = useAllProjectStats(projects, true)

  const positions = useMemo(
    () => computePositions(projects, width, height),
    [projects, width, height]
  )

  const connections = useMemo(() => {
    const lines: Array<{ a: string; b: string; color: string }> = []
    for (let i = 0; i < projects.length; i++) {
      for (let j = i + 1; j < projects.length; j++) {
        const pa = projects[i]!
        const pb = projects[j]!
        if (pa.color === pb.color) {
          lines.push({ a: pa.id, b: pb.id, color: pa.color })
        }
      }
    }
    return lines
  }, [projects])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (pinnedProjectId) {
          setPinnedProjectId(null)
        } else {
          onClose()
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, pinnedProjectId])

  const panelProjectId = pinnedProjectId ?? hoveredProjectId
  const panelProject = projects.find((p) => p.id === panelProjectId) ?? null
  const panelStats = panelProject ? statsMap.get(panelProject.id) ?? null : null

  return (
    <div
      className="map-mode"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          if (pinnedProjectId) {
            setPinnedProjectId(null)
          } else {
            onClose()
          }
        }
      }}
    >
      <svg className="map-svg" width={width} height={height}>
        <defs>
          <radialGradient id="mapBgGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(34, 211, 238, 0.04)" />
            <stop offset="100%" stopColor="rgba(0, 0, 0, 0)" />
          </radialGradient>
        </defs>
        <rect width={width} height={height} fill="url(#mapBgGlow)" />

        {connections.map(({ a, b, color }, i) => {
          const pa = positions.get(a)
          const pb = positions.get(b)
          if (!pa || !pb) return null
          const mx = (pa.x + pb.x) / 2
          const my = (pa.y + pb.y) / 2
          const dx = pb.x - pa.x
          const dy = pb.y - pa.y
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          const offset = dist * 0.15
          const perpX = (-dy / dist) * offset
          const perpY = (dx / dist) * offset
          return (
            <path
              key={`conn-${i}`}
              d={`M ${pa.x} ${pa.y} Q ${mx + perpX} ${my + perpY}, ${pb.x} ${pb.y}`}
              stroke={color}
              strokeWidth={1}
              strokeOpacity={0.16}
              fill="none"
            />
          )
        })}

        {/* Activity halos around each project */}
        {projects.map((p) => {
          const pos = positions.get(p.id)
          if (!pos) return null
          const stats = statsMap.get(p.id)
          const intensity = activityIntensity(stats?.lastActivityTimestamp)
          if (intensity < 0.05) return null
          return (
            <g key={`halo-${p.id}`}>
              <circle
                cx={pos.x}
                cy={pos.y}
                r={88}
                fill="none"
                stroke={p.color}
                strokeWidth={1}
                strokeOpacity={intensity * 0.5}
              />
              <circle
                cx={pos.x}
                cy={pos.y}
                r={92}
                fill="none"
                stroke={p.color}
                strokeWidth={0.5}
                strokeOpacity={intensity * 0.25}
              />
            </g>
          )
        })}
      </svg>

      {projects.map((p, i) => {
        const pos = positions.get(p.id)
        if (!pos) return null
        const stats = statsMap.get(p.id)
        const recency = stats?.lastActivityTimestamp
        const recencyLabel = recency ? formatShort(Date.now() - recency) : '—'
        const isHighlighted = panelProjectId === p.id
        const branch = stats?.git?.branch
        const dirty = stats?.git?.hasUncommittedChanges
        const ahead = stats?.git?.ahead ?? 0
        const behind = stats?.git?.behind ?? 0
        return (
          <button
            key={p.id}
            type="button"
            className={`map-node${isHighlighted ? ' hovered' : ''}`}
            style={{
              left: pos.x - 70,
              top: pos.y - 70,
              animationDelay: `${i * 40}ms`
            }}
            onClick={(e) => {
              e.stopPropagation()
              if (e.metaKey || e.shiftKey) {
                setPinnedProjectId(p.id)
              } else {
                onSelect(p)
              }
            }}
            onMouseEnter={() => setHoveredProjectId(p.id)}
            onMouseLeave={() => setHoveredProjectId(null)}
          >
            <div className="map-node-sigil">
              <Sigil name={p.name} color={p.color} size={140} />
            </div>
            <span
              className="map-node-name"
              style={{ color: p.color, textShadow: `0 0 12px ${p.color}88` }}
            >
              {p.name}
            </span>
            <div className="map-node-meta">
              <span className="map-node-recency">{recencyLabel}</span>
              {branch && <span className="map-node-branch">{branch}</span>}
              {dirty && (
                <span className="map-node-dirty" title="Uncommitted changes">
                  ●
                </span>
              )}
              {ahead > 0 && <span className="map-node-ahead">↑{ahead}</span>}
              {behind > 0 && <span className="map-node-behind">↓{behind}</span>}
            </div>
          </button>
        )
      })}

      {panelProject && (
        <MapHoverPanel
          project={panelProject}
          stats={panelStats}
          pinned={!!pinnedProjectId}
          onOpen={() => onSelect(panelProject)}
          onOpenInFinder={() => window.api.shell.openPath(panelProject.path)}
          onCopyPath={() => window.api.clipboard.writeText(panelProject.path)}
          onClose={() => setPinnedProjectId(null)}
        />
      )}

      <div className="map-help">
        ESC TO CLOSE · HOVER FOR DETAILS · CLICK TO OPEN · ⌘CLICK TO PIN PANEL
      </div>
    </div>
  )
}
