// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import {
  installModelSelection,
  type Agent,
  type AgentHandle,
  type ModelSelection,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type {} from '@deepseek-ai/dsh-skill'
import { apply as applySkillFilesystem } from '@deepseek-ai/dsh-skill-filesystem'
import { apply as applyFsTools } from '@deepseek-ai/dsh-tool-fs'
import {
  GLOB_MAX_RESULTS,
  GREP_MAX_LINE_BYTES,
  GREP_MAX_MATCHES,
  RAW_OUTPUT_MAX_BYTES,
  SEARCH_GRACE_MS,
  SEARCH_META_MAX_BYTES,
  SEARCH_STDERR_MAX_BYTES,
  SEARCH_TIMEOUT_MS,
  apply as applyFsSearchTools,
} from '@deepseek-ai/dsh-tool-fs-search'
import { apply as applyPwshTool } from '@deepseek-ai/dsh-tool-pwsh'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-host-webserver'
// @ts-expect-error The bundled knotline server is authored in checked ESM JavaScript.
import { createKnotlineServer } from '../../server/app.mjs'
import {
  KNOTLINE_API_PATH,
  KNOTLINE_BASE_PATH,
  type ApiErrorBody,
  type TurnOutcome,
} from '../contracts.ts'
import {
  readTurnOutcome,
  summarizeSession,
  titleMap,
} from './project.ts'

export const name = 'knotline'
export const inject = [
  'webServer',
  'sessionQuery',
  'sessions',
  'agents',
  'agentDefaultModel',
  'llm',
  'skills',
  'tools',
  'fs',
  'shell',
  'shellEnv',
  'subprocess',
  'systemPrompt',
]

const MAX_OVERVIEW_SESSIONS = 200
const MAP_BASE_PATH = `${KNOTLINE_BASE_PATH}/map`
const TEAM_CONTEXT_MAX_MESSAGES = 8
const TEAM_CONTEXT_MAX_CHARS = 24_000
const TEAM_CONTEXT_MAX_MESSAGE_CHARS = 6_000

interface KnotlineServerHandle {
  server: { emit(event: 'request', req: IncomingMessage, res: ServerResponse): boolean }
  database: {
    getAgentProfile(id: string): any
    getAgentRuntimeBindingByProfile(id: string): any
    getAgentRuntimeBindingBySession(id: string): any
    createAgentRuntimeBinding(input: Record<string, unknown>): any
    getAgentTeamMembers(id: string): any[]
    getNodeRun(id: string): any
    getKnowledgeAsset(id: string): any
    getKnowledgeVersion(assetId: string, versionNumber: number): any
    getProject(id: string): any
    getWorkstream(id: string): any
    listRecoverableAgentRuntimeBindings(): any[]
    listRecoverableNodeRuns(): any[]
    listKnowledgeBindings(projectId: string): any[]
    updateAgentRuntimeBinding(id: string, changes: Record<string, unknown>): any
    updateNodeRun(id: string, changes: Record<string, unknown>): any
  }
  close(): Promise<void>
}

interface LiveFacts {
  outcome: TurnOutcome | null
  lastActivityAt: number | null
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown, head = false): void {
  const json = JSON.stringify(body)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
  })
  res.end(head ? undefined : json)
}

function sendError(res: ServerResponse, statusCode: number, code: string, message: string): void {
  const body: ApiErrorBody = { error: { code, message } }
  sendJson(res, statusCode, body)
}

function methodAllowed(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return true
  res.setHeader('Allow', 'GET, HEAD')
  sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Knotline exposes a read-only HTTP surface.')
  return false
}

function lastLiveFacts(agent: Agent | undefined): LiveFacts {
  if (agent === undefined) return { outcome: null, lastActivityAt: null }
  let outcome: TurnOutcome | null = null
  for (const event of agent.session.events) outcome = readTurnOutcome(event) ?? outcome
  return {
    outcome,
    lastActivityAt: agent.session.events.at(-1)?.time ?? null,
  }
}

const FINAL_MESSAGE_MAX_CHARS = 200_000

// The agent's last full reply text, so the Map surfaces exactly what a chat turn would have shown.
function lastAssistantText(agent: Agent): string | null {
  const events: readonly unknown[] = agent.session.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!event || typeof event !== 'object') continue
    const record = event as { type?: unknown; data?: unknown }
    if (record.type !== 'assistant/message') continue
    const data = record.data && typeof record.data === 'object' ? record.data as { message?: unknown } : null
    const message = data?.message && typeof data.message === 'object' ? data.message as { content?: unknown } : null
    const content = Array.isArray(message?.content) ? message.content : []
    const textParts: string[] = []
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const piece = part as { type?: unknown; text?: unknown }
      if (piece.type === 'text' && typeof piece.text === 'string' && piece.text.trim()) textParts.push(piece.text)
    }
    const joined = textParts.join('\n\n').trim()
    if (joined.length === 0) return null
    return joined.length > FINAL_MESSAGE_MAX_CHARS ? `${joined.slice(0, FINAL_MESSAGE_MAX_CHARS)}\n[truncated]` : joined
  }
  return null
}

