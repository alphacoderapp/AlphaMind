import { useEffect, useId, useMemo, useRef } from 'react'

type OrbMode = 'idle' | 'thinking' | 'speaking'

interface Props {
  /** Continuous intensity 0..1 driving rotation, breath, glow, pulse.
   *  0 = calm idle drift, 0.3 = light thinking, 0.6 = active streaming,
   *  1 = peak (fast tools + many workers + fast token stream). */
  intensity?: number
  /** Legacy 3-state mode — translated to intensity if provided and intensity is not. */
  mode?: OrbMode
  /** Legacy bool — true=thinking, false=idle. Ignored if intensity/mode set. */
  thinking?: boolean
  size?: number
  /** Hex colour for the particle fill. Defaults to cyan (master tone). */
  accent?: string
  /** Optional explicit count. If omitted we derive a count from size so
   *  smaller orbs stay readable + cheap to render. */
  particleCount?: number
}

const DEFAULT_SIZE = 40
// Per-particle rendering produces a volumetric particle cloud (no outline,
// no boundary sphere — just lots of tiny lights at varying depth). Idle
// rotates slowly with gentle drift; thinking spins up rotation, increases
// internal flow, and brightens.

interface Particle {
  phi: number
  theta: number
  r: number
  driftSpeed: number
  driftPhase: number
  baseSize: number
}

function generateParticles(count: number): Particle[] {
  const out: Particle[] = []
  for (let i = 0; i < count; i++) {
    // Uniform distribution on a sphere (Marsaglia-ish) gives a less polar
    // -clustered look than naïve random angles.
    const u = Math.random() * 2 - 1
    const phi = Math.random() * Math.PI * 2
    const theta = Math.acos(u)
    out.push({
      phi,
      theta,
      // Particles aren't all on the surface — small radial scatter gives a
      // volumetric impression rather than a hollow shell.
      r: 0.55 + Math.random() * 0.45,
      driftSpeed: 0.5 + Math.random() * 1.4,
      driftPhase: Math.random() * Math.PI * 2,
      baseSize: 0.35 + Math.random() * 0.65
    })
  }
  return out
}

