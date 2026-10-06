// 构建前自检的运行器：用 esbuild 把 verify.ts 打成临时 ESM 再执行，无需额外 TS 运行依赖。
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { rmSync } from 'node:fs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(root, 'node_modules/.cache/verify.mjs')

await build({
  entryPoints: [path.join(root, 'scripts/verify.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  tsconfig: path.join(root, 'tsconfig.json'),
  external: ['esbuild'],
})

// 打包后 import.meta.url 指向缓存文件，项目根目录通过环境变量显式传入。
process.env.PROJECT_ROOT = root
await import(pathToFileURL(outfile).href)
rmSync(outfile, { force: true })
