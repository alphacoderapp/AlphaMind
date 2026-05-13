import { app, BrowserWindow } from 'electron'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'

interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
}

const STORE_DIR = join(app.getPath('home'), '.alphacod')
const FILE = join(STORE_DIR, 'window.json')

const MIN_RESTORE_W = 880
const MIN_RESTORE_H = 540

export async function loadWindowBounds(): Promise<WindowBounds | null> {
  if (!existsSync(FILE)) return null
  try {
    const raw = await readFile(FILE, 'utf-8')
    const parsed = JSON.parse(raw)
    if (typeof parsed.width === 'number' && typeof parsed.height === 'number') {
      // Defensively reject undersized bounds — these can happen if the app
      // was last closed while in Mini Mode and the pause flag wasn't set
      // (older builds). Falling back to defaults is much better than
      // launching into a stuck tiny window.
      if (parsed.width < MIN_RESTORE_W || parsed.height < MIN_RESTORE_H) {
        return null
      }
      return parsed
    }
  } catch {
    /* noop */
  }
  return null
}

let saveTimer: NodeJS.Timeout | null = null
let savePaused = false

export function setWindowStateSavePaused(paused: boolean): void {
  savePaused = paused
}

export function attachWindowState(win: BrowserWindow): void {
  const save = () => {
    if (savePaused) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(async () => {
      if (win.isDestroyed()) return
      const bounds = win.getBounds()
      try {
        if (!existsSync(STORE_DIR)) await mkdir(STORE_DIR, { recursive: true })
        await writeFile(FILE, JSON.stringify(bounds, null, 2), 'utf-8')
      } catch (e) {
        console.error('Save window state failed:', e)
      }
    }, 500)
  }

  win.on('resize', save)
  win.on('move', save)
  win.on('close', save)
}
