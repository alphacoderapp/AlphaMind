import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { Icon, type IconName } from './Icon'
import { MasterThinkOrb } from './MasterThinkOrb'

interface ToolCall {
  id: string
  name: string
  input?: Record<string, unknown>
  status: 'running' | 'done' | 'error'
}

const TOOL_LABELS: Record<string, string> = {
  list_open_tabs: 'Checking tabs',
  list_all_projects: 'Listing projects',
  dispatch_to_worker: 'Dispatching to worker',
  inject_prompt: 'Sending prompt',
  read_output: 'Reading output',
  wait_for_idle: 'Waiting for worker',
  git_status: 'Git status',
  git_log: 'Git log',
  read_file: 'Reading file',
  create_project: 'Creating project',
  open_tab: 'Opening tab',
  close_tab: 'Closing tab',
  switch_tab: 'Switching tab',
  open_url: 'Opening browser'
}

function formatToolName(tc: ToolCall): string {
  const short = (tc.name || 'tool').replace(/^mcp__orchestrator__/, '')
  const label = TOOL_LABELS[short] || short
  const input = tc.input || {}
  const arg = (() => {
    if (typeof input.url === 'string') return input.url
    if (typeof input.relativePath === 'string') return input.relativePath
    if (typeof input.path === 'string') return input.path
    if (typeof input.projectPath === 'string') return input.projectPath.split('/').pop()
    if (typeof input.name === 'string') return input.name
    return ''
  })()
  return arg ? `${label} · ${arg}` : label
}

interface WorkerActivity {
  tabId: string
  projectName: string
  status: 'queued' | 'start' | 'tick' | 'done' | 'timeout'
  elapsedMs: number
  snippet: string
}

interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  toolCalls?: ToolCall[]
  streaming?: boolean
  timestamp: number
}

interface Props {
  collapsed: boolean
  onToggleCollapse: () => void
  height: number
  onResize: (height: number) => void
}

interface AnyEvent {
  type?: string
  message?: {
    content?: Array<{
      type?: string
      text?: string
      name?: string
      id?: string
      tool_use_id?: string
      input?: Record<string, unknown>
    }>
  }
  result?: string
  error?: string
}

function extractFromEvent(event: unknown): { textDelta?: string; toolCalls?: ToolCall[]; done?: boolean; error?: string; resultText?: string } {
  if (!event || typeof event !== 'object') return {}
  const e = event as AnyEvent

  if (e.type === 'done') return { done: true }
  if (e.type === 'error') return { error: e.error || 'unknown error' }

  if (e.type === 'assistant') {
    const blocks = e.message?.content ?? []
    let textDelta = ''
    const toolCalls: ToolCall[] = []
    for (const b of blocks) {
      if (b?.type === 'text' && typeof b.text === 'string') {
        textDelta += b.text
      } else if (b?.type === 'tool_use' && b.name) {
        toolCalls.push({
          id: b.id ?? Math.random().toString(36),
          name: b.name,
          input: b.input,
          status: 'running'
        })
      }
    }
    return { textDelta, toolCalls: toolCalls.length > 0 ? toolCalls : undefined }
  }

  if (e.type === 'user') {
    // tool result events
    const blocks = e.message?.content ?? []
    const completed: ToolCall[] = []
    for (const b of blocks) {
      if (b?.type === 'tool_result' && b.tool_use_id) {
        completed.push({ id: b.tool_use_id, name: '', status: 'done' })
      }
    }
    return { toolCalls: completed.length > 0 ? completed : undefined }
  }

  if (e.type === 'result') {
    const text = typeof e.result === 'string' ? e.result : undefined
    return { done: true, resultText: text }
  }

  return {}
}

interface MasterAttachment {
  path: string
  name: string
  mimeType: string
  sizeBytes: number
  previewDataUrl?: string
}

const MAX_FILE_BYTES = 20 * 1024 * 1024

