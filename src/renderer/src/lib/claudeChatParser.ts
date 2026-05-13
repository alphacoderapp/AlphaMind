// Parses xterm.js buffer lines (already ANSI-resolved) into chat-style
// message blocks. Best-effort heuristic — claude CLI's TUI format may shift
// between versions, so we keep the rules tolerant and fall back to assistant
// text for anything we don't recognize.

export type ChatItem =
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string }
  | { type: 'tool'; name: string; args: string; output: string }
  | { type: 'status'; text: string }

const USER_PROMPT_RE = /^\s*[>›❯]\s+(.+)$/
const STATUS_RE = /^[*✻✸✦✺⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+(.+?)(?:\s*\(esc to interrupt\))?$/
const TOOL_CALL_RE = /^[●⏺]\s+([A-Z][\w-]*)\((.*)\)\s*$/
const BANNER_RE = /^\s*(╭|╰|│|─|═|╔|╗|╚|╝|║|━|┃|┏|┓|┗|┛|┣|┫|┳|┻|╋)/
const HELP_HINT_RE = /(ctrl\+v to paste|esc to interrupt|shift\+enter)/i

// Strip box-drawing decoration lines, completely empty lines collapsed.
function isDecorative(line: string): boolean {
  if (!line) return true
  const trimmed = line.trim()
  if (!trimmed) return true
  if (BANNER_RE.test(line)) return true
  if (HELP_HINT_RE.test(trimmed) && trimmed.length < 80) return true
  return false
}

// Find the index of the input-prompt area at the end of the buffer.
// Returns -1 if not found.
function findInputPromptStart(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    if (USER_PROMPT_RE.test(line)) {
      // Walk up while preceding line is a box-drawing line (input border).
      let start = i
      while (start > 0 && BANNER_RE.test(lines[start - 1] ?? '')) {
        start--
      }
      return start
    }
  }
  return -1
}

// Detect if a line starts a *past* user message (claude shows them inline
// in the scrollback as `> text` blocks). The currently-being-typed prompt
// is at the end and excluded by findInputPromptStart.
function isPastUserMessage(line: string): boolean {
  return USER_PROMPT_RE.test(line)
}

export function parseClaudeBuffer(rawLines: string[]): ChatItem[] {
  const inputStart = findInputPromptStart(rawLines)
  const lines = inputStart >= 0 ? rawLines.slice(0, inputStart) : rawLines

  const items: ChatItem[] = []
  let assistantBuf: string[] = []
  let currentTool: { name: string; args: string; output: string[] } | null = null

  const flushAssistant = (): void => {
    if (assistantBuf.length === 0) return
    const text = assistantBuf
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    if (text) items.push({ type: 'assistant', text })
    assistantBuf = []
  }

  const flushTool = (): void => {
    if (!currentTool) return
    items.push({
      type: 'tool',
      name: currentTool.name,
      args: currentTool.args,
      output: currentTool.output.join('\n').trim()
    })
    currentTool = null
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')

    if (isDecorative(line)) {
      // Blank/box line. If we're inside a tool block, treat blank as end-of-output.
      if (currentTool && line.trim() === '') {
        // continue collecting; tool output may have blank lines
      }
      continue
    }

    const userMatch = USER_PROMPT_RE.exec(line)
    if (userMatch) {
      flushAssistant()
      flushTool()
      items.push({ type: 'user', text: userMatch[1]!.trim() })
      continue
    }

    const toolMatch = TOOL_CALL_RE.exec(line)
    if (toolMatch) {
      flushAssistant()
      flushTool()
      currentTool = {
        name: toolMatch[1]!,
        args: (toolMatch[2] ?? '').trim(),
        output: []
      }
      continue
    }

    const statusMatch = STATUS_RE.exec(line)
    if (statusMatch && line.length < 120) {
      flushAssistant()
      flushTool()
      items.push({ type: 'status', text: statusMatch[1]!.trim() })
      continue
    }

    // Continuation of a tool block: indented output lines below the call.
    if (currentTool && (line.startsWith('  ') || line.startsWith('\t'))) {
      currentTool.output.push(line.replace(/^\s+/, ''))
      continue
    }

    // Anything that breaks out of a tool block ends it.
    if (currentTool) {
      flushTool()
    }

    assistantBuf.push(line)
  }

  flushTool()
  flushAssistant()

  return items
}

// Read xterm's full buffer (including scrollback) into plain text lines.
export function readTerminalLines(term: {
  buffer: { active: { length: number; getLine: (y: number) => { translateToString: (trimRight?: boolean) => string } | undefined } }
}): string[] {
  const lines: string[] = []
  const buf = term.buffer.active
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y)
    if (line) lines.push(line.translateToString(true))
  }
  return lines
}
