import type { Tab } from '../types'
import { TerminalTab } from './TerminalTab'

interface Props {
  tabs: Tab[]
  activeTabId: string | null
}

export function TerminalArea({ tabs, activeTabId }: Props) {
  if (tabs.length === 0) {
    return (
      <div className="terminal-area terminal-area-empty">
        <div className="terminal-empty">
          <span className="terminal-empty-title">SELECT A PROJECT</span>
          <span className="terminal-empty-hint">click any project on the left to open a session</span>
        </div>
      </div>
    )
  }

  return (
    <div className="terminal-area">
      {tabs.map((tab) => (
        <TerminalTab key={tab.id} tab={tab} active={tab.id === activeTabId} />
      ))}
    </div>
  )
}
