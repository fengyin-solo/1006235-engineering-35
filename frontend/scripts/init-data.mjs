#!/usr/bin/env node
/**
 * 检修人员台账初始化脚本：与浏览器首次播种跑的是同一条流水线
 * （src/data/crew/pipeline.ts + src/data/crew/legacy.ts）。
 *
 * 用途：
 *   node scripts/init-data.mjs            # 跑一遍迁移并把台账快照写到 .init-snapshot/crew-ledger.json
 *   node scripts/init-data.mjs --verify   # 连跑两遍，校验反复初始化幂等、人数口径稳定
 *
 * 本地开发、CI 构建、容器部署都执行这一个入口；脚本不依赖浏览器，也不读 localStorage。
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function loadPipeline() {
  const tempDir = await mkdtempSafe()
  const outFile = path.join(tempDir, 'init-bundle.mjs')
  try {
    await build({
      entryPoints: [path.join(root, 'src/data/crew/init-entry.ts')],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile: outFile,
      logLevel: 'silent',
    })
    return await import(pathToFileURL(outFile).href)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

async function mkdtempSafe() {
  const { mkdtemp } = await import('node:fs/promises')
  return mkdtemp(path.join(os.tmpdir(), 'crew-init-'))
}

async function main() {
  const { runCrewPipeline, LEGACY_CREW_SOURCES, LEGACY_HYDROLOGY } = await loadPipeline()

  const first = runCrewPipeline({ sources: LEGACY_CREW_SOURCES, hydrology: LEGACY_HYDROLOGY })
  const outDir = path.join(root, '.init-snapshot')
  await mkdir(outDir, { recursive: true })
  const snapshot = {
    generatedAt: first.report.generatedAt,
    referenceDate: first.report.referenceDate,
    totals: first.report.totals,
    stages: first.report.stages.map((stage) => stage.title),
    crew: first.crew,
    hydrology: first.hydrology,
    report: first.report,
  }
  await writeFile(path.join(outDir, 'crew-ledger.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')

  console.log('[init] 检修人员台账初始化完成')
  console.log(`[init] 阶段顺序：${snapshot.stages.join(' → ')}`)
  console.log(
    `[init] 在册 ${first.report.totals.crew} 人 · 在场 ${first.report.totals.onSite} 人 · ` +
      `持证 ${first.report.totals.certified} 人 · 90天内到期 ${first.report.totals.expiring} 人 · ` +
      `过期 ${first.report.totals.expired} 人 · 自检问题 ${first.report.totals.issues} 条`,
  )
  console.log(
    `[init] 水情记录 ${first.hydrology.length} 条 · 待办 ${first.report.totals.hydrologyPending} 条 · ` +
      `联动改派 ${first.report.totals.hydrologyReassigned} 条`,
  )

  if (process.argv.includes('--verify')) {
    // 第二遍把第一遍的在册台账当作「最晚产生的一套」喂回去：人员集合、人数必须完全不变。
    const second = runCrewPipeline({
      sources: LEGACY_CREW_SOURCES,
      hydrology: LEGACY_HYDROLOGY,
      previousCrew: first.crew,
    })
    const sameCrew = JSON.stringify(second.crew) === JSON.stringify(first.crew)
    const sameHydrology = JSON.stringify(second.hydrology) === JSON.stringify(first.hydrology)
    const sameTotals = JSON.stringify(second.report.totals) === JSON.stringify(first.report.totals)
    if (!sameCrew || !sameHydrology || !sameTotals) {
      console.error('[init] 幂等校验失败：反复初始化结果不一致', { sameCrew, sameHydrology, sameTotals })
      process.exit(1)
    }
    console.log('[init] 幂等校验通过：连续初始化两次，在册人员、水情清单、人数口径完全一致')
  }

  // 不变量自检：报告在场人数必须等于台账在场条数（另一个入口对账的依据）。
  const onSiteRows = first.crew.filter((row) => String(row.在场状态) === '在场').length
  if (onSiteRows !== first.report.totals.onSite) {
    console.error(`[init] 对账失败：台账在场 ${onSiteRows} 条 ≠ 报告在场 ${first.report.totals.onSite} 人`)
    process.exit(1)
  }
  // 水情待办不得引用已离场/非台账/证书过期人员。
  const validOnSite = new Set(
    first.crew
      .filter((row) => String(row.在场状态) === '在场' && String(row.证书有效期) >= first.report.referenceDate)
      .map((row) => row.姓名),
  )
  for (const row of first.hydrology) {
    if (row.pending && !validOnSite.has(row.值守人员)) {
      console.error(`[init] 水情待办 ${row.记录编号} 值守人员「${row.值守人员}」不满足在场持证要求`)
      process.exit(1)
    }
  }
  console.log('[init] 对账校验通过：报告/台账/水情待办三处口径一致')

  // 顺带确认快照可被重新读回（自检结果先落库的离线等价验证）。
  const reread = JSON.parse(await readFile(path.join(outDir, 'crew-ledger.json'), 'utf8'))
  if (reread.totals.onSite !== first.report.totals.onSite) {
    console.error('[init] 快照回读校验失败')
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('[init] 初始化失败：', error)
  process.exit(1)
})
