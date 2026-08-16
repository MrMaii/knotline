// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

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
