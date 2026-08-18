// SPDX-License-Identifier: Apache-2.0

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionRecord, SessionTitleObservationResult } from '@deepseek-ai/dsh-session-query'
import type { SessionSummary, TurnOutcome } from '../contracts.ts'

export function readTurnOutcome(event: SessionEvent): TurnOutcome | null {
  return event.type === 'turn/end' ? event.data.reason.kind : null
}

export function titleMap(results: readonly SessionTitleObservationResult[]): Map<string, { title: string; updatedAt: number }> {
  const map = new Map<string, { title: string; updatedAt: number }>()
  for (const result of results) {
    if (result.status !== 'fulfilled' || result.value.title === undefined) continue
    map.set(String(result.sessionId), {
      title: result.value.title.title,
      updatedAt: result.value.title.updatedAt,
    })
  }
  return map
}

export function summarizeSession(
  record: SessionRecord,
  title: { title: string; updatedAt: number } | undefined,
  agent: Agent | undefined,
  lastOutcome: TurnOutcome | null,
  lastActivityAt: number | null = null,
): SessionSummary {
  const id = String(record.header.id)
  const fallback = record.header.cwd?.split(/[\\/]/).filter(Boolean).at(-1) ?? `Session ${id.slice(0, 8)}`
  const state = lastOutcome === 'error'
    ? 'failed'
    : agent?.status === 'running'
      ? 'running'
      : agent === undefined
        ? 'recorded'
        : 'idle'
  return {
    id,
    title: title?.title ?? fallback,
    cwd: record.header.cwd ?? null,
    parentSessionId: record.header.parentSession === undefined ? null : String(record.header.parentSession),
    origin: record.header.origin ?? null,
    depth: record.header.delegationDepth ?? 0,
    agentPreset: record.header.agentPreset ?? null,
    createdAt: record.header.createdAt,
    titleUpdatedAt: title?.updatedAt ?? null,
    lastActivityAt,
    live: record.live,
    persisted: record.persisted,
    state,
    provider: agent?.options.provider ?? null,
    model: agent?.options.model ?? null,
    lastOutcome,
  }
}
