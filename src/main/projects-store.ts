import { app } from 'electron'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'

export interface StoredProject {
  id: string
  name: string
  color: string
  path: string
  category?: string
}

const STORE_DIR = join(app.getPath('home'), '.simple-claude')
const STORE_FILE = join(STORE_DIR, 'projects.json')

export async function loadProjects(): Promise<StoredProject[] | null> {
  if (!existsSync(STORE_FILE)) return null
  try {
    const raw = await readFile(STORE_FILE, 'utf-8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed
    return null
  } catch {
    return null
  }
}

export async function saveProjects(projects: StoredProject[]): Promise<void> {
  if (!existsSync(STORE_DIR)) {
    await mkdir(STORE_DIR, { recursive: true })
  }
  await writeFile(STORE_FILE, JSON.stringify(projects, null, 2), 'utf-8')
}
