import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type { Tab } from '../types'
import { TerminalTab, type TabViewMode, type UlmLayout } from './TerminalTab'
import { WorkerSwarmLayer } from './WorkerSwarmLayer'

interface WorkerActivity {
  status: 'queued' | 'start' | 'tick' | 'done' | 'timeout'
  elapsedMs: number
  snippet: string
  updatedAt: number
}

interface Props {
  tabs: Tab[]
  activeTabId: string | null
  ultimateModeProjectId: string | null
  onActivateTab: (tabId: string) => void
  swarmTargetTabId: string | null
  viewModes: Map<string, TabViewMode>
  onViewModeChange: (tabId: string, mode: TabViewMode) => void
  onRestart: (tabId: string) => void
  onRepath: (tabId: string) => void
  onRemoveProject: (projectId: string) => void
}

// ULM grid layout: every worker tab in the active ULM project is a live
// mini-window in a grid filling the terminal area. Hover one → it grows to
// ~88% of the area, anchored at its original slot centre (clamped to area
// bounds) so the cursor stays inside the cell as it grows — otherwise the
// cell jumps to area-centre and triggers a hover/leave flicker loop.
const GRID_GAP = 14
const GRID_PADDING = 18
// Hard caps so idle cells stay compact ("mini-aknakesed", not robotic
// full-stage walls). The grid centres within the area when natural slot
// size exceeds these caps.
const CELL_MAX_W_PCT = 0.5
const CELL_MAX_H_PCT = 0.5
const HOVER_GROW_W_PCT = 0.55
const HOVER_GROW_H_PCT = 0.55
const HOVER_PROMOTE_MS = 80
const HOVER_DEMOTE_MS = 140

// Three across by default — feels less robotic than 2×2 / 4×N grids and
// matches the user's mental model ("kõrvuti, pigem kolmekesi"). Wraps as
// needed: 4 → 3+1, 5 → 3+2, 6 → 3+3, etc.
function pickCols(count: number): number {
  if (count <= 1) return 1
  if (count === 2) return 2
  return 3
}

interface Slot {
  x: number
  y: number
  w: number
  h: number
}

function computeSlots(count: number, areaW: number, areaH: number): Slot[] {
  if (count === 0) return []
  const cols = pickCols(count)
  const rows = Math.ceil(count / cols)
  const innerW = areaW - GRID_PADDING * 2
  const innerH = areaH - GRID_PADDING * 2
  // Each row gets an equal share, each col an equal share — but we cap at
  // CELL_MAX_W/H so cells stay compact on big screens. Excess space is
  // distributed as gutter, centring the grid horizontally and vertically.
  const naturalW = (innerW - GRID_GAP * (cols - 1)) / cols
  const naturalH = (innerH - GRID_GAP * (rows - 1)) / rows
  const slotW = Math.min(naturalW, areaW * CELL_MAX_W_PCT)
  const slotH = Math.min(naturalH, areaH * CELL_MAX_H_PCT)
  const totalW = cols * slotW + (cols - 1) * GRID_GAP
  const totalH = rows * slotH + (rows - 1) * GRID_GAP
  const startX = Math.floor((areaW - totalW) / 2)
  const startY = Math.floor((areaH - totalH) / 2)
  const slots: Slot[] = []
  for (let i = 0; i < count; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    slots.push({
      x: startX + col * (slotW + GRID_GAP),
      y: startY + row * (slotH + GRID_GAP),
      w: slotW,
      h: slotH
    })
  }
  return slots
}

function hoveredSlotAnchored(original: Slot, areaW: number, areaH: number): Slot {
  // Grow the slot in place, anchored at the original slot's centre, then
  // clamp to area bounds. This keeps the cursor inside the cell as it grows
  // — otherwise growing to a fixed area centre causes a flicker loop when
  // the cursor lands in the original (now empty) slot location.
  const w = Math.floor(areaW * HOVER_GROW_W_PCT)
  const h = Math.floor(areaH * HOVER_GROW_H_PCT)
  const cx = original.x + original.w / 2
  const cy = original.y + original.h / 2
  let x = Math.floor(cx - w / 2)
  let y = Math.floor(cy - h / 2)
  // Clamp so the grown slot stays fully visible.
  x = Math.max(8, Math.min(areaW - w - 8, x))
  y = Math.max(8, Math.min(areaH - h - 8, y))
  return { x, y, w, h }
}

// Returns the visible rect of the scaled wrapper in the slot — the wrapper's
// natural full-stage size scaled uniformly to fit, so only one dimension
// matches the slot exactly. We position the cell-frame on this rect (not the
// full slot) so there is no empty white space inside the frame.
function fittedRect(slot: Slot, stageW: number, stageH: number): Slot {
  const wrapperW = stageW - 24
  const wrapperH = stageH - 16
  const scale = Math.min(slot.w / wrapperW, slot.h / wrapperH)
  const w = Math.floor(wrapperW * scale)
  const h = Math.floor(wrapperH * scale)
  return {
    x: slot.x + Math.floor((slot.w - w) / 2),
    y: slot.y + Math.floor((slot.h - h) / 2),
    w,
    h
  }
}

