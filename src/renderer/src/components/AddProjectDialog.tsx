import { useEffect, useRef, useState } from 'react'

interface Props {
  initialName: string
  initialPath: string
  onCancel: () => void
  onSubmit: (name: string, color: string) => void
}

const COLORS = [
  { name: 'cyan', value: '#22d3ee' },
  { name: 'emerald', value: '#34d399' },
  { name: 'magenta', value: '#e879f9' },
  { name: 'amber', value: '#fbbf24' },
  { name: 'violet', value: '#a78bfa' },
  { name: 'rose', value: '#fb7185' }
]

export function AddProjectDialog({ initialName, initialPath, onCancel, onSubmit }: Props) {
  const [name, setName] = useState(initialName)
  const [color, setColor] = useState(COLORS[0]!.value)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const submit = () => {
    if (name.trim()) onSubmit(name.trim(), color)
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="modal">
        <div className="modal-header">
          <span className="micro-label">NEW PROJECT</span>
        </div>
        <div className="modal-body">
          <div className="modal-field">
            <label className="micro-label">NAME</label>
            <input
              ref={inputRef}
              className="modal-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
            />
          </div>
          <div className="modal-field">
            <label className="micro-label">PATH</label>
            <div className="modal-path">{initialPath}</div>
          </div>
          <div className="modal-field">
            <label className="micro-label">COLOR</label>
            <div className="color-row">
              {COLORS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  className={`color-swatch${color === c.value ? ' active' : ''}`}
                  style={{ background: c.value, color: c.value }}
                  onClick={() => setColor(c.value)}
                  aria-label={c.name}
                />
              ))}
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="modal-btn" onClick={onCancel} type="button">
            CANCEL
          </button>
          <button
            className="modal-btn primary"
            onClick={submit}
            disabled={!name.trim()}
            type="button"
          >
            ADD
          </button>
        </div>
      </div>
    </div>
  )
}
