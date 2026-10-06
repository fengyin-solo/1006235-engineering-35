/**
 * 构建前自检脚本：直接验证迁移链路的口径，本地与部署环境的构建都跑这一份。
 *
 * 校验项：
 *  1. 迁移结果人数、在场/持证/即将到期人数符合预期口径；
 *  2. 反复运行结论幂等，不会多出重复人员；
 *  3. 去重按人员编号、较晚产生的一套为准；
 *  4. 早年证书缺项按进场时间补领 4 年，无证人员不计入持证；
 *  5. 在场状态与撤编班组的矛盾已改派；
 *  6. 水情待办随人员结论改派，待办数与页面口径一致；
 *  7. 自检结果在场人数与台账在场条数一致，并含三类必列问题；
 *  8. 环节必须顺序推进，跳级直接拦下并报缺哪一步。
 */
import { build } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.env.PROJECT_ROOT ?? process.cwd()

async function loadPipeline() {
  const innerOut = path.join(root, 'node_modules/.cache/verify-pipeline.mjs')
  mkdirSync(path.dirname(innerOut), { recursive: true })
  await build({
    entryPoints: [path.join(root, 'src/data/migration/pipeline.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: innerOut,
    tsconfig: path.join(root, 'tsconfig.json'),
  })
  try {
    return (await import(pathToFileURL(innerOut).href)) as typeof import('../src/data/migration/pipeline')
  } finally {
    rmSync(innerOut, { force: true })
  }
}

const checks: { name: string; run: () => void }[] = []
function check(name: string, run: () => void) {
  checks.push({ name, run })
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

const pipelineMod = await loadPipeline()
const { runPipeline } = pipelineMod
const { LEGACY_CREW, LEGACY_HYDROLOGY } = await import('../src/data/migration/legacy.ts')

const first = runPipeline(LEGACY_CREW, LEGACY_HYDROLOGY)

check('1. 迁移后为 9 名检修人员（11 条老记录含 2 条重复）', () => {
  assert(first.crew.length === 9, `期望 9 人，实际 ${first.crew.length} 人`)
})

check('2. 指标口径：在场 6、持证 8、90 天内到期 2', () => {
  const { metrics } = first.report
  assert(metrics.在场人员 === 6, `在场人员期望 6，实际 ${metrics.在场人员}`)
  assert(metrics.持证人员 === 8, `持证人员期望 8，实际 ${metrics.持证人员}`)
  assert(metrics.证书即将到期 === 2, `证书即将到期期望 2，实际 ${metrics.证书即将到期}`)
})

check('3. 页面在场条数与自检结果一致', () => {
  const onSiteRows = first.crew.filter((row) => String(row.在场状态) === '在场').length
  assert(
    onSiteRows === first.report.metrics.在场人员,
    `台账在场 ${onSiteRows} 条，自检 ${first.report.metrics.在场人员} 人，不一致`,
  )
})

check('4. 反复初始化幂等：人员与自检结论完全一致', () => {
  const second = runPipeline(LEGACY_CREW, LEGACY_HYDROLOGY)
  assert(second.crew.length === first.crew.length, '二次初始化人数不一致')
  assert(JSON.stringify(second.crew) === JSON.stringify(first.crew), '二次初始化人员数据不一致')
  assert(JSON.stringify(second.report) === JSON.stringify(first.report), '二次自检结论不一致')
  const codes = second.crew.map((row) => String(row.人员编号))
  assert(new Set(codes).size === codes.length, '迁移后仍存在重复人员编号')
})

check('5. 去重以人员编号为准，两套取值冲突取较晚产生的一套', () => {
  const qian = first.crew.find((row) => String(row.姓名) === '钱卫东')
  assert(qian, '钱卫东去重后缺失')
  assert(String(qian!.在场状态) === '在场', '钱卫东应按 2026-09-28 较晚手抄台账统一为「在场」')
  const li = first.crew.find((row) => String(row.姓名) === '李建国')
  assert(li, '李建国去重后缺失')
  assert(String(li!.联系电话) === '13800000001', '李建国缺失字段应由较早记录补 13800000001')
})

check('6. 早年证书缺项按办理进场时间补领 4 年；无证人员不计入持证', () => {
  const li = first.crew.find((row) => String(row.姓名) === '李建国')
  assert(String(li!.证书有效期) === '2026-11-18(补领)', `李建国补领日期异常：${li!.证书有效期}`)
  const zhao = first.crew.find((row) => String(row.姓名) === '赵国强')
  assert(String(zhao!.证书有效期) === '2023-09-12(补领)', `赵国强补领日期异常：${zhao!.证书有效期}`)
  const he = first.crew.find((row) => String(row.姓名) === '何秀兰')
  assert(String(he!.持证类型) === '', '何秀兰应保持无证')
})

check('7. 在场状态与撤编班组矛盾已按岗位改派', () => {
  const zheng = first.crew.find((row) => String(row.姓名) === '郑永年')
  assert(String(zheng!.所属班组) === '电气检修班', `郑永年应改派电气检修班，实际 ${zheng!.所属班组}`)
  const wang = first.crew.find((row) => String(row.姓名) === '王海涛')
  assert(String(wang!.所属班组) === '机械检修一班', '王海涛班组应按岗位补机械检修一班')
})

check('8. 水情待办随人员结论改派，待办 4 条与页面口径一致', () => {
  assert(first.report.hydrologyPending === 4, `水情待办期望 4，实际 ${first.report.hydrologyPending}`)
  assert(first.hydrology.length === LEGACY_HYDROLOGY.length, '水情记录条数不应因改派变化')
  const sep28 = first.hydrology.find((row) => String(row.记录编号) === 'HYDR-20260928-02')
  assert(String(sep28!.值守人员) === '周淑芬', `09-28 待办应改派同班组周淑芬，实际 ${sep28!.值守人员}`)
  const oct05 = first.hydrology.find((row) => String(row.记录编号) === 'HYDR-20261005-01')
  assert(String(oct05!.值守人员) === '郑永年', `10-05 待办应改派电气检修班编号最小的郑永年，实际 ${oct05!.值守人员}`)
  const followIssues = first.report.issues.filter((issue) => issue.类型 === 'hydrology-follow')
  assert(followIssues.length === 2, `水情改派应列示 2 条，实际 ${followIssues.length} 条`)
})

check('9. 自检三类问题均单独列示且注明缘由', () => {
  const types = new Set(first.report.issues.map((issue) => issue.类型))
  for (const required of ['duplicate-code', 'cert-backfill', 'team-conflict', 'cert-missing', 'cert-expired']) {
    assert(types.has(required), `自检缺少问题类型 ${required}`)
  }
  assert(
    first.report.issues.every((issue) => issue.缘由.length > 10),
    '存在未注明缘由的自检条目',
  )
})

check('10. 环节跳级被拦截并指明缺少的环节', () => {
  const { MigrationPipeline, StageOrderError } = pipelineMod
  // 直接调 dedupe：normalize（字段规范化）未完成，必须拦下。
  let caught: unknown = null
  try {
    new MigrationPipeline(LEGACY_CREW, LEGACY_HYDROLOGY).dedupe()
  } catch (error) {
    caught = error
  }
  assert(caught instanceof StageOrderError, '跳级执行 dedupe 未被拦截')
  assert(
    caught instanceof Error && caught.message.includes('字段规范化'),
    `拦截信息未指明缺少环节：${caught instanceof Error ? caught.message : ''}`,
  )
  // 直接读结果：self-check 未完成同样拦下。
  let caughtResult: unknown = null
  try {
    new MigrationPipeline(LEGACY_CREW, LEGACY_HYDROLOGY).result()
  } catch (error) {
    caughtResult = error
  }
  assert(caughtResult instanceof StageOrderError, '未自检就读取结果未被拦截')
})

let failed = 0
for (const item of checks) {
  try {
    await item.run()
    console.log(`✓ ${item.name}`)
  } catch (error) {
    failed += 1
    console.error(`✗ ${item.name}`)
    console.error(`  ${error instanceof Error ? error.message : String(error)}`)
  }
}
if (failed > 0) {
  console.error(`\n迁移链路自检未通过：${failed}/${checks.length} 项失败`)
  process.exit(1)
}
console.log(`\n迁移链路自检全部通过（${checks.length} 项）`)
