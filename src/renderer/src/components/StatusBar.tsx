import { useEffect, useState } from 'react'
import type { Tab } from '../types'

const APP_VERSION = '0.2.3'

interface UpdateState {
  available: boolean
  version?: string
}

interface Props {
  tab: Tab | null
}

export function StatusBar({ tab }: Props) {
  const [update, setUpdate] = useState<UpdateState>({ available: false })

  useEffect(() => {
    return window.api.updater.onEvent((event) => {
      const e = event as { type?: string; version?: string }
      if (e.type === 'available' && e.version) {
        setUpdate({ available: true, version: e.version })
      } else if (e.type === 'not-available') {
        setUpdate({ available: false })
      }
    })
  }, [])

  return (
    <div className="statusbar">
      <div className="statusbar-section">
        <span>SIMPLE CLAUDE {APP_VERSION}</span>
      </div>
      <div className="statusbar-divider" />
      <div className="statusbar-section">
        <span
          className="statusbar-dot"
          style={
            tab
              ? {
                  background: tab.project.color,
                  boxShadow: `0 0 4px ${tab.project.color}`
                }
              : undefined
          }
        />
        <span>{tab ? 'RUNNING' : 'READY'}</span>
      </div>
      <div className="statusbar-divider" />
      <div className="statusbar-section">
        <span>{tab ? tab.project.path : 'NO PROJECT'}</span>
      </div>
      <div style={{ flex: 1 }} />
      {update.available && update.version && (
        <button
          type="button"
          className="statusbar-update"
          onClick={() => window.api.updater.openRelease(update.version)}
          title="Click to download new version"
        >
          ↑ v{update.version} AVAILABLE · DOWNLOAD
        </button>
      )}
      {tab && (
        <div className="statusbar-section">
          <span>PTY {tab.ptyId.slice(0, 8)}</span>
        </div>
      )}
    </div>
  )
}
