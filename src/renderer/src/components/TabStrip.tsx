import type { CSSProperties } from 'react'
import type { Tab } from '../types'
import type { TabActivity } from '../App'

interface Props {
  tabs: Tab[]
  activeTabId: string | null
  activityStates: Map<string, TabActivity>
  onSelect: (id: string) => void
  onClose: (id: string) => void
  ultimateModeProjectName?: string
  onSpawnUltimateWorker?: () => void
}

function tabTitle(tab: Tab, allTabs: Tab[]): string {
  const sameProject = allTabs.filter((t) => t.project.id === tab.project.id)
  if (sameProject.length === 1) return tab.project.name
  const idx = sameProject.findIndex((t) => t.id === tab.id)
  return `${tab.project.name} · ${idx + 1}`
}

export function TabStrip({
  tabs,
  activeTabId,
  activityStates,
  onSelect,
  onClose,
  ultimateModeProjectName,
  onSpawnUltimateWorker
}: Props) {
  if (tabs.length === 0) {
    return (
      <div className="tabstrip">
        {ultimateModeProjectName ? (
          <>
            <div className="tabstrip-empty">
              ULTIMATE MODE · {ultimateModeProjectName.toUpperCase()} · NO WORKERS YET
            </div>
            {onSpawnUltimateWorker && (
              <button
                type="button"
                className="tabstrip-spawn-worker"
                onClick={onSpawnUltimateWorker}
              >
                + SPAWN WORKER
              </button>
            )}
          </>
        ) : (
          <div className="tabstrip-empty">NO ACTIVE SESSIONS</div>
        )}
      </div>
    )
  }

  return (
    <div className="tabstrip">
      {tabs.map((tab) => {
        const isActive = activeTabId === tab.id
        const activity = activityStates.get(tab.id)
        const showsIndicator =
          !isActive && activity && (activity.hasBell || activity.hasUnread || activity.isRunning)
        const indicatorClass = activity?.hasBell
          ? 'bell'
          : activity?.hasUnread
            ? 'unread'
            : 'running'
        const stateClass = !isActive
          ? activity?.hasBell
            ? ' has-bell'
            : activity?.hasUnread
              ? ' has-unread'
              : activity?.isRunning
                ? ' has-running'
                : ''
          : ''
        const isResumed = !!tab.sessionId
        return (
          <div
            key={tab.id}
            className={`tab${isActive ? ' active' : ''}${stateClass}${isResumed ? ' resumed' : ''}`}
            onClick={() => onSelect(tab.id)}
            style={{ '--accent': tab.project.color } as CSSProperties}
            role="button"
            tabIndex={0}
            title={isResumed ? 'Resumed session' : undefined}
          >
            <span className="tab-stripe" />
            {isResumed && <span className="tab-resumed-glyph" aria-hidden="true">↻</span>}
            <span className="tab-name">{tabTitle(tab, tabs)}</span>
            {showsIndicator && <span className={`tab-status-dot ${indicatorClass}`} />}
            <span
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation()
                onClose(tab.id)
              }}
              role="button"
              aria-label="close tab"
            >
              ×
            </span>
          </div>
        )
      })}
      {onSpawnUltimateWorker && (
        <button
          type="button"
          className="tabstrip-spawn-worker tabstrip-spawn-worker-inline"
          onClick={onSpawnUltimateWorker}
          title="Spawn parallel worker for this project"
        >
          + WORKER
        </button>
      )}
    </div>
  )
}
