import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

interface SpawnOptions {
  cols?: number
  rows?: number
  autoRun?: string
}

interface StoredProject {
  id: string
  name: string
  color: string
  path: string
  category?: string
}

interface ClaudeSession {
  id: string
  firstMessage: string
  lastTimestamp: number
  messageCount: number
}

interface StoredAppState {
  tabs: { projectId: string; sessionId?: string }[]
  activeIndex: number
}

interface ResizeImageResult {
  hadImage: boolean
  resized?: boolean
  original?: { width: number; height: number }
  final?: { width: number; height: number }
}

interface GitCommit {
  hash: string
  shortHash: string
  message: string
  author: string
  timestamp: number
}

interface GitStats {
  isGitRepo: boolean
  branch?: string
  hasUncommittedChanges?: boolean
  ahead?: number
  behind?: number
  hasUpstream?: boolean
  lastCommit?: GitCommit
  recentCommits?: GitCommit[]
  commitsLast7Days?: number
  commitsLast30Days?: number
  changedFiles?: number
}

interface ProjectStats {
  path: string
  git: GitStats
  recentSessions: ClaudeSession[]
  lastSessionTimestamp?: number
  sessionsLast7Days: number
  sessionsLast30Days: number
  lastActivityTimestamp?: number
  fetchedAt: number
}

interface TabInfoForRegistry {
  tabId: string
  ptyId: string
  projectId: string
  projectName: string
  projectPath: string
  projectColor: string
  sessionId?: string
}

const api = {
  pty: {
    spawn: (cwd: string, options?: SpawnOptions): Promise<string> =>
      ipcRenderer.invoke('pty:spawn', cwd, options),
    write: (id: string, data: string): void => {
      ipcRenderer.send('pty:write', id, data)
    },
    resize: (id: string, cols: number, rows: number): void => {
      ipcRenderer.send('pty:resize', id, cols, rows)
    },
    kill: (id: string): void => {
      ipcRenderer.send('pty:kill', id)
    },
    onData: (cb: (id: string, data: string) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, payload: { id: string; data: string }) =>
        cb(payload.id, payload.data)
      ipcRenderer.on('pty:data', handler)
      return () => {
        ipcRenderer.removeListener('pty:data', handler)
      }
    },
    onExit: (cb: (id: string, exitCode: number) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, payload: { id: string; exitCode: number }) =>
        cb(payload.id, payload.exitCode)
      ipcRenderer.on('pty:exit', handler)
      return () => {
        ipcRenderer.removeListener('pty:exit', handler)
      }
    }
  },
  projects: {
    list: (): Promise<StoredProject[] | null> => ipcRenderer.invoke('projects:list'),
    save: (projects: StoredProject[]): Promise<void> =>
      ipcRenderer.invoke('projects:save', projects)
  },
  sessions: {
    list: (projectPath: string): Promise<ClaudeSession[]> =>
      ipcRenderer.invoke('sessions:list', projectPath)
  },
  stats: {
    get: (path: string): Promise<ProjectStats> => ipcRenderer.invoke('stats:get', path),
    refresh: (path?: string): Promise<void> => ipcRenderer.invoke('stats:refresh', path)
  },
  state: {
    load: (): Promise<StoredAppState | null> => ipcRenderer.invoke('state:load'),
    save: (state: StoredAppState): Promise<void> => ipcRenderer.invoke('state:save', state)
  },
  dialog: {
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickFolder')
  },
  shell: {
    openPath: (path: string): void => {
      ipcRenderer.send('shell:openPath', path)
    }
  },
  clipboard: {
    writeText: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:writeText', text),
    resizeImage: (): Promise<ResizeImageResult> => ipcRenderer.invoke('clipboard:resizeImage')
  },
  window: {
    focus: (): void => {
      ipcRenderer.send('window:focus')
    },
    onAction: (cb: (action: string) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, action: string) => cb(action)
      ipcRenderer.on('window:action', handler)
      return () => {
        ipcRenderer.removeListener('window:action', handler)
      }
    }
  },
  tabRegistry: {
    set: (info: TabInfoForRegistry): void => {
      ipcRenderer.send('tab-registry:set', info)
    },
    remove: (tabId: string): void => {
      ipcRenderer.send('tab-registry:remove', tabId)
    },
    setActive: (tabId: string | null): void => {
      ipcRenderer.send('tab-registry:setActive', tabId)
    }
  },
  master: {
    sendStart: (
      message: string,
      history?: Array<{ role: 'user' | 'assistant'; content: string }>
    ): Promise<string> => ipcRenderer.invoke('master:send-start', message, history),
    onEvent: (cb: (requestId: string, event: unknown) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, payload: { requestId: string; event: unknown }) =>
        cb(payload.requestId, payload.event)
      ipcRenderer.on('master:event', handler)
      return () => {
        ipcRenderer.removeListener('master:event', handler)
      }
    },
    onControlRequest: (
      cb: (req: { requestId: string; action: string; payload: unknown }) => void
    ): (() => void) => {
      const handler = (
        _e: IpcRendererEvent,
        payload: { requestId: string; action: string; payload: unknown }
      ) => cb(payload)
      ipcRenderer.on('master-control:request', handler)
      return () => {
        ipcRenderer.removeListener('master-control:request', handler)
      }
    },
    respondControl: (
      requestId: string,
      result: { ok: true; data?: unknown } | { ok: false; error: string }
    ): void => {
      ipcRenderer.send('master-control:response', { requestId, result })
    }
  },
  updater: {
    openRelease: (version?: string): void => {
      ipcRenderer.send('updater:open-release', version)
    },
    check: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('updater:check'),
    onEvent: (cb: (event: unknown) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, payload: unknown) => cb(payload)
      ipcRenderer.on('updater:event', handler)
      return () => {
        ipcRenderer.removeListener('updater:event', handler)
      }
    }
  }
}

try {
  contextBridge.exposeInMainWorld('api', api)
} catch (e) {
  console.error(e)
}