export function MasterPane({ collapsed, onToggleCollapse, height, onResize }: Props) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [workers, setWorkers] = useState<Map<string, WorkerActivity>>(new Map())
  const [parallelOpen, setParallelOpen] = useState(false)
  const [parallelTasks, setParallelTasks] = useState('')
  const [attachments, setAttachments] = useState<MasterAttachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)
  const requestIdRef = useRef<string | null>(null)
  const streamingMsgIdRef = useRef<string | null>(null)
  const [lastDeltaTs, setLastDeltaTs] = useState(0)
  const [lastToolTs, setLastToolTs] = useState(0)
  const [nowTs, setNowTs] = useState(0)
  // Rolling token-rate sample for intensity. Tracks total assistant chars
  // emitted in the last ~1.5s so a fast streaming response pushes intensity
  // up and a slow one keeps it modest.
  const charSamplesRef = useRef<{ ts: number; total: number }[]>([])
  const totalCharsRef = useRef(0)
  const [tokenRate, setTokenRate] = useState(0)

  // Tick fast so intensity feels live. Idle: 200ms is enough (orb just drifts).
  // Active (sending OR recent activity): 80ms so radial pulses + decay look
  // smooth instead of stepped.
  useEffect(() => {
    const since = Math.min(
      Date.now() - lastDeltaTs,
      Date.now() - lastToolTs
    )
    const fastMode = sending || since < 1500
    const interval = fastMode ? 80 : 200
    const id = window.setInterval(() => {
      const now = Date.now()
      setNowTs(now)
      // recompute rolling token rate from sample window
      const cutoff = now - 1500
      charSamplesRef.current = charSamplesRef.current.filter((s) => s.ts >= cutoff)
      const samples = charSamplesRef.current
      if (samples.length >= 2) {
        const first = samples[0]!
        const last = samples[samples.length - 1]!
        const dt = (last.ts - first.ts) / 1000
        const dc = last.total - first.total
        setTokenRate(dt > 0 ? dc / dt : 0)
      } else {
        setTokenRate(0)
      }
    }, interval)
    return () => window.clearInterval(id)
  }, [sending, lastDeltaTs, lastToolTs])

  // Continuous intensity 0-1 — feeds the orb's rotation, breath, glow.
  // Components: baseline (sending), token-rate (speaking), tool-call pulse
  // (decaying spike), running-worker count. Clamped to [0,1].
  const orbIntensity = (() => {
    let i = 0
    if (sending) i += 0.25
    // Token rate: 80 chars/s = full speak intensity. Caps at 0.5.
    i += Math.min(0.5, tokenRate / 160)
    // Recent tool-call → 200ms spike that decays over 700ms.
    const sinceTool = nowTs - lastToolTs
    if (sinceTool < 700) {
      const decay = Math.exp(-sinceTool / 250)
      i += 0.4 * decay
    }
    // Active workers → bias intensity up.
    const runningWorkers = Array.from(workers.values()).filter(
      (w) => w.status === 'start' || w.status === 'tick' || w.status === 'queued'
    ).length
    if (runningWorkers > 0) i += Math.min(0.3, runningWorkers * 0.1)
    return Math.min(1, Math.max(0, i))
  })()

  // Load persisted master conversation on mount
  const historyLoadedRef = useRef(false)
  useEffect(() => {
    if (historyLoadedRef.current) return
    historyLoadedRef.current = true
    window.api.master
      .loadHistory()
      .then((data) => {
        if (!data || !data.messages || data.messages.length === 0) return
        // Restore but mark non-streaming so the spinner doesn't show
        const restored: Message[] = data.messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          streaming: false
        }))
        setMessages(restored)
      })
      .catch((e) => console.error('Master history load failed:', e))
  }, [])

  // Persist conversation on changes (debounced). Saves streaming messages too —
  // their partial content is still better than losing the whole turn if the app
  // crashes mid-stream. Restore marks them streaming:false.
  const messagesRef = useRef<Message[]>([])
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  const persistNow = useCallback(() => {
    const msgs = messagesRef.current
    if (msgs.length === 0) return
    const persistable = msgs
      .filter((m) => m.content && m.content.trim().length > 0)
      .map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp
      }))
    window.api.master
      .saveHistory(persistable)
      .catch((e) => console.error('Master history save failed:', e))
  }, [])

  useEffect(() => {
    if (!historyLoadedRef.current) return
    if (messages.length === 0) return
    const t = setTimeout(persistNow, 500)
    return () => clearTimeout(t)
  }, [messages, persistNow])

  useEffect(() => {
    return window.api.master.onWorkerActivity((evt) => {
      const e = evt as WorkerActivity
      setWorkers((prev) => {
        const next = new Map(prev)
        if (e.status === 'done' || e.status === 'timeout') {
          // Keep visible briefly with final state, then drop
          next.set(e.tabId, e)
          setTimeout(() => {
            setWorkers((p) => {
              const cur = p.get(e.tabId)
              if (cur && cur.status !== 'tick' && cur.status !== 'start') {
                const n = new Map(p)
                n.delete(e.tabId)
                return n
              }
              return p
            })
          }, 2500)
        } else {
          next.set(e.tabId, e)
        }
        return next
      })
    })
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Listen for streaming events
  useEffect(() => {
    return window.api.master.onEvent((requestId, event) => {
      if (requestId !== requestIdRef.current) return

      const parsed = extractFromEvent(event)

      if (parsed.error) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `Error: ${parsed.error}`,
            timestamp: Date.now()
          }
        ])
        setSending(false)
        requestIdRef.current = null
        streamingMsgIdRef.current = null
        return
      }

      if (parsed.done) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === streamingMsgIdRef.current ? { ...m, streaming: false, content: parsed.resultText && !m.content ? parsed.resultText : m.content } : m
          )
        )
        setSending(false)
        requestIdRef.current = null
        streamingMsgIdRef.current = null
        // Force-save immediately on completion so a crash/restart between turns
        // doesn't lose the just-finished assistant response. Use setTimeout(0)
        // so the messagesRef has the latest streaming:false state.
        setTimeout(persistNow, 0)
        return
      }

      if (parsed.textDelta) {
        setLastDeltaTs(Date.now())
        totalCharsRef.current += parsed.textDelta.length
        charSamplesRef.current.push({ ts: Date.now(), total: totalCharsRef.current })
      }
      if (parsed.toolCalls && parsed.toolCalls.length > 0) {
        setLastToolTs(Date.now())
      }
      if (parsed.textDelta || parsed.toolCalls) {
        setMessages((prev) => {
          const lastIdx = prev.length - 1
          const last = prev[lastIdx]
          if (!last || last.role !== 'assistant' || last.id !== streamingMsgIdRef.current) {
            const id = crypto.randomUUID()
            streamingMsgIdRef.current = id
            return [
              ...prev,
              {
                id,
                role: 'assistant',
                content: parsed.textDelta ?? '',
                toolCalls: parsed.toolCalls ?? [],
                streaming: true,
                timestamp: Date.now()
              }
            ]
          }
          // merge into existing streaming message
          const merged: Message = {
            ...last,
            content: last.content + (parsed.textDelta ?? ''),
            toolCalls: parsed.toolCalls
              ? mergeToolCalls(last.toolCalls ?? [], parsed.toolCalls)
              : last.toolCalls
          }
          return [...prev.slice(0, lastIdx), merged]
        })
      }
    })
  }, [])

  const sendPrompt = useCallback(
    async (text: string, extraAttachments: MasterAttachment[] = []) => {
      const trimmed = text.trim()
      const combinedAttachments = [...attachments, ...extraAttachments]
      if ((!trimmed && combinedAttachments.length === 0) || sending) return

      // Render attachments inline in the user-visible message so the chat shows
      // the user "I sent these files". The actual prompt to master gets the
      // raw paths via the attachmentPaths IPC arg.
      const attachmentSummary =
        combinedAttachments.length > 0
          ? combinedAttachments.map((a) => `📎 ${a.name}`).join('  ')
          : ''
      const displayContent = [trimmed, attachmentSummary].filter(Boolean).join('\n\n')

      const userMsg: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        content: displayContent || '(attachments)',
        timestamp: Date.now()
      }
      const history = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(-8)
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content
        }))
        .filter((m) => m.content.trim().length > 0)

      const paths = combinedAttachments.map((a) => a.path)
      setMessages((prev) => [...prev, userMsg])
      setInput('')
      setAttachments([])
      setUploadError(null)
      setSending(true)
      streamingMsgIdRef.current = null

      try {
        const requestId = await window.api.master.sendStart(
          trimmed || 'Look at the attached file(s).',
          history,
          paths.length > 0 ? paths : undefined
        )
        requestIdRef.current = requestId
      } catch (e) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `Error: ${e instanceof Error ? e.message : String(e)}`,
            timestamp: Date.now()
          }
        ])
        setSending(false)
      }
    },
    [messages, sending, attachments]
  )

  // Allow other components (like WebPreview's "Pane käima" button) to drop a
  // pre-built prompt into the master pane via a global event.
  useEffect(() => {
    const handler = (e: Event): void => {
      const ev = e as CustomEvent<{ text: string }>
      if (!ev.detail || !ev.detail.text) return
      void sendPrompt(ev.detail.text)
    }
    window.addEventListener('master:prompt', handler)
    return () => window.removeEventListener('master:prompt', handler)
  }, [sendPrompt])

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    setUploadError(null)
    const list = Array.from(files)
    const next: MasterAttachment[] = []
    for (const file of list) {
      if (file.size > MAX_FILE_BYTES) {
        setUploadError(`${file.name} too large (cap 20 MB)`)
        continue
      }
      try {
        const buffer = await file.arrayBuffer()
        const saved = await window.api.uploads.save({
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          data: buffer
        })
        let previewDataUrl: string | undefined
        if (file.type.startsWith('image/')) {
          previewDataUrl = await blobToDataUrl(file)
        }
        next.push({ ...saved, previewDataUrl })
      } catch (e) {
        setUploadError(e instanceof Error ? e.message : String(e))
      }
    }
    if (next.length > 0) {
      setAttachments((prev) => [...prev, ...next])
    }
  }, [])

  const viewScreen = useCallback(async () => {
    if (sending) return
    setUploadError(null)
    const result = await window.api.screen.capture()
    if ('error' in result) {
      setUploadError(result.error)
      return
    }
    await sendPrompt('Vaata mu ekraani ja räägi mida sa näed.', [
      { ...result, previewDataUrl: undefined }
    ])
  }, [sending, sendPrompt])

  const onDragOver = (e: React.DragEvent): void => {
    if (Array.from(e.dataTransfer.types).includes('Files')) {
      e.preventDefault()
      setDragOver(true)
    }
  }
  const onDragLeave = (e: React.DragEvent): void => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setDragOver(false)
  }
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length > 0) {
      void handleFiles(e.dataTransfer.files)
    }
  }
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    if (!e.clipboardData) return
    const dropped: File[] = []
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind === 'file') {
        const f = item.getAsFile()
        if (f) dropped.push(f)
      }
    }
    if (dropped.length > 0) {
      e.preventDefault()
      void handleFiles(dropped)
    }
  }
  const removeAttachment = (idx: number): void => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx))
  }

  const submit = useCallback(async () => {
    const trimmed = input.trim()
    if ((!trimmed && attachments.length === 0) || sending) return

    // Slash command: /parallel opens task list modal
    if (/^\/parallel\b/i.test(trimmed)) {
      setParallelOpen(true)
      setInput('')
      return
    }

    await sendPrompt(trimmed)
  }, [input, sending, sendPrompt, attachments])

  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = { startY: e.clientY, startH: height }
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return
      const delta = dragRef.current.startY - ev.clientY
      const newH = Math.max(160, Math.min(window.innerHeight - 200, dragRef.current.startH + delta))
      onResize(newH)
    }
    const onUp = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div
      className={`master-pane${collapsed ? ' collapsed' : ''}${dragOver ? ' master-pane-drag-over' : ''}`}
      style={{ height: collapsed ? 36 : height }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {!collapsed && <div className="master-pane-handle" onMouseDown={onDragStart} />}
      <div className="master-pane-header" onClick={collapsed ? onToggleCollapse : undefined}>
        <div className="master-pane-title">
          <span className="master-pane-mark">◆</span>
          <span>MASTER</span>
          <span className="master-pane-status">{sending ? 'thinking…' : 'idle'}</span>
        </div>
        <button
          type="button"
          className="master-pane-toggle"
          onClick={(e) => {
            e.stopPropagation()
            onToggleCollapse()
          }}
          title={collapsed ? 'Expand (⌘J)' : 'Collapse (⌘J)'}
        >
          {collapsed ? '▴' : '▾'}
        </button>
      </div>
      {!collapsed && (
        <>
          <div className="master-pane-messages">
            {messages.length === 0 ? (
              <div className="master-pane-empty">
                <div className="master-pane-empty-title">MASTER CLAUDE</div>
                <div className="master-pane-empty-hint">
                  manage all projects from one window. ask anything.
                </div>
              </div>
            ) : (
              messages.map((m) => (
                <div key={m.id} className={`master-message master-message-${m.role}`}>
                  <div className="master-message-role">
                    {m.role === 'user' ? 'YOU' : m.role === 'assistant' ? '◆ MASTER' : 'SYS'}
                  </div>
                  {m.toolCalls && m.toolCalls.length > 0 && (
                    <div className="master-tool-calls">
                      {m.toolCalls.map((tc) => (
                        <div key={tc.id} className={`master-tool-call master-tool-call-${tc.status}`}>
                          <span className="master-tool-call-arrow">→</span>
                          <span className="master-tool-call-name">{formatToolName(tc)}</span>
                          <span className="master-tool-call-status">
                            {tc.status === 'running' ? '…' : tc.status === 'done' ? '✓' : '✗'}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {m.content && (
                    <div className="master-message-content">
                      <ReactMarkdown>{m.content}</ReactMarkdown>
                    </div>
                  )}
                </div>
              ))
            )}
            {sending && !streamingMsgIdRef.current && (
              <div className="master-message master-message-assistant">
                <div className="master-message-role">◆ MASTER</div>
                <div className="master-message-content master-thinking">
                  <span className="master-thinking-dot" />
                  <span className="master-thinking-dot" />
                  <span className="master-thinking-dot" />
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
          {workers.size > 0 && (
            <div className="master-workers">
              {Array.from(workers.values()).map((w) => (
                <div
                  key={w.tabId}
                  className={`master-worker master-worker-${w.status}`}
                >
                  <div className="master-worker-head">
                    <span className="master-worker-dot" />
                    <span className="master-worker-name">{w.projectName}</span>
                    <span className="master-worker-elapsed">
                      {(w.elapsedMs / 1000).toFixed(1)}s
                    </span>
                    <span className="master-worker-status">
                      {w.status === 'queued'
                        ? 'queued · waiting for prior dispatch'
                        : w.status === 'start'
                          ? 'dispatching…'
                          : w.status === 'tick'
                            ? 'working…'
                            : w.status === 'done'
                              ? 'done'
                              : 'timeout'}
                    </span>
                  </div>
                  {w.snippet && (
                    <pre className="master-worker-tail">{w.snippet}</pre>
                  )}
                </div>
              ))}
            </div>
          )}
          {(attachments.length > 0 || uploadError) && (
            <div className="master-pane-attachments">
              {attachments.map((a, i) => (
                <MasterAttachmentChip
                  key={`${a.path}-${i}`}
                  attachment={a}
                  onRemove={() => removeAttachment(i)}
                />
              ))}
              {uploadError && <div className="chat-upload-error">{uploadError}</div>}
            </div>
          )}
          <div className="master-pane-quick-actions">
            <button
              type="button"
              className="master-pane-quick-btn"
              onClick={viewScreen}
              disabled={sending}
              title="Master teeb ekraanipildi ja vastab selle põhjal"
            >
              Vaata ekraani
            </button>
          </div>
          <div className="master-pane-input">
            <MasterThinkOrb intensity={orbIntensity} />
            <textarea
              ref={inputRef}
              className="master-pane-textarea"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submit()
                }
              }}
              onPaste={onPaste}
              placeholder="◆ Ask master..."
              rows={2}
              disabled={sending}
            />
            <button
              type="button"
              className="master-pane-submit"
              onClick={submit}
              disabled={sending || (!input.trim() && attachments.length === 0)}
              title="Send (⏎)"
            >
              ⏎
            </button>
          </div>
        </>
      )}
      {parallelOpen && (
        <div
          className="master-parallel-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setParallelOpen(false)
              setParallelTasks('')
            }
          }}
        >
          <div className="master-parallel-card">
            <div className="master-parallel-header">
              <span className="master-parallel-title">PARALLEL DISPATCH</span>
              <button
                type="button"
                className="master-parallel-close"
                onClick={() => {
                  setParallelOpen(false)
                  setParallelTasks('')
                }}
                aria-label="close"
              >
                ×
              </button>
            </div>
            <div className="master-parallel-hint">
              One task per line. Master spawns one worker per task, plans
              non-overlapping scope, runs in parallel, reviews diff at the end.
              Workers will not commit — you confirm before push.
            </div>
            <textarea
              className="master-parallel-textarea"
              autoFocus
              value={parallelTasks}
              onChange={(e) => setParallelTasks(e.target.value)}
              placeholder={`Diagnose Apple sign-in regression\nImplement email login\nFix dashboard hardcoded ET locale\nFix payment-timeout email to client`}
              rows={8}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault()
                  const tasks = parallelTasks
                    .split('\n')
                    .map((t) => t.trim())
                    .filter((t) => t.length > 0)
                  if (tasks.length === 0) return
                  const numbered = tasks.map((t, i) => `${i + 1}. ${t}`).join('\n')
                  const prompt = `Run the following ${tasks.length} task(s) in parallel via the PARALLEL DISPATCH PROTOCOL (RECON → SPAWN → DISPATCH → REVIEW). Workers must not commit; you ask me before any commit/push.\n\nTASKS:\n${numbered}\n\nIf any two tasks would touch the same file, serialize those instead of parallelizing them.`
                  setParallelOpen(false)
                  setParallelTasks('')
                  sendPrompt(prompt)
                }
              }}
            />
            <div className="master-parallel-actions">
              <button
                type="button"
                className="master-parallel-cancel"
                onClick={() => {
                  setParallelOpen(false)
                  setParallelTasks('')
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="master-parallel-submit"
                disabled={parallelTasks.trim().length === 0 || sending}
                onClick={() => {
                  const tasks = parallelTasks
                    .split('\n')
                    .map((t) => t.trim())
                    .filter((t) => t.length > 0)
                  if (tasks.length === 0) return
                  const numbered = tasks.map((t, i) => `${i + 1}. ${t}`).join('\n')
                  const prompt = `Run the following ${tasks.length} task(s) in parallel via the PARALLEL DISPATCH PROTOCOL (RECON → SPAWN → DISPATCH → REVIEW). Workers must not commit; you ask me before any commit/push.\n\nTASKS:\n${numbered}\n\nIf any two tasks would touch the same file, serialize those instead of parallelizing them.`
                  setParallelOpen(false)
                  setParallelTasks('')
                  sendPrompt(prompt)
                }}
              >
                Dispatch · ⌘⏎
              </button>
            </div>
          </div>
        </div>
      )}
      {dragOver && (
        <div className="master-pane-drop-overlay">
          <div className="master-pane-drop-overlay-text">Drop to attach</div>
        </div>
      )}
    </div>
  )
}

