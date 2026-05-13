import { useEffect, useRef, useState } from 'react'
import type { Project } from '../data/mockProjects'
import { Icon } from './Icon'

interface Props {
  project: Project | null
  url: string | undefined
  onClear: () => void
  onStartDevServer: (project: Project) => void
}

const HEADER_H = 32
const DEFAULT_W = 520
const DEFAULT_H = 380
const MIN_W = 320
const MIN_H = 220
const MAX_ERRORS = 50
const AUTO_DISPATCH_DEBOUNCE_MS = 4000
const AUTO_DISPATCH_THRESHOLD = 3
const STORAGE_KEY = 'alphacod.webpreview.geom'
const MINIMIZED_KEY = 'alphacod.webpreview.minimized'

type DeviceProfile = 'desktop' | 'tablet' | 'mobile'

const DEVICE_PROFILES: Record<DeviceProfile, { w: number; h: number; label: string }> = {
  desktop: { w: 1440, h: 900, label: 'Desktop' },
  tablet: { w: 820, h: 1180, label: 'Tablet' },
  mobile: { w: 390, h: 844, label: 'Mobile' }
}

const DEVICE_ICONS: Record<DeviceProfile, 'desktop' | 'tablet' | 'mobile'> = {
  desktop: 'desktop',
  tablet: 'tablet',
  mobile: 'mobile'
}

interface Geom {
  left: number
  top: number
  width: number
  height: number
}

type WebviewElement = HTMLElement & {
  reload?: () => void
  loadURL?: (url: string) => void
  src?: string
  isLoading?: () => boolean
  openDevTools?: () => void
}

interface FailEvent extends Event {
  errorCode?: number
  errorDescription?: string
  validatedURL?: string
}

interface ConsoleMessageEvent extends Event {
  level?: number | string
  message?: string
  line?: number
  sourceId?: string
}

interface CapturedError {
  id: string
  timestamp: number
  source: 'console' | 'load'
  message: string
  details?: string
}

function defaultGeom(): Geom {
  if (typeof window === 'undefined') {
    return { left: 800, top: 60, width: DEFAULT_W, height: DEFAULT_H }
  }
  const left = Math.max(40, window.innerWidth - DEFAULT_W - 16)
  return { left, top: 56, width: DEFAULT_W, height: DEFAULT_H }
}

function loadGeom(): Geom {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaultGeom()
    const parsed = JSON.parse(raw) as Partial<Geom>
    const g = { ...defaultGeom(), ...parsed }
    return clampGeom(g)
  } catch {
    return defaultGeom()
  }
}

function clampGeom(g: Geom): Geom {
  if (typeof window === 'undefined') return g
  const w = Math.max(MIN_W, Math.min(g.width, window.innerWidth - 80))
  const h = Math.max(MIN_H, Math.min(g.height, window.innerHeight - 80))
  const left = Math.max(8, Math.min(g.left, window.innerWidth - w - 8))
  const top = Math.max(48, Math.min(g.top, window.innerHeight - h - 8))
  return { left, top, width: w, height: h }
}

function loadMinimized(): boolean {
  try {
    return localStorage.getItem(MINIMIZED_KEY) === '1'
  } catch {
    return false
  }
}

