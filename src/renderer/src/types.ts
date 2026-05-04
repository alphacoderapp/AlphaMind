import type { Project } from './data/mockProjects'

export interface Tab {
  id: string
  ptyId: string
  project: Project
  sessionId?: string
}

export interface ClaudeSession {
  id: string
  firstMessage: string
  lastTimestamp: number
  messageCount: number
}
