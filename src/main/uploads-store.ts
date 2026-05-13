// Manages the temp uploads directory for files dragged into either chat.
// Files saved here are referenced via @path syntax in claude prompts (claude
// CLI auto-resolves @-prefixed paths into content blocks for both master and
// workers). Auto-cleans files older than 7 days on app start.

import { app } from 'electron'
import { writeFile, readdir, stat, unlink, mkdir } from 'fs/promises'
import { join, extname } from 'path'
import { existsSync } from 'fs'
import { randomUUID } from 'crypto'

const STORE_DIR = join(app.getPath('home'), '.alphacod')
const UPLOADS_DIR = join(STORE_DIR, 'uploads')
const MAX_AGE_DAYS = 7
const MAX_FILE_BYTES = 20 * 1024 * 1024 // 20 MB cap

export interface SavedUpload {
  path: string
  name: string
  mimeType: string
  sizeBytes: number
}

async function ensureDir(): Promise<void> {
  if (!existsSync(UPLOADS_DIR)) {
    await mkdir(UPLOADS_DIR, { recursive: true })
  }
}

export async function saveUpload(
  originalName: string,
  mimeType: string,
  data: Uint8Array
): Promise<SavedUpload> {
  if (data.byteLength > MAX_FILE_BYTES) {
    throw new Error(
      `File too large (${(data.byteLength / 1024 / 1024).toFixed(1)} MB). Cap is 20 MB.`
    )
  }
  await ensureDir()
  // Preserve extension when present, fall back on a sanitized version of the
  // original name. The file content is what matters; the name is just hint.
  const ext = extname(originalName).toLowerCase().slice(0, 10) || ''
  const filename = `${randomUUID()}${ext}`
  const fullPath = join(UPLOADS_DIR, filename)
  await writeFile(fullPath, Buffer.from(data))
  return {
    path: fullPath,
    name: originalName,
    mimeType,
    sizeBytes: data.byteLength
  }
}

export async function cleanupOldUploads(): Promise<{ deleted: number }> {
  if (!existsSync(UPLOADS_DIR)) return { deleted: 0 }
  let deleted = 0
  try {
    const files = await readdir(UPLOADS_DIR)
    const now = Date.now()
    const cutoff = now - MAX_AGE_DAYS * 24 * 60 * 60 * 1000
    for (const f of files) {
      const p = join(UPLOADS_DIR, f)
      try {
        const s = await stat(p)
        if (s.mtimeMs < cutoff) {
          await unlink(p)
          deleted++
        }
      } catch {
        /* file disappeared between readdir and stat — ignore */
      }
    }
  } catch (e) {
    console.error('cleanupOldUploads failed:', e)
  }
  return { deleted }
}