function compactTeamHistory(events: readonly unknown[]): Array<{ type: string; contentExcerpt: string }> {
  const history: Array<{ type: string; contentExcerpt: string }> = []
  let remainingChars = TEAM_CONTEXT_MAX_CHARS
  for (let index = events.length - 1; index >= 0 && history.length < TEAM_CONTEXT_MAX_MESSAGES; index -= 1) {
    const event = events[index]
    if (!event || typeof event !== 'object') continue
    const record = event as { type?: unknown; data?: unknown }
    const type = typeof record.type === 'string' ? record.type : ''
    if (type !== 'user/message' && type !== 'assistant/message') continue
    const data = record.data && typeof record.data === 'object'
      ? record.data as { content?: unknown; message?: unknown }
      : null
    const content = type === 'user/message' ? data?.content : data?.message
    if (content === undefined) continue
    const serialized = JSON.stringify(content)
    if (!serialized) continue
    const excerptLength = Math.min(serialized.length, TEAM_CONTEXT_MAX_MESSAGE_CHARS, remainingChars)
    if (excerptLength <= 0) break
    history.unshift({
      type,
      contentExcerpt: serialized.length > excerptLength
        ? `${serialized.slice(0, excerptLength)}\n[truncated]`
        : serialized,
    })
    remainingChars -= excerptLength
  }
  return history
}

async function agentRuntimeSessions(ctx: Context) {
  const allRecords = await ctx.sessionQuery.listSessions()
  const records = allRecords.slice(0, MAX_OVERVIEW_SESSIONS)
  const titleResults = await ctx.sessionQuery.readTitleSnapshots(records.map(record => record.header.id))
  const titles = titleMap(titleResults)
  const agents = ctx.agents.list()
  const agentsById = new Map(agents.map(agent => [String(agent.id), agent]))
  return records.map((record) => {
    const agent = agentsById.get(String(record.header.id))
    const facts = lastLiveFacts(agent)
    return summarizeSession(record, titles.get(String(record.header.id)), agent, facts.outcome, facts.lastActivityAt)
  })
}

function forwardMapRequest(
  knotline: KnotlineServerHandle,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): void {
  const suffix = url.pathname.slice(MAP_BASE_PATH.length)
  req.url = `${suffix}${url.search}`
  knotline.server.emit('request', req, res)
}

async function knotlineJson<T>(
  ctx: Context,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(
    `http://127.0.0.1:${ctx.webServer.port}${MAP_BASE_PATH}/api${path}`,
    init,
  )
  const body = await response.json() as T & { error?: { message?: string } }
  if (!response.ok) throw new Error(body.error?.message ?? `Knotline task API returned ${response.status}`)
  return body
}

const AGENT_REQUEST_HEADERS = {
  'Content-Type': 'application/json',
  'X-Knotline-User-Id': 'deepseek-harness-agent',
  'X-Knotline-User-Name': encodeURIComponent('DeepSeek Harness'),
}

