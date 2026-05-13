// Append-only archive of every master conversation message + its embedding.
// Separate from master-history.json (working memory) which caps at 200 messages
// and is a full snapshot. Archive grows forever, gives master long-term recall.
//
// Layout:
//   ~/.alphacod/master-archive.ndjson      — one JSON per line, append-only
//   ~/.alphacod/master-embeddings.bin      — packed Float32 vectors, parallel to ndjson
//   ~/.alphacod/master-archive.index       — index of {id, ts, byteOffset} for fast id lookup
//
// For MVP we keep all three small enough to load fully into memory at startup.
// Linear cosine scan over the embedding array is plenty fast for <100k entries.

import { app } from 'electron'
import { readFile, appendFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { existsSync, statSync } from 'fs'
import { embed, cosineSimilarity, EMBEDDING_DIM } from './embeddings'

const STORE_DIR = join(app.getPath('home'), '.alphacod')
const ARCHIVE_FILE = join(STORE_DIR, 'master-archive.ndjson')
const EMBEDDINGS_FILE = join(STORE_DIR, 'master-embeddings.bin')

export interface ArchiveMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
}

interface InMemoryEntry extends ArchiveMessage {
  embedding: number[]
}

interface SearchHit extends ArchiveMessage {
  score: number
}

let memoryCache: InMemoryEntry[] | null = null
let seenIds: Set<string> | null = null
let loadPromise: Promise<void> | null = null

async function ensureDir(): Promise<void> {
  if (!existsSync(STORE_DIR)) {
    await mkdir(STORE_DIR, { recursive: true })
  }
}

async function loadIntoMemory(): Promise<void> {
  if (memoryCache !== null) return
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    memoryCache = []
    seenIds = new Set()
    if (!existsSync(ARCHIVE_FILE)) return
    const raw = await readFile(ARCHIVE_FILE, 'utf-8')
    const lines = raw.split('\n').filter((l) => l.trim())
    if (lines.length === 0) return

    let embeddingsBuffer: Buffer | null = null
    if (existsSync(EMBEDDINGS_FILE)) {
      embeddingsBuffer = await readFile(EMBEDDINGS_FILE)
    }
    const bytesPerEmbedding = EMBEDDING_DIM * 4 // Float32 = 4 bytes

    for (let i = 0; i < lines.length; i++) {
      try {
        const msg = JSON.parse(lines[i]!) as ArchiveMessage
        let embedding: number[] = []
        if (embeddingsBuffer && embeddingsBuffer.length >= (i + 1) * bytesPerEmbedding) {
          const offset = i * bytesPerEmbedding
          const view = new Float32Array(
            embeddingsBuffer.buffer,
            embeddingsBuffer.byteOffset + offset,
            EMBEDDING_DIM
          )
          embedding = Array.from(view)
        }
        memoryCache!.push({ ...msg, embedding })
        seenIds!.add(msg.id)
      } catch (e) {
        console.error('archive parse failed for line', i, e)
      }
    }
  })()
  return loadPromise
}

// Append a single message to the archive, computing its embedding first.
// Idempotent: if the message id was already archived, no-op.
export async function archiveMessage(msg: ArchiveMessage): Promise<void> {
  await ensureDir()
  await loadIntoMemory()
  if (!memoryCache || !seenIds) return
  if (seenIds.has(msg.id)) return

  let embedding: number[]
  try {
    embedding = await embed(msg.content)
  } catch (e) {
    console.error('embedding failed, archiving without vector:', e)
    embedding = new Array(EMBEDDING_DIM).fill(0)
  }

  // Append message line to NDJSON
  const line = JSON.stringify({
    id: msg.id,
    role: msg.role,
    content: msg.content,
    timestamp: msg.timestamp
  }) + '\n'
  await appendFile(ARCHIVE_FILE, line, 'utf-8')

  // Append embedding bytes to bin file
  const buf = Buffer.alloc(EMBEDDING_DIM * 4)
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    buf.writeFloatLE(embedding[i] ?? 0, i * 4)
  }
  await appendFile(EMBEDDINGS_FILE, buf)

  memoryCache.push({ ...msg, embedding })
  seenIds.add(msg.id)
}

// Bulk-archive any messages from a list that aren't already archived.
// Used to backfill on startup.
export async function archiveBulk(msgs: ArchiveMessage[]): Promise<{ added: number }> {
  await loadIntoMemory()
  if (!seenIds) return { added: 0 }
  let added = 0
  for (const msg of msgs) {
    if (seenIds.has(msg.id)) continue
    await archiveMessage(msg)
    added++
  }
  return { added }
}

// Semantic search via cosine similarity. Returns top-N hits with surrounding
// context (one message before + one after) merged in.
export async function searchArchive(
  query: string,
  limit = 5,
  withContext = true
): Promise<{
  hits: SearchHit[]
  contextWindow?: ArchiveMessage[]
  total: number
}> {
  await loadIntoMemory()
  if (!memoryCache || memoryCache.length === 0) {
    return { hits: [], total: 0 }
  }
  const queryVec = await embed(query)
  const scored: SearchHit[] = memoryCache.map((entry) => ({
    id: entry.id,
    role: entry.role,
    content: entry.content,
    timestamp: entry.timestamp,
    score: cosineSimilarity(queryVec, entry.embedding)
  }))
  scored.sort((a, b) => b.score - a.score)
  const hits = scored.slice(0, limit)

  if (!withContext) {
    return { hits, total: memoryCache.length }
  }

  const idIndex = new Map<string, number>()
  memoryCache.forEach((m, i) => idIndex.set(m.id, i))
  const contextIds = new Set<string>()
  const ctx: ArchiveMessage[] = []
  for (const hit of hits) {
    const i = idIndex.get(hit.id)
    if (i === undefined) continue
    const before = memoryCache[i - 1]
    const after = memoryCache[i + 1]
    for (const m of [before, hit, after]) {
      if (m && !contextIds.has(m.id)) {
        contextIds.add(m.id)
        ctx.push({
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: m.timestamp
        })
      }
    }
  }
  ctx.sort((a, b) => a.timestamp - b.timestamp)
  return { hits, contextWindow: ctx, total: memoryCache.length }
}

// Read all messages between two timestamps (inclusive).
export async function readArchiveRange(
  fromTs: number,
  toTs: number
): Promise<ArchiveMessage[]> {
  await loadIntoMemory()
  if (!memoryCache) return []
  return memoryCache
    .filter((m) => m.timestamp >= fromTs && m.timestamp <= toTs)
    .map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp
    }))
}

export async function getArchiveStats(): Promise<{
  totalMessages: number
  oldestTs: number | null
  newestTs: number | null
  fileBytes: number
}> {
  await loadIntoMemory()
  let bytes = 0
  if (existsSync(ARCHIVE_FILE)) bytes += statSync(ARCHIVE_FILE).size
  if (existsSync(EMBEDDINGS_FILE)) bytes += statSync(EMBEDDINGS_FILE).size
  if (!memoryCache || memoryCache.length === 0) {
    return { totalMessages: 0, oldestTs: null, newestTs: null, fileBytes: bytes }
  }
  return {
    totalMessages: memoryCache.length,
    oldestTs: memoryCache[0]!.timestamp,
    newestTs: memoryCache[memoryCache.length - 1]!.timestamp,
    fileBytes: bytes
  }
}

// Force a reset of the in-memory cache. Used in tests or after manual file edits.
export function resetCache(): void {
  memoryCache = null
  seenIds = null
  loadPromise = null
}

// Export this so callers can avoid recompute when they already have the data.
export { writeFile }
