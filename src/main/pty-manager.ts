import * as pty from 'node-pty'
import type { WebContents } from 'electron'
import { randomUUID } from 'crypto'

interface BufferEntry {
  ts: number
  data: string
}

interface PtyEntry {
  id: string
  pty: pty.IPty
  webContents: WebContents
  buffer: BufferEntry[]
  bufferSize: number
}

export interface SpawnOptions {
  cols?: number
  rows?: number
  autoRun?: string
}

const BUFFER_MAX_BYTES = 200 * 1024

export class PtyManager {
  private ptys = new Map<string, PtyEntry>()

  spawn(cwd: string, webContents: WebContents, options: SpawnOptions = {}): string {
    const id = randomUUID()
    const shell = process.env.SHELL || '/bin/zsh'

    const env = { ...process.env }
    delete env.npm_config_prefix

    const ptyProcess = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: options.cols ?? 120,
      rows: options.rows ?? 30,
      cwd,
      env: env as { [key: string]: string }
    })

    const entry: PtyEntry = {
      id,
      pty: ptyProcess,
      webContents,
      buffer: [],
      bufferSize: 0
    }

    ptyProcess.onData((data) => {
      entry.buffer.push({ ts: Date.now(), data })
      entry.bufferSize += data.length
      while (entry.bufferSize > BUFFER_MAX_BYTES && entry.buffer.length > 1) {
        const removed = entry.buffer.shift()
        if (removed) entry.bufferSize -= removed.data.length
      }
      if (!webContents.isDestroyed()) {
        webContents.send('pty:data', { id, data })
      }
    })

    ptyProcess.onExit(({ exitCode }) => {
      if (!webContents.isDestroyed()) {
        webContents.send('pty:exit', { id, exitCode })
      }
      this.ptys.delete(id)
    })

    this.ptys.set(id, entry)

    if (options.autoRun) {
      setTimeout(() => {
        const e = this.ptys.get(id)
        if (e) e.pty.write(`${options.autoRun}\r`)
      }, 250)
    }

    return id
  }

  write(id: string, data: string): void {
    const entry = this.ptys.get(id)
    if (entry) entry.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this.ptys.get(id)
    if (entry) {
      try {
        entry.pty.resize(cols, rows)
      } catch {
        /* noop */
      }
    }
  }

  kill(id: string): void {
    const entry = this.ptys.get(id)
    if (entry) {
      try {
        entry.pty.kill()
      } catch {
        /* noop */
      }
      this.ptys.delete(id)
    }
  }

  killAll(): void {
    for (const entry of this.ptys.values()) {
      try {
        entry.pty.kill()
      } catch {
        /* noop */
      }
    }
    this.ptys.clear()
  }

  getBuffer(id: string, sinceTs?: number): string {
    const entry = this.ptys.get(id)
    if (!entry) return ''
    const filtered = sinceTs
      ? entry.buffer.filter((e) => e.ts >= sinceTs)
      : entry.buffer
    return filtered.map((e) => e.data).join('')
  }

  getLastDataTime(id: string): number | null {
    const entry = this.ptys.get(id)
    if (!entry || entry.buffer.length === 0) return null
    return entry.buffer[entry.buffer.length - 1]!.ts
  }
}
