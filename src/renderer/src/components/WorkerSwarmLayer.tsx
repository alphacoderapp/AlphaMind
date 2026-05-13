import { useEffect, useRef, useState, type RefObject } from 'react'

interface WorkerActivity {
  status: 'queued' | 'start' | 'tick' | 'done' | 'timeout'
  elapsedMs: number
  snippet: string
  updatedAt: number
}

interface Props {
  areaRef: RefObject<HTMLDivElement | null>
  activity: Map<string, WorkerActivity>
  ulmTabIds: string[]
}

// Number of "anchor" particles per active stream direction. Each anchor is
// itself a loose particle cloud (CLUSTER_SIZE scattered satellites) — reads
// as a sparse flock-of-flocks rather than tight clumps. With mode='both'
// (active two-way comm) you get 2× anchors, interleaved by phase offset
// for a duplex-cable feel.
const PARTICLES_PER_STREAM = 9
const CLUSTER_SIZE = 7
// Radius of the cluster scatter in pixels — bigger = looser flock. Tightened
// version felt too "robotic"; loose feels like the reference particle cloud.
const CLUSTER_RADIUS = 14

interface Endpoint {
  x: number
  y: number
}

type StreamMode = 'forward' | 'reverse' | 'both'

interface Stream {
  tabId: string
  // Bottom-edge-centre of the cell frame (in area-local coords).
  cellAnchor: Endpoint
  // Top-edge-centre of the master pane (in area-local coords). Always above
  // the cells in our layout, but we still compute per frame to handle resize.
  masterAnchor: Endpoint
  // 'forward' = master→worker (sending), 'reverse' = worker→master (output
  // coming back), 'both' = active two-way communication (most of an active
  // dispatch lives here — master polling + worker streaming).
  mode: StreamMode
}

