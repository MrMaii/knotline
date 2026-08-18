// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, resolve } from 'node:path'
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'

const CSS_VIRTUAL_PREFIX = '\0knotline-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
const require = createRequire(import.meta.url)

function inlineClientCss(pluginId: string) {
  return {
    name: 'knotline-css-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.css') || importer === undefined) return null
      const fileId = isAbsolute(source)
        ? source
        : source.startsWith('.')
          ? resolve(dirname(importer), source)
          : require.resolve(source, { paths: [dirname(importer)] })
      return `${CSS_VIRTUAL_PREFIX}${fileId}${CSS_VIRTUAL_SUFFIX}`
    },
    async load(this: { addWatchFile: (id: string) => void }, virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const isModule = fileId.endsWith('.module.css')
      const result = transform({
        filename: fileId,
        code: await readFile(fileId),
        minify: true,
        ...(isModule ? { cssModules: { pattern: '[hash]_[local]' } } : {}),
      })
      const classes: Record<string, string> = {}
      if (isModule) {
        for (const [local, value] of Object.entries(result.exports ?? {})) classes[local] = value.name
      }
      const digest = createHash('sha256').update(fileId).digest('hex').slice(0, 8)
      const tagId = `${pluginId}/${digest}`
      return [
        `const css = ${JSON.stringify(result.code.toString())};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
        "  const tag = document.createElement('style');",
        `  tag.dataset.plugin = ${JSON.stringify(pluginId)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classes)};`,
      ].join('\n')
    },
  }
}

function inlineClientImages() {
  const prefix = '\0knotline-image:'
  return {
    name: 'knotline-image-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.png') || importer === undefined) return null
      const fileId = source.startsWith('.')
        ? resolve(dirname(importer), source)
        : require.resolve(source, { paths: [dirname(importer)] })
      return `${prefix}${fileId}`
    },
    async load(this: { addWatchFile: (id: string) => void }, virtualId: string) {
      if (!virtualId.startsWith(prefix)) return null
      const fileId = virtualId.slice(prefix.length)
      this.addWatchFile(fileId)
      const image = (await readFile(fileId)).toString('base64')
      return `export default ${JSON.stringify(`data:image/png;base64,${image}`)};`
    },
  }
}

const clientExternals = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-sidebar/client',
  '@deepseek-ai/dsh-client-ui-slots',
]

export default defineConfig([
  {
    name: 'knotline-dsh',
    entry: { index: 'src/host/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    fixedExtension: false,
    clean: true,
    dts: true,
    external: [/^@deepseek-ai\//],
  },
  {
    name: 'knotline-dsh/client',
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    define: {
      'import.meta.env': JSON.stringify({ MODE: 'production' }),
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    fixedExtension: false,
    clean: false,
    dts: false,
    sourcemap: false,
    minify: true,
    external: clientExternals,
    noExternal: [/^@xyflow\//, /^@phosphor-icons\//],
    plugins: [inlineClientCss('knotline-dsh'), inlineClientImages()],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: "window.__ModuleLoader__.load({ id: 'knotline-dsh', factory: (require) => {",
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
  {
    name: 'knotline-dsh/client-types',
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    fixedExtension: false,
    clean: false,
    dts: { emitDtsOnly: true },
    external: clientExternals,
  },
])