function MasterAttachmentChip({
  attachment,
  onRemove
}: {
  attachment: MasterAttachment
  onRemove: () => void
}): React.JSX.Element {
  const isImage = attachment.mimeType.startsWith('image/')
  return (
    <div className="chat-attachment-chip" title={attachment.name}>
      {isImage && attachment.previewDataUrl ? (
        <img src={attachment.previewDataUrl} alt={attachment.name} />
      ) : (
        <span className="chat-attachment-icon">
          <Icon name={kindIconName(attachment.mimeType)} size={13} />
        </span>
      )}
      <span className="chat-attachment-name">{attachment.name}</span>
      <span className="chat-attachment-size">{formatBytes(attachment.sizeBytes)}</span>
      <button
        type="button"
        className="chat-attachment-remove"
        onClick={onRemove}
        title="Remove"
      >
        <Icon name="close" size={11} />
      </button>
    </div>
  )
}

function kindIconName(mime: string): IconName {
  if (mime.startsWith('video/')) return 'attach-video'
  if (mime === 'application/pdf') return 'attach-doc'
  if (mime.startsWith('audio/')) return 'attach-audio'
  if (mime.startsWith('text/')) return 'attach-doc'
  if (mime.startsWith('image/')) return 'attach-image'
  return 'attach'
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function blobToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

function mergeToolCalls(existing: ToolCall[], incoming: ToolCall[]): ToolCall[] {
  const result = [...existing]
  for (const tc of incoming) {
    const idx = result.findIndex((e) => e.id === tc.id)
    if (idx === -1) {
      result.push(tc)
    } else {
      const cur = result[idx]!
      result[idx] = {
        ...cur,
        name: tc.name && tc.name.length > 0 ? tc.name : cur.name,
        input: tc.input ?? cur.input,
        status: tc.status
      }
    }
  }
  return result
}
