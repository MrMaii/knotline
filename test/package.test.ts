// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  assertAssignedNodeRun,
  assertAssignedReview,
  isAllowedMapApiRequest,
  isLoopbackAddress,
} from '../src/host/security.ts'

describe('installable DSH bundle metadata', () => {
  it('declares both the bundle patch and browser client face', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      name: string
      dsh?: { bundle?: { patch?: string }; client?: { platform?: string } }
      keywords?: string[]
    }
    expect(manifest.name).toBe('knotline-dsh')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh?.client?.platform).toBe('web')
    expect(manifest.keywords).toContain('dsh-plugin')
  })

  it('mounts exactly one Knotline Loader row', async () => {
    const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toContain('id: knotline')
    expect(patch).toContain('name: knotline-dsh')
  })
})

describe('Knotline DSH security boundary', () => {
  it('accepts local peers and rejects remote peers', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('192.168.1.20')).toBe(false)
  })

  it('allows current Map routes and blocks legacy APIs', () => {
    const currentRoutes = [
      ['GET', '/api/events'],
      ['GET', '/api/projects'],
      ['POST', '/api/projects'],
      ['GET', '/api/projects/project/map'],
      ['GET', '/api/projects/project/canvases'],
      ['POST', '/api/projects/project/canvases'],
      ['POST', '/api/projects/project/canvases/canvas/nodes'],
      ['POST', '/api/projects/project/canvases/canvas/clear'],
      ['POST', '/api/projects/project/agents'],
      ['PATCH', '/api/agents/agent'],
      ['POST', '/api/agents/agent/messages'],
      ['POST', '/api/projects/project/knowledge/initialize'],
      ['POST', '/api/projects/project/demands'],
      ['POST', '/api/projects/project/backlogs'],
      ['POST', '/api/projects/project/approval-pools'],
      ['GET', '/api/workflow-capabilities'],
      ['GET', '/api/model-selection'],
      ['PUT', '/api/model-selection'],
      ['POST', '/api/projects/project/skills'],
      ['POST', '/api/knowledge-assets/asset/duplicate'],
      ['POST', '/api/projects/project/scheduled-triggers'],
      ['PATCH', '/api/scheduled-triggers/trigger'],
      ['POST', '/api/projects/project/map-items'],
      ['PATCH', '/api/graph/nodes/node/layout'],
      ['POST', '/api/projects/project/graph/actions/resolve'],
      ['POST', '/api/projects/project/graph/commands'],
      ['POST', '/api/node-runs/run/control'],
      ['GET', '/api/notifications'],
      ['PATCH', '/api/notifications/notification'],
      ['POST', '/api/notifications/notification/actions/approve'],
      ['GET', '/api/node-runs/run/project-context'],
      ['POST', '/api/node-runs/run/start'],
      ['POST', '/api/node-runs/run/update'],
      ['POST', '/api/node-runs/run/submit-delivery'],
      ['POST', '/api/node-runs/run/request-review'],
      ['POST', '/api/node-runs/run/knowledge-proposals'],
      ['POST', '/api/node-runs/run/runtime'],
    ] as const
    for (const [method, route] of currentRoutes) {
      expect(isAllowedMapApiRequest(method, route), `${method} ${route}`).toBe(true)
    }
    expect(isAllowedMapApiRequest('POST', '/api/local/ai/threads')).toBe(false)
    expect(isAllowedMapApiRequest('GET', '/api/tasks')).toBe(false)
    expect(isAllowedMapApiRequest('GET', '/api/device-workspaces')).toBe(false)
    expect(isAllowedMapApiRequest('POST', '/api/local/cloud-session')).toBe(false)
    expect(isAllowedMapApiRequest('POST', '/api/local/jira/connection')).toBe(false)
    expect(isAllowedMapApiRequest('DELETE', '/api/projects')).toBe(false)
  })

  it('binds lifecycle and review operations to the assigned agent', () => {
    const database = {
      getNodeRun: (id: string) => id === 'review-run'
        ? { agentProfileId: 'reviewer', projectId: 'project', workstreamId: 'workstream' }
        : { agentProfileId: 'producer', projectId: 'project', workstreamId: 'workstream' },
      getReviewGate: () => ({
        reviewerAgentId: 'reviewer',
        projectId: 'project',
        workstreamId: 'workstream',
      }),
    }
    expect(() => assertAssignedNodeRun(database, 'producer', 'producer-run')).not.toThrow()
    expect(() => assertAssignedNodeRun(database, 'reviewer', 'producer-run')).toThrow(/assigned Node Run/)
    expect(() => assertAssignedReview(database, 'reviewer', {
      nodeRunId: 'review-run',
      projectId: 'project',
      workstreamId: 'workstream',
      reviewGateId: 'gate',
    })).not.toThrow()
    expect(() => assertAssignedReview(database, 'producer', {
      nodeRunId: 'producer-run',
      projectId: 'project',
      workstreamId: 'workstream',
      reviewGateId: 'gate',
    })).toThrow(/not assigned/)
  })
})
