import type { ReactElement } from 'react'

interface Props {
  name: string
  color?: string
  size?: number
}

function djb2(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) + s.charCodeAt(i)
    h |= 0
  }
  return h >>> 0
}

function mulberry32(seed: number) {
  let s = seed
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function Sigil({ name, color = '#22d3ee', size = 64 }: Props) {
  const seed = djb2(name)
  const rng = mulberry32(seed)

  const symmetry = 4 + Math.floor(rng() * 5)
  const center = size / 2
  const radius = size * 0.42
  const wedgeAngle = (Math.PI * 2) / symmetry

  const motifCount = 3 + Math.floor(rng() * 4)
  const motifs: ReactElement[] = []

  for (let i = 0; i < motifCount; i++) {
    const r = (0.25 + rng() * 0.7) * radius
    const a = rng() * wedgeAngle
    const x = center + r * Math.cos(a)
    const y = center + r * Math.sin(a)
    const t = rng()

    if (t < 0.4) {
      motifs.push(<line key={i} x1={center} y1={center} x2={x} y2={y} />)
    } else if (t < 0.7) {
      motifs.push(<circle key={i} cx={x} cy={y} r={size * 0.025} fill={color} />)
    } else {
      const tr = size * 0.04
      const points = `${x},${y - tr} ${x - tr * 0.866},${y + tr * 0.5} ${x + tr * 0.866},${y + tr * 0.5}`
      motifs.push(<polygon key={i} points={points} />)
    }
  }

  const innerRing = rng() < 0.5
  const centerDot = rng() < 0.7

  const slices: ReactElement[] = []
  for (let i = 0; i < symmetry; i++) {
    slices.push(
      <g key={i} transform={`rotate(${(i * 360) / symmetry} ${center} ${center})`}>
        {motifs}
      </g>
    )
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{
        filter: `drop-shadow(0 0 ${size * 0.06}px ${color}80)`,
        flexShrink: 0
      }}
    >
      <g
        stroke={color}
        strokeWidth={Math.max(0.5, size * 0.012)}
        fill="none"
        opacity={0.92}
        strokeLinecap="round"
      >
        <circle cx={center} cy={center} r={radius} />
        {innerRing && <circle cx={center} cy={center} r={radius * 0.55} />}
        {slices}
        {centerDot && <circle cx={center} cy={center} r={size * 0.03} fill={color} stroke="none" />}
      </g>
    </svg>
  )
}
