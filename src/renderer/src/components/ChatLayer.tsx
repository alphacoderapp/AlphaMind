import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Terminal } from '@xterm/xterm'
import { parseClaudeBuffer, readTerminalLines, type ChatItem } from '../lib/claudeChatParser'
import { Icon, type IconName } from './Icon'

export interface ChatAttachment {
  path: string
  name: string
  mimeType: string
  sizeBytes: number
  previewDataUrl?: string
}

interface Props {
  ptyId: string
  terminal: Terminal
  accent: string
  active: boolean
  input: string
  onInputChange: (value: string) => void
  attachments: ChatAttachment[]
  onAttachmentsChange: (attachments: ChatAttachment[]) => void
}

const REPARSE_DEBOUNCE_MS = 120
const MAX_FILE_BYTES = 20 * 1024 * 1024

export function ChatLayer({
  ptyId,
  terminal,
  accent,
  active,
  input,
  onInputChange,
  attachments,
  onAttachmentsChange
}: Props) {
  const [items, setItems] = useState<ChatItem[]>([])
  const [stuckToBottom, setStuckToBottom] = useState(true)
  const [dragOver, setDragOver] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const reparseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Re-parse the terminal buffer on every write event (debounced).
  useEffect(() => {
    const reparse = (): void => {
      try {
        const lines = readTerminalLines(terminal)
        const parsed = parseClaudeBuffer(lines)
        setItems(parsed)
      } catch (e) {
        console.error('chat parse failed', e)
      }
    }

    reparse()

    const schedule = (): void => {
      if (reparseTimer.current) clearTimeout(reparseTimer.current)
      reparseTimer.current = setTimeout(reparse, REPARSE_DEBOUNCE_MS)
    }

    const writeDisp = terminal.onWriteParsed(schedule)
    const cursorDisp = terminal.onCursorMove(schedule)

    return () => {
      if (reparseTimer.current) clearTimeout(reparseTimer.current)
      writeDisp.dispose()
      cursorDisp.dispose()
    }
  }, [terminal])

  // Track scroll position so we only auto-scroll when user is at bottom.
  useEffect(() => {
    const el = messagesRef.current
    if (!el) return
    const onScroll = (): void => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      setStuckToBottom(distance < 32)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useLayoutEffect(() => {
    if (!stuckToBottom) return
    const el = messagesRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items, stuckToBottom])

  // Focus the input when the chat layer becomes active.
  useEffect(() => {
    if (active) textareaRef.current?.focus()
  }, [active])

  const send = (): void => {
    const text = input.trim()
    if (!text && attachments.length === 0) return
    // Compose: text + @path for each attachment so claude TUI auto-loads them
    // as content blocks.
    const parts: string[] = []
    if (text) parts.push(text)
    for (const a of attachments) parts.push(`@${a.path}`)
    const composed = parts.join(' ')
    window.api.pty.write(ptyId, composed)
    onInputChange('')
    onAttachmentsChange([])
    setUploadError(null)
    setTimeout(() => {
      window.api.pty.write(ptyId, '\r')
    }, 80)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      send()
    }
  }

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      setUploadError(null)
      const list = Array.from(files)
      const next: ChatAttachment[] = []
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
        onAttachmentsChange([...attachments, ...next])
      }
    },
    [attachments, onAttachmentsChange]
  )

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
    onAttachmentsChange(attachments.filter((_, i) => i !== idx))
  }

  // Auto-resize textarea up to a cap.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [input])

  const lastStatus = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]
      if (it && it.type === 'status') return it.text
      if (it && (it.type === 'assistant' || it.type === 'user')) break
    }
    return null
  }, [items])

  const renderItems = useMemo(() => items.filter((it) => it.type !== 'status'), [items])

  return (
    <div
      className={`chat-layer${dragOver ? ' chat-layer-drag-over' : ''}`}
      style={{ '--chat-accent': accent } as React.CSSProperties}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="chat-messages" ref={messagesRef}>
        {renderItems.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-mark" style={{ background: accent, boxShadow: `0 0 12px ${accent}` }} />
            <div className="chat-empty-title">Chat view</div>
            <div className="chat-empty-hint">
              Start typing below — same session, prettier surface.
              <br />
              Drop files anywhere to attach. Toggle to terminal anytime.
            </div>
          </div>
        ) : (
          renderItems.map((item, i) => {
            if (item.type === 'user') {
              return (
                <div className="chat-bubble chat-bubble-user" key={i}>
                  <div className="chat-bubble-role">YOU</div>
                  <div className="chat-bubble-body">{item.text}</div>
                </div>
              )
            }
            if (item.type === 'assistant') {
              return (
                <div className="chat-bubble chat-bubble-assistant" key={i}>
                  <div className="chat-bubble-role">CLAUDE</div>
                  <div className="chat-bubble-body chat-bubble-md">
                    <ReactMarkdown>{item.text}</ReactMarkdown>
                  </div>
                </div>
              )
            }
            if (item.type === 'tool') {
              return (
                <details className="chat-tool" key={i}>
                  <summary>
                    <span className="chat-tool-arrow">▸</span>
                    <span className="chat-tool-name">{item.name}</span>
                    {item.args && <span className="chat-tool-args">{truncate(item.args, 80)}</span>}
                  </summary>
                  {item.output && <pre className="chat-tool-output">{item.output}</pre>}
                </details>
              )
            }
            return null
          })
        )}
      </div>

      {lastStatus && (
        <div className="chat-status">
          <span className="chat-status-spinner">✻</span>
          <span>{lastStatus}</span>
        </div>
      )}

      {(attachments.length > 0 || uploadError) && (
        <div className="chat-attachments">
          {attachments.map((a, i) => (
            <AttachmentChip
              key={`${a.path}-${i}`}
              attachment={a}
              onRemove={() => removeAttachment(i)}
            />
          ))}
          {uploadError && <div className="chat-upload-error">{uploadError}</div>}
        </div>
      )}

      <div className="chat-input-row">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder="Message Claude…"
          rows={1}
          spellCheck={false}
        />
        <button
          type="button"
          className="chat-send"
          onClick={send}
          disabled={!input.trim() && attachments.length === 0}
          title="Send (Enter)"
        >
          <Icon name="send" size={14} />
        </button>
      </div>

      {dragOver && (
        <div className="chat-drop-overlay">
          <div className="chat-drop-overlay-text">Drop to attach</div>
        </div>
      )}
    </div>
  )
}

function AttachmentChip({
  attachment,
  onRemove
}: {
  attachment: ChatAttachment
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

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}
