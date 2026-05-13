import { z } from 'zod'
import { app, shell } from 'electron'
import { join, sep } from 'path'
import { existsSync } from 'fs'
import type { PtyManager } from './pty-manager'
import { tabRegistry } from './tab-registry'
import { getProjectStats } from './project-stats'
import { loadProjects } from './projects-store'
import { searchArchive } from './master-archive-store'

function resolveClaudeCodeBinary(): string | undefined {
  if (!app.isPackaged) return undefined
  const platform = process.platform
  const arch = process.arch
  const rel = join(
    'node_modules',
    `@anthropic-ai`,
    `claude-agent-sdk-${platform}-${arch}`,
    'claude'
  )
  const candidates = [
    join(process.resourcesPath, 'app.asar.unpacked', rel),
    join(
      process.resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk',
      rel
    )
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  try {
    const resolved = require.resolve(`@anthropic-ai/claude-agent-sdk-${platform}-${arch}/claude`)
    const marker = `${sep}app.asar${sep}`
    if (resolved.includes(marker)) {
      const unpacked = resolved.split(marker).join(`${sep}app.asar.unpacked${sep}`)
      if (existsSync(unpacked)) return unpacked
    }
    return resolved
  } catch {
    return undefined
  }
}

// Prepended to every dispatched prompt. The first paragraph is a DIRECTIVE
// ("execute the task using your tools") — without it Claude Code reads short
// task lines as conversational and produces empty responses. The output
// directive comes second so it doesn't dilute the action signal. Workers
// MUST reply with a status line, even on success — silent dispatches are how
// we ended up with the "(no response)" bug where master's prompt suffix got
// echoed back as the assistant message.
const COMPRESSION_PREFIX = `Execute the task below in this project. Use your tools (Bash for shell, Edit for code, Read for files) to actually do the work — do not just describe it. When done, reply with ONE line:
  • "DONE: <one specific fact>" on success (e.g. "DONE: server up at http://localhost:3000")
  • "FAILED: <reason>" on error
No reasoning, no plan, no recap, no parentheticals. Just execute then status line.

Task: `

const SYSTEM_PROMPT = `You are MASTER, a fast orchestrator AI for the user's project workspace in Alphacod.

CRITICAL UX CONTRACT:
- The user ONLY talks to you, in this one chat. They never type into project tabs.
- NEVER tell the user "go to the X tab" or "type Y in project". You execute everything.
- If work belongs in a project (edit code, run command, commit, test, debug, build), DISPATCH to that project's worker. Never describe steps for the user to do.
- dispatch_to_worker AUTO-DETECTS URLs in worker output and routes them to the EMBEDDED preview pane (top-right of app). If you see "[URL DETECTED: ... already shown in embedded preview pane]" in the dispatch result, the user can already see the live site IN THE APP — do NOT call open_url for the same URL. Just mention it: "Server üleval: <url> — preview vaateväljas".
- open_url is for situations where the user explicitly wants the URL in their EXTERNAL browser (e.g. "ava Chromes", "open in browser", DevTools needed). Default routing is in-app preview.
- For "run/start dev server / pane käima" tasks, ALWAYS dispatch_to_worker and trust its URL detection. Never guess ports (no "tüüpiliselt localhost:3000"). If no URL was detected, the worker is probably still building — say so and let user wait, do NOT invent ports.
- Never write "How to test:" / "Kuidas katsetada:" sections with manual steps. If something needs to happen, you do it. The only output to user is a status report of what already happened.

VISION:
- You CAN see images the user attaches (drag-drop, screenshots via "Vaata ekraani" button). Images arrive as inline visual content, NOT as file paths to Read. Describe what you actually see in pixels.
- Do NOT say "I cannot see images" or "I don't have OCR/vision". You do — Claude 4.x has multimodal vision built in.
- For screenshots of the user's screen, identify the app/window, key UI elements, error messages, and visible state. Answer the user's question about what is shown.

KNOWLEDGE BOUNDARY:
- You know NOTHING about the user's projects beyond what list_open_tabs / list_all_projects / git_status / read_file / dispatch_to_worker tell you in THIS conversation. No prior project knowledge cached.
- When the user asks "what does X do" / "mis X teeb", call read_file (e.g. README.md, package.json, CLAUDE.md inside the project) or dispatch_to_worker to ask the project's own claude. Never make up architecture details from general knowledge.
- If you don't know, say so and propose calling a tool. Don't fabricate.

LONG-TERM MEMORY (search_master_history):
- Working memory in this prompt only includes the last few turns. Anything older is on disk in a searchable archive.
- IMMEDIATELY call search_master_history when the user references past conversations: "eelmine kord", "siis kui", "mäletad", "we already talked about", "last time", "what did we decide", references to dates/weekdays, or any "X is what I asked about before" pattern.
- Also call it when YOU lack context to answer ("hetkel ma ei tea, mis sa varem otsustasid…" → search instead of guessing).
- Phrase the query specifically. BAD: "previous discussion". GOOD: "decision about ULM gate behavior when user requests parallel work".
- If results are empty or weak (low scores), say so honestly: "ei leidnud arhiivist midagi seotut".
- Don't search proactively for unrelated turns. Only when context is genuinely missing.

INVESTIGATE BEFORE ASKING:
- Before asking the user clarifying questions about a project ("did you mean X or Y?"), FIRST dispatch a discovery prompt to the project's worker: "brief 3-4 bullets: what is this, current stack, deployment, mobile/web/desktop status, what's in flight". Workers know the project deeply.
- Use the worker's answer to understand what the user means. Then ask the user ONLY about decisions/preferences the worker can't know (priorities, scope, deadlines).
- BAD: "Did you mean iOS App Store or PWA wrapper?" — when you haven't even checked if a mobile version already exists.
- GOOD: dispatch "is there a mobile version of this project? where is it deployed?" → read response → "Worker says React Native version live in App Store at v2.3. What about it: bug fix / new feature / different store listing?"
- Rule of thumb: if a question can be answered by the worker, ask the worker. Only escalate to the user when intent or preference is the gap.

ULTIMATE DEVELOPER MODE (ULM):
- Call get_workspace_state at the start of any task to check ULM status. If ULM is active for project X, the rules change.
- In ULM, the user is FOCUSED on project X. ALL dispatches go to that project's tabs unless the user explicitly references another project.
- Multiple workers for the ULM project are ALLOWED and ENCOURAGED for parallel sub-tasks.
- Workers are SEPARATE Claude Code subprocesses (independent sessions). They are NOT subagents inside you. To run work in parallel, you MUST spawn additional workers and dispatch to them — never try to do the work yourself.

PARALLEL DISPATCH PROTOCOL — when user gives N parallel tasks (N > 1), follow these phases EXACTLY:

  PHASE 1 (one assistant turn): RECON
    - get_workspace_state (confirm ULM project + existing worker count)
    - list_open_tabs
    - git_status on the project path (see in-flight changes)
    - For each task, if scope unclear, read_file the likely-affected file to estimate scope.

  PHASE 1.5: ULM GATE — STOP and DECIDE based on workspace state:
    a) ULM is ACTIVE for the right project → proceed straight to PHASE 2.
    b) ULM is OFF (ultimateMode === null) AND user wants N > 1 parallel tasks → DO NOT silently serialize.
       STOP and ask user verbatim, in their language:
         "ULM pole aktiivne <projectName> projektil. Aktiveerin selle, et <N> workerit paralleelselt jooksutada? (Y/n)"
       (English: "Ultimate Developer Mode is off for <projectName>. Activate it to run <N> workers in parallel? (Y/n)")
       Wait for user reply. End your turn here.
       On 'Y' / 'jah' / 'jah, aktiveeri' / similar: call set_ultimate_mode({projectId}) THEN proceed to PHASE 2 in the SAME turn.
       On 'n' / 'ei' / 'sequential' / similar: skip to fallback — dispatch all N tasks to the single existing tab serially (one dispatch_to_worker per task, await each).
    c) ULM is ACTIVE but for a DIFFERENT project than the one the user wants parallel work on → ask user verbatim:
         "ULM on praegu <currentProject> projektil. Vahetan <newProject> peale, et seal paralleelselt töötada? (Y/n)"
       On confirm: set_ultimate_mode({projectId: newProjectId}) then proceed.

  PHASE 2 (one assistant turn): SPAWN
    - Call spawn_parallel_worker EXACTLY (N - existing_workers) times in this single turn (parallel tool calls).
    - Capture each returned tabId.

  PHASE 3 (one assistant turn): DISPATCH
    - Call dispatch_to_workers ONCE with an array of N {tabId, prompt} pairs — they run truly in parallel and you get all results back together.
    - EACH dispatched prompt MUST contain three lines verbatim:
      1. The task description (specific, scoped).
      2. "Touch only these files/dirs: <list>"
      3. "DO NOT git commit. DO NOT git push. DO NOT git add. Only edit files. Master will commit centrally when all workers are done."

  PHASE 4 (after all dispatches return): REVIEW
    - git_status + git_diff on the project.
    - Summarize what each worker delivered in 1 sentence per worker.
    - Ask user verbatim: "All N workers idle. Diff summary above. Commit & push, or any follow-up?"
    - DO NOT commit until user confirms.

  PHASE 5 (only on user confirmation): COMMIT
    - dispatch_to_worker on a SINGLE worker tab with: "git add -A && git commit -m '<concise message>' && git push"

CONFLICT PREVENTION:
- Before PHASE 3, if two tasks plausibly touch the same file (e.g. both mention auth, both edit config, both need package.json changes), SERIALIZE those: dispatch task A, wait_for_idle, then dispatch task B to the same worker. Do NOT run them in parallel.
- Default-safe: when in doubt, serialize. The user can override with explicit "päriselt paralleelselt" / "really in parallel".
- After PHASE 4 review, if you see two workers modified the same file (overlapping diff), flag this in the review summary as ⚠ before asking to commit.

NEVER:
- Workers must NEVER commit, push, or stage. Period. Always include the "DO NOT" line in every dispatched prompt.
- Master is the only entity that touches git history.
- If user has NOT specified the parallel sub-tasks, ASK them to enumerate before spawning. Don't invent tasks.

ROUTING DECISIONS:
1. Pure metadata query (git status, recent commits, read a file) → use direct tools (git_status, git_log, read_file). Faster, no worker round-trip.
2. Code/file/build/test/commit work → dispatch_to_worker. The worker has full Claude Code capabilities (Edit, Bash, etc.) inside the project.
3. User references a project with no open tab → list_all_projects → open_tab(projectId) → dispatch_to_worker(newTabId, …). Do this transparently; don't ask.
4. User references a path that isn't a known project → create_project(path) → open_tab(newProjectId) → dispatch.
5. Multi-project task → dispatch in parallel by calling dispatch_to_worker multiple times in one assistant turn.

WORKER COMMUNICATION (FAST PATH):
- For ≥2 independent tasks: ALWAYS use dispatch_to_workers([{tabId, prompt}, …]) — ONE tool call, all run in parallel, all results returned together. This is the fastest possible orchestration.
- For 1 task or a follow-up on the same tab: use dispatch_to_worker(tabId, prompt).
- If a worker task is long-running (>30s), pass timeoutMs explicitly (e.g. 90000 for builds).
- Worker output is already stripped of TUI noise. Parse the gist; don't echo the raw stream.
- For follow-ups in the same project, reuse the same tabId (worker keeps context).
- Same tabId twice in one batch → serialised, wastes time. Use DIFFERENT tabIds for parallelism. Spawn extra workers via spawn_parallel_worker if you need more tabs.
- Don't poll a worker. If a dispatch returns 'timeout', extend timeoutMs on the NEXT call about that tab — don't spam new dispatches.

DISPATCH PROMPT RULES — when constructing the \`prompt\` arg for dispatch_to_worker:
- Write a plain imperative directive: "Run \`npm test\`. Reply DONE/FAILED with the count." — never a narrated paragraph.
- NEVER add parenthetical meta-instructions like "(no response)", "(silent)", "(quick)", "(just run)". Workers read parentheticals as conversation, not directives, and reply with the literal text instead of executing.
- NEVER tell the worker to stay silent. The dispatch tool ALREADY reads the worker's reply — workers MUST end with one status line so master can confirm completion.
- NEVER include "Task:" or "Compressed output:" prefixes — the dispatch tool prepends them automatically.
- NEVER concatenate multiple unrelated tasks in one prompt. One dispatch = one task. For N tasks, call dispatch_to_worker N times.
- For shell commands: "Run \`<command>\`. Reply DONE: <terse fact> or FAILED: <reason>."
- For file edits: "Edit <path> to <change>. Reply DONE: <one-line summary>."
- For investigation: "Read <path> and tell me <specific question>. Reply with the answer in one line."

LEGACY TOOLS — avoid:
- inject_prompt + wait_for_idle + read_output → use dispatch_to_worker instead

RESPONSE FORMAT to user:
- 1-sentence summary first.
- Bullets with: ✓ done · ⚠ needs attn · ✗ failed · × skipped · ⌛ in progress.
- Max 3-6 bullets. \`code\` for paths/commands. No preamble, no recap, no apologies.
- If you dispatched to a worker, mention which project briefly ("dispatched to Websta").

LANGUAGE — STRICT:
- ALWAYS respond in the same language the user wrote in.
- User writes Estonian → you respond Estonian. User writes English → English. Never switch mid-conversation.
- Technical identifiers (paths, function names, tool names) stay verbatim regardless of response language.

TAB DISCIPLINE:
- BEFORE open_tab, ALWAYS list_open_tabs first. If a tab for the project already exists, REUSE it (use that tabId). Only open_tab if no tab exists for that project.
- The open_tab tool itself reuses existing tabs (returns reused:true); trust the response.

Be JARVIS-fast. The user should feel that one sentence to you = real work happening across their projects.`

export type RendererControlAction =
  | { action: 'create-project'; payload: { path: string; name?: string; color?: string } }
  | { action: 'open-tab'; payload: { projectId: string } }
  | { action: 'close-tab'; payload: { tabId: string } }
  | { action: 'switch-tab'; payload: { tabId: string } }
  | { action: 'spawn-parallel-worker'; payload: { projectId: string } }
  | { action: 'get-workspace-state'; payload: Record<string, never> }
  | { action: 'set-ultimate-mode'; payload: { projectId: string | null } }
  | { action: 'set-project-preview'; payload: { projectId: string; url: string } }

export type RendererControlResult =
  | { ok: true; data?: unknown }
  | { ok: false; error: string }

export interface WorkerActivityEvent {
  tabId: string
  projectName: string
  status: 'queued' | 'start' | 'tick' | 'done' | 'timeout'
  elapsedMs: number
  snippet: string
}

interface MasterAgentDeps {
  ptyManager: PtyManager
  rendererControl: (req: RendererControlAction) => Promise<RendererControlResult>
  broadcastWorkerActivity: (event: WorkerActivityEvent) => void
}

const ANSI_REGEX = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b[=>]/g
const CONTROL_REGEX = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

function stripAnsi(s: string): string {
  return s.replace(ANSI_REGEX, '').replace(CONTROL_REGEX, '')
}

// Belt-and-suspenders sanitizer for worker prompts. The master LLM has been
// observed (a) re-prefixing with "Task:" or "Compressed output:" even though
// the dispatch tool adds those, and (b) tacking trailing parenthetical
// meta-instructions like "(no response - just run command...)" — Claude Code
// reads the parenthetical as conversational and replies with the literal
// phrase instead of executing the command. Strip these defensively so a
// regressed system prompt can't break dispatch silently.
function sanitizeWorkerPrompt(prompt: string): string {
  let s = prompt
  // Drop master-side prefixes the LLM may have duplicated.
  s = s.replace(/^\s*Compressed output:[^\n]*\n+/i, '')
  s = s.replace(/^\s*Task:\s*/i, '')
  // Drop a trailing parenthetical meta-instruction. Match the WHOLE balanced
  // parenthesis only when it's clearly a directive (contains one of the
  // known offending phrases) so we don't accidentally strip legitimate
  // notes the user wrote.
  s = s.replace(
    /\s*\([^()]*\b(no response|just run|stay silent|silent|fire.and.forget|brief only|quick only)\b[^()]*\)\s*$/i,
    ''
  )
  return s.trim()
}

function tail(s: string, lines: number): string {
  const arr = s.split('\n')
  return arr.slice(Math.max(0, arr.length - lines)).join('\n')
}

let sdkPromise: Promise<typeof import('@anthropic-ai/claude-agent-sdk')> | null = null
async function getSdk(): Promise<typeof import('@anthropic-ai/claude-agent-sdk')> {
  if (!sdkPromise) {
    sdkPromise = import('@anthropic-ai/claude-agent-sdk')
  }
  return sdkPromise
}

const POLL_INTERVAL_MS = 50
const IDLE_THRESHOLD_MS = 400
const DEFAULT_DISPATCH_TIMEOUT_MS = 60000
// Once a URL is detected the dev server is up — short post-detect grace lets
// any final stdout settle before we return. Was 1500ms, halved for snappier
// "preview is ready" feedback.
const URL_POST_DETECT_GRACE_MS = 700

// Extract URLs from worker output. Common patterns: localhost ports, deploy URLs.
const URL_REGEX = /https?:\/\/(?:[a-zA-Z0-9.-]+|localhost)(?::\d+)?(?:\/[^\s\x1b'"<>)]*)?/g

const ORCHESTRATOR_TOOL_NAMES = [
  'list_open_tabs',
  'list_all_projects',
  'dispatch_to_worker',
  'dispatch_to_workers',
  'git_status',
  'git_log',
  'git_diff',
  'read_file',
  'create_project',
  'open_tab',
  'close_tab',
  'switch_tab',
  'open_url',
  'get_workspace_state',
  'spawn_parallel_worker',
  'set_ultimate_mode',
  'search_master_history'
] as const

const BUILTIN_TOOLS_TO_BLOCK = [
  'Task',
  'Bash',
  'BashOutput',
  'KillShell',
  'Glob',
  'Grep',
  'Read',
  'Edit',
  'Write',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'ExitPlanMode'
]

export function createMasterAgent(deps: MasterAgentDeps) {
  const { ptyManager, rendererControl, broadcastWorkerActivity } = deps

  let serverCache: unknown = null

  // Per-tab serialisation. A worker tab is a single Claude Code TUI sharing
  // one PTY input stream — concurrent prompt writes interleave bytes inside
  // the TUI's editor and either corrupt the input or queue prompts that the
  // user never sees the result of. We chain dispatches to the same tabId on
  // a Promise so a later call waits for the in-flight one to finish, while
  // dispatches to OTHER tabs continue running in parallel (the original
  // parallelism property of multi-tab dispatch is preserved).
  //
  // Map value is the tail of the chain (always resolves, errors swallowed).
  // Cleared opportunistically when the tail settles and no follow-up has
  // attached, to avoid leaking entries for closed tabs.
  const tabDispatchTail = new Map<string, Promise<unknown>>()

  // Depth counter per tab — number of dispatches currently in-flight + queued
  // for that tabId. A dispatch that enters with depth > 1 was stacked by the
  // LLM rather than awaited; we surface that fact in its return so the LLM
  // sees a concrete signal next assistant turn and learns to await instead.
  const tabDispatchDepth = new Map<string, number>()

  // Core dispatch routine — shared by single (`dispatch_to_worker`) and
  // batch (`dispatch_to_workers`) tools. Returns notFound when tab is gone,
  // otherwise the formatted result text the master should see.
  async function runDispatch(
    tabId: string,
    prompt: string,
    timeoutMs?: number
  ): Promise<{ notFound: boolean; text: string }> {
    const tab = tabRegistry.get(tabId)
    if (!tab) return { notFound: true, text: '' }

    const queuedAt = Date.now()
    const depthOnEnter = (tabDispatchDepth.get(tabId) ?? 0) + 1
    tabDispatchDepth.set(tabId, depthOnEnter)
    const aheadOfMe = depthOnEnter - 1
    const prior = tabDispatchTail.get(tabId)
    if (prior) {
      broadcastWorkerActivity({
        tabId,
        projectName: tab.projectName,
        status: 'queued',
        elapsedMs: 0,
        snippet: `Queued behind ${aheadOfMe} in-flight dispatch${aheadOfMe === 1 ? '' : 'es'} · ${prompt.slice(0, 140)}`
      })
      try {
        await prior
      } catch {
        /* prior errors handled by their own dispatch */
      }
    }

    let releaseTail!: () => void
    const myTail = new Promise<void>((res) => {
      releaseTail = res
    })
    tabDispatchTail.set(tabId, myTail)

    try {
      const startTs = Date.now()
      const cleanedPrompt = sanitizeWorkerPrompt(prompt)
      const fullPrompt = COMPRESSION_PREFIX + cleanedPrompt
      ptyManager.write(tab.ptyId, fullPrompt)
      await new Promise((r) => setTimeout(r, 80))
      ptyManager.write(tab.ptyId, '\r')

      const waitedMs = startTs - queuedAt
      broadcastWorkerActivity({
        tabId,
        projectName: tab.projectName,
        status: 'start',
        elapsedMs: 0,
        snippet:
          waitedMs > 50
            ? `(waited ${waitedMs}ms in queue) ${prompt.slice(0, 180)}`
            : prompt.slice(0, 200)
      })

      const totalTimeout = timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS
      const deadline = Date.now() + totalTimeout
      let final: 'idle' | 'timeout' | 'url-detected' = 'timeout'
      let lastTickAt = 0
      let detectedUrl: string | null = null
      let urlDetectedAt = 0

      while (Date.now() < deadline) {
        const last = ptyManager.getLastDataTime(tab.ptyId) ?? startTs

        if (!detectedUrl) {
          const cleaned = stripAnsi(ptyManager.getBuffer(tab.ptyId, startTs))
          const matches = cleaned.match(URL_REGEX)
          if (matches && matches.length > 0) {
            const candidate = matches[matches.length - 1]!.replace(/[.,;:]+$/, '')
            detectedUrl = candidate
            urlDetectedAt = Date.now()
          }
        }

        if (Date.now() - last > IDLE_THRESHOLD_MS) {
          final = detectedUrl ? 'url-detected' : 'idle'
          break
        }

        if (detectedUrl && Date.now() - urlDetectedAt > URL_POST_DETECT_GRACE_MS) {
          final = 'url-detected'
          break
        }

        if (Date.now() - lastTickAt > 250) {
          lastTickAt = Date.now()
          const buf = ptyManager.getBuffer(tab.ptyId, startTs)
          const cleaned = stripAnsi(buf)
          broadcastWorkerActivity({
            tabId,
            projectName: tab.projectName,
            status: 'tick',
            elapsedMs: Date.now() - startTs,
            snippet: tail(cleaned, 4).slice(-400)
          })
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      }

      const rawOutput = ptyManager.getBuffer(tab.ptyId, startTs)
      const cleaned = stripAnsi(rawOutput).trim()

      if (detectedUrl) {
        try {
          await rendererControl({
            action: 'set-project-preview',
            payload: { projectId: tab.projectId, url: detectedUrl }
          })
        } catch {
          /* noop */
        }
      }

      broadcastWorkerActivity({
        tabId,
        projectName: tab.projectName,
        status: final === 'timeout' ? 'timeout' : 'done',
        elapsedMs: Date.now() - startTs,
        snippet: detectedUrl
          ? `Server up at ${detectedUrl} (in embedded preview)`
          : tail(cleaned, 6).slice(-500)
      })

      const urlLine = detectedUrl
        ? `\n[URL DETECTED: ${detectedUrl} — already shown in embedded preview pane; do NOT call open_url for this URL]`
        : ''

      const queueLine =
        aheadOfMe > 0
          ? `\n[QUEUE WARNING: stacked behind ${aheadOfMe} prior dispatch(es) to ${tabId} (waited ${startTs - queuedAt}ms). Use dispatch_to_workers with DIFFERENT tabIds for true parallelism.]`
          : ''

      return {
        notFound: false,
        text: `[${final} after ${Date.now() - startTs}ms · project=${tab.projectName}]${urlLine}${queueLine}\n${cleaned || '(no output)'}`
      }
    } finally {
      releaseTail()
      const newDepth = (tabDispatchDepth.get(tabId) ?? 1) - 1
      if (newDepth <= 0) tabDispatchDepth.delete(tabId)
      else tabDispatchDepth.set(tabId, newDepth)
      if (tabDispatchTail.get(tabId) === myTail) {
        tabDispatchTail.delete(tabId)
      }
    }
  }

  async function getOrchestratorServer(): Promise<unknown> {
    if (serverCache) return serverCache
    const { createSdkMcpServer, tool } = await getSdk()

    const orchestratorTools = [
      tool(
        'list_open_tabs',
        'List currently open project tabs.',
        {},
        async () => {
          const tabs = tabRegistry.getAll()
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(tabs, null, 2) }]
          }
        }
      ),

      tool(
        'list_all_projects',
        'List all configured projects.',
        {},
        async () => {
          const projects = (await loadProjects()) ?? []
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(projects, null, 2) }]
          }
        }
      ),

      tool(
        'dispatch_to_worker',
        'Send ONE task to ONE worker tab and wait for its result. PREFER dispatch_to_workers when you have N tasks — that batches them into ONE tool call running in parallel. Use this single-tab variant only for one-off tasks or follow-ups.',
        {
          tabId: z.string().describe('Tab ID from list_open_tabs'),
          prompt: z.string().describe('Task for the worker'),
          timeoutMs: z
            .number()
            .optional()
            .describe(`Max wait ms (default ${DEFAULT_DISPATCH_TIMEOUT_MS})`)
        },
        async ({ tabId, prompt, timeoutMs }) => {
          const result = await runDispatch(tabId, prompt, timeoutMs)
          if (result.notFound) {
            return {
              content: [{ type: 'text' as const, text: `Error: tab ${tabId} not found` }],
              isError: true
            }
          }
          return { content: [{ type: 'text' as const, text: result.text }] }
        }
      ),

      tool(
        'dispatch_to_workers',
        'BATCH PARALLEL DISPATCH. Send N tasks to N worker tabs in ONE call — all run concurrently and you get all results back together. Use this whenever you have ≥2 independent tasks across different tabs. Each item: {tabId, prompt, timeoutMs?}. Returns one result block per task in order. Tabs MUST be different — same tabId twice in one batch will serialise and waste time.',
        {
          dispatches: z
            .array(
              z.object({
                tabId: z.string().describe('Tab ID'),
                prompt: z.string().describe('Task for that worker'),
                timeoutMs: z.number().optional()
              })
            )
            .min(1)
            .describe('Array of dispatches (≥1)')
        },
        async ({ dispatches }) => {
          const results = await Promise.all(
            dispatches.map((d) => runDispatch(d.tabId, d.prompt, d.timeoutMs))
          )
          const blocks = results.map((r, i) => {
            const d = dispatches[i]!
            if (r.notFound) return `[#${i + 1} tabId=${d.tabId}] Error: tab not found`
            return `[#${i + 1} tabId=${d.tabId}]\n${r.text}`
          })
          return {
            content: [{ type: 'text' as const, text: blocks.join('\n\n---\n\n') }]
          }
        }
      ),

      tool(
        'git_status',
        'Get git status for a project path.',
        {
          projectPath: z.string().describe('Absolute project path')
        },
        async ({ projectPath }) => {
          try {
            const stats = await getProjectStats(projectPath)
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(stats.git, null, 2) }]
            }
          } catch (e) {
            return {
              content: [
                { type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }
              ],
              isError: true
            }
          }
        }
      ),

      tool(
        'git_diff',
        'Get uncommitted git diff (unstaged + staged) for a project. Use after parallel workers finish to review aggregate changes before committing centrally.',
        {
          projectPath: z.string().describe('Absolute project path'),
          maxBytes: z
            .number()
            .optional()
            .describe('Truncate diff at this many bytes (default 20000)')
        },
        async ({ projectPath, maxBytes }) => {
          try {
            const { exec } = await import('child_process')
            const { promisify } = await import('util')
            const execP = promisify(exec)
            const cap = maxBytes ?? 20000
            const { stdout: status } = await execP(`git -C "${projectPath}" status --short`, {
              maxBuffer: 1024 * 1024
            })
            const { stdout: diff } = await execP(`git -C "${projectPath}" diff HEAD`, {
              maxBuffer: 5 * 1024 * 1024
            })
            const truncated = diff.length > cap
            const body =
              `=== STATUS (short) ===\n${status || '(clean)'}\n\n=== DIFF (HEAD) ===\n` +
              (truncated ? diff.slice(0, cap) + `\n\n...[truncated, ${diff.length} bytes total]` : diff || '(no diff)')
            return {
              content: [{ type: 'text' as const, text: body }]
            }
          } catch (e) {
            return {
              content: [
                { type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }
              ],
              isError: true
            }
          }
        }
      ),

      tool(
        'git_log',
        'Recent commits for a project.',
        {
          projectPath: z.string().describe('Absolute project path'),
          limit: z.number().optional().describe('Max commits (default 5)')
        },
        async ({ projectPath, limit }) => {
          try {
            const stats = await getProjectStats(projectPath)
            const commits = (stats.git.recentCommits ?? []).slice(0, limit ?? 5)
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(commits, null, 2) }]
            }
          } catch (e) {
            return {
              content: [
                { type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }
              ],
              isError: true
            }
          }
        }
      ),

      tool(
        'read_file',
        'Read a file from a project (relative path).',
        {
          projectPath: z.string().describe('Absolute project path'),
          relativePath: z.string().describe('Relative path within project')
        },
        async ({ projectPath, relativePath }) => {
          try {
            const { readFile } = await import('fs/promises')
            const fullPath = join(projectPath, relativePath)
            const content = await readFile(fullPath, 'utf-8')
            const truncated = content.length > 10000
            return {
              content: [
                {
                  type: 'text' as const,
                  text: truncated
                    ? content.slice(0, 10000) + '\n...[truncated, file >10KB]'
                    : content
                }
              ]
            }
          } catch (e) {
            return {
              content: [
                { type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }
              ],
              isError: true
            }
          }
        }
      ),

      tool(
        'create_project',
        'Create a new project entry from an absolute folder path. Adds to sidebar. Use open_tab afterwards to spawn a tab.',
        {
          path: z.string().describe('Absolute folder path'),
          name: z.string().optional().describe('Display name (default: basename of path)'),
          color: z.string().optional().describe('Hex color e.g. #34d399')
        },
        async ({ path, name, color }) => {
          const result = await rendererControl({
            action: 'create-project',
            payload: { path, name, color }
          })
          if (!result.ok) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${result.error}` }],
              isError: true
            }
          }
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }]
          }
        }
      ),

      tool(
        'open_tab',
        'Open a project as a new tab (spawns a Claude Code session). Returns tab info.',
        {
          projectId: z.string().describe('Project ID from list_all_projects')
        },
        async ({ projectId }) => {
          const result = await rendererControl({
            action: 'open-tab',
            payload: { projectId }
          })
          if (!result.ok) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${result.error}` }],
              isError: true
            }
          }
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }]
          }
        }
      ),

      tool(
        'close_tab',
        'Close an open tab.',
        {
          tabId: z.string().describe('Tab ID')
        },
        async ({ tabId }) => {
          const result = await rendererControl({
            action: 'close-tab',
            payload: { tabId }
          })
          if (!result.ok) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${result.error}` }],
              isError: true
            }
          }
          return {
            content: [{ type: 'text' as const, text: 'closed' }]
          }
        }
      ),

      tool(
        'switch_tab',
        'Make a tab active.',
        {
          tabId: z.string().describe('Tab ID')
        },
        async ({ tabId }) => {
          const result = await rendererControl({
            action: 'switch-tab',
            payload: { tabId }
          })
          if (!result.ok) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${result.error}` }],
              isError: true
            }
          }
          return {
            content: [{ type: 'text' as const, text: 'active' }]
          }
        }
      ),

      tool(
        'get_workspace_state',
        'Get current workspace state, including whether Ultimate Developer Mode is active for any project. ALWAYS call this first before deciding how to dispatch — ULM mode changes the rules.',
        {},
        async () => {
          const result = await rendererControl({
            action: 'get-workspace-state',
            payload: {}
          })
          if (!result.ok) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${result.error}` }],
              isError: true
            }
          }
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }]
          }
        }
      ),

      tool(
        'search_master_history',
        'Semantic search over the user\'s long-term master conversation archive (across all past sessions). Use when the user references something from before — phrases like "eelmine kord", "siis kui", "mäletad", "we discussed", "last time", references to specific dates/decisions, or any time you don\'t have the context in working memory. Returns top-N relevant messages with surrounding context (one before, one after each hit).',
        {
          query: z.string().describe('What to look for — paraphrase the user\'s reference into a search query, e.g. "decision about ULM gate parallel workers"'),
          limit: z.number().int().positive().max(15).optional().describe('How many top hits to return (default 5)')
        },
        async ({ query, limit }) => {
          try {
            const result = await searchArchive(query, limit ?? 5, true)
            if (result.total === 0) {
              return {
                content: [{ type: 'text' as const, text: 'Archive is empty — no past conversations stored yet.' }]
              }
            }
            if (result.hits.length === 0) {
              return {
                content: [{ type: 'text' as const, text: `No matches for "${query}" in ${result.total} archived messages.` }]
              }
            }
            const lines: string[] = [`Found ${result.hits.length} matches in ${result.total} archived messages:`]
            const ctx = result.contextWindow ?? result.hits
            for (const m of ctx) {
              const date = new Date(m.timestamp).toISOString().slice(0, 16).replace('T', ' ')
              const isHit = result.hits.some((h) => h.id === m.id)
              const score = isHit ? result.hits.find((h) => h.id === m.id)!.score.toFixed(2) : '–'
              const marker = isHit ? '★' : '·'
              const trimmed = m.content.length > 400 ? m.content.slice(0, 400) + '…' : m.content
              lines.push(`\n${marker} [${date} · ${m.role} · score=${score}]\n${trimmed}`)
            }
            return {
              content: [{ type: 'text' as const, text: lines.join('\n') }]
            }
          } catch (e) {
            return {
              content: [{ type: 'text' as const, text: `Error searching archive: ${e instanceof Error ? e.message : String(e)}` }],
              isError: true
            }
          }
        }
      ),

      tool(
        'set_ultimate_mode',
        'Activate or deactivate Ultimate Developer Mode for a project. Pass projectId to activate. Pass null to turn ULM off entirely. ONLY call this AFTER the user has explicitly confirmed they want ULM on. Required before spawning parallel workers when ULM is currently off.',
        {
          projectId: z
            .string()
            .nullable()
            .describe('Project ID to activate ULM for, or null to turn ULM off')
        },
        async ({ projectId }) => {
          const result = await rendererControl({
            action: 'set-ultimate-mode',
            payload: { projectId }
          })
          if (!result.ok) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${result.error}` }],
              isError: true
            }
          }
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }]
          }
        }
      ),

      tool(
        'spawn_parallel_worker',
        'Spawn an additional worker tab on a project (only allowed when that project is in Ultimate Developer Mode). Each worker is a fresh independent Claude Code session. Outside ULM, this reuses the existing single tab. Call this N times in one turn before dispatching to N parallel workers.',
        {
          projectId: z.string().describe('Project ID — must be the active ULM project')
        },
        async ({ projectId }) => {
          const result = await rendererControl({
            action: 'spawn-parallel-worker',
            payload: { projectId }
          })
          if (!result.ok) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${result.error}` }],
              isError: true
            }
          }
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }]
          }
        }
      ),

      tool(
        'open_url',
        'Open a URL in the user default browser. Use immediately when a worker reports a localhost server URL, deploy URL, or anything the user should see — do NOT tell the user to open it themselves.',
        {
          url: z.string().describe('Full URL with protocol')
        },
        async ({ url }) => {
          try {
            await shell.openExternal(url)
            return { content: [{ type: 'text' as const, text: `Opened ${url}` }] }
          } catch (e) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error: ${e instanceof Error ? e.message : String(e)}`
                }
              ],
              isError: true
            }
          }
        }
      )
    ]

    serverCache = createSdkMcpServer({
      name: 'orchestrator',
      version: '1.0.0',
      tools: orchestratorTools
    })
    return serverCache
  }

  async function* runQuery(
    userMessage: string,
    history?: Array<{ role: 'user' | 'assistant'; content: string }>,
    attachmentPaths?: string[]
  ): AsyncGenerator<unknown> {
    try {
      const { query } = await getSdk()
      const orchestratorServer = await getOrchestratorServer()

      let promptText = userMessage
      // Split image attachments out from other files. Images get inlined as
      // base64 vision content blocks below; non-image files stay as @path
      // refs (Claude CLI resolves them as document context).
      const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp']
      const isImage = (p: string): boolean =>
        imageExts.some((ext) => p.toLowerCase().endsWith(ext))
      const imagePaths = (attachmentPaths ?? []).filter(isImage)
      const otherPaths = (attachmentPaths ?? []).filter((p) => !isImage(p))
      if (otherPaths.length > 0) {
        const refs = otherPaths.map((p) => `@${p}`).join('\n')
        promptText = `${refs}\n\n${promptText}`
      }
      if (history && history.length > 0) {
        const transcript = history
          .map((m) => `${m.role === 'user' ? 'USER' : 'MASTER'}: ${m.content}`)
          .join('\n\n')
        promptText = `Recent conversation context (for continuity):\n\n${transcript}\n\n---\nNEW USER MESSAGE: ${promptText}`
      }

      // Build image content blocks for vision. The Claude Agent SDK accepts
      // an AsyncIterable<SDKUserMessage> as `prompt`, where the message can
      // contain multimodal content blocks. Without this, attached PNGs reach
      // Claude only as file paths that Read tools see as binary — no vision.
      const { readFile } = await import('fs/promises')
      const imageBlocks: Array<{
        type: 'image'
        source: { type: 'base64'; media_type: string; data: string }
      }> = []
      for (const p of imagePaths) {
        try {
          const buf = await readFile(p)
          const lower = p.toLowerCase()
          let media: string = 'image/png'
          if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) media = 'image/jpeg'
          else if (lower.endsWith('.gif')) media = 'image/gif'
          else if (lower.endsWith('.webp')) media = 'image/webp'
          imageBlocks.push({
            type: 'image',
            source: { type: 'base64', media_type: media, data: buf.toString('base64') }
          })
        } catch (e) {
          console.error('master: failed to load image', p, e)
        }
      }

      const claudeBin = resolveClaudeCodeBinary()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const queryOptions: any = {
        systemPrompt: SYSTEM_PROMPT,
        mcpServers: { orchestrator: orchestratorServer },
        permissionMode: 'bypassPermissions',
        cwd: process.env.HOME || '/',
        // Haiku 4.5 for fast tool orchestration. Master is a coordinator
        // (which tab? which tool? in parallel?) — Haiku handles tool selection
        // 3-5x faster than Sonnet. If we ever hit a case that needs deeper
        // reasoning, swap back to claude-sonnet-4-6 here.
        model: 'claude-haiku-4-5-20251001',
        effort: 'low',
        // Isolate master from user-level memory/settings. Without this, master
        // pulls ~/.claude/projects/*/memory/*.md into context and answers project
        // questions from cached general knowledge instead of the actual project.
        settingSources: [],
        // Master must only use orchestrator MCP tools. Both:
        //  - tools: [] disables ALL built-in tools (Bash/Read/Write/Edit/etc)
        //  - disallowedTools: explicit blocklist as belt-and-suspenders
        //  - allowedTools: orchestrator MCPs auto-approved (no permission prompts)
        tools: [],
        disallowedTools: BUILTIN_TOOLS_TO_BLOCK,
        allowedTools: ORCHESTRATOR_TOOL_NAMES.map((n) => `mcp__orchestrator__${n}`)
      }
      if (claudeBin) queryOptions.pathToClaudeCodeExecutable = claudeBin

      // Choose prompt form. Plain string when there are no images (fast path,
      // unchanged behavior); AsyncIterable carrying a multimodal user message
      // when we have images so the SDK forwards them to the vision model.
      let promptArg: unknown = promptText
      if (imageBlocks.length > 0) {
        const content = [
          { type: 'text' as const, text: promptText },
          ...imageBlocks
        ]
        async function* multimodalPrompt(): AsyncGenerator<unknown> {
          yield {
            type: 'user' as const,
            message: { role: 'user' as const, content },
            parent_tool_use_id: null,
            session_id: ''
          }
        }
        promptArg = multimodalPrompt()
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream = (query as any)({ prompt: promptArg, options: queryOptions })

      for await (const event of stream) {
        yield event
      }
    } catch (e) {
      yield { type: 'error', error: e instanceof Error ? e.message : String(e) }
    }
  }

  return { runQuery }
}
