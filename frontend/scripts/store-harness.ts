/** local-store 落库链路桩测试（由 run-store-verify.mjs 打包后执行）。 */
import { build } from 'esbuild'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdirSync, rmSync } from 'node:fs'

type StoreMap = Record<string, string>

function makeWindow(initial: StoreMap = {}) {
  const map: StoreMap = { ...initial }
  return {
    localStorage: {
      getItem: (key: string) => (key in map ? map[key] : null),
      setItem: (key: string, value: string) => {
        map[key] = value
      },
      removeItem: (key: string) => {
        delete map[key]
      },
    },
    __dump: () => map,
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

const root = process.env.PROJECT_ROOT ?? process.cwd()
const tmpDir = path.join(root, 'node_modules/.cache/store-instances')
mkdirSync(tmpDir, { recursive: true })
let seq = 0

// 每次重新打一个独立 bundle，模块单例全新，模拟「重开浏览器 / 另一环境」。
async function freshStore() {
  const file = path.join(tmpDir, `store-${seq++}.mjs`)
  await build({
    entryPoints: [path.join(root, 'src/data/local-store.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: file,
    tsconfig: path.join(root, 'tsconfig.json'),
  })
  const mod = (await import(pathToFileURL(file).href)) as typeof import('../src/data/local-store')
  rmSync(file, { force: true })
  return mod
}

let currentWindow = makeWindow()
;(globalThis as Record<string, unknown>).window = currentWindow as unknown

// 第一次初始化：数据与自检结果都应落库。
const first = await freshStore()
first.ensureBoot()
const crew1 = first.listRows('crew')
const report1 = first.selfCheckReport()
const stored1 = currentWindow.__dump()
assert(stored1['hydropower-plant-om:entries'], '初始化未把台账落库')
assert(stored1['hydropower-plant-om:crew-self-check'], '自检结果未先落库')
assert(crew1.length === 9, `首次初始化期望 9 人，实际 ${crew1.length}`)
assert(report1.metrics.在场人员 === 6, '首次初始化在场人数口径错误')

// 重开页面：直接读 localStorage，不重跑链路，应读到同一份。
currentWindow = makeWindow(stored1)
;(globalThis as Record<string, unknown>).window = currentWindow
const second = await freshStore()
second.ensureBoot()
assert(JSON.stringify(second.listRows('crew')) === JSON.stringify(crew1), '重开页面台账不是同一份')
assert(JSON.stringify(second.selfCheckReport()) === JSON.stringify(report1), '重开页面自检结果不是同一份')

// 另一个入口（概览）读到的在场人数与自检一致。
const overviewOnSite = second
  .listRows('crew')
  .filter((row) => String(row.在场状态) === '在场').length
assert(overviewOnSite === report1.metrics.在场人员, '概览入口在场人数与自检对不上')

// 模拟用户做了状态流转：钱卫东办理离场，落库后重开仍保留该改动。
second.saveRows(
  'crew',
  second.listRows('crew').map((row) =>
    String(row.姓名) === '钱卫东'
      ? { ...row, 在场状态: '已离场', status: '已离场' }
      : row,
  ),
)
const mutated = currentWindow.__dump()
currentWindow = makeWindow(mutated)
;(globalThis as Record<string, unknown>).window = currentWindow
const third = await freshStore()
third.ensureBoot()
const qianAfter = third.listRows('crew').find((row) => String(row.姓名) === '钱卫东')
assert(String(qianAfter?.在场状态) === '已离场', '状态流转落库后重开未保留')

// 重新初始化：回到链路结论，幂等且不会多出人。
third.reinitialize()
assert(third.listRows('crew').length === 9, '重新初始化后人数发生变化')
assert(
  JSON.stringify(third.listRows('crew')) === JSON.stringify(crew1),
  '重新初始化结论与首次不一致（非幂等）',
)
assert(
  JSON.stringify(third.selfCheckReport()) === JSON.stringify(report1),
  '重新初始化自检结论与首次不一致',
)

// 本地环境重建（库残缺，无版本标记）：初始化按链路版本整体替换残缺人员。
currentWindow = makeWindow({
  'hydropower-plant-om:entries': JSON.stringify({
    crew: [
      { id: 1, 人员编号: 'CREW-0001', 姓名: '残', 在场状态: '在场' },
      { id: 2, 人员编号: 'CREW-0001', 姓名: '残', 在场状态: '在场' },
    ],
  }),
})
;(globalThis as Record<string, unknown>).window = currentWindow
const rebuilt = await freshStore()
rebuilt.ensureBoot()
const crewRebuilt = rebuilt.listRows('crew')
assert(crewRebuilt.length === 9, `本地重建后期望 9 人，实际 ${crewRebuilt.length}（残缺数据未替换）`)
const codes = crewRebuilt.map((row) => String(row.人员编号))
assert(new Set(codes).size === codes.length, '重建后仍有重复人员编号')
assert(rebuilt.selfCheckReport().metrics.在场人员 === 6, '重建后在场人数口径不一致')

// 模拟部署环境：全新空库，结论与本地完全一致。
currentWindow = makeWindow()
;(globalThis as Record<string, unknown>).window = currentWindow
const deployed = await freshStore()
deployed.ensureBoot()
assert(JSON.stringify(deployed.listRows('crew')) === JSON.stringify(crew1), '部署环境与本地初始化结论不一致')
assert(
  JSON.stringify(deployed.selfCheckReport()) === JSON.stringify(report1),
  '部署环境自检结果与本地不一致',
)

rmSync(tmpDir, { recursive: true, force: true })
console.log('✓ 落库链路：初始化落库、重开一致、重复初始化幂等、残缺重建替换、本地/部署同口径')