export function MasterThinkOrb({
  intensity,
  mode,
  thinking = false,
  size = DEFAULT_SIZE,
  accent = '#7dd3fc',
  particleCount
}: Props) {
  // Resolve a target intensity 0..1 from whichever prop the caller used.
  const targetIntensity = (() => {
    if (typeof intensity === 'number') return Math.min(1, Math.max(0, intensity))
    if (mode === 'speaking') return 0.85
    if (mode === 'thinking') return 0.55
    if (mode === 'idle') return 0
    return thinking ? 0.55 : 0
  })()
  const svgRef = useRef<SVGSVGElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const count = particleCount ?? Math.max(6, Math.round((size * size) / 18))
  const particles = useMemo(() => generateParticles(count), [count])
  // Smoothed intensity: target updates discretely (every 80-200ms) but the
  // rendered value glides toward it each frame so changes look organic, not
  // stepped. tau ≈ 250ms feels like a heartbeat catching up.
  const targetRef = useRef<number>(targetIntensity)
  targetRef.current = targetIntensity
  const smoothedRef = useRef<number>(targetIntensity)
  // Filter id must be unique across the document so multiple orbs each
  // reference their own glow filter, not the first one rendered.
  const filterId = `orb-glow-${useId().replace(/:/g, '_')}`

  useEffect(() => {
    let mounted = true
    const ns = 'http://www.w3.org/2000/svg'

    const tick = (): void => {
      if (!mounted) return
      const svg = svgRef.current
      if (!svg) {
        rafRef.current = requestAnimationFrame(tick)
        return
      }
      while (svg.firstChild) svg.removeChild(svg.firstChild)

      // Defs with glow filter (one per render — cheap enough at this size).
      const defs = document.createElementNS(ns, 'defs')
      const filter = document.createElementNS(ns, 'filter')
      filter.setAttribute('id', filterId)
      filter.setAttribute('x', '-50%')
      filter.setAttribute('y', '-50%')
      filter.setAttribute('width', '200%')
      filter.setAttribute('height', '200%')
      const blur = document.createElementNS(ns, 'feGaussianBlur')
      // Glow blur scales with the orb's size — at the master's 40px the
      // ~0.9 stddev reads as a soft halo, but at 8-10px it would balloon
      // each particle into a fuzzy blob bigger than the orb itself. Tying
      // it to size keeps proportions consistent.
      const blurAmount = Math.max(0.25, size / 44)
      blur.setAttribute('stdDeviation', blurAmount.toFixed(2))
      filter.appendChild(blur)
      defs.appendChild(filter)
      svg.appendChild(defs)

      const t = performance.now() / 1000
      // Frame-rate-independent exponential smoothing toward target intensity.
      // dt clamped so a hidden tab → visible jump doesn't cause a snap.
      const dt = Math.min(0.1, 1 / 60)
      const tau = 0.25
      const alpha = 1 - Math.exp(-dt / tau)
      smoothedRef.current += (targetRef.current - smoothedRef.current) * alpha
      const I = smoothedRef.current
      // Map intensity 0..1 to all visual parameters (continuous):
      const rotSpeed = 0.18 + I * 0.55
      const rot = t * rotSpeed
      const tiltAmp = 0.12 + I * 0.25
      const tiltFreq = 0.18 + I * 0.4
      const tilt = Math.sin(t * tiltFreq) * tiltAmp
      // Pulse: silent at low I, full speech-like wave at high I.
      const pulseAmp = Math.max(0, (I - 0.3) / 0.7) // 0 below 0.3, 1 at 1.0
      const speakPulse = Math.sin(t * (4 + I * 3)) * pulseAmp

      const cx = size / 2
      const cy = size / 2
      // Keep particles well inside the bounding box so a small orb stays a
      // tight cluster rather than a wide nebula leaking past its declared
      // pixel size.
      const maxR = size * 0.42

      for (const p of particles) {
        // Phi rotates over time; theta drifts gently. When thinking, drift
        // amplitude grows so particles wobble more.
        const driftAmp = thinking ? 0.18 : 0.05
        const phi = p.phi + rot
        const theta = p.theta + Math.sin(t * p.driftSpeed + p.driftPhase) * driftAmp

        // Spherical → cartesian, then a slight axis tilt for organic feel.
        let x = Math.sin(theta) * Math.cos(phi)
        let y = Math.cos(theta)
        let z = Math.sin(theta) * Math.sin(phi)
        // Tilt around X axis: y' = y*cos - z*sin, z' = y*sin + z*cos
        const ct = Math.cos(tilt)
        const st = Math.sin(tilt)
        const y2 = y * ct - z * st
        const z2 = y * st + z * ct
        y = y2
        z = z2

        // Per-particle breathing — frequency + amplitude both grow with intensity.
        const breathFreq = 0.55 + I * 0.9
        const breathAmp = 0.025 + I * 0.05
        const breath = 1 + Math.sin(t * breathFreq + p.driftPhase) * breathAmp
        // Coherent radial pulse rides on top — at high intensity all particles
        // flex outward together like a voice waveform. Phase by depth so it
        // looks 3D, not flat scale.
        const speakRadial = 1 + speakPulse * 0.18 * (0.6 + p.r * 0.4)
        const radial = p.r * breath * speakRadial
        const sx = cx + x * radial * maxR
        const sy = cy + y * radial * maxR

        // Depth (z in [-1, 1]): front = 1, back = -1. Particles at the back
        // are smaller + dimmer, particles in front bigger + brighter — the
        // orthographic projection plus this depth cue gives 3D feel without
        // a boundary outline.
        const depth = (z + 1) / 2
        const sizeMul = 0.95 + I * 0.2 + speakPulse * 0.12
        // Scale particle size with the orb's overall size — small orbs need
        // proportionally smaller dots so they don't blob into a single fuzzy
        // ball at 12-14px diameter.
        const sizeScale = size / DEFAULT_SIZE
        const dotSize = p.baseSize * (0.55 + depth * 0.95) * sizeMul * Math.max(0.5, sizeScale)
        const baseOpacity = 0.18 + depth * 0.7
        const flickerFreq = 1.6 + I * 4.5
        const flickerAmp = 0.08 + I * 0.12
        const flicker = 1 - flickerAmp + flickerAmp * Math.sin(t * flickerFreq + p.driftPhase * (1 + I * 2))
        const opacity = Math.min(1, baseOpacity * flicker)

        const dot = document.createElementNS(ns, 'circle')
        dot.setAttribute('cx', sx.toFixed(2))
        dot.setAttribute('cy', sy.toFixed(2))
        dot.setAttribute('r', dotSize.toFixed(2))
        dot.setAttribute('fill', accent)
        dot.setAttribute('opacity', opacity.toFixed(2))
        dot.setAttribute('filter', `url(#${filterId})`)
        svg.appendChild(dot)

        if (depth > 0.75) {
          const core = document.createElementNS(ns, 'circle')
          core.setAttribute('cx', sx.toFixed(2))
          core.setAttribute('cy', sy.toFixed(2))
          core.setAttribute('r', (dotSize * 0.42).toFixed(2))
          core.setAttribute('fill', '#ffffff')
          core.setAttribute('opacity', (opacity * 0.85).toFixed(2))
          svg.appendChild(core)
        }
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => {
      mounted = false
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [particles, accent, size, filterId])

  return (
    <svg
      ref={svgRef}
      className={`master-think-orb${targetIntensity > 0.15 ? ' master-think-orb-active' : ''}${targetIntensity > 0.6 ? ' master-think-orb-speaking' : ''}`}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
    />
  )
}
