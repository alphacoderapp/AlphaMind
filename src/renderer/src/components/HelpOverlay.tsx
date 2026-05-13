import { useEffect } from 'react'

interface Shortcut {
  keys: string
  label: string
}

interface Section {
  title: string
  shortcuts: Shortcut[]
}

const SECTIONS: Section[] = [
  {
    title: 'NAVIGATION',
    shortcuts: [
      { keys: '⌘1 .. ⌘9', label: 'Jump to project by index' },
      { keys: '⌘P', label: 'Quick switcher (search)' },
      { keys: '⌘M', label: 'Map mode (graph view)' },
      { keys: '⌘⇧]', label: 'Next tab' },
      { keys: '⌘⇧[', label: 'Previous tab' }
    ]
  },
  {
    title: 'TABS',
    shortcuts: [
      { keys: '⌘T', label: 'New tab in active project' },
      { keys: '⌘W', label: 'Close active tab' },
      { keys: '⌘ + click project', label: 'Force new tab in same project' }
    ]
  },
  {
    title: 'PROJECT',
    shortcuts: [
      { keys: 'Right-click project', label: 'Open in Finder · Copy path · Rename · Color · Remove' },
      { keys: 'Click ›', label: 'Show / hide sessions' },
      { keys: 'Click session', label: 'Resume that conversation' },
      { keys: 'Click +', label: 'Add new project' }
    ]
  },
  {
    title: 'SYSTEM',
    shortcuts: [
      { keys: '⌘⇧I', label: 'Resize clipboard image (avoid Claude 2000px limit)' },
      { keys: '⌘/', label: 'Show this help' },
      { keys: '⌘Q', label: 'Quit Alphacod' },
      { keys: '⌘⌥M', label: 'Minimize window' },
      { keys: 'Esc', label: 'Close any modal' }
    ]
  }
]

interface Props {
  onClose: () => void
}

export function HelpOverlay({ onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="help-overlay" onMouseDown={(e) => e.stopPropagation()}>
        <div className="help-header">
          <span className="micro-label">KEYBOARD SHORTCUTS</span>
          <span className="help-close-hint">ESC TO CLOSE</span>
        </div>
        <div className="help-body">
          {SECTIONS.map((section) => (
            <div key={section.title} className="help-section">
              <div className="help-section-title">{section.title}</div>
              <div className="help-shortcuts">
                {section.shortcuts.map((s, i) => (
                  <div key={`${section.title}-${i}`} className="help-row">
                    <span className="help-keys">{s.keys}</span>
                    <span className="help-label">{s.label}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
