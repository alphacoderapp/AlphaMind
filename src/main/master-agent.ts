import { z } from 'zod'
import { app } from 'electron'
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

The user has multiple Claude Code sessions in project tabs. You manage everything from one chat.

PRIMARY TOOLS (prefer these — they are FAST):
- read_file, git_status, git_log → direct facts, no worker needed
- list_open_tabs, list_all_projects → workspace state
- create_project / open_tab / close_tab / switch_tab → workspace control
- dispatch_to_worker(tabId, prompt) → injects, waits, reads in ONE call. Prefer over inject_prompt+wait+read.

LEGACY TOOLS (avoid unless dispatch_to_worker is unsuitable):
- inject_prompt, wait_for_idle, read_output

RESPONSE FORMAT:
- 1-sentence summary first
- Bullets with: ✓ done · ⚠ needs attn · ✗ failed · × skipped · ⌛ in progress
- Max 3-6 bullets
- \`code\` for paths/commands
- No preamble, no recap, no apologies

WHEN NOT TO DISPATCH:
- Cheap tools answer it (read_file, git_status) → use those
- Spawning a worker is slow; prefer direct tools

WORKSPACE MUTATION:
- create_project + open_tab → spin up new tab from a folder path
- open_tab(projectId) → opens existing project as a fresh tab
- close_tab / switch_tab → manage focus

Be JARVIS-fast. No fluff.`

export type RendererControlAction =
  | { action: 'create-project'; payload: { path: string; name?: string; color?: string } }
  | { action: 'open-tab'; payload: { projectId: string } }
  | { action: 'close-tab'; payload: { tabId: string } }
  | { action: 'switch-tab'; payload: { tabId: string } }

export type RendererControlResult =
  | { ok: true; data?: unknown }
  | { ok: false; error: string }

interface MasterAgentDeps {
  ptyManager: PtyManager
  rendererControl: (req: RendererControlAction) => Promise<RendererControlResult>
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
  const { ptyManager, rendererControl } = deps

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
        'Inject prompt into project tab, wait for worker to finish, return output. Single round-trip. Use this over inject_prompt+wait_for_idle+read_output.',
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

          const result = await waitForIdle(
            ptyManager,
            tab.ptyId,
            timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS,
            startTs
          )
          const output = ptyManager.getBuffer(tab.ptyId, startTs)
          const status = result === 'idle' ? 'idle' : 'timeout'
          return {
            content: [
              {
                type: 'text' as const,
                text: `[${status} after ${Date.now() - startTs}ms]\n${output || '(no output)'}`
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
          return {
            content: [{ type: 'text' as const, text: text || '(no output yet)' }]
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
        model: 'claude-haiku-4-5'
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
