import { app } from 'electron'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import { archiveBulk } from './master-archive-store'

export interface StoredMasterMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
}

export interface StoredMasterHistory {
  messages: StoredMasterMessage[]
  updatedAt: number
}

const STORE_DIR = join(app.getPath('home'), '.alphacod')
const HISTORY_FILE = join(STORE_DIR, 'master-history.json')
const MAX_MESSAGES = 200

export async function loadMasterHistory(): Promise<StoredMasterHistory | null> {
  if (!existsSync(HISTORY_FILE)) return null
  try {
    const raw = await readFile(HISTORY_FILE, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && Array.isArray(parsed.messages)) {
      return {
        messages: parsed.messages.slice(-MAX_MESSAGES),
        updatedAt: parsed.updatedAt ?? 0
      }
    }
    return null
  } catch {
    return null
  }
}

export async function saveMasterHistory(messages: StoredMasterMessage[]): Promise<void> {
  if (!existsSync(STORE_DIR)) {
    await mkdir(STORE_DIR, { recursive: true })
  }
  const trimmed = messages.slice(-MAX_MESSAGES)
  const payload: StoredMasterHistory = {
    messages: trimmed,
    updatedAt: Date.now()
  }
  await writeFile(HISTORY_FILE, JSON.stringify(payload, null, 2), 'utf-8')

  // Append any new messages to the long-term archive (idempotent on id).
  // Embedding generation happens here. Don't await — let it stream in the
  // background so saveHistory stays snappy. Errors swallow at the archive
  // layer; the working memory snapshot is already on disk.
  void archiveBulk(messages).catch((e) => {
    console.error('archive bulk failed (non-fatal):', e)
  })
}