function executionTools(ctx: Context) {
  return [
    defineTool({
      name: 'knotline_read_project_context',
      description: 'Read grounded Project code, docs, Tasks, governance state, and matching DSH Sessions for a Knowledge or planning Node Run.',
      parameters: {
        nodeRunId: { type: 'string', required: true, description: 'Assigned Node Run UUID.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            context: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.context }],
      },
      async execute(args, exec) {
        return knotlineJson<{ context: string }>(ctx, `/node-runs/${encodeURIComponent(args.nodeRunId)}/project-context`, {
          signal: exec.signal,
        })
      },
    }),
    defineTool({
      name: 'knotline_start_node',
      description: 'Start the assigned Knotline Node Run before doing execution work.',
      parameters: {
        nodeRunId: { type: 'string', required: true, description: 'Assigned Node Run UUID.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            nodeRunId: { type: 'string', required: true },
            status: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `Node Run ${value.nodeRunId} is ${value.status}.` }],
      },
      async execute(args, exec) {
        const result = await knotlineJson<{ nodeRun: { id: string; status: string } }>(ctx, `/node-runs/${encodeURIComponent(args.nodeRunId)}/start`, {
          method: 'POST',
          headers: AGENT_REQUEST_HEADERS,
          body: '{}',
          signal: exec.signal,
        })
        return { nodeRunId: result.nodeRun.id, status: result.nodeRun.status }
      },
    }),
    defineTool({
      name: 'knotline_update_node',
      description: 'Record structured progress, waiting state, or a blocker on the current Knotline Node Run.',
      parameters: {
        nodeRunId: { type: 'string', required: true, description: 'Assigned Node Run UUID.' },
        status: { type: 'string', required: true, enum: ['running', 'waiting', 'blocked'] },
        comment: { type: 'string', description: 'Concise progress or blocker detail.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            nodeRunId: { type: 'string', required: true },
            status: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `Node Run ${value.nodeRunId} is ${value.status}.` }],
      },
      async execute(args, exec) {
        const result = await knotlineJson<{ nodeRun: { id: string; status: string } }>(ctx, `/node-runs/${encodeURIComponent(args.nodeRunId)}/update`, {
          method: 'POST',
          headers: AGENT_REQUEST_HEADERS,
          body: JSON.stringify({ status: args.status, comment: args.comment ?? '' }),
          signal: exec.signal,
        })
        return { nodeRunId: result.nodeRun.id, status: result.nodeRun.status }
      },
    }),
    defineTool({
      name: 'knotline_submit_delivery',
      description: 'Submit the current Node Run deliverable and evidence for independent review.',
      parameters: {
        nodeRunId: { type: 'string', required: true, description: 'Assigned Node Run UUID.' },
        summary: { type: 'string', required: true, description: 'Delivery summary.' },
        evidence: { type: 'string', description: 'Validation evidence, paths, commands, or observed results.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            nodeRunId: { type: 'string', required: true },
            status: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `Node Run ${value.nodeRunId} entered ${value.status}.` }],
      },
      async execute(args, exec) {
        const result = await knotlineJson<{ nodeRun: { id: string; status: string } }>(ctx, `/node-runs/${encodeURIComponent(args.nodeRunId)}/submit-delivery`, {
          method: 'POST',
          headers: AGENT_REQUEST_HEADERS,
          body: JSON.stringify({ summary: args.summary, evidence: args.evidence ?? '' }),
          signal: exec.signal,
        })
        return { nodeRunId: result.nodeRun.id, status: result.nodeRun.status }
      },
    }),
    defineTool({
      name: 'knotline_request_review',
      description: 'Request independent review for the current Node Run without claiming final approval.',
      parameters: {
        nodeRunId: { type: 'string', required: true, description: 'Assigned Node Run UUID.' },
        summary: { type: 'string', required: true, description: 'What is ready for review.' },
        evidence: { type: 'string', description: 'Available review evidence.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            nodeRunId: { type: 'string', required: true },
            status: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `Review requested for Node Run ${value.nodeRunId}.` }],
      },
      async execute(args, exec) {
        const result = await knotlineJson<{ nodeRun: { id: string; status: string } }>(ctx, `/node-runs/${encodeURIComponent(args.nodeRunId)}/request-review`, {
          method: 'POST',
          headers: AGENT_REQUEST_HEADERS,
          body: JSON.stringify({ summary: args.summary, evidence: args.evidence ?? '' }),
          signal: exec.signal,
        })
        return { nodeRunId: result.nodeRun.id, status: result.nodeRun.status }
      },
    }),
    defineTool({
      name: 'knotline_submit_artifact_review',
      description: 'Submit the assigned pre-review artifact decision, then complete the reviewer Node Run.',
      parameters: {
        nodeRunId: { type: 'string', required: true, description: 'Reviewer Node Run UUID.' },
        projectId: { type: 'string', required: true, description: 'Knotline Project ID.' },
        reviewGateId: { type: 'string', required: true, description: 'Pre-review artifact Review Gate UUID.' },
        workstreamId: { type: 'string', required: true, description: 'Workstream UUID from the assignment.' },
        decision: { type: 'string', required: true, enum: ['approved', 'rejected'] },
        comment: { type: 'string', description: 'Concrete review conclusion and evidence assessment.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            reviewGateId: { type: 'string', required: true },
            decision: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `Pre-review artifact ${value.reviewGateId} was ${value.decision}.` }],
      },
      async execute(args, exec) {
        await knotlineJson(ctx, `/projects/${encodeURIComponent(args.projectId)}/graph/commands`, {
          method: 'POST',
          headers: AGENT_REQUEST_HEADERS,
          body: JSON.stringify({
            sourceNodeId: `review_gate:${args.reviewGateId}`,
            targetNodeId: `review_gate:${args.reviewGateId}`,
            actionType: 'decide_execution_review',
            idempotencyKey: randomUUID(),
            input: { decision: args.decision, comment: args.comment ?? '' },
          }),
          signal: exec.signal,
        })
        await knotlineJson(ctx, `/node-runs/${encodeURIComponent(args.nodeRunId)}/submit-delivery`, {
          method: 'POST',
          headers: AGENT_REQUEST_HEADERS,
          body: JSON.stringify({
            summary: `Pre-review ${args.decision}`,
            evidence: args.comment ?? '',
          }),
          signal: exec.signal,
        })
        return { reviewGateId: args.reviewGateId, decision: args.decision }
      },
    }),
    defineTool({
      name: 'knotline_report_blocker',
      description: 'Mark the current Node Run and its Task blocked with a concrete reason.',
      parameters: {
        nodeRunId: { type: 'string', required: true, description: 'Assigned Node Run UUID.' },
        reason: { type: 'string', required: true, description: 'Concrete blocker and needed resolution.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            nodeRunId: { type: 'string', required: true },
            status: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `Node Run ${value.nodeRunId} is ${value.status}.` }],
      },
      async execute(args, exec) {
        const result = await knotlineJson<{ nodeRun: { id: string; status: string } }>(ctx, `/node-runs/${encodeURIComponent(args.nodeRunId)}/update`, {
          method: 'POST',
          headers: AGENT_REQUEST_HEADERS,
          body: JSON.stringify({ status: 'blocked', comment: args.reason }),
          signal: exec.signal,
        })
        return { nodeRunId: result.nodeRun.id, status: result.nodeRun.status }
      },
    }),
    defineTool({
      name: 'knotline_propose_knowledge_update',
      description: 'Propose reusable knowledge from this Node Run. The proposal is not published until review approves it.',
      parameters: {
        nodeRunId: { type: 'string', required: true, description: 'Assigned Node Run UUID.' },
        title: { type: 'string', required: true, description: 'Short knowledge title.' },
        content: { type: 'string', required: true, description: 'Reusable knowledge content with evidence.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            proposalId: { type: 'string', required: true },
            status: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `Knowledge proposal ${value.proposalId} is ${value.status}.` }],
      },
      async execute(args, exec) {
        return knotlineJson<{ proposalId: string; status: string }>(ctx, `/node-runs/${encodeURIComponent(args.nodeRunId)}/knowledge-proposals`, {
          method: 'POST',
          headers: AGENT_REQUEST_HEADERS,
          body: JSON.stringify({ title: args.title, content: args.content }),
          signal: exec.signal,
        })
      },
    }),
  ]
}

function agentMessage(text: string, summary: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: name, form: 'notice', summary },
  })
}

