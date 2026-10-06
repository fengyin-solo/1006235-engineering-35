#!/usr/bin/env node
/**
 * 浏览器数据层冒烟校验：用最小 localStorage 桩驱动 src/data/local-store.ts 的真实代码，
 * 覆盖：首次播种、本地重建后的样例残档修复、反复初始化幂等、自检报告先落库、
 * 两个入口（检修人员页 / 运营概览）在场人数对账、进场离场动作后口径联动、水情待办改派。
 */
import { rm, mkdir } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await import('node:fs/promises').then((fs) => fs.mkdtemp(path.join(os.tmpdir(), 'crew-smoke-')))
const outFile = path.join(temp, 'store-bundle.mjs')
await build({
  entryPoints: [path.join(root, 'scripts/store-smoke-entry.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: outFile,
  alias: { '@': path.join(root, 'src') },
  logLevel: 'silent',
})

function makeBrowserEnv() {
  const storage = new Map()
  const storeApi = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear(),
  }
  globalThis.window = { localStorage: storeApi }
  globalThis.localStorage = storeApi
  return storage
}

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.error(`  ✗ ${name} ${detail}`)
  }
}

// —— 场景 1：首次播种 ——
{
  const storage = makeBrowserEnv()
  const store = await import(pathToFileURL(outFile).href + '?case=fresh')
  const report = store.crewReport()
  const crew = store.listRows('crew')
  const hydrology = store.listRows('hydrology')
  console.log('场景1：首次打开（空 localStorage）')
  check('台账 13 人', crew.length === 13, `实际 ${crew.length}`)
  check('在场 9 人', report.totals.onSite === 9)
  check('水情 7 条', hydrology.length === 7)
  const raw = storage.get('hydropower-plant-om:entries')
  check('自检报告与台账同一次落库', raw.includes('"__crew_report__"'))
  const persisted = JSON.parse(raw)
  check('落库报告在场人数=9', persisted.__crew_report__.totals.onSite === 9)
  const onSiteRows = crew.filter((r) => r.在场状态 === '在场').length
  check('报告在场人数=页面在场条数', persisted.__crew_report__.totals.onSite === onSiteRows)
}

// —— 场景 2：本地环境重建后的样例残档自动修复 ——
{
  const storage = makeBrowserEnv()
  storage.set(
    'hydropower-plant-om:entries',
    JSON.stringify({
      crew: [
        { id: 1, status: '待进场', pending: true, abnormal: false, 人员编号: 'CREW-0001', 姓名: '检修人员样例1', 在场状态: '检修人员样例1' },
      ],
    }),
  )
  const store = await import(pathToFileURL(outFile).href + '?case=stale')
  const crew = store.listRows('crew')
  const report = store.crewReport()
  console.log('场景2：本地重建只剩样例残档')
  check('样例残档被修复为 13 人', crew.length === 13, `实际 ${crew.length}`)
  check('无样例字样人员', crew.every((r) => !String(r.姓名).includes('样例')))
  check('修复后自检报告齐全', report.totals.issues > 0 && report.stages.length === 5)
}

// —— 场景 3：重新打开页面读到同一份报告（持久化），并反复初始化幂等 ——
{
  const storage = makeBrowserEnv()
  const store = await import(pathToFileURL(outFile).href + '?case=persist')
  const first = JSON.stringify({ crew: store.listRows('crew'), report: store.crewReport() })
  const beforeStorage = storage.get('hydropower-plant-om:entries')
  store.reinitializeCrew()
  store.reinitializeCrew()
  const afterCrew = JSON.stringify(store.listRows('crew'))
  const afterReportTotals = JSON.stringify(store.crewReport().totals)
  console.log('场景3：反复初始化与重新打开')
  const parsedFirst = JSON.parse(first)
  check('反复初始化不新增重复人员', store.listRows('crew').length === 13)
  check('人员集合逐字节一致', afterCrew === JSON.stringify(parsedFirst.crew))
  check('人数口径一致', afterReportTotals === JSON.stringify(parsedFirst.report.totals))
  check('落库内容已更新但键不变', storage.get('hydropower-plant-om:entries') !== beforeStorage && storage.has('hydropower-plant-om:entries'))
}

// —— 场景 4：两个入口对账 + 页面动作联动 ——
{
  makeBrowserEnv()
  const store = await import(pathToFileURL(outFile).href + '?case=reconcile')
  const service = store.smokeService()
  console.log('场景4：运营概览 / 检修人员页 / 水情页对账')
  const overview = service.loadOverview()
  const onSiteCard = overview.cards.find((c) => c.label === '检修在场人员')
  const hydroCard = overview.cards.find((c) => c.label === '水情待办')
  check('概览在场人数=9 且与报告一致', onSiteCard.value === 9 && onSiteCard.value === store.crewReport().totals.onSite)
  check('概览水情待办=6', hydroCard.value === 6)

  // 给一个在场人员办理离场
  const firstOnSite = store.listRows('crew').find((r) => r.在场状态 === '在场')
  const result = service.runAction('crew', firstOnSite.id, '办理离场')
  check('办理离场成功', result.ok === true, result.message)
  const updated = store.listRows('crew').find((r) => r.id === firstOnSite.id)
  check('离场后班组改为撤场班组', updated.所属班组 === '撤场班组')
  const report = store.crewReport()
  check('自检报告在场人数同步为 8', report.totals.onSite === 8)
  const overview2 = service.loadOverview()
  check('概览在场人数同步为 8', overview2.cards.find((c) => c.label === '检修在场人员').value === 8)
  const pageOnSite = store.listRows('crew').filter((r) => r.在场状态 === '在场').length
  check('页面在场条数与报告仍一致', pageOnSite === 8 && pageOnSite === report.totals.onSite)

  // 水情待办值守人全部在场持证
  const validNames = new Set(
    store.listRows('crew').filter((r) => r.在场状态 === '在场' && r.证书有效期 >= '2026-10-06').map((r) => r.姓名),
  )
  const badTodo = store.listRows('hydrology').filter((r) => r.pending && !validNames.has(r.值守人员))
  check('水情待办值守人全部在场持证', badTodo.length === 0, JSON.stringify(badTodo))
}

await rm(temp, { recursive: true, force: true })
if (failures) {
  console.error(`\n冒烟校验失败 ${failures} 项`)
  process.exit(1)
}
console.log('\n全部冒烟校验通过')
