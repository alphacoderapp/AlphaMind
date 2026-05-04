import { useEffect, useState } from 'react'
import type { Project } from '../data/mockProjects'

export interface GitCommit {
  hash: string
  shortHash: string
  message: string
  author: string
  timestamp: number
}

export interface GitStats {
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

export interface ProjectStats {
  path: string
  git: GitStats
  recentSessions: { id: string; firstMessage: string; lastTimestamp: number; messageCount: number }[]
  lastSessionTimestamp?: number
  sessionsLast7Days: number
  sessionsLast30Days: number
  lastActivityTimestamp?: number
  fetchedAt: number
}

export function useAllProjectStats(projects: Project[], enabled: boolean) {
  const [statsMap, setStatsMap] = useState<Map<string, ProjectStats>>(new Map())
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!enabled || projects.length === 0) {
      return
    }
    let cancelled = false
    setLoading(true)

    Promise.all(
      projects.map((p) =>
        window.api.stats.get(p.path).catch(() => null)
      )
    ).then((results) => {
      if (cancelled) return
      const next = new Map<string, ProjectStats>()
      projects.forEach((p, i) => {
        if (results[i]) next.set(p.id, results[i] as ProjectStats)
      })
      setStatsMap(next)
      setLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [enabled, projects])

  return { statsMap, loading }
}
