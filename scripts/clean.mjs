// SPDX-License-Identifier: Apache-2.0

import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const targets = [fileURLToPath(new URL('../lib', import.meta.url))]

await Promise.all(targets.map(target => rm(target, { recursive: true, force: true })))
