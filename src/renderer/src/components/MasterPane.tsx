import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'

interface ToolCall {
  id: string
  name: string
  status: 'running' | 'done' | 'error'
}

interface WorkerActivity {
  tabId: string
  projectName: string
  status: 'start' | 'tick' | 'done' | 'timeout'
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

export function MasterPane({ collapsed, onToggleCollapse, height, onResize }: Props) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [workers, setWorkers] = useState<Map<string, WorkerActivity>>(new Map())
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)
  const requestIdRef = useRef<string | null>(null)
  const streamingMsgIdRef = useRef<string | null>(null)

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
        return
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

  const submit = useCallback(async () => {
    const trimmed = input.trim()
    if (!trimmed || sending) return

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed,
      timestamp: Date.now()
    }
    // Build history (last 8 turns, user+assistant only) BEFORE state update
    const history = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-8)
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content
      }))
      .filter((m) => m.content.trim().length > 0)

    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setSending(true)
    streamingMsgIdRef.current = null

    try {
      const requestId = await window.api.master.sendStart(trimmed, history)
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
  }, [input, sending])

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
      className={`master-pane${collapsed ? ' collapsed' : ''}`}
      style={{ height: collapsed ? 36 : height }}
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
                          <span className="master-tool-call-name">
                            {(tc.name || 'tool').replace(/^mcp__orchestrator__/, '')}
                          </span>
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
                      {w.status === 'start'
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
          <div className="master-pane-input">
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
              placeholder="◆ Ask master..."
              rows={2}
              disabled={sending}
            />
            <button
              type="button"
              className="master-pane-submit"
              onClick={submit}
              disabled={sending || !input.trim()}
              title="Send (⏎)"
            >
              ⏎
            </button>
          </div>
        </>
      )}
    </div>
  )
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
        status: tc.status
      }
    }
  }
  return result
}
