import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

export interface MenuItem {
  label: string
  onClick: () => void
  destructive?: boolean
}

interface Props {
  x: number
  y: number
  items: MenuItem[]
  extra?: ReactNode
  onClose: () => void
}

export function ContextMenu({ x, y, items, extra, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div ref={ref} className="context-menu" style={{ left: x, top: y }}>
      {items.map((item, i) => (
        <button
          key={i}
          type="button"
          className={`context-menu-item${item.destructive ? ' destructive' : ''}`}
          onClick={() => {
            item.onClick()
            onClose()
          }}
        >
          {item.label}
        </button>
      ))}
      {extra}
    </div>
  )
}
