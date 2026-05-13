// Alphacod app icon generator. The brand mark itself is a 3D-rendered
// α-fish ribbon (provided by the user as alphacod_logo_icon.png). This
// script wraps that mark on a charcoal radial-gradient background to
// produce the square app icon, and emits a small transparent version for
// the in-app titlebar.

import sharp from 'sharp'
import { mkdir, writeFile, copyFile } from 'fs/promises'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const RESOURCES_DIR = './resources'
const RENDERER_ASSETS_DIR = './src/renderer/src/assets'
const SOURCE_LOGO = join(homedir(), 'Downloads', 'alphacod_logo_icon.png')

function bgSvg(canvas, tile, cornerRadius) {
  // macOS app-icon spec: 1024 canvas with a 824 tile centered (100px
  // transparent margin all sides). Apps that ship without that margin
  // (filling the full 1024) read as visibly larger than neighbours in the
  // dock, even when the logo inside is small.
  // Cool light tile: top-down white→paper→cool-grey gradient (same palette
  // the app's light theme uses), plus a soft top highlight band for the
  // "lit from above" 3D feel and a thin cool hairline at the inset edge to
  // define the shape against a light dock backdrop.
  const offset = (canvas - tile) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${canvas}" viewBox="0 0 ${canvas} ${canvas}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#ffffff" />
        <stop offset="50%" stop-color="#f9f9f9" />
        <stop offset="100%" stop-color="#d2d2d2" />
      </linearGradient>
      <linearGradient id="topHighlight" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgba(255,255,255,0.85)" />
        <stop offset="100%" stop-color="rgba(255,255,255,0)" />
      </linearGradient>
    </defs>
    <rect x="${offset}" y="${offset}" width="${tile}" height="${tile}" rx="${cornerRadius}" ry="${cornerRadius}" fill="url(#bg)" />
    <rect x="${offset}" y="${offset}" width="${tile}" height="${Math.round(tile * 0.45)}" rx="${cornerRadius}" ry="${cornerRadius}" fill="url(#topHighlight)" />
    <rect x="${offset + 3}" y="${offset + 3}" width="${tile - 6}" height="${tile - 6}" rx="${cornerRadius - 3}" ry="${cornerRadius - 3}" fill="none" stroke="rgba(0,0,0,0.10)" stroke-width="1.5" />
  </svg>`
}

async function buildAppIcon() {
  const canvas = 1024
  const tile = 824 // Apple's macOS icon tile size; rest is transparent margin.
  const cornerRadius = Math.round(tile * 0.2237)
  const bg = await sharp(Buffer.from(bgSvg(canvas, tile, cornerRadius))).png().toBuffer()

  // Logo at ~58% of TILE width (not canvas) so padding inside the tile
  // matches neighbouring apps that reserve ~20% around their primary mark.
  const logoTargetW = Math.round(tile * 0.58)
  const logo = await sharp(SOURCE_LOGO).resize({ width: logoTargetW, fit: 'inside' }).toBuffer()
  const logoMeta = await sharp(logo).metadata()
  const left = Math.round((canvas - (logoMeta.width || 0)) / 2)
  // Nudge ~3% upward of tile center — optical centering for landscape mark.
  const top = Math.round((canvas - (logoMeta.height || 0)) / 2 - tile * 0.03)

  await sharp(bg)
    .composite([{ input: logo, left, top }])
    .png()
    .toFile(`${RESOURCES_DIR}/icon.png`)

  // 512 variant for downstream tooling
  await sharp(`${RESOURCES_DIR}/icon.png`).resize(512, 512).png().toFile(`${RESOURCES_DIR}/icon@512.png`)
}

async function buildTitlebarLogo() {
  if (!existsSync(RENDERER_ASSETS_DIR)) {
    await mkdir(RENDERER_ASSETS_DIR, { recursive: true })
  }
  // Transparent, retina-sharp at 64px tall (rendered down to 16-24px in UI).
  await sharp(SOURCE_LOGO)
    .resize({ height: 64, fit: 'inside' })
    .png()
    .toFile(`${RENDERER_ASSETS_DIR}/alphacod-logo.png`)
}

async function main() {
  if (!existsSync(SOURCE_LOGO)) {
    console.error(`Source logo not found: ${SOURCE_LOGO}`)
    process.exit(1)
  }
  if (!existsSync(RESOURCES_DIR)) {
    await mkdir(RESOURCES_DIR, { recursive: true })
  }
  await buildAppIcon()
  await buildTitlebarLogo()
  console.log('✓ Generated app icon (1024 + 512 PNG) and titlebar logo (transparent 64px)')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
