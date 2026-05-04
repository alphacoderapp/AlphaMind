import { useEffect } from 'react'

export type ToastKind = 'info' | 'success' | 'error'

interface Props {
  message: string
  kind: ToastKind
  onDismiss: () => void
  duration?: number
}

export function Toast({ message, kind, onDismiss, duration = 2800 }: Props) {
  useEffect(() => {
    const t = setTimeout(onDismiss, duration)
    return () => clearTimeout(t)
  }, [onDismiss, duration])

  return (
    <div className={`toast toast-${kind}`} role="status" aria-live="polite">
      {message}
    </div>
  )
}