class AgentOrchestrator {
  private readonly handles = new Map<string, AgentHandle>()
  private readonly monitoring = new Set<string>()
  private readonly transientRetries = new Map<string, number>()

  constructor(
    private readonly ctx: Context,
    private readonly knotline: KnotlineServerHandle,
  ) {}

  private async setupAgent(agentCtx: Context): Promise<void> {
    const globalModel = this.ctx.agentDefaultModel
    const selection: ModelSelectionRef = {
      get current() {
        return globalModel.currentSelection()
      },
      assembled: undefined,
    }
    agentCtx.effect(
      () => installModelSelection(agentCtx, selection),
      'knotline: global model selection',
    )
    for (const tool of executionTools(this.ctx)) {
      agentCtx.effect(() => agentCtx.tools.register(tool), `knotline: scoped ${tool.name}`)
    }
    await Promise.all([
      agentCtx.inject(['fs', 'systemPrompt'], toolCtx => {
        applyFsTools(toolCtx, {
          readLimit: 2_000,
          readMaxLineLength: 2_000,
          readMaxBytes: 50 * 1_024,
          readStreamMinSize: 10 * 1_024 * 1_024,
        })
      }),
      agentCtx.inject(['shell', 'systemPrompt', 'shellEnv'], toolCtx => {
        applyPwshTool(toolCtx)
      }),
      agentCtx.inject(['systemPrompt', 'subprocess'], toolCtx => applyFsSearchTools(toolCtx, {
        sampleOverCapGlobResults: true,
        globMaxResults: GLOB_MAX_RESULTS,
        grepMaxMatches: GREP_MAX_MATCHES,
        grepMaxLineBytes: GREP_MAX_LINE_BYTES,
        searchMetaMaxBytes: SEARCH_META_MAX_BYTES,
        rawOutputMaxBytes: RAW_OUTPUT_MAX_BYTES,
        graceMs: SEARCH_GRACE_MS,
        stderrMaxBytes: SEARCH_STDERR_MAX_BYTES,
        timeoutMs: SEARCH_TIMEOUT_MS,
      })),
    ])
  }

