/// <reference types="vite/client" />

interface SpawnOptions {
  cols?: number
  rows?: number
  autoRun?: string
}

interface PtyApi {
  spawn: (cwd: string, options?: SpawnOptions) => Promise<string>
  write: (id: string, data: string) => void
  resize: (id: string, cols: number, rows: number) => void
  kill: (id: string) => void
  onData: (cb: (id: string, data: string) => void) => () => void
  onExit: (cb: (id: string, exitCode: number) => void) => () => void
}

interface StoredProject {
  id: string
  name: string
  color: string
  path: string
  category?: string
}

interface ProjectsApi {
  list: () => Promise<StoredProject[] | null>
  save: (projects: StoredProject[]) => Promise<void>
}

interface ClaudeSessionShape {
  id: string
  firstMessage: string
  lastTimestamp: number
  messageCount: number
}

interface SessionsApi {
  list: (projectPath: string) => Promise<ClaudeSessionShape[]>
}

interface GitCommitShape {
  hash: string
  shortHash: string
  message: string
  author: string
  timestamp: number
}

interface GitStatsShape {
  isGitRepo: boolean
  branch?: string
  hasUncommittedChanges?: boolean
  ahead?: number
  behind?: number
  hasUpstream?: boolean
  lastCommit?: GitCommitShape
  recentCommits?: GitCommitShape[]
  commitsLast7Days?: number
  commitsLast30Days?: number
  changedFiles?: number
}

interface ProjectStatsShape {
  path: string
  git: GitStatsShape
  recentSessions: ClaudeSessionShape[]
  lastSessionTimestamp?: number
  sessionsLast7Days: number
  sessionsLast30Days: number
  lastActivityTimestamp?: number
  fetchedAt: number
}

interface StatsApi {
  get: (path: string) => Promise<ProjectStatsShape>
  refresh: (path?: string) => Promise<void>
}

interface StoredAppStateShape {
  tabs: { projectId: string; sessionId?: string }[]
  activeIndex: number
}

interface StateApi {
  load: () => Promise<StoredAppStateShape | null>
  save: (state: StoredAppStateShape) => Promise<void>
}

interface DialogApi {
  pickFolder: () => Promise<string | null>
}

interface ShellApi {
  openPath: (path: string) => void
}

interface ResizeImageResultShape {
  hadImage: boolean
  resized?: boolean
  original?: { width: number; height: number }
  final?: { width: number; height: number }
}

interface ClipboardApi {
  writeText: (text: string) => Promise<void>
  resizeImage: () => Promise<ResizeImageResultShape>
}

interface WindowApi {
  focus: () => void
  onAction: (cb: (action: string) => void) => () => void
}

interface TabInfoForRegistryShape {
  tabId: string
  ptyId: string
  projectId: string
  projectName: string
  projectPath: string
  projectColor: string
  sessionId?: string
}

interface TabRegistryApi {
  set: (info: TabInfoForRegistryShape) => void
  remove: (tabId: string) => void
  setActive: (tabId: string | null) => void
}

interface MasterApi {
  sendStart: (
    message: string,
    history?: Array<{ role: 'user' | 'assistant'; content: string }>
  ) => Promise<string>
  onEvent: (cb: (requestId: string, event: unknown) => void) => () => void
}

interface UpdaterApi {
  openRelease: (version?: string) => void
  check: () => Promise<{ ok: boolean; error?: string }>
  onEvent: (cb: (event: unknown) => void) => () => void
}

declare global {
  interface Window {
    api: {
      pty: PtyApi
      projects: ProjectsApi
      sessions: SessionsApi
      stats: StatsApi
      state: StateApi
      dialog: DialogApi
      shell: ShellApi
      clipboard: ClipboardApi
      window: WindowApi
      tabRegistry: TabRegistryApi
      master: MasterApi
      updater: UpdaterApi
    }
  }
}

export {}