export function WorkerSwarmLayer({ areaRef, activity, ulmTabIds }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })

  // Track per-tab "currently animating" + when state last changed. Active
  // iff a recent activity event exists AND it isn't a stale done/timeout.
  // Mode tracks whether to draw forward / reverse / both directions of
  // particles — the stream stays alive for the entire dispatch lifecycle so
  // the user sees continuous activity while a worker is busy, not just a
  // brief flash at start.
  interface StreamState {
    mode: StreamMode
    enteredAt: number
    expiresAt: number
  }
  const streamsRef = useRef<Map<string, StreamState>>(new Map())

  // Keep size in sync with the area for SVG viewBox.
  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    const update = (): void => {
      const r = el.getBoundingClientRect()
      setSize({ w: r.width, h: r.height })
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [areaRef])

  // Update stream state from activity events. The stream lives for the
  // entire dispatch lifecycle (queued → start → tick(s) → done) so the user
  // sees continuous flow while a worker is busy. Mode shifts based on what's
  // happening at each phase.
  useEffect(() => {
    const now = Date.now()
    activity.forEach((a, tabId) => {
      if (!ulmTabIds.includes(tabId)) return
      const cur = streamsRef.current.get(tabId)
      let mode: StreamMode = cur?.mode ?? 'forward'
      let expiresAt = cur?.expiresAt ?? now + 30000

      if (a.status === 'queued' || a.status === 'start') {
        // Master is initiating / queued — pure forward burst (visually the
        // command flying up to the worker).
        mode = 'forward'
        expiresAt = now + 30000
      } else if (a.status === 'tick') {
        // Active two-way conversation: master is polling + worker is
        // streaming output. Both directions of particles read as a live
        // duplex link.
        mode = 'both'
        expiresAt = now + 8000
      } else if (a.status === 'done') {
        // Final burst of output coming home. Keep the stream alive briefly
        // so the user sees the closing arc.
        mode = 'reverse'
        expiresAt = now + 1500
      } else if (a.status === 'timeout') {
        mode = 'reverse'
        expiresAt = now + 1500
      }

      streamsRef.current.set(tabId, {
        mode,
        enteredAt: cur?.enteredAt ?? now,
        expiresAt
      })
    })
    // Drop streams for tabs that no longer exist in activity.
    streamsRef.current.forEach((_, tabId) => {
      if (!activity.has(tabId)) streamsRef.current.delete(tabId)
    })
  }, [activity, ulmTabIds])

  // Animation loop: only runs while ≥1 stream is active. Each frame we
  // recompute endpoints (cells may move on resize/hover) and animate
  // particles along the bezier.
  useEffect(() => {
    let mounted = true

    const tick = (): void => {
      if (!mounted) return
      const now = Date.now()
      const states = streamsRef.current
      // Drop expired entries.
      states.forEach((s, tabId) => {
        if (now > s.expiresAt) states.delete(tabId)
      })

      const svg = svgRef.current
      const area = areaRef.current
      if (!svg || !area) {
        rafRef.current = requestAnimationFrame(tick)
        return
      }
      const areaRect = area.getBoundingClientRect()

      // Locate master pane top edge (above area in DOM order — master is a
      // sibling below in flex column, so master-top-y in area-local coords
      // equals the area's height + a small margin if we want to enter the
      // master pane). We use the area's own bottom edge as approximation;
      // particles arrive at and depart from that edge. Looks correct because
      // the master pane sits flush below the area.
      const masterY = areaRect.height
      const masterX = areaRect.width / 2

      // Build active streams from current cell frame DOM positions.
      const streams: Stream[] = []
      states.forEach((s, tabId) => {
        const frame = area.querySelector<HTMLElement>(`.ulm-cell-frame[data-tab-id="${tabId}"]`)
        if (!frame) return
        const fr = frame.getBoundingClientRect()
        const cx = fr.left - areaRect.left + fr.width / 2
        const cy = fr.top - areaRect.top + fr.height
        streams.push({
          tabId,
          cellAnchor: { x: cx, y: cy },
          masterAnchor: { x: masterX, y: masterY },
          mode: s.mode
        })
      })

      // Render: clear existing children, redraw paths + particles.
      while (svg.firstChild) svg.removeChild(svg.firstChild)
      if (streams.length > 0) {
        const ns = 'http://www.w3.org/2000/svg'
        // Defs with glow filter once per render.
        const defs = document.createElementNS(ns, 'defs')
        const filter = document.createElementNS(ns, 'filter')
        filter.setAttribute('id', 'swarm-glow')
        filter.setAttribute('x', '-50%')
        filter.setAttribute('y', '-50%')
        filter.setAttribute('width', '200%')
        filter.setAttribute('height', '200%')
        const blur = document.createElementNS(ns, 'feGaussianBlur')
        blur.setAttribute('stdDeviation', '2.4')
        blur.setAttribute('result', 'b')
        filter.appendChild(blur)
        const merge = document.createElementNS(ns, 'feMerge')
        const m1 = document.createElementNS(ns, 'feMergeNode')
        m1.setAttribute('in', 'b')
        const m2 = document.createElementNS(ns, 'feMergeNode')
        m2.setAttribute('in', 'SourceGraphic')
        merge.appendChild(m1)
        merge.appendChild(m2)
        filter.appendChild(merge)
        defs.appendChild(filter)
        svg.appendChild(defs)

        const drawDirection = (
          fromPt: Endpoint,
          toPt: Endpoint,
          phaseOffset: number
        ): void => {
          const dy = toPt.y - fromPt.y
          const c1x = fromPt.x
          const c1y = fromPt.y + dy * 0.35
          const c2x = toPt.x
          const c2y = toPt.y - dy * 0.35

          // Faint guide line for visual cohesion.
          const guide = document.createElementNS(ns, 'path')
          guide.setAttribute(
            'd',
            `M${fromPt.x},${fromPt.y} C${c1x},${c1y} ${c2x},${c2y} ${toPt.x},${toPt.y}`
          )
          guide.setAttribute('fill', 'none')
          guide.setAttribute('stroke', 'rgba(56, 189, 248, 0.18)')
          guide.setAttribute('stroke-width', '1')
          svg.appendChild(guide)

          for (let i = 0; i < PARTICLES_PER_STREAM; i++) {
            const phase = (now / 850 + i / PARTICLES_PER_STREAM + phaseOffset) % 1
            const t = phase
            const oneMt = 1 - t
            const ax =
              oneMt * oneMt * oneMt * fromPt.x +
              3 * oneMt * oneMt * t * c1x +
              3 * oneMt * t * t * c2x +
              t * t * t * toPt.x
            const ay =
              oneMt * oneMt * oneMt * fromPt.y +
              3 * oneMt * oneMt * t * c1y +
              3 * oneMt * t * t * c2y +
              t * t * t * toPt.y

            const fade = Math.sin(t * Math.PI)

            // Each anchor scatters into a loose particle cloud of
            // CLUSTER_SIZE satellites with independent phases — reads as a
            // drifting flock, not a rigid ring. Some satellites wander
            // farther out for a sparse "particles falling out of the
            // current" feel.
            for (let j = 0; j < CLUSTER_SIZE; j++) {
              const wobblePhase = now / 280 + i * 1.7 + j * 2.31
              // Each satellite has its own characteristic drift radius —
              // some hug the anchor tightly, some wander far. Combined with
              // phase difference this looks scattered rather than circular.
              const baseR = 0.25 + ((j * 0.1379) % 1) * 0.95
              const wobbleR =
                CLUSTER_RADIUS *
                (0.45 + 0.55 * fade) *
                baseR *
                (0.65 + 0.45 * Math.sin(wobblePhase * 0.6 + j * 1.1))
              const wobbleAngle = wobblePhase * (0.6 + ((j * 0.31) % 0.8)) + j * 2.1
              const ox = Math.cos(wobbleAngle) * wobbleR
              const oy = Math.sin(wobbleAngle * 1.27 + j * 0.7) * wobbleR
              const px = ax + ox
              const py = ay + oy

              // Smaller, sparser dots — no big "ball" anymore, just stardust.
              const radius = 0.55 + fade * 0.85 + (j === 0 ? 0.4 : 0)
              const flicker = 0.55 + 0.45 * Math.sin(wobblePhase * 1.9 + j * 0.4)
              const opacity = (0.16 + fade * 0.55) * (j === 0 ? 1 : flicker)

              const dot = document.createElementNS(ns, 'circle')
              dot.setAttribute('cx', px.toFixed(2))
              dot.setAttribute('cy', py.toFixed(2))
              dot.setAttribute('r', radius.toFixed(2))
              dot.setAttribute('fill', '#7dd3fc')
              dot.setAttribute('opacity', opacity.toFixed(2))
              dot.setAttribute('filter', 'url(#swarm-glow)')
              svg.appendChild(dot)

              if (j === 0) {
                const core = document.createElementNS(ns, 'circle')
                core.setAttribute('cx', px.toFixed(2))
                core.setAttribute('cy', py.toFixed(2))
                core.setAttribute('r', (radius * 0.42).toFixed(2))
                core.setAttribute('fill', '#ffffff')
                core.setAttribute('opacity', (opacity * 0.85).toFixed(2))
                svg.appendChild(core)
              }
            }
          }
        }

        for (const s of streams) {
          const drawForward = s.mode === 'forward' || s.mode === 'both'
          const drawReverse = s.mode === 'reverse' || s.mode === 'both'
          if (drawForward) drawDirection(s.masterAnchor, s.cellAnchor, 0)
          // Reverse uses a half-period phase offset so the two streams don't
          // sit on top of each other when 'both' is active — they interleave
          // visually like a duplex cable instead of overlapping into one.
          if (drawReverse) drawDirection(s.cellAnchor, s.masterAnchor, 0.5)
        }
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => {
      mounted = false
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [areaRef])

  return (
    <svg
      ref={svgRef}
      className="ulm-swarm-layer"
      width={size.w}
      height={size.h}
      viewBox={`0 0 ${size.w} ${size.h}`}
      aria-hidden="true"
    />
  )
}
