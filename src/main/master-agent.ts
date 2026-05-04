import { z } from 'zod'
import type { PtyManager } from './pty-manager'
import { tabRegistry } from './tab-registry'
import { getProjectStats } from './project-stats'
import { loadProjects } from './projects-store'

const COMPRESSION_PREFIX = `Respond compressed style: drop articles, fragments not sentences, abbreviate where unambiguous. Preserve code/paths/identifiers exact. Keep all technical facts (errors, line numbers, fix details). Be specific and short.

Task: `

const SYSTEM_PROMPT = `You are MASTER, an orchestrator AI for the user's project workspace in Simple Claude.

The user has multiple Claude Code sessions running in project tabs. You manage all projects from this single chat window.

YOUR ROLE:
- Use tools to gather information about projects
- Dispatch work to project Claudes via inject_prompt (writes into their session)
- Synthesize results into concise overviews for the user
- Ask clarifying questions when intent ambiguous

RESPONSE FORMAT (ALWAYS):
- Start with 1-sentence summary
- Then bullets with status icons:
  - ✓ done
  - ⚠ needs attention
  - ✗ failed
  - × skipped
  - ⌛ in progress
- Maximum 3-6 bullets typically
- No preamble, no recap, no apologies
- Use \`code\` formatting for paths/commands

WHEN DISPATCHING TO WORKERS:
- Workers are project Claude Code instances. inject_prompt writes into their PTY session.
- The tool prefixes your task with compression instructions automatically.
- Use wait_for_idle after inject_prompt to know when worker finished
- Use read_output to read what worker produced
- Parse compressed output, synthesize into bullet for user

WHEN NOT TO DISPATCH (preferred):
- If cheap tools answer it (read_file, git_status, list_open_tabs, list_all_projects), use those
- Spawning a Claude is expensive; prefer direct file/git access for facts

PARALLEL WORK:
- When tasks across multiple projects are independent, use inject_prompt for all in sequence then wait_for_idle for each. Tools run in parallel naturally when called within one assistant turn.

Always use the most efficient path. Be JARVIS, not a chatty assistant.`

interface MasterAgentDeps {
  ptyManager: PtyManager
}

// Lazy-loaded ESM module (claude-agent-sdk is ESM, our main is CJS, must use dynamic import)
let sdkPromise: Promise<typeof import('@anthropic-ai/claude-agent-sdk')> | null = null
async function getSdk(): Promise<typeof import('@anthropic-ai/claude-agent-sdk')> {
  if (!sdkPromise) {
    sdkPromise = import('@anthropic-ai/claude-agent-sdk')
  }
  return sdkPromise
}

export function createMasterAgent(deps: MasterAgentDeps) {
  const { ptyManager } = deps

  let serverCache: unknown = null

  async function getOrchestratorServer(): Promise<unknown> {
    if (serverCache) return serverCache
    const { createSdkMcpServer, tool } = await getSdk()

    const orchestratorTools = [
      tool(
        'list_open_tabs',
        'List all currently open project tabs with their state. Returns array of {tabId, projectId, projectName, projectPath, projectColor, sessionId, isActive}.',
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
        'List all configured projects (open or not). Returns array of {id, name, path, color}.',
        {},
        async () => {
          const projects = (await loadProjects()) ?? []
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(projects, null, 2) }]
          }
        }
      ),

      tool(
        'inject_prompt',
        'Send a prompt to a specific project tab. Auto-prefixes with compression instructions so worker responds tersely. Returns immediately; use wait_for_idle then read_output to see worker response.',
        {
          tabId: z.string().describe('Tab ID from list_open_tabs'),
          prompt: z.string().describe('Task for the project Claude')
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
          ptyManager.write(tab.ptyId, fullPrompt + '\r')
          return {
            content: [
              {
                type: 'text' as const,
                text: `Sent to ${tab.projectName}. Use wait_for_idle (tabId: ${tabId}) then read_output.`
              }
            ]
          }
        }
      ),

      tool(
        'read_output',
        'Read recent output from a project tab. Returns text from rolling buffer (last ~200KB).',
        {
          tabId: z.string().describe('Tab ID'),
          sinceMs: z
            .number()
            .optional()
            .describe('Optional unix ms timestamp; only returns output since this time')
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
        'Wait until a project tab has been silent for at least 2s (Claude finished). Returns when idle or timeout.',
        {
          tabId: z.string().describe('Tab ID'),
          timeoutMs: z.number().optional().describe('Max wait in ms (default 60000)')
        },
        async ({ tabId, timeoutMs }) => {
          const tab = tabRegistry.get(tabId)
          if (!tab) {
            return {
              content: [{ type: 'text' as const, text: `Error: tab ${tabId} not found` }],
              isError: true
            }
          }
          const timeout = timeoutMs ?? 60000
          const start = Date.now()
          const idleThreshold = 2000

          while (Date.now() - start < timeout) {
            const lastTs = ptyManager.getLastDataTime(tab.ptyId)
            if (lastTs && Date.now() - lastTs > idleThreshold) {
              return { content: [{ type: 'text' as const, text: 'idle' }] }
            }
            await new Promise((r) => setTimeout(r, 500))
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: 'timeout (still active or no activity yet). Try read_output to inspect.'
              }
            ]
          }
        }
      ),

      tool(
        'git_status',
        'Get git status (branch, ahead/behind, uncommitted) for a project at the given path.',
        {
          projectPath: z.string().describe('Absolute path to project root')
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
                {
                  type: 'text' as const,
                  text: `Error: ${e instanceof Error ? e.message : String(e)}`
                }
              ],
              isError: true
            }
          }
        }
      ),

      tool(
        'git_log',
        'Get recent commits for a project',
        {
          projectPath: z.string().describe('Absolute path to project'),
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
                {
                  type: 'text' as const,
                  text: `Error: ${e instanceof Error ? e.message : String(e)}`
                }
              ],
              isError: true
            }
          }
        }
      ),

      tool(
        'read_file',
        'Read a file from a project. Relative path from project root.',
        {
          projectPath: z.string().describe('Absolute path to project root'),
          relativePath: z.string().describe('Relative path within project')
        },
        async ({ projectPath, relativePath }) => {
          try {
            const { readFile } = await import('fs/promises')
            const { join } = await import('path')
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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream = (query as any)({
        prompt: promptText,
        options: {
          systemPrompt: SYSTEM_PROMPT,
          mcpServers: { orchestrator: orchestratorServer },
          permissionMode: 'bypassPermissions'
        }
      })

      for await (const event of stream) {
        yield event
      }
    } catch (e) {
      yield { type: 'error', error: e instanceof Error ? e.message : String(e) }
    }
  }

  return { runQuery }
}
