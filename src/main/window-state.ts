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

const STORE_DIR = join(app.getPath('home'), '.simple-claude')
const FILE = join(STORE_DIR, 'window.json')

export async function loadWindowBounds(): Promise<WindowBounds | null> {
  if (!existsSync(FILE)) return null
  try {
    const raw = await readFile(FILE, 'utf-8')
    const parsed = JSON.parse(raw)
    if (typeof parsed.width === 'number' && typeof parsed.height === 'number') {
      return parsed
    }
  } catch {
    /* noop */
  }
  return null
}

let saveTimer: NodeJS.Timeout | null = null

export function attachWindowState(win: BrowserWindow): void {
  const save = () => {
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
