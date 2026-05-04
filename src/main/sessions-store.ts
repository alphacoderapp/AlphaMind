import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export interface ClaudeSession {
  id: string
  firstMessage: string
  lastTimestamp: number
  messageCount: number
}

interface HistoryEntry {
  display: string
  timestamp: number
  project: string
  sessionId: string
}

const HISTORY_FILE = join(homedir(), '.claude', 'history.jsonl')

function truncate(s: string, max: number): string {
  const trimmed = s.trim().replace(/\s+/g, ' ')
  return trimmed.length > max ? trimmed.slice(0, max) + '...' : trimmed
}

export async function listSessions(projectPath: string, limit = 30): Promise<ClaudeSession[]> {
  if (!existsSync(HISTORY_FILE)) return []

  const raw = await readFile(HISTORY_FILE, 'utf-8')
  const lines = raw.split('\n')

  interface Acc {
    first: string
    firstTs: number
    lastTs: number
    count: number
  }
  const sessions = new Map<string, Acc>()

  for (const line of lines) {
    if (!line) continue
    let entry: HistoryEntry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.project !== projectPath) continue
    if (!entry.sessionId) continue
    if (typeof entry.display !== 'string') continue
    if (typeof entry.timestamp !== 'number') continue

    const existing = sessions.get(entry.sessionId)
    if (!existing) {
      sessions.set(entry.sessionId, {
        first: entry.display,
        firstTs: entry.timestamp,
        lastTs: entry.timestamp,
        count: 1
      })
    } else {
      if (entry.timestamp < existing.firstTs) {
        existing.first = entry.display
        existing.firstTs = entry.timestamp
      }
      if (entry.timestamp > existing.lastTs) {
        existing.lastTs = entry.timestamp
      }
      existing.count++
    }
  }

  const result: ClaudeSession[] = Array.from(sessions.entries()).map(([id, data]) => ({
    id,
    firstMessage: truncate(data.first, 80),
    lastTimestamp: data.lastTs,
    messageCount: data.count
  }))

  result.sort((a, b) => b.lastTimestamp - a.lastTimestamp)
  return result.slice(0, limit)
}
