// SPDX-License-Identifier: Apache-2.0

export const KNOTLINE_BASE_PATH = '/knotline'
export const KNOTLINE_API_PATH = `${KNOTLINE_BASE_PATH}/api`

export type SessionState = 'running' | 'idle' | 'recorded' | 'failed'
export type TurnOutcome = 'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens' | 'interrupted'

export interface SessionSummary {
  id: string
  title: string
  cwd: string | null
  parentSessionId: string | null
  origin: 'subagent' | null
  depth: number
  agentPreset: string | null
  createdAt: number
  titleUpdatedAt: number | null
  lastActivityAt: number | null
  live: boolean
  persisted: boolean
  state: SessionState
  provider: string | null
  model: string | null
  lastOutcome: TurnOutcome | null
}

export interface ApiErrorBody {
  error: {
    code: string
    message: string
  }
}
