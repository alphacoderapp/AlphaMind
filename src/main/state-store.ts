import { app } from 'electron'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'

export interface StoredAppState {
  tabs: { projectId: string; sessionId?: string }[]
  activeIndex: number
  ultimateModeProjectId?: string | null
  projectPreviews?: Record<string, string>
  previewWidth?: number
  previewCollapsed?: boolean
  theme?: 'dark' | 'cream'
}

const STORE_DIR = join(app.getPath('home'), '.alphacod')
const STATE_FILE = join(STORE_DIR, 'state.json')

export async function loadState(): Promise<StoredAppState | null> {
  if (!existsSync(STATE_FILE)) return null
  try {
    const raw = await readFile(STATE_FILE, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && Array.isArray(parsed.tabs)) return parsed
    return null
  } catch {
    return null
  }
}

export async function saveState(state: StoredAppState): Promise<void> {
  if (!existsSync(STORE_DIR)) {
    await mkdir(STORE_DIR, { recursive: true })
  }
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8')
}