export function TerminalArea({
  tabs,
  activeTabId,
  ultimateModeProjectId,
  onActivateTab,
  swarmTargetTabId,
  viewModes,
  onViewModeChange,
  onRestart,
  onRepath,
  onRemoveProject
}: Props) {
  const areaRef = useRef<HTMLDivElement | null>(null)
  // Seed with a sane viewport-derived guess so the first paint already has a
  // usable grid layout. Without this, the initial useLayoutEffect+RO chain
  // sometimes leaves areaSize at 0×0 (flex parent hasn't sized us yet) and
  // every cell scales to 0 → invisible.
  const [areaSize, setAreaSize] = useState<{ w: number; h: number }>(() => {
    if (typeof window === 'undefined') return { w: 1200, h: 600 }
    return {
      w: Math.max(600, window.innerWidth - 280),
      h: Math.max(400, window.innerHeight - 380)
    }
  })
  const [hoveredCellId, setHoveredCellId] = useState<string | null>(null)
  const promoteTimer = useRef<number | null>(null)
  const demoteTimer = useRef<number | null>(null)
  const [activity, setActivity] = useState<Map<string, WorkerActivity>>(new Map())

  // Subscribe to worker activity events for the cell header status line + the
  // swarm animation. Cleared per-tab when a 'done' or 'timeout' fades.
  useEffect(() => {
    const unsub = window.api.master.onWorkerActivity((evt) => {
      const e = evt as { tabId: string; status: WorkerActivity['status']; elapsedMs: number; snippet: string }
      setActivity((prev) => {
        const next = new Map(prev)
        next.set(e.tabId, {
          status: e.status,
          elapsedMs: e.elapsedMs,
          snippet: e.snippet,
          updatedAt: Date.now()
        })
        return next
      })
      if (e.status === 'done' || e.status === 'timeout') {
        window.setTimeout(() => {
          setActivity((prev) => {
            const next = new Map(prev)
            const cur = next.get(e.tabId)
            if (cur && cur.updatedAt <= Date.now() - 2400) next.delete(e.tabId)
            return next
          })
        }, 2500)
      }
    })
    return unsub
  }, [])

  useLayoutEffect(() => {
    const el = areaRef.current
    if (!el) return
    const update = (): void => {
      const r = el.getBoundingClientRect()
      // Ignore degenerate measurements (parent not laid out yet); keep the
      // viewport-derived seed in place until we have real numbers.
      if (r.width < 50 || r.height < 50) return
      setAreaSize({ w: r.width, h: r.height })
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    return () => {
      if (promoteTimer.current !== null) window.clearTimeout(promoteTimer.current)
      if (demoteTimer.current !== null) window.clearTimeout(demoteTimer.current)
    }
  }, [])

  if (tabs.length === 0) {
    return (
      <div className="terminal-area terminal-area-empty">
        <div className="terminal-empty">
          <span className="terminal-empty-title">SELECT A PROJECT</span>
          <span className="terminal-empty-hint">click any project on the left to open a session</span>
        </div>
      </div>
    )
  }

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  const ulmTabs =
    ultimateModeProjectId && activeTab && activeTab.project.id === ultimateModeProjectId
      ? tabs.filter((t) => t.project.id === ultimateModeProjectId)
      : []
  // Single worker = no grid, just fill the stage. Grid kicks in at 2+.
  const ulmGridMode = ulmTabs.length >= 2

  const slots = ulmGridMode ? computeSlots(ulmTabs.length, areaSize.w, areaSize.h) : []

  const onCellHover = (tabId: string): void => {
    if (demoteTimer.current !== null) {
      window.clearTimeout(demoteTimer.current)
      demoteTimer.current = null
    }
    if (promoteTimer.current !== null) window.clearTimeout(promoteTimer.current)
    promoteTimer.current = window.setTimeout(() => {
      setHoveredCellId(tabId)
      onActivateTab(tabId)
    }, HOVER_PROMOTE_MS)
  }
  const onCellUnhover = (): void => {
    if (promoteTimer.current !== null) {
      window.clearTimeout(promoteTimer.current)
      promoteTimer.current = null
    }
    if (demoteTimer.current !== null) window.clearTimeout(demoteTimer.current)
    demoteTimer.current = window.setTimeout(() => {
      setHoveredCellId(null)
    }, HOVER_DEMOTE_MS)
  }

  // The wrapper renders at its natural full-stage size (top:8 left:12
  // width:calc(100%-24) height:calc(100%-16)). We position the visible scaled
  // rect at `visible` (no empty space — the rect is the wrapper's natural
  // aspect fitted into the slot). The cell-frame overlay sits on the same
  // rect so frame and content share the same bounds.
  const buildCellStyle = (visible: Slot, stageW: number, stageH: number): CSSProperties => {
    const wrapperW = stageW - 24
    const scale = visible.w / wrapperW
    const dx = visible.x - 12
    const dy = visible.y - 8
    return {
      transform: `translate(${dx}px, ${dy}px) scale(${scale})`
    }
  }

  // Pre-compute slot info per ULM tab. We track BOTH the natural grid slot
  // (where the cell sits at rest) and the visible rect (slot fitted to the
  // wrapper's aspect, no empty space). Hovered cells use a grown slot
  // anchored at their natural slot's centre — this keeps the cursor inside
  // the cell as it grows so we don't get a hover/leave flicker loop.
  const ulmSlots = new Map<
    string,
    { slot: Slot; visible: Slot; idx: number; isHovered: boolean }
  >()
  if (ulmGridMode) {
    for (let i = 0; i < ulmTabs.length; i++) {
      const t = ulmTabs[i]!
      const natural = slots[i]
      if (!natural) continue
      const isHovered = hoveredCellId === t.id
      const slot = isHovered ? hoveredSlotAnchored(natural, areaSize.w, areaSize.h) : natural
      const visible = fittedRect(slot, areaSize.w, areaSize.h)
      ulmSlots.set(t.id, { slot, visible, idx: i, isHovered })
    }
  }

  const formatStatus = (a: WorkerActivity | undefined): string => {
    if (!a) return 'idle'
    const secs = (a.elapsedMs / 1000).toFixed(1)
    switch (a.status) {
      case 'queued':
        return 'queued'
      case 'start':
        return 'dispatching…'
      case 'tick':
        return `working · ${secs}s`
      case 'done':
        return `done · ${secs}s`
      case 'timeout':
        return `timeout · ${secs}s`
    }
  }

  return (
    <div
      ref={areaRef}
      className={`terminal-area${ulmGridMode ? ' terminal-area-ulm' : ''}${
        ulmGridMode && hoveredCellId ? ' terminal-area-ulm-has-hover' : ''
      }`}
    >
      {tabs.map((tab) => {
        const slotInfo = ulmSlots.get(tab.id)
        let ulmLayout: UlmLayout | undefined
        if (slotInfo) {
          ulmLayout = {
            role: 'cell',
            cellStyle: buildCellStyle(slotInfo.visible, areaSize.w, areaSize.h),
            hovered: slotInfo.isHovered,
            onCellHover: () => onCellHover(tab.id),
            onCellUnhover,
            swarmActive: tab.id === swarmTargetTabId
          }
        }
        return (
          <TerminalTab
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            viewMode={viewModes.get(tab.id) ?? 'chat'}
            onViewModeChange={onViewModeChange}
            onRestart={onRestart}
            onRepath={onRepath}
            onRemoveProject={onRemoveProject}
            ulmLayout={ulmLayout}
          />
        )
      })}

      {/* Decorative cell frames sit on top of each scaled wrapper at the slot
          position — they carry the project header/status (unscaled, readable)
          and the visible border, while the wrapper underneath provides the
          live scaled chat content. The frame is pointer-events: none so the
          wrapper still catches the hover that promotes the cell. */}
      {ulmGridMode &&
        ulmTabs.map((tab) => {
          const info = ulmSlots.get(tab.id)
          if (!info) return null
          const a = activity.get(tab.id)
          const sameProject = ulmTabs.length
          const indexLabel =
            sameProject > 1 ? `${tab.project.name.toUpperCase()} · ${info.idx + 1}` : tab.project.name.toUpperCase()
          return (
            <div
              key={`frame-${tab.id}`}
              className={`ulm-cell-frame${info.isHovered ? ' ulm-cell-frame-hovered' : ''}${
                a && a.status !== 'done' && a.status !== 'timeout' ? ' ulm-cell-frame-active' : ''
              }`}
              style={
                {
                  left: info.visible.x,
                  top: info.visible.y,
                  width: info.visible.w,
                  height: info.visible.h,
                  '--accent': tab.project.color
                } as CSSProperties
              }
              data-tab-id={tab.id}
            >
              <div className="ulm-cell-header">
                <span
                  className="ulm-cell-dot"
                  style={{ background: tab.project.color, boxShadow: `0 0 6px ${tab.project.color}` }}
                />
                <span className="ulm-cell-name">{indexLabel}</span>
                <span className="ulm-cell-status">{formatStatus(a)}</span>
              </div>
            </div>
          )
        })}

      {/* Electric-blue swarm layer — renders animated particle paths between
          the master pane (below) and active worker cells (above) when master
          dispatches/receives output. Idle state: invisible, no rAF. */}
      {ulmGridMode && (
        <WorkerSwarmLayer
          areaRef={areaRef}
          activity={activity}
          ulmTabIds={ulmTabs.map((t) => t.id)}
        />
      )}
    </div>
  )
}
