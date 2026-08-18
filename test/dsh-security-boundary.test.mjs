// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createKnotlineServer } from '../server/app.mjs'

test('DSH mode rejects hidden AI and ignores stale Cloud configuration', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'knotline-dsh-security-'))
  await writeFile(path.join(dataDirectory, 'cloud-companion.json'), '{not valid json', 'utf8')
  const knotline = createKnotlineServer({
    dshMode: true,
    dataDirectory,
    staticDirectory: path.join(dataDirectory, 'static'),
    deviceWorkspaces: async () => ({}),
    workflowCapabilities: async () => ({ skills: [], mcpServers: [] }),
    modelSelection: {
      get: async () => ({ providers: [], selected: null }),
      select: async value => value,
    },
  })

  try {
    const address = await knotline.listen({ host: '127.0.0.1', port: 0 })
    assert(address && typeof address === 'object')
    const origin = `http://127.0.0.1:${address.port}`

    const hiddenAi = await fetch(`${origin}/api/local/ai/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspacePath: dataDirectory, sandbox: 'danger-full-access' }),
    })
    assert.equal(hiddenAi.status, 404)

    const projects = await fetch(`${origin}/api/projects`)
    assert.equal(projects.status, 200)
    assert.equal((await projects.json()).projects[0]?.id, 'local')
  } finally {
    await knotline.close()
    await rm(dataDirectory, { recursive: true, force: true })
  }
})
