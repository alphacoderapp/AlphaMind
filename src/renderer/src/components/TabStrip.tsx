import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { Tab } from '../types'
import type { TabActivity } from '../App'
import { MasterThinkOrb } from './MasterThinkOrb'

interface Props {
  tabs: Tab[]
  activeTabId: string | null
  activityStates: Map<string, TabActivity>
  onSelect: (id: string) => void
  onClose: (id: string) => void
  ultimateModeProjectName?: string
  onSpawnUltimateWorker?: () => void
  // When true, the strip is showing the project that's currently in Ultimate
  // Developer Mode — closing any of these tabs is a "kill a worker" action,
  // so we require a second click within ~2.5s to actually close. Outside ULM
  // close stays single-click (the previous behaviour).
  ulmActive?: boolean
}

const CLOSE_CONFIRM_MS = 2500

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
  onSpawnUltimateWorker,
  ulmActive
}: Props) {
  const [armedCloseId, setArmedCloseId] = useState<string | null>(null)
  const armedTimer = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (armedTimer.current !== null) window.clearTimeout(armedTimer.current)
    }
  }, [])

  // If the user clicks anywhere in the strip outside an armed close button,
  // the confirmation should reset — keeps the "armed" state from lingering
  // visibly after the user has clearly moved on.
  useEffect(() => {
    if (!armedCloseId) return
    const onDocClick = (e: MouseEvent): void => {
      const t = e.target as HTMLElement | null
      if (t?.closest('.tab-close')) return
      setArmedCloseId(null)
      if (armedTimer.current !== null) {
        window.clearTimeout(armedTimer.current)
        armedTimer.current = null
      }
    }
    document.addEventListener('mousedown', onDocClick, true)
    return () => document.removeEventListener('mousedown', onDocClick, true)
  }, [armedCloseId])

  const handleCloseClick = (e: React.MouseEvent, tabId: string): void => {
    e.stopPropagation()
    if (!ulmActive) {
      onClose(tabId)
      return
    }
    if (armedCloseId === tabId) {
      setArmedCloseId(null)
      if (armedTimer.current !== null) {
        window.clearTimeout(armedTimer.current)
        armedTimer.current = null
      }
      onClose(tabId)
      return
    }
    setArmedCloseId(tabId)
    if (armedTimer.current !== null) window.clearTimeout(armedTimer.current)
    armedTimer.current = window.setTimeout(() => {
      setArmedCloseId(null)
      armedTimer.current = null
    }, CLOSE_CONFIRM_MS)
  }

  if (tabs.length === 0) {
    return (
      <div className="tabstrip">
        {ultimateModeProjectName ? (
          <>
            <div className="tabstrip-empty">
              Ultimate mode · {ultimateModeProjectName} · no workers yet
            </div>
            {onSpawnUltimateWorker && (
              <button
                type="button"
                className="tabstrip-spawn-worker"
                onClick={onSpawnUltimateWorker}
              >
                + Spawn worker
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
            <span className="tab-orb">
              <MasterThinkOrb
                size={6}
                accent={tab.project.color}
                thinking={!!activity?.isRunning || !!activity?.hasBell}
              />
            </span>
            {isResumed && <span className="tab-resumed-glyph" aria-hidden="true">↻</span>}
            <span className="tab-name">{tabTitle(tab, tabs)}</span>
            {showsIndicator && <span className={`tab-status-dot ${indicatorClass}`} />}
            <span
              className={`tab-close${armedCloseId === tab.id ? ' tab-close-armed' : ''}`}
              onClick={(e) => handleCloseClick(e, tab.id)}
              role="button"
              aria-label={armedCloseId === tab.id ? 'click again to close worker' : 'close tab'}
              title={armedCloseId === tab.id ? 'Click again to close worker' : undefined}
            >
              {armedCloseId === tab.id ? '?' : '×'}
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
          + Worker
        </button>
      )}
    </div>
  )
}
