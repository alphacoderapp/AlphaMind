import { getGitStats, type GitStats } from './git-stats'
import { listSessions, type ClaudeSession } from './sessions-store'

export interface ProjectStats {
  path: string
  git: GitStats
  recentSessions: ClaudeSession[]
  lastSessionTimestamp?: number
  sessionsLast7Days: number
  sessionsLast30Days: number
  lastActivityTimestamp?: number
  fetchedAt: number
}

const cache = new Map<string, ProjectStats>()
const CACHE_TTL = 60_000

const DAY = 24 * 60 * 60 * 1000

export async function getProjectStats(path: string): Promise<ProjectStats> {
  const cached = cache.get(path)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached
  }

  const [git, sessions] = await Promise.all([
    getGitStats(path),
    listSessions(path, 50).catch(() => [] as ClaudeSession[])
  ])

  const now = Date.now()
  const sevenDaysAgo = now - 7 * DAY
  const thirtyDaysAgo = now - 30 * DAY

  const lastSessionTimestamp = sessions.length > 0 ? sessions[0]!.lastTimestamp : undefined
  const sessionsLast7Days = sessions.filter((s) => s.lastTimestamp >= sevenDaysAgo).length
  const sessionsLast30Days = sessions.filter((s) => s.lastTimestamp >= thirtyDaysAgo).length
  const recentSessions = sessions.slice(0, 5)

  const lastCommitTs = git.lastCommit?.timestamp
  const lastActivityTimestamp =
    lastSessionTimestamp && lastCommitTs
      ? Math.max(lastSessionTimestamp, lastCommitTs)
      : lastSessionTimestamp ?? lastCommitTs

  const stats: ProjectStats = {
    path,
    git,
    recentSessions,
    lastSessionTimestamp,
    sessionsLast7Days,
    sessionsLast30Days,
    lastActivityTimestamp,
    fetchedAt: now
  }

  cache.set(path, stats)
  return stats
}

export function clearProjectStatsCache(path?: string): void {
  if (path) cache.delete(path)
  else cache.clear()
}
