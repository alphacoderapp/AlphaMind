import { z } from 'zod'
import { app, shell } from 'electron'
import { join, sep } from 'path'
import { existsSync } from 'fs'
import type { PtyManager } from './pty-manager'
import { tabRegistry } from './tab-registry'
import { getProjectStats } from './project-stats'
import { loadProjects } from './projects-store'

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

const COMPRESSION_PREFIX = `Compressed output: fragments not sentences, abbreviate, drop articles. Keep code/paths/identifiers exact. Be specific and short.

Task: `

const SYSTEM_PROMPT = `You are MASTER, a fast orchestrator AI for the user's project workspace in Simple Claude.

CRITICAL UX CONTRACT:
- The user ONLY talks to you, in this one chat. They never type into project tabs.
- NEVER tell the user "go to the X tab" or "type Y in project". You execute everything.
- If work belongs in a project (edit code, run command, commit, test, debug, build), DISPATCH to that project's worker. Never describe steps for the user to do.
- When a worker reports a URL (localhost server, deploy URL, anything that needs a browser), AUTO-OPEN it immediately via open_url. Do NOT write "Open http://..." for the user. Do NOT write "Visit example.com" — call open_url and just confirm "opened in browser".
- Never write "How to test:" / "Kuidas katsetada:" sections with manual steps. If something needs to happen, you do it (dispatch + open_url). The only output to user is a status report of what already happened.

ROUTING DECISIONS:
1. Pure metadata query (git status, recent commits, read a file) → use direct tools (git_status, git_log, read_file). Faster, no worker round-trip.
2. Code/file/build/test/commit work → dispatch_to_worker. The worker has full Claude Code capabilities (Edit, Bash, etc.) inside the project.
3. User references a project with no open tab → list_all_projects → open_tab(projectId) → dispatch_to_worker(newTabId, …). Do this transparently; don't ask.
4. User references a path that isn't a known project → create_project(path) → open_tab(newProjectId) → dispatch.
5. Multi-project task → dispatch in parallel by calling dispatch_to_worker multiple times in one assistant turn.

WORKER COMMUNICATION:
- dispatch_to_worker(tabId, prompt) injects, waits ~600ms idle, returns stripped output. Use this as your primary execute tool.
- If a worker task is long-running (>30s), pass timeoutMs explicitly (e.g. 90000 for builds).
- Worker output is already stripped of TUI noise. Parse the gist; don't echo the raw stream.
- For follow-ups in the same project, reuse the same tabId (worker keeps context).

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

export type RendererControlResult =
  | { ok: true; data?: unknown }
  | { ok: false; error: string }

export interface WorkerActivityEvent {
  tabId: string
  projectName: string
  status: 'start' | 'tick' | 'done' | 'timeout'
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

const POLL_INTERVAL_MS = 100
const IDLE_THRESHOLD_MS = 600
const DEFAULT_DISPATCH_TIMEOUT_MS = 30000

const ORCHESTRATOR_TOOL_NAMES = [
  'list_open_tabs',
  'list_all_projects',
  'dispatch_to_worker',
  'inject_prompt',
  'read_output',
  'wait_for_idle',
  'git_status',
  'git_log',
  'read_file',
  'create_project',
  'open_tab',
  'close_tab',
  'switch_tab',
  'open_url'
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

async function waitForIdle(
  ptyManager: PtyManager,
  ptyId: string,
  timeoutMs: number,
  startTs: number
): Promise<'idle' | 'timeout'> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const last = ptyManager.getLastDataTime(ptyId) ?? startTs
    if (Date.now() - last > IDLE_THRESHOLD_MS) return 'idle'
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  return 'timeout'
}

export function createMasterAgent(deps: MasterAgentDeps) {
  const { ptyManager, rendererControl, broadcastWorkerActivity } = deps

  let serverCache: unknown = null

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
        'Inject prompt into project tab, wait for worker to finish, return cleaned output. ANSI-stripped. Single round-trip. Use this as primary execution tool.',
        {
          tabId: z.string().describe('Tab ID from list_open_tabs'),
          prompt: z.string().describe('Task for the worker'),
          timeoutMs: z
            .number()
            .optional()
            .describe(`Max wait ms (default ${DEFAULT_DISPATCH_TIMEOUT_MS})`)
        },
        async ({ tabId, prompt, timeoutMs }) => {
          const tab = tabRegistry.get(tabId)
          if (!tab) {
            return {
              content: [{ type: 'text' as const, text: `Error: tab ${tabId} not found` }],
              isError: true
            }
          }
          const startTs = Date.now()
          const fullPrompt = COMPRESSION_PREFIX + prompt
          ptyManager.write(tab.ptyId, fullPrompt)
          await new Promise((r) => setTimeout(r, 80))
          ptyManager.write(tab.ptyId, '\r')

          broadcastWorkerActivity({
            tabId,
            projectName: tab.projectName,
            status: 'start',
            elapsedMs: 0,
            snippet: prompt.slice(0, 200)
          })

          const totalTimeout = timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS
          const deadline = Date.now() + totalTimeout
          let final: 'idle' | 'timeout' = 'timeout'
          let lastTickAt = 0
          while (Date.now() < deadline) {
            const last = ptyManager.getLastDataTime(tab.ptyId) ?? startTs
            if (Date.now() - last > IDLE_THRESHOLD_MS) {
              final = 'idle'
              break
            }
            // Tick every ~250ms with last few stripped lines
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

          broadcastWorkerActivity({
            tabId,
            projectName: tab.projectName,
            status: final === 'idle' ? 'done' : 'timeout',
            elapsedMs: Date.now() - startTs,
            snippet: tail(cleaned, 6).slice(-500)
          })

          return {
            content: [
              {
                type: 'text' as const,
                text: `[${final} after ${Date.now() - startTs}ms · project=${tab.projectName}]\n${cleaned || '(no output)'}`
              }
            ]
          }
        }
      ),

      tool(
        'inject_prompt',
        'Send prompt to a tab without waiting. Use dispatch_to_worker instead unless you need fire-and-forget.',
        {
          tabId: z.string().describe('Tab ID'),
          prompt: z.string().describe('Task for the worker')
        },
        async ({ tabId, prompt }) => {
          const tab = tabRegistry.get(tabId)
          if (!tab) {
            return {
              content: [{ type: 'text' as const, text: `Error: tab ${tabId} not found` }],
              isError: true
            }
          }
          const fullPrompt = COMPRESSION_PREFIX + prompt
          ptyManager.write(tab.ptyId, fullPrompt)
          await new Promise((r) => setTimeout(r, 80))
          ptyManager.write(tab.ptyId, '\r')
          return {
            content: [{ type: 'text' as const, text: `Sent to ${tab.projectName}` }]
          }
        }
      ),

      tool(
        'read_output',
        'Read recent output from a tab.',
        {
          tabId: z.string().describe('Tab ID'),
          sinceMs: z.number().optional().describe('Unix ms timestamp filter')
        },
        async ({ tabId, sinceMs }) => {
          const tab = tabRegistry.get(tabId)
          if (!tab) {
            return {
              content: [{ type: 'text' as const, text: `Error: tab ${tabId} not found` }],
              isError: true
            }
          }
          const text = ptyManager.getBuffer(tab.ptyId, sinceMs)
          const cleaned = stripAnsi(text).trim()
          return {
            content: [{ type: 'text' as const, text: cleaned || '(no output yet)' }]
          }
        }
      ),

      tool(
        'wait_for_idle',
        'Wait for tab to finish (idle threshold ~600ms). Returns idle or timeout.',
        {
          tabId: z.string().describe('Tab ID'),
          timeoutMs: z.number().optional().describe('Max wait ms (default 30000)')
        },
        async ({ tabId, timeoutMs }) => {
          const tab = tabRegistry.get(tabId)
          if (!tab) {
            return {
              content: [{ type: 'text' as const, text: `Error: tab ${tabId} not found` }],
              isError: true
            }
          }
          const result = await waitForIdle(
            ptyManager,
            tab.ptyId,
            timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS,
            Date.now()
          )
          return { content: [{ type: 'text' as const, text: result }] }
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
    history?: Array<{ role: 'user' | 'assistant'; content: string }>
  ): AsyncGenerator<unknown> {
    try {
      const { query } = await getSdk()
      const orchestratorServer = await getOrchestratorServer()

      let promptText = userMessage
      if (history && history.length > 0) {
        const transcript = history
          .map((m) => `${m.role === 'user' ? 'USER' : 'MASTER'}: ${m.content}`)
          .join('\n\n')
        promptText = `Recent conversation context (for continuity):\n\n${transcript}\n\n---\nNEW USER MESSAGE: ${userMessage}`
      }

      const claudeBin = resolveClaudeCodeBinary()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const queryOptions: any = {
        systemPrompt: SYSTEM_PROMPT,
        mcpServers: { orchestrator: orchestratorServer },
        permissionMode: 'bypassPermissions',
        cwd: process.env.HOME || '/',
        model: 'claude-haiku-4-5',
        // Master must only use orchestrator MCP tools. Both:
        //  - tools: [] disables ALL built-in tools (Bash/Read/Write/Edit/etc)
        //  - disallowedTools: explicit blocklist as belt-and-suspenders
        //  - allowedTools: orchestrator MCPs auto-approved (no permission prompts)
        // This prevents macOS TCC prompts (Music/Documents/Photos) from
        // incidental Bash filesystem walks, AND keeps master strictly an
        // orchestrator — workers do all real fs/shell work.
        tools: [],
        disallowedTools: BUILTIN_TOOLS_TO_BLOCK,
        allowedTools: ORCHESTRATOR_TOOL_NAMES.map((n) => `mcp__orchestrator__${n}`)
      }
      if (claudeBin) queryOptions.pathToClaudeCodeExecutable = claudeBin
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream = (query as any)({ prompt: promptText, options: queryOptions })

      for await (const event of stream) {
        yield event
      }
    } catch (e) {
      yield { type: 'error', error: e instanceof Error ? e.message : String(e) }
    }
  }

  return { runQuery }
}
