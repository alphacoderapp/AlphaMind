import sharp from 'sharp'
import { mkdir, writeFile } from 'fs/promises'
import { existsSync } from 'fs'

function djb2(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) + s.charCodeAt(i)
    h |= 0
  }
  return h >>> 0
}

function mulberry32(seed) {
  let s = seed
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function generateIconSvg(name, size = 1024, color = '#22d3ee', bg = '#08080b') {
  const seed = djb2(name)
  const rng = mulberry32(seed)

  const symmetry = 6
  const center = size / 2
  const radius = size * 0.34
  const wedgeAngle = (Math.PI * 2) / symmetry

  const motifs = []
  const motifCount = 6 + Math.floor(rng() * 3)

  for (let i = 0; i < motifCount; i++) {
    const r = (0.25 + rng() * 0.7) * radius
    const a = rng() * wedgeAngle
    const x = center + r * Math.cos(a)
    const y = center + r * Math.sin(a)
    const t = rng()

    if (t < 0.4) {
      motifs.push(
        `<line x1="${center}" y1="${center}" x2="${x.toFixed(2)}" y2="${y.toFixed(2)}" />`
      )
    } else if (t < 0.7) {
      motifs.push(
        `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${(size * 0.022).toFixed(2)}" fill="${color}" stroke="none" />`
      )
    } else {
      const tr = size * 0.038
      const x1 = x.toFixed(2)
      const y1 = (y - tr).toFixed(2)
      const x2 = (x - tr * 0.866).toFixed(2)
      const y2 = (y + tr * 0.5).toFixed(2)
      const x3 = (x + tr * 0.866).toFixed(2)
      const y3 = (y + tr * 0.5).toFixed(2)
      motifs.push(`<polygon points="${x1},${y1} ${x2},${y2} ${x3},${y3}" />`)
    }
  }

  const slices = []
  for (let i = 0; i < symmetry; i++) {
    slices.push(
      `<g transform="rotate(${(i * 360) / symmetry} ${center} ${center})">${motifs.join('')}</g>`
    )
  }

  const cornerRadius = size * 0.224

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <radialGradient id="bgGrad" cx="50%" cy="50%" r="60%">
      <stop offset="0%" stop-color="#0d0d12" />
      <stop offset="100%" stop-color="${bg}" />
    </radialGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${cornerRadius}" ry="${cornerRadius}" fill="url(#bgGrad)" />
  <rect x="6" y="6" width="${size - 12}" height="${size - 12}" rx="${cornerRadius - 6}" ry="${cornerRadius - 6}" fill="none" stroke="${color}" stroke-width="2" opacity="0.18" />
  <g stroke="${color}" stroke-width="${(size * 0.022).toFixed(2)}" fill="none" opacity="0.18">
    <circle cx="${center}" cy="${center}" r="${radius.toFixed(2)}" />
    <circle cx="${center}" cy="${center}" r="${(radius * 0.55).toFixed(2)}" />
    ${slices.join('')}
  </g>
  <g stroke="${color}" stroke-width="${(size * 0.008).toFixed(2)}" fill="none" opacity="0.95" stroke-linecap="round">
    <circle cx="${center}" cy="${center}" r="${radius.toFixed(2)}" />
    <circle cx="${center}" cy="${center}" r="${(radius * 0.55).toFixed(2)}" />
    ${slices.join('')}
    <circle cx="${center}" cy="${center}" r="${(size * 0.028).toFixed(2)}" fill="${color}" stroke="none" />
  </g>
</svg>`
}

const RESOURCES_DIR = './resources'

async function main() {
  if (!existsSync(RESOURCES_DIR)) {
    await mkdir(RESOURCES_DIR, { recursive: true })
  }

  const svg = generateIconSvg('Simple Claude', 1024)
  await writeFile(`${RESOURCES_DIR}/icon.svg`, svg)

  await sharp(Buffer.from(svg)).resize(1024, 1024).png().toFile(`${RESOURCES_DIR}/icon.png`)
  await sharp(Buffer.from(svg)).resize(512, 512).png().toFile(`${RESOURCES_DIR}/icon@512.png`)

  console.log('✓ Generated resources/icon.svg, icon.png (1024), icon@512.png')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
