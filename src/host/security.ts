// SPDX-License-Identifier: Apache-2.0

type AllowedMethod = 'DELETE' | 'GET' | 'HEAD' | 'PATCH' | 'POST' | 'PUT'

interface RouteRule {
  methods: readonly AllowedMethod[]
  pattern: RegExp
}

const READ = ['GET', 'HEAD'] as const

const MAP_API_ROUTES: readonly RouteRule[] = [
  { methods: READ, pattern: /^\/api\/events$/ },
  { methods: [...READ, 'POST'], pattern: /^\/api\/projects$/ },
  { methods: READ, pattern: /^\/api\/projects\/[^/]+\/map$/ },
  { methods: [...READ, 'POST'], pattern: /^\/api\/projects\/[^/]+\/canvases$/ },
  { methods: ['POST'], pattern: /^\/api\/projects\/[^/]+\/canvases\/[^/]+\/(?:nodes|clear)$/ },
  { methods: ['POST'], pattern: /^\/api\/projects\/[^/]+\/(?:agents|demands|backlogs|approval-pools|skills|scheduled-triggers|map-items)$/ },
  { methods: ['POST'], pattern: /^\/api\/projects\/[^/]+\/knowledge\/initialize$/ },
  { methods: ['POST'], pattern: /^\/api\/projects\/[^/]+\/graph\/(?:actions\/resolve|commands)$/ },
  { methods: ['PATCH'], pattern: /^\/api\/agents\/[^/]+$/ },
  { methods: ['POST'], pattern: /^\/api\/agents\/[^/]+\/messages$/ },
  { methods: READ, pattern: /^\/api\/workflow-capabilities$/ },
  { methods: [...READ, 'PUT'], pattern: /^\/api\/model-selection$/ },
  { methods: ['POST'], pattern: /^\/api\/knowledge-assets\/[^/]+\/duplicate$/ },
  { methods: ['PATCH'], pattern: /^\/api\/scheduled-triggers\/[^/]+$/ },
  { methods: ['PATCH'], pattern: /^\/api\/graph\/nodes\/[^/]+\/layout$/ },
  { methods: ['POST'], pattern: /^\/api\/node-runs\/[^/]+\/control$/ },
  { methods: READ, pattern: /^\/api\/notifications$/ },
  { methods: ['PATCH'], pattern: /^\/api\/notifications\/[^/]+$/ },
  { methods: ['POST'], pattern: /^\/api\/notifications\/[^/]+\/actions\/[^/]+$/ },
  { methods: READ, pattern: /^\/api\/node-runs\/[^/]+\/project-context$/ },
  { methods: ['POST'], pattern: /^\/api\/node-runs\/[^/]+\/(?:start|update|submit-delivery|request-review|knowledge-proposals|runtime)$/ },
]

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1'
    || address === '::1'
    || address?.startsWith('::ffff:127.') === true
}

export function isAllowedMapApiRequest(method: string | undefined, pathname: string): boolean {
  const normalizedMethod = (method ?? 'GET').toUpperCase() as AllowedMethod
  return MAP_API_ROUTES.some(route => route.pattern.test(pathname) && route.methods.includes(normalizedMethod))
}

interface AgentSecurityDatabase {
  getNodeRun(id: string): { agentProfileId?: string; projectId?: string; workstreamId?: string } | null
  getReviewGate(id: string): {
    projectId?: string
    workstreamId?: string
    reviewerAgentId?: string | null
  } | null
}

export function assertAssignedNodeRun(
  database: AgentSecurityDatabase,
  agentProfileId: string,
  nodeRunId: string,
): { agentProfileId?: string; projectId?: string; workstreamId?: string } {
  const nodeRun = database.getNodeRun(nodeRunId)
  if (!nodeRun || nodeRun.agentProfileId !== agentProfileId) {
    throw new Error('This Knotline Agent can access only its assigned Node Run')
  }
  return nodeRun
}

export function assertAssignedReview(
  database: AgentSecurityDatabase,
  agentProfileId: string,
  input: { nodeRunId: string; projectId: string; workstreamId: string; reviewGateId: string },
): void {
  const nodeRun = assertAssignedNodeRun(database, agentProfileId, input.nodeRunId)
  const reviewGate = database.getReviewGate(input.reviewGateId)
  if (
    nodeRun.projectId !== input.projectId
    || nodeRun.workstreamId !== input.workstreamId
    || !reviewGate
    || reviewGate.reviewerAgentId !== agentProfileId
    || reviewGate.projectId !== input.projectId
    || reviewGate.workstreamId !== input.workstreamId
  ) {
    throw new Error('This Knotline Agent is not assigned to that review gate')
  }
}
