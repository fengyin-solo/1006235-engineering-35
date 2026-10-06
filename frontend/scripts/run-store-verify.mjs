/**
 * 落库链路验证：用 localStorage 桩跑 local-store 的初始化/重开/重初始化，
 * 确认自检结果先落库、重开读到同一份、反复初始化不产生重复人员。
 */
import { build } from 'esbuild'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdirSync, rmSync } from 'node:fs'

const root = process.env.PROJECT_ROOT ?? process.cwd()
const out = path.join(root, 'node_modules/.cache/verify-store.mjs')
mkdirSync(path.dirname(out), { recursive: true })

await build({
  entryPoints: [path.join(root, 'scripts/store-harness.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  tsconfig: path.join(root, 'tsconfig.json'),
  external: ['esbuild'],
})

try {
  await import(pathToFileURL(out).href)
} finally {
  rmSync(out, { force: true })
}