  private async ensureAgentProfile(agentProfileId: string): Promise<Agent> {
    const profile = this.knotline.database.getAgentProfile(agentProfileId)
    const project = profile ? this.knotline.database.getProject(profile.projectId) : null
    const binding = profile
      ? this.knotline.database.getAgentRuntimeBindingByProfile(profile.id)
        ?? this.knotline.database.createAgentRuntimeBinding({
          id: randomUUID(),
          projectId: profile.projectId,
          agentProfileId: profile.id,
          currentNodeRunId: null,
        })
      : null
    if (!profile || !project || !binding) throw new Error('Knotline Agent no longer exists')
    const defaultModel = this.ctx.agentDefaultModel.currentSelection()
    const agentOptions = {
      provider: profile.provider ?? defaultModel.provider,
      model: profile.model ?? defaultModel.model,
    }

    if (binding.sessionId) {
      const sessionId = SessionId(binding.sessionId)
      const live = this.ctx.agents.get(sessionId)
      if (live) return live
      const handle = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions,
        setup: agentCtx => this.setupAgent(agentCtx),
      })
      this.handles.set(profile.id, handle)
      return handle.agent
    }

    const sessionId = SessionId(randomUUID())
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: project.workspacePath ?? process.cwd() },
      agentOptions,
      setup: agentCtx => this.setupAgent(agentCtx),
    })
    this.handles.set(profile.id, handle)
    this.knotline.database.updateAgentRuntimeBinding(profile.id, {
      sessionId: String(handle.agent.id),
      status: 'idle',
      lastError: null,
    })
    return handle.agent
  }

  private async ensureAgent(nodeRun: any): Promise<Agent> {
    return this.ensureAgentProfile(nodeRun.agentProfileId)
  }

  async provisionAgent(agentProfileId: string): Promise<any> {
    const agent = await this.ensureAgentProfile(agentProfileId)
    return this.knotline.database.updateAgentRuntimeBinding(agentProfileId, {
      sessionId: String(agent.id),
      status: 'idle',
      lastError: null,
    })
  }

  private async resetAgentSession(agentProfileId: string): Promise<void> {
    const handle = this.handles.get(agentProfileId)
    this.handles.delete(agentProfileId)
    if (handle) await handle.dispose()
    this.knotline.database.updateAgentRuntimeBinding(agentProfileId, {
      sessionId: null,
      currentNodeRunId: null,
      status: 'idle',
      lastError: null,
    })
  }

  private async prepareTeamDialogue(nodeRun: any): Promise<void> {
    const team = this.knotline.database.getAgentProfile(nodeRun.agentProfileId)
    const workstream = this.knotline.database.getWorkstream(nodeRun.workstreamId)
    const members = this.knotline.database.getAgentTeamMembers(nodeRun.agentProfileId)
    if (!team || !workstream || members.length === 0) return
    await Promise.all(members.map(async member => {
      const memberAgent = await this.ensureAgentProfile(member.id)
      memberAgent.followup(agentMessage([
        `<knotline_team_internal team="${team.name}">`,
        `Shared Demand: ${workstream.title}`,
        `Goal: ${workstream.goal}`,
        `Your retained working method: ${member.skillId ?? member.role}`,
        "This is an internal Team discussion turn. Read your own conversation history and contribute your perspective, proposed plan, risks, and questions for the other member.",
        "Do not publish the external answer and do not call Knotline lifecycle tools; the Team coordinator will reconcile both member contributions.",
        "</knotline_team_internal>",
      ].join('\n'), `Internal Team discussion for ${workstream.title}`))
      await memberAgent.whenIdle()
    }))
  }

  private async teamContext(agentProfileId: string): Promise<string> {
    const members = this.knotline.database.getAgentTeamMembers(agentProfileId)
    if (members.length === 0) return ''
    const histories = await Promise.all(members.map(async member => {
      const binding = this.knotline.database.getAgentRuntimeBindingByProfile(member.id)
      if (!binding?.sessionId) {
        return { member, sessionId: null, history: [] }
      }
      try {
        const surface = await this.ctx.sessionQuery.readSurface(SessionId(binding.sessionId))
        return { member, sessionId: binding.sessionId, history: compactTeamHistory(surface.events) }
      } catch (error) {
        return {
          member,
          sessionId: binding.sessionId,
          history: [{ unavailable: error instanceof Error ? error.message : String(error) }],
        }
      }
    }))
    return [
      '<knotline_team_context>',
      'Work externally as one Team. Internally compare both member perspectives, resolve disagreements, produce a plan, and maintain one shared working document.',
      JSON.stringify(histories.map(({ member, sessionId, history }) => ({
        member: {
          id: member.id,
          name: member.name,
          workStyle: member.skillId ?? member.role,
          provider: member.provider,
          model: member.model,
          sessionId,
        },
        recentConversationExcerpts: history,
      })), null, 2),
      '</knotline_team_context>',
    ].join('\n')
  }

  private async assignmentPrompt(nodeRun: any): Promise<string> {
    const profile = this.knotline.database.getAgentProfile(nodeRun.agentProfileId)
    const workstream = this.knotline.database.getWorkstream(nodeRun.workstreamId)
    const knowledgeContext = this.knotline.database.listKnowledgeBindings(nodeRun.projectId)
      .filter(binding => binding.agentProfileId === nodeRun.agentProfileId)
      .map(binding => {
        const asset = this.knotline.database.getKnowledgeAsset(binding.assetId)
        const version = this.knotline.database.getKnowledgeVersion(binding.assetId, binding.boundVersion)
        return `<knowledge_binding asset="${asset?.title}" version="${binding.boundVersion}" status="${binding.status}">\n${version?.content ?? ''}\n</knowledge_binding>`
      })
      .join('\n')
    const skill = profile?.skillId ? `/${profile.skillId}\n` : ''
    const teamContext = await this.teamContext(nodeRun.agentProfileId)
    return `${skill}<knotline_assignment>\nAgent Profile: ${profile?.name}\nNode Run ID: ${nodeRun.id}\nTask ID: ${nodeRun.taskId}\nWorkstream: ${workstream?.title ?? 'Standalone governed node'}\nGovernance: execute only the approved scope; do not self-approve; use Knotline tools for lifecycle changes.\n${teamContext}\n${knowledgeContext}\n${nodeRun.instruction}\n</knotline_assignment>`
  }

  async startNodeRun(nodeRunId: string): Promise<void> {
    const nodeRun = this.knotline.database.getNodeRun(nodeRunId)
    if (!nodeRun || !['queued', 'running', 'waiting_input', 'changes_requested'].includes(nodeRun.status)) return
    try {
      await this.prepareTeamDialogue(nodeRun)
      const agent = await this.ensureAgent(nodeRun)
      await knotlineJson(this.ctx, `/node-runs/${encodeURIComponent(nodeRun.id)}/runtime`, {
        method: 'POST',
        headers: AGENT_REQUEST_HEADERS,
        body: JSON.stringify({ sessionId: String(agent.id), status: 'working', error: null }),
      })
      await knotlineJson(this.ctx, `/node-runs/${encodeURIComponent(nodeRun.id)}/start`, {
        method: 'POST',
        headers: AGENT_REQUEST_HEADERS,
        body: '{}',
      })
      agent.followup(agentMessage(await this.assignmentPrompt(nodeRun), `Assigned Node Run ${nodeRun.id}`))
      this.monitor(nodeRun.id, agent)
    } catch (error) {
      this.knotline.database.updateNodeRun(nodeRun.id, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
      this.knotline.database.updateAgentRuntimeBinding(nodeRun.agentProfileId, {
        currentNodeRunId: nodeRun.id,
        status: 'blocked',
        lastError: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  async controlNodeRun(nodeRunId: string, action: 'pause' | 'resume'): Promise<any> {
    const nodeRun = this.knotline.database.getNodeRun(nodeRunId)
    if (!nodeRun) throw new Error('Knotline Node Run no longer exists')
    if (action === 'resume') {
      if (nodeRun.status !== 'waiting_input') throw new Error('Only a paused Task Bench can resume')
      if (nodeRun.error && nodeRun.error !== 'Paused from Task Bench') {
        await this.resetAgentSession(nodeRun.agentProfileId)
      }
      await this.startNodeRun(nodeRun.id)
      return {
        nodeRun: this.knotline.database.getNodeRun(nodeRun.id),
        binding: this.knotline.database.getAgentRuntimeBindingByProfile(nodeRun.agentProfileId),
      }
    }
    if (!['queued', 'running', 'waiting_input', 'changes_requested'].includes(nodeRun.status)) {
      throw new Error('Only an active Task Bench can pause')
    }
    const agent = await this.ensureAgent(nodeRun)
    const pausedRun = this.knotline.database.updateNodeRun(nodeRun.id, {
      status: 'waiting_input',
      error: 'Paused from Task Bench',
    })
    const binding = this.knotline.database.updateAgentRuntimeBinding(nodeRun.agentProfileId, {
      currentNodeRunId: nodeRun.id,
      status: 'paused',
      lastError: null,
    })
    agent.cancel({ kind: 'user' })
    return { nodeRun: pausedRun, binding }
  }

  private monitor(nodeRunId: string, agent: Agent): void {
    if (this.monitoring.has(nodeRunId)) return
    this.monitoring.add(nodeRunId)
    let retryAfterIdle = false
    void agent.whenIdle().then(async () => {
      const current = this.knotline.database.getNodeRun(nodeRunId)
      const outcome = lastLiveFacts(agent).outcome
      const finalMessage = lastAssistantText(agent)
      if (current && outcome === 'error' && ['queued', 'running'].includes(current.status)) {
        const retryCount = this.transientRetries.get(nodeRunId) ?? 0
        if (retryCount < 1) {
          this.transientRetries.set(nodeRunId, retryCount + 1)
          await this.resetAgentSession(current.agentProfileId)
          retryAfterIdle = true
          return
        }
      }
      if (current && outcome !== null && outcome !== 'completed' && current.status !== 'waiting_input') {
        await knotlineJson(this.ctx, `/node-runs/${encodeURIComponent(nodeRunId)}/runtime`, {
          method: 'POST',
          headers: AGENT_REQUEST_HEADERS,
          body: JSON.stringify({
            sessionId: String(agent.id),
            status: 'blocked',
            error: `DSH Agent turn ended with ${outcome}.`,
            ...(finalMessage ? { finalMessage } : {}),
          }),
        })
        return
      }
      this.transientRetries.delete(nodeRunId)
      if (current && ['queued', 'running'].includes(current.status)) {
        // A clean turn that answered without lifecycle tools is an answer awaiting the
        // user's next instruction, not a blocked run — report it honestly.
        const answeredCleanly = outcome === 'completed' && finalMessage !== null
        await knotlineJson(this.ctx, `/node-runs/${encodeURIComponent(nodeRunId)}/runtime`, {
          method: 'POST',
          headers: AGENT_REQUEST_HEADERS,
          body: JSON.stringify({
            sessionId: String(agent.id),
            status: answeredCleanly ? 'waiting' : 'blocked',
            error: answeredCleanly ? null : 'The DSH Agent became idle without calling a Knotline completion tool.',
            ...(finalMessage ? { finalMessage } : {}),
          }),
        })
        return
      }
      if (current && outcome === 'completed' && finalMessage) {
        await knotlineJson(this.ctx, `/node-runs/${encodeURIComponent(nodeRunId)}/runtime`, {
          method: 'POST',
          headers: AGENT_REQUEST_HEADERS,
          body: JSON.stringify({
            sessionId: String(agent.id),
            status: 'idle',
            finalMessage,
          }),
        })
      }
    }).catch(error => {
      this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
    }).finally(() => {
      this.monitoring.delete(nodeRunId)
      if (retryAfterIdle) {
        void this.startNodeRun(nodeRunId).catch(error => {
          this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
        })
      }
    })
  }

  async messageAgent(
    agentProfileId: string,
    mode: 'followup' | 'steer' | 'inject',
    message: string,
    nodeRunId: string | null,
  ): Promise<void> {
    const binding = this.knotline.database.getAgentRuntimeBindingByProfile(agentProfileId)
    const currentRunId = nodeRunId ?? binding?.currentNodeRunId
    const nodeRun = currentRunId ? this.knotline.database.getNodeRun(currentRunId) : null
    if (!nodeRun) throw new Error('Knotline Agent has no active Node Run')
    const agent = await this.ensureAgent(nodeRun)
    const input = agentMessage(message, `Knotline ${mode}`)
    if (mode === 'followup') {
      await knotlineJson(this.ctx, `/node-runs/${encodeURIComponent(nodeRun.id)}/start`, {
        method: 'POST',
        headers: AGENT_REQUEST_HEADERS,
        body: '{}',
      })
      agent.followup(input)
      this.monitor(nodeRun.id, agent)
    } else if (mode === 'steer') {
      agent.steer(input)
    } else {
      agent.inject(input)
    }
  }

  async rememberContext(agentProfileId: string, title: string, content: string): Promise<void> {
    const agent = await this.ensureAgentProfile(agentProfileId)
    agent.followup(agentMessage([
      '<knotline_context_document>',
      `Title: ${title}`,
      content,
      'Retain this as context for future conversation in this Agent.',
      'Acknowledge it briefly. Do not execute project work, create a plan, or call Knotline lifecycle tools.',
      '</knotline_context_document>',
    ].join('\n\n'), `Context: ${title}`))
  }

  observeStatus(agent: Agent, status: 'idle' | 'running'): void {
    const binding = this.knotline.database.getAgentRuntimeBindingBySession(String(agent.id))
    if (!binding?.currentNodeRunId) return
    const nodeRun = this.knotline.database.getNodeRun(binding.currentNodeRunId)
    if (!nodeRun) return
    if (status === 'idle' && ['waiting_input', 'failed', 'waiting_review', 'approved', 'completed', 'canceled'].includes(nodeRun.status)) {
      this.knotline.database.updateAgentRuntimeBinding(nodeRun.agentProfileId, {
        currentNodeRunId: null,
        status: 'idle',
        lastError: null,
      })
      return
    }
    void knotlineJson(this.ctx, `/node-runs/${encodeURIComponent(binding.currentNodeRunId)}/runtime`, {
      method: 'POST',
      headers: AGENT_REQUEST_HEADERS,
      body: JSON.stringify({
        sessionId: String(agent.id),
        status: status === 'running' ? 'working' : 'idle',
        error: null,
      }),
    }).catch(error => {
      this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
    })
  }

  observeError(agent: Agent, error: unknown): void {
    const binding = this.knotline.database.getAgentRuntimeBindingBySession(String(agent.id))
    if (!binding?.currentNodeRunId) return
    void knotlineJson(this.ctx, `/node-runs/${encodeURIComponent(binding.currentNodeRunId)}/runtime`, {
      method: 'POST',
      headers: AGENT_REQUEST_HEADERS,
      body: JSON.stringify({
        sessionId: String(agent.id),
        status: 'blocked',
        error: error instanceof Error ? error.message : String(error),
      }),
    }).catch(nextError => {
      this.ctx.logger.warn(nextError instanceof Error ? nextError : new Error(String(nextError)))
    })
  }

  recover(): void {
    for (const binding of this.knotline.database.listRecoverableAgentRuntimeBindings()) {
      const nodeRun = binding.currentNodeRunId
        ? this.knotline.database.getNodeRun(binding.currentNodeRunId)
        : null
      if (!nodeRun || ['failed', 'waiting_review', 'approved', 'completed', 'canceled'].includes(nodeRun.status)) {
        this.knotline.database.updateAgentRuntimeBinding(binding.agentProfileId, {
          currentNodeRunId: null,
          status: 'idle',
          lastError: null,
        })
      }
    }
    for (const nodeRun of this.knotline.database.listRecoverableNodeRuns()) {
      void this.startNodeRun(nodeRun.id).catch(error => {
        this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      })
    }
  }

  async dispose(): Promise<void> {
    const handles = [...this.handles.values()]
    this.handles.clear()
    await Promise.allSettled(handles.map(handle => handle.dispose()))
  }
}

async function workflowCapabilities(ctx: Context, workspacePath: string) {
  const [skills, schemas] = await Promise.all([
    ctx.skills.list({ cwd: workspacePath }),
    Promise.resolve(ctx.tools.schemas()),
  ])
  return {
    skills: skills.map(skill => ({
      id: skill.name,
      label: skill.name,
      description: skill.description,
      path: skill.resourceBase?.kind === 'directory' ? skill.resourceBase.path : '',
      scope: skill.source.startsWith('project-')
        ? 'repo'
        : skill.source.startsWith('user-') ? 'user' : 'system',
    })),
    mcpServers: schemas.map(schema => ({
      id: schema.name,
      label: schema.name,
      transport: 'dsh-tool',
    })),
  }
}

async function globalModelDirectory(ctx: Context) {
  const catalog = await Promise.all(ctx.llm.listProviders().map(async provider => {
    try {
      const models = await ctx.llm.listModels(provider.id)
      const entries = await Promise.all(models.map(async model => {
        const resolved = await ctx.llm.resolveModelInfo(provider.id, model.id)
        return {
          id: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
          ...(resolved.reasoning === undefined ? {} : {
            reasoning: {
              efforts: resolved.reasoning.efforts.map(effort => ({
                id: effort.id,
                name: effort.name,
                ...(effort.description === undefined ? {} : { description: effort.description }),
              })),
              ...(resolved.reasoning.defaultEffort === undefined
                ? {}
                : { defaultEffort: resolved.reasoning.defaultEffort }),
            },
          }),
        }
      }))
      return {
        kind: 'group' as const,
        value: { id: provider.id, name: provider.name, models: entries },
      }
    } catch (error) {
      return {
        kind: 'failure' as const,
        value: {
          id: provider.id,
          name: provider.name,
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }))
  return {
    current: ctx.agentDefaultModel.currentSelection(),
    groups: catalog.filter(entry => entry.kind === 'group' && entry.value.models.length > 0).map(entry => entry.value),
    failures: catalog.filter(entry => entry.kind === 'failure').map(entry => entry.value),
  }
}

async function saveGlobalModelSelection(ctx: Context, input: ModelSelection): Promise<ModelSelection> {
  const resolved = await ctx.llm.resolveCallConfig({
    provider: input.provider,
    model: input.model,
    ...(input.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(input.reasoningEffort) }),
  })
  const selected: ModelSelection = {
    provider: resolved.provider,
    model: resolved.model,
    ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
  }
  await ctx.agentDefaultModel.saveSelection(selected)
  return selected
}

interface TranscriptLine { role: 'user' | 'assistant' | 'tool'; text: string }

const TRANSCRIPT_MAX_LINES = 200
const TRANSCRIPT_MAX_LINE_CHARS = 4_000

// A compact live view of the agent conversation behind a node run, so the Map
// shows the same narrative a chat window would.
function serializeTranscript(events: readonly unknown[]): TranscriptLine[] {
  const lines: TranscriptLine[] = []
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const record = event as { type?: unknown; data?: unknown }
    const type = typeof record.type === 'string' ? record.type : ''
    const data = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : null
    if (type === 'user/message' || type === 'assistant/message') {
      const payload = type === 'user/message' ? data?.content : (data?.message as { content?: unknown } | undefined)?.content
      const parts = Array.isArray(payload) ? payload : []
      const texts: string[] = []
      for (const part of parts) {
        if (!part || typeof part !== 'object') continue
        const piece = part as { type?: unknown; text?: unknown }
        if (piece.type === 'text' && typeof piece.text === 'string' && piece.text.trim()) texts.push(piece.text)
      }
      const joined = texts.join('\n\n').trim()
      if (joined) {
        lines.push({
          role: type === 'user/message' ? 'user' : 'assistant',
          text: joined.length > TRANSCRIPT_MAX_LINE_CHARS ? `${joined.slice(0, TRANSCRIPT_MAX_LINE_CHARS)}…` : joined,
        })
      }
      continue
    }
    if (type.startsWith('tool/')) {
      const name = typeof data?.name === 'string' ? data.name : typeof data?.tool === 'string' ? data.tool : null
      if (name && type.endsWith('/start')) lines.push({ role: 'tool', text: name })
    }
  }
  return lines.slice(-TRANSCRIPT_MAX_LINES)
}

async function handleRequest(
  knotline: KnotlineServerHandle,
  req: IncomingMessage,
  res: ServerResponse,
  readTranscript?: (nodeRunId: string) => TranscriptLine[] | null,
): Promise<void> {
  const url = new URL(req.url ?? KNOTLINE_BASE_PATH, 'http://knotline.local')
  const pathname = url.pathname

  if (pathname === `${MAP_BASE_PATH}/api` || pathname.startsWith(`${MAP_BASE_PATH}/api/`)) {
    forwardMapRequest(knotline, req, res, url)
    return
  }
  if (!methodAllowed(req, res)) return

  const transcriptRoute = pathname.match(new RegExp(`^${KNOTLINE_API_PATH}/node-runs/([^/]+)/transcript$`))
  if (transcriptRoute?.[1] !== undefined && readTranscript) {
    const lines = readTranscript(decodeURIComponent(transcriptRoute[1]))
    if (lines === null) {
      sendError(res, 404, 'TRANSCRIPT_UNAVAILABLE', 'This node run has no live conversation to read.')
      return
    }
    sendJson(res, 200, { lines }, req.method === 'HEAD')
    return
  }

  if (pathname === `${KNOTLINE_API_PATH}/health`) {
    sendJson(res, 200, {
      ok: true,
      product: 'Knotline',
      source: 'deepseek-harness',
      services: ['map', 'sessions', 'agents', 'sidebarPlugin'],
    }, req.method === 'HEAD')
    return
  }
  if (pathname.startsWith(`${KNOTLINE_API_PATH}/`)) {
    sendError(res, 404, 'API_NOT_FOUND', 'Unknown Knotline API route.')
    return
  }
  sendError(res, 404, 'NOT_FOUND', 'Knotline is available only from the DeepSeek Harness sidebar.')
}

export function apply(ctx: Context): void {
  applySkillFilesystem(ctx, { providerName: 'knotline-filesystem' })
  let orchestrator: AgentOrchestrator | null = null
  const agentOrchestrator = {
    provisionAgent: (agentProfileId: string) => orchestrator?.provisionAgent(agentProfileId),
    startNodeRun: (nodeRunId: string) => orchestrator?.startNodeRun(nodeRunId),
    controlNodeRun: (nodeRunId: string, action: 'pause' | 'resume') => orchestrator?.controlNodeRun(nodeRunId, action),
    messageAgent: (
      agentProfileId: string,
      mode: 'followup' | 'steer' | 'inject',
      message: string,
      nodeRunId: string | null,
    ) => orchestrator?.messageAgent(agentProfileId, mode, message, nodeRunId),
    rememberContext: (agentProfileId: string, title: string, content: string) => (
      orchestrator?.rememberContext(agentProfileId, title, content)
    ),
  }
  const knotline = createKnotlineServer({
    dshMode: true,
    dataDirectory: dshHomePath('knotline', 'knotline'),
    staticDirectory: dshHomePath('knotline', 'no-static-ui'),
    skillPath: '',
    version: '0.1.0',
    workflowCapabilities: (workspacePath: string) => workflowCapabilities(ctx, workspacePath),
    modelSelection: {
      get: () => globalModelDirectory(ctx),
      select: (selection: ModelSelection) => saveGlobalModelSelection(ctx, selection),
    },
    agentRuntimeProvider: () => agentRuntimeSessions(ctx),
    agentOrchestrator,
    deviceWorkspaces: async () => ({}),
  }) as KnotlineServerHandle
  orchestrator = new AgentOrchestrator(ctx, knotline)
  ctx.effect(() => async () => { await knotline.close() }, 'knotline: knotline database')
  ctx.effect(() => async () => { await orchestrator?.dispose() }, 'knotline: agent orchestrator')

  ctx.on('agent/status', ({ agent, status }) => {
    orchestrator?.observeStatus(agent, status)
  }, { global: true })
  ctx.on('agent/error', ({ agent, error }) => {
    orchestrator?.observeError(agent, error)
  }, { global: true })
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: KNOTLINE_BASE_PATH,
    handler: async (req, res) => {
      try {
        await handleRequest(knotline, req, res, (nodeRunId) => {
          const run = knotline.database.getNodeRun(nodeRunId) as { sessionId?: string | null } | null
          if (!run?.sessionId) return null
          const agent = ctx.agents.list().find(candidate => String(candidate.id) === String(run.sessionId))
          if (!agent) return null
          return serializeTranscript(agent.session.events)
        })
      } catch (error) {
        ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
        if (!res.headersSent) sendError(res, 500, 'INTERNAL_ERROR', 'Knotline could not read the current DSH state.')
        else res.destroy()
      }
    },
  }), 'knotline: web route')
  setTimeout(() => { orchestrator?.recover() }, 0)
}