export function WebPreview({ project, url, onClear, onStartDevServer }: Props) {
  const [geom, setGeom] = useState<Geom>(() => loadGeom())
  const [maximized, setMaximized] = useState(false)
  const [minimized, setMinimized] = useState<boolean>(() => loadMinimized())
  const [device, setDevice] = useState<DeviceProfile>('desktop')
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [autoDispatchToast, setAutoDispatchToast] = useState<string | null>(null)
  const webviewRef = useRef<WebviewElement | null>(null)
  const dragRef = useRef<
    | {
        kind: 'move' | 'resize'
        startX: number
        startY: number
        startGeom: Geom
      }
    | null
  >(null)

  // Pending errors batched for auto-dispatch to master.
  const pendingErrorsRef = useRef<CapturedError[]>([])
  const dispatchTimerRef = useRef<number | null>(null)
  const retryCountRef = useRef(0)
  const retryTimerRef = useRef<number | null>(null)
  const toastTimerRef = useRef<number | null>(null)

  // Persist geometry (debounced via setState natural batching — saving on every
  // change is cheap for localStorage).
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(geom))
    } catch {
      // ignore
    }
  }, [geom])

  useEffect(() => {
    try {
      localStorage.setItem(MINIMIZED_KEY, minimized ? '1' : '0')
    } catch {
      // ignore
    }
  }, [minimized])

  const flushErrorsToMaster = (): void => {
    if (!project) return
    const errs = pendingErrorsRef.current
    if (errs.length === 0) return
    const lines = errs.map((er, i) => {
      const time = new Date(er.timestamp).toLocaleTimeString()
      const tag = er.source === 'load' ? 'LOAD' : 'CONSOLE'
      const detail = er.details ? ` [${er.details}]` : ''
      return `${i + 1}. [${time}] [${tag}] ${er.message}${detail}`
    })
    const prompt = `${project.name} preview'is (${url ?? 'no url'}) ilmnesid järgnevad vead. Uuri põhjus ja paranda — dispatch worker'ile, paranda kood, raporteeri:\n\n${lines.join(
      '\n'
    )}`
    window.dispatchEvent(new CustomEvent('master:prompt', { detail: { text: prompt } }))
    const count = errs.length
    pendingErrorsRef.current = []
    if (dispatchTimerRef.current !== null) {
      window.clearTimeout(dispatchTimerRef.current)
      dispatchTimerRef.current = null
    }
    setAutoDispatchToast(`${count} error${count === 1 ? '' : 's'} sent to master`)
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => {
      setAutoDispatchToast(null)
      toastTimerRef.current = null
    }, 3500)
  }

  const captureError = (next: CapturedError): void => {
    const buf = pendingErrorsRef.current
    const last = buf[buf.length - 1]
    if (last && last.message === next.message && next.timestamp - last.timestamp < 1000) return
    buf.push(next)
    if (buf.length > MAX_ERRORS) buf.splice(0, buf.length - MAX_ERRORS)
    if (buf.length >= AUTO_DISPATCH_THRESHOLD) {
      flushErrorsToMaster()
      return
    }
    if (dispatchTimerRef.current !== null) window.clearTimeout(dispatchTimerRef.current)
    dispatchTimerRef.current = window.setTimeout(() => {
      dispatchTimerRef.current = null
      flushErrorsToMaster()
    }, AUTO_DISPATCH_DEBOUNCE_MS)
  }

  // Reset transient state on URL change. Pending errors flush so they don't
  // get attributed to the new URL.
  useEffect(() => {
    if (pendingErrorsRef.current.length > 0) flushErrorsToMaster()
    setFailure(null)
    retryCountRef.current = 0
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  // Esc exits maximize.
  useEffect(() => {
    if (!maximized) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMaximized(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [maximized])

  // Cmd/Ctrl+Shift+R restart hotkey.
  useEffect(() => {
    if (!project || !url) return
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'r') {
        e.preventDefault()
        const prompt = `Restardi "${project.name}" projekti dev server (asukoht: ${project.path}). Otsi jooksev server-protsess selle projekti terminalides, tapa see (Ctrl+C või kill PID-iga), siis käivita uuesti sama käsuga (npm/pnpm/yarn run dev — vaata package.json'i scripts-i kui vaja). Raporteeri kui server on tagasi üleval; preview laeb iseenesest.`
        window.dispatchEvent(new CustomEvent('master:prompt', { detail: { text: prompt } }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [project, url])

  // Reclamp on window resize so the floating widget never ends up off-screen.
  useEffect(() => {
    const onResize = (): void => setGeom((g) => clampGeom(g))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    return () => {
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current)
      if (dispatchTimerRef.current !== null) window.clearTimeout(dispatchTimerRef.current)
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const el = webviewRef.current
    if (!el || !url) return

    const onStart = (): void => {
      setLoading(true)
      setFailure(null)
    }
    const onStop = (): void => {
      setLoading(false)
      retryCountRef.current = 0
    }
    const TRANSIENT_NET_ERRORS = new Set([-100, -101, -102, -118, -324])
    const MAX_AUTO_RETRIES = 3
    const onFail = (e: Event): void => {
      const fe = e as FailEvent
      setLoading(false)
      if (fe.errorCode === -3) return
      const code = fe.errorCode ?? 0
      if (TRANSIENT_NET_ERRORS.has(code) && retryCountRef.current < MAX_AUTO_RETRIES) {
        retryCountRef.current += 1
        const delay = 700 * retryCountRef.current
        if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current)
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = null
          const w = webviewRef.current
          if (!w) return
          if (w.reload) w.reload()
          else if (url && w.loadURL) w.loadURL(url)
        }, delay)
        return
      }
      const desc = fe.errorDescription || 'Failed to load'
      setFailure(`${desc} (${fe.errorCode ?? '?'})`)
      captureError({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        source: 'load',
        message: desc,
        details: fe.validatedURL
      })
    }
    const onConsole = (e: Event): void => {
      const ce = e as ConsoleMessageEvent
      const level = ce.level
      const isError =
        level === 'error' || level === 3 || (typeof level === 'number' && level >= 2)
      if (!isError) return
      const msg = (ce.message || '').trim()
      if (!msg) return
      captureError({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        source: 'console',
        message: msg,
        details: ce.sourceId ? `${ce.sourceId}:${ce.line ?? ''}` : undefined
      })
    }

    el.addEventListener('did-start-loading', onStart)
    el.addEventListener('did-stop-loading', onStop)
    el.addEventListener('did-finish-load', onStop)
    el.addEventListener('did-fail-load', onFail)
    el.addEventListener('console-message', onConsole)
    return () => {
      el.removeEventListener('did-start-loading', onStart)
      el.removeEventListener('did-stop-loading', onStop)
      el.removeEventListener('did-finish-load', onStop)
      el.removeEventListener('did-fail-load', onFail)
      el.removeEventListener('console-message', onConsole)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  if (!project) return null

  const onHeaderMouseDown = (e: React.MouseEvent): void => {
    if (e.button !== 0) return
    if (maximized) return
    const target = e.target as HTMLElement
    if (target.closest('button') || target.closest('input')) return
    e.preventDefault()
    dragRef.current = {
      kind: 'move',
      startX: e.clientX,
      startY: e.clientY,
      startGeom: geom
    }
    document.body.classList.add('web-preview-dragging-body')
    const onMove = (ev: MouseEvent): void => {
      const s = dragRef.current
      if (!s) return
      const dx = ev.clientX - s.startX
      const dy = ev.clientY - s.startY
      setGeom(
        clampGeom({
          ...s.startGeom,
          left: s.startGeom.left + dx,
          top: s.startGeom.top + dy
        })
      )
    }
    const onUp = (): void => {
      dragRef.current = null
      document.body.classList.remove('web-preview-dragging-body')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const onResizeMouseDown = (e: React.MouseEvent): void => {
    if (e.button !== 0) return
    if (maximized) return
    e.preventDefault()
    e.stopPropagation()
    dragRef.current = {
      kind: 'resize',
      startX: e.clientX,
      startY: e.clientY,
      startGeom: geom
    }
    document.body.classList.add('web-preview-dragging-body')
    const onMove = (ev: MouseEvent): void => {
      const s = dragRef.current
      if (!s) return
      const dx = ev.clientX - s.startX
      const dy = ev.clientY - s.startY
      setGeom(
        clampGeom({
          ...s.startGeom,
          width: s.startGeom.width + dx,
          height: s.startGeom.height + dy
        })
      )
    }
    const onUp = (): void => {
      dragRef.current = null
      document.body.classList.remove('web-preview-dragging-body')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const reload = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const el = webviewRef.current
    setFailure(null)
    if (el && el.reload) el.reload()
    else if (el && url && el.loadURL) el.loadURL(url)
  }
  const restartServer = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (!project) return
    const prompt = `Restardi "${project.name}" projekti dev server (asukoht: ${project.path}). Otsi jooksev server-protsess selle projekti terminalides, tapa see (Ctrl+C või kill PID-iga), siis käivita uuesti sama käsuga (npm/pnpm/yarn run dev — vaata package.json'i scripts-i kui vaja). Raporteeri kui server on tagasi üleval; preview laeb iseenesest.`
    window.dispatchEvent(new CustomEvent('master:prompt', { detail: { text: prompt } }))
  }
  const openExternal = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (url) window.api.shell.openExternal(url)
  }
  const toggleMaximize = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setMaximized((m) => !m)
  }
  const handleMinimize = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setMinimized(true)
  }
  const handleRestore = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setMinimized(false)
  }
  const handleClose = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    onClear()
  }
  const setProfile = (p: DeviceProfile) => (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setDevice(p)
  }

  // Minimized → render compact pill in top-right corner instead of the full
  // widget. Full preview state (URL, geometry, device profile) is preserved
  // in component state, so restoring is a single setState call.
  if (minimized) {
    return (
      <button
        type="button"
        className="web-preview-pill"
        onClick={handleRestore}
        title={url ? `Restore preview · ${shortenUrl(url)}` : 'Restore preview'}
        style={{ '--accent': project.color } as React.CSSProperties}
      >
        <span
          className="web-preview-pill-dot"
          style={{ background: project.color, boxShadow: `0 0 6px ${project.color}` }}
        />
        <span className="web-preview-pill-name">{project.name}</span>
        {url && <span className="web-preview-pill-url">{shortenUrl(url)}</span>}
        <Icon name="max" size={11} />
      </button>
    )
  }

  // Active widget dimensions (maximized takes over; otherwise use geom).
  const widgetW = maximized ? Math.floor(window.innerWidth * 0.95) : geom.width
  const widgetH = maximized ? Math.floor(window.innerHeight * 0.92) : geom.height
  const positionStyle: React.CSSProperties = maximized
    ? {
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)'
      }
    : { top: geom.top, left: geom.left }

  // Fit profile aspect into body box.
  const profile = DEVICE_PROFILES[device]
  const bodyInnerW = widgetW
  const bodyInnerH = widgetH - HEADER_H
  const padding = 12
  const availW = Math.max(1, bodyInnerW - padding * 2)
  const availH = Math.max(1, bodyInnerH - padding * 2)
  const scale = Math.min(availW / profile.w, availH / profile.h)
  const scaledW = Math.floor(profile.w * scale)
  const scaledH = Math.floor(profile.h * scale)

  return (
    <div
      className={`web-preview${maximized ? ' web-preview-maximized' : ''}`}
      style={
        {
          ...positionStyle,
          width: widgetW,
          height: widgetH,
          '--accent': project.color
        } as unknown as React.CSSProperties
      }
    >
      <div
        className="web-preview-header"
        style={{ height: HEADER_H }}
        onMouseDown={onHeaderMouseDown}
        title={maximized ? '' : 'Drag to move'}
      >
        <span
          className="web-preview-dot"
          style={{ background: project.color, boxShadow: `0 0 6px ${project.color}` }}
        />
        <span className="web-preview-project">{project.name}</span>
        {url ? (
          <span className="web-preview-url" title={url}>
            {shortenUrl(url)}
          </span>
        ) : (
          <span className="web-preview-url web-preview-url-empty">no server</span>
        )}
        <div className="web-preview-actions">
          {url && (
            <div className="web-preview-devices">
              {(Object.keys(DEVICE_PROFILES) as DeviceProfile[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={setProfile(p)}
                  title={`${DEVICE_PROFILES[p].label} (${DEVICE_PROFILES[p].w}×${DEVICE_PROFILES[p].h})`}
                  className={`web-preview-device${device === p ? ' web-preview-device-active' : ''}`}
                >
                  <Icon name={DEVICE_ICONS[p]} size={13} />
                </button>
              ))}
            </div>
          )}
          {url && (
            <>
              <button
                type="button"
                onClick={restartServer}
                title="Restart dev server (⇧⌘R)"
                className="web-preview-btn"
              >
                <Icon name="power" size={13} />
              </button>
              <button type="button" onClick={reload} title="Reload" className="web-preview-btn">
                <Icon name="reload" size={13} />
              </button>
              <button
                type="button"
                onClick={openExternal}
                title="Open in Chrome"
                className="web-preview-btn"
              >
                <Icon name="external" size={13} />
              </button>
              <span className="web-preview-divider" aria-hidden="true" />
              <button
                type="button"
                onClick={toggleMaximize}
                title={maximized ? 'Exit maximize (Esc)' : 'Maximize'}
                className={`web-preview-btn${maximized ? ' web-preview-btn-active' : ''}`}
              >
                <Icon name={maximized ? 'restore' : 'max'} size={13} />
              </button>
              <button
                type="button"
                onClick={handleMinimize}
                title="Minimize to corner pill"
                className="web-preview-btn"
              >
                <Icon name="minus" size={13} />
              </button>
              <button
                type="button"
                onClick={handleClose}
                title="Hide preview (server keeps running)"
                className="web-preview-btn"
              >
                <Icon name="close" size={13} />
              </button>
            </>
          )}
          {!url && (
            <>
              <button
                type="button"
                onClick={handleMinimize}
                title="Minimize to corner pill"
                className="web-preview-btn"
              >
                <Icon name="minus" size={13} />
              </button>
              <button
                type="button"
                onClick={handleClose}
                title="Hide preview"
                className="web-preview-btn"
              >
                <Icon name="close" size={13} />
              </button>
            </>
          )}
        </div>
      </div>

      <div className="web-preview-body">
        {url ? (
          <div className="web-preview-scale-wrapper" style={{ width: scaledW, height: scaledH }}>
            <div
              className="web-preview-scale-inner"
              style={{
                width: profile.w,
                height: profile.h,
                transform: `scale(${scale})`,
                transformOrigin: 'top left'
              }}
            >
              {(() => {
                const Webview = 'webview' as unknown as React.ElementType
                return (
                  <Webview
                    ref={webviewRef as unknown as React.Ref<HTMLElement>}
                    src={url}
                    allowpopups="true"
                    className="web-preview-frame"
                    style={{
                      display: 'flex',
                      width: profile.w,
                      height: profile.h
                    }}
                  />
                )
              })()}
            </div>
          </div>
        ) : (
          <div className="web-preview-empty">
            <div className="web-preview-empty-title">No dev server</div>
            <div className="web-preview-empty-hint">
              Start the local dev server for <strong>{project.name}</strong>?
            </div>
            <button
              type="button"
              className="web-preview-start"
              onClick={() => onStartDevServer(project)}
            >
              <Icon name="chevron-right" size={11} /> Pane käima
            </button>
          </div>
        )}
        {loading && url && <div className="web-preview-loading-strip" />}
        {failure && url && (
          <div className="web-preview-fail">
            <div className="web-preview-fail-title">Preview failed</div>
            <div className="web-preview-fail-detail">{failure}</div>
            <div className="web-preview-fail-hint">
              Site may block embedding. Try opening externally.
            </div>
            <div className="web-preview-fail-actions">
              <button type="button" className="web-preview-btn-primary" onClick={reload}>
                <Icon name="reload" size={11} /> Retry
              </button>
              <button type="button" className="web-preview-btn-primary" onClick={openExternal}>
                <Icon name="external" size={11} /> Open in Chrome
              </button>
            </div>
          </div>
        )}
        {autoDispatchToast && (
          <div className="web-preview-toast">
            <Icon name="send" size={11} />
            <span>{autoDispatchToast}</span>
          </div>
        )}
      </div>

      {!maximized && <div className="web-preview-resize-handle" onMouseDown={onResizeMouseDown} />}
    </div>
  )
}

function shortenUrl(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname === '/' ? '' : u.pathname
    return `${u.host}${path}`
  } catch {
    return url
  }
}
