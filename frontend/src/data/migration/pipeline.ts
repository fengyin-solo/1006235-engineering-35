/**
 * 检修人员台账迁移流水线（纯函数、与浏览器无关，本地与部署环境跑同一套）。
 *
 * 环节只能按 normalize → dedupe → backfill → reconcile → hydrology-follow → self-check
 * 的顺序推进，跳级由 assertStage 直接拦下并报缺哪一步。反复运行结论幂等，不会多出重复人员。
 */
import type { EntryRow } from '@/data/types'
import type { LegacyCrewRow, LegacyHydrologyRow } from './legacy'
import {
  CERT_BACKFILL_YEARS,
  CERT_WARNING_DAYS,
  CREW_CODE_PATTERN,
  DISBANDED_TEAMS,
  POST_DEFAULT_TEAM,
  REFERENCE_DATE,
  STAGES,
  addYears,
  diffDays,
} from './rules'
import type { CrewMetrics, SelfCheckIssue, SelfCheckReport } from './self-check'

/** 迁移中的人员中间结构：保留来源信息，落库前再转成页面用的 EntryRow。 */
export type WorkingCrew = {
  人员编号: string
  姓名: string
  岗位: string
  持证类型: string
  证书有效期: string
  所属班组: string
  联系电话: string
  在场状态: string
  办理进场时间: string
  _来源: string
  _产生时间: string
  _原始编号: string
  _合并来源: string[]
}

type WorkingHydrology = LegacyHydrologyRow

export type PipelineResult = {
  crew: EntryRow[]
  hydrology: EntryRow[]
  report: SelfCheckReport
}

export type StageName =
  | 'normalize'
  | 'dedupe'
  | 'backfill'
  | 'reconcile'
  | 'hydrology-follow'
  | 'self-check'

/** 跳级拦截：执行 next 前必须先完成它的上一环节。 */
export class StageOrderError extends Error {
  constructor(next: string, expected: string) {
    super(`迁移环节跳级：执行「${next}」前必须先完成「${expected}」`)
    this.name = 'StageOrderError'
  }
}

type StageCompletion = Record<Exclude<StageName, never>, boolean>

/**
 * 顺序迁移器：每个环节一个方法，后一环节显式依赖前一环节。
 * 用 createMigrationPipeline 逐环节推进；runPipeline 是跑完整条链路的便捷封装。
 */
export class MigrationPipeline {
  crew: WorkingCrew[] = []
  hydrology: WorkingHydrology[] = []
  report: SelfCheckReport | null = null
  issues: SelfCheckIssue[] = []

  private readonly legacyCrew: LegacyCrewRow[]
  private readonly legacyHydrology: LegacyHydrologyRow[]
  private readonly done: StageCompletion = {
    normalize: false,
    dedupe: false,
    backfill: false,
    reconcile: false,
    'hydrology-follow': false,
    'self-check': false,
  }

  constructor(legacyCrew: LegacyCrewRow[], legacyHydrology: LegacyHydrologyRow[]) {
    this.legacyCrew = legacyCrew
    this.legacyHydrology = legacyHydrology
  }

  private assertStage(next: StageName): void {
    const index = STAGES.findIndex((stage) => stage.key === next)
    if (index > 0 && !this.done[STAGES[index - 1].key as StageName]) {
      throw new StageOrderError(STAGES[index].name, STAGES[index - 1].name)
    }
  }

  /** 环节 1：字段规范化。老台账按业务时间（办理进场时间）排序，再统一重新编号。 */
  normalize(): this {
    this.assertStage('normalize')
    this.crew = normalizeCrew(this.legacyCrew)
    this.done.normalize = true
    return this
  }

  /** 环节 2：去重。判法：规范化后的人员编号相同即同人，较晚产生的一套为准，较早一条仅补缺。 */
  dedupe(): this {
    this.assertStage('dedupe')
    dedupeCrew(this.crew, this.issues)
    this.done.dedupe = true
    return this
  }

  /** 环节 3：缺项补齐。班组按岗位默认归属补；早年没有证书有效期的按进场时间加 4 年补领。 */
  backfill(): this {
    this.assertStage('backfill')
    backfillCrew(this.crew, this.issues)
    this.done.backfill = true
    return this
  }

  /** 环节 4：矛盾核定。在场人员挂已撤编班组的，按岗位改派到在编班组并注明缘由。 */
  reconcile(): this {
    this.assertStage('reconcile')
    reconcileCrew(this.crew, this.issues)
    this.done.reconcile = true
    return this
  }

  /** 环节 5：水情待办随人员结论一起改派。值守人员不在场的待办，改派同班组在场持证人员。 */
  followHydrology(): this {
    this.assertStage('hydrology-follow')
    this.hydrology = followHydrology(this.legacyHydrology, this.crew, this.issues)
    this.done['hydrology-follow'] = true
    return this
  }

  /** 环节 6：自检落库。编号重复、证书缺项、在场与班组矛盾逐条列示并注明缘由。 */
  selfCheck(): this {
    this.assertStage('self-check')
    this.report = buildReport(this.crew, this.hydrology, this.issues)
    this.done['self-check'] = true
    return this
  }

  result(): PipelineResult {
    if (!this.report) {
      throw new StageOrderError('读取迁移结果', '自检落库')
    }
    return {
      crew: toCrewEntries(this.crew, this.report.issues),
      hydrology: toHydrologyEntries(this.hydrology),
      report: this.report,
    }
  }
}

export function runPipeline(
  legacyCrew: LegacyCrewRow[],
  legacyHydrology: LegacyHydrologyRow[],
): PipelineResult {
  return new MigrationPipeline(legacyCrew, legacyHydrology)
    .normalize()
    .dedupe()
    .backfill()
    .reconcile()
    .followHydrology()
    .selfCheck()
    .result()
}

function normalizeCrew(legacy: LegacyCrewRow[]): WorkingCrew[] {
  const sorted = [...legacy].sort((a, b) =>
    a.办理进场时间 === b.办理进场时间
      ? a._产生时间.localeCompare(b._产生时间)
      : a.办理进场时间.localeCompare(b.办理进场时间),
  )
  const peopleOrder: string[] = []
  for (const row of sorted) {
    if (!peopleOrder.includes(row.姓名)) {
      peopleOrder.push(row.姓名)
    }
  }
  return sorted.map((row) => {
    // 原始编号格式不统一（CREW-001/CREW-0007），先按进场顺序给每个自然人分配统一序号。
    const seq = peopleOrder.indexOf(row.姓名) + 1
    return {
      人员编号: `CREW-${String(seq).padStart(4, '0')}`,
      姓名: row.姓名,
      岗位: row.岗位,
      持证类型: row.持证类型,
      证书有效期: row.证书有效期,
      所属班组: row.所属班组,
      联系电话: row.联系电话,
      在场状态: row.在场状态,
      办理进场时间: row.办理进场时间,
      _来源: row._来源,
      _产生时间: row._产生时间,
      _原始编号: row.人员编号,
      _合并来源: [],
    }
  })
}

function dedupeCrew(crew: WorkingCrew[], issues: SelfCheckIssue[]): void {
  const groups = new Map<string, WorkingCrew[]>()
  for (const row of crew) {
    const list = groups.get(row.人员编号) ?? []
    list.push(row)
    groups.set(row.人员编号, list)
  }

  const merged: WorkingCrew[] = []
  for (const [code, list] of groups) {
    if (list.length === 1) {
      merged.push(list[0])
      continue
    }
    const ordered = [...list].sort((a, b) => a._产生时间.localeCompare(b._产生时间))
    const later = ordered[ordered.length - 1]
    const earlier = ordered.slice(0, -1)
    // 较晚产生的一套为准；较早一套只在较晚一条该字段为空时补缺。
    const winner: WorkingCrew = { ...later }
    const conflictFields: string[] = []
    for (const old of earlier) {
      for (const field of ['岗位', '持证类型', '证书有效期', '所属班组', '联系电话', '在场状态'] as const) {
        if (old[field] !== winner[field]) {
          if (winner[field] === '' && old[field] !== '') {
            winner[field] = old[field]
          } else if (old[field] !== '' && !conflictFields.includes(field)) {
            conflictFields.push(field)
          }
        }
      }
    }
    winner._合并来源 = ordered.map((row) => row._来源)
    issues.push({
      类型: 'duplicate-code',
      级别: 'warn',
      模块: 'crew',
      编号: code,
      姓名: winner.姓名,
      缘由:
        `人员编号 ${code} 在${ordered.map((row) => `「${row._来源}」(${row._产生时间})`).join('、')}中各有一条，` +
        `按较晚产生的「${later._来源}」(${later._产生时间})为准去重，较早记录仅补缺` +
        (conflictFields.length ? `；两套取值冲突字段（${conflictFields.join('、')}）已统一为较晚一套` : ''),
    })
    merged.push(winner)
  }

  crew.splice(0, crew.length, ...merged.sort((a, b) => a.人员编号.localeCompare(b.人员编号)))
}

function backfillCrew(crew: WorkingCrew[], issues: SelfCheckIssue[]): void {
  for (const row of crew) {
    if (!row.所属班组) {
      const team = POST_DEFAULT_TEAM[row.岗位]
      if (team) {
        row.所属班组 = team
        issues.push({
          类型: 'team-backfill',
          级别: 'info',
          模块: 'crew',
          编号: row.人员编号,
          姓名: row.姓名,
          缘由: `所属班组缺失，按岗位「${row.岗位}」的默认归属补为「${team}」`,
        })
      }
    }

    if (!row.持证类型) {
      issues.push({
        类型: 'cert-missing',
        级别: 'error',
        模块: 'crew',
        编号: row.人员编号,
        姓名: row.姓名,
        缘由: '持证类型与证书有效期均缺失，无法补领，标记为待补证；该人员不计入持证人员',
      })
      continue
    }
    if (!row.证书有效期) {
      // 早年台账没有证书有效期：以办理进场时间为业务锚点补领 4 年，并标「补领」。
      const expiry = addYears(row.办理进场时间, CERT_BACKFILL_YEARS)
      row.证书有效期 = `${expiry}(补领)`
      issues.push({
        类型: 'cert-backfill',
        级别: 'warn',
        模块: 'crew',
        编号: row.人员编号,
        姓名: row.姓名,
        缘由: `老台账缺证书有效期，按办理进场时间 ${row.办理进场时间} 补领 ${CERT_BACKFILL_YEARS} 年至 ${row.证书有效期}`,
      })
    }
  }
}

function reconcileCrew(crew: WorkingCrew[], issues: SelfCheckIssue[]): void {
  for (const row of crew) {
    if (row.在场状态 === '在场' && (DISBANDED_TEAMS as readonly string[]).includes(row.所属班组)) {
      const target = POST_DEFAULT_TEAM[row.岗位] ?? '机械检修一班'
      issues.push({
        类型: 'team-conflict',
        级别: 'error',
        模块: 'crew',
        编号: row.人员编号,
        姓名: row.姓名,
        缘由: `在场状态「在场」与所属班组「${row.所属班组}」矛盾（该班组已撤编），按岗位改派至「${target}」`,
      })
      row.所属班组 = target
    }
  }
}

function followHydrology(
  legacy: LegacyHydrologyRow[],
  crew: WorkingCrew[],
  issues: SelfCheckIssue[],
): WorkingHydrology[] {
  const byName = new Map(crew.map((row) => [row.姓名, row]))
  const pendingStatuses = ['待观测', '已观测']
  const sorted = [...legacy].sort((a, b) =>
    a.观测时间 === b.观测时间
      ? a.记录编号.localeCompare(b.记录编号)
      : a.观测时间.localeCompare(b.观测时间),
  )

  const onSiteCertified = (team?: string) =>
    crew
      .filter(
        (candidate) =>
          candidate.在场状态 === '在场' &&
          candidate.持证类型 &&
          (team === undefined || candidate.所属班组 === team),
      )
      .sort((a, b) => a.人员编号.localeCompare(b.人员编号))

  const pickReplacement = (team: string): string | null => {
    // 优先同班组在场持证人员；同班组没有时，取人员编号最小的在场持证人员兜底。
    return onSiteCertified(team)[0]?.姓名 ?? onSiteCertified()[0]?.姓名 ?? null
  }

  return sorted.map((row) => {
    if (!pendingStatuses.includes(row.调度状态)) {
      return row
    }
    const keeper = byName.get(row.值守人员)
    if (keeper && keeper.在场状态 === '在场') {
      return row
    }
    // 待办的值守人员已离场/停工/待进场：随人员台账结论改派，优先同班组在场持证人员。
    const replacement = pickReplacement(keeper?.所属班组 ?? '')
    const next: WorkingHydrology = { ...row }
    if (replacement) {
      next.值守人员 = replacement
      issues.push({
        类型: 'hydrology-follow',
        级别: 'warn',
        模块: 'hydrology',
        编号: row.记录编号,
        姓名: row.值守人员,
        缘由:
          `水情记录 ${row.记录编号}（${row.观测时间}）待办值守人员「${row.值守人员}」当前不在场` +
          (keeper ? `（在场状态：${keeper.在场状态}）` : '（人员台账已查无此人，原引用为重复/作废编号）') +
          `，按检修人员台账结论改派给在场持证人员「${replacement}」`,
      })
    }
    return next
  })
}

export function certExpiryDate(row: { [field: string]: unknown }): string {
  return String(row.证书有效期 ?? '').replace('(补领)', '')
}

export function computeCrewMetrics(crew: readonly EntryRow[]): CrewMetrics {
  const onSite = crew.filter((row) => String(row.在场状态) === '在场').length
  const certified = crew.filter((row) => String(row.持证类型 ?? '') !== '').length
  const expiring = crew
    .filter((row) => String(row.在场状态) === '在场' && String(row.持证类型 ?? '') !== '')
    .filter((row) => {
      const expiry = certExpiryDate(row)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
        return false
      }
      const days = diffDays(REFERENCE_DATE, expiry)
      return days >= 0 && days <= CERT_WARNING_DAYS
    }).length
  return { 在场人员: onSite, 持证人员: certified, 证书即将到期: expiring }
}

function buildReport(
  crew: WorkingCrew[],
  hydrology: WorkingHydrology[],
  issues: SelfCheckIssue[],
): SelfCheckReport {
  // 编号自检：迁移后仍重复即数据本身有问题（理论上 dedupe 已合并，此处兜底）。
  const seen = new Set<string>()
  for (const row of crew) {
    if (!CREW_CODE_PATTERN.test(row.人员编号)) {
      issues.push({
        类型: 'code-format',
        级别: 'error',
        模块: 'crew',
        编号: row.人员编号,
        姓名: row.姓名,
        缘由: '人员编号不符合 CREW-#### 统一规则',
      })
    }
    if (seen.has(row.人员编号)) {
      issues.push({
        类型: 'duplicate-code',
        级别: 'error',
        模块: 'crew',
        编号: row.人员编号,
        姓名: row.姓名,
        缘由: '去重后人员编号仍重复',
      })
    }
    seen.add(row.人员编号)

    // 证书已过期：持过期证属高风险，单独列示。
    const expiry = certExpiryDate(row)
    if (row.持证类型 && /^\d{4}-\d{2}-\d{2}$/.test(expiry) && diffDays(REFERENCE_DATE, expiry) < 0) {
      issues.push({
        类型: 'cert-expired',
        级别: 'error',
        模块: 'crew',
        编号: row.人员编号,
        姓名: row.姓名,
        缘由: `证书已于 ${expiry} 到期，当前在场状态「${row.在场状态}」，须换证后上岗`,
      })
    }
  }

  const metrics = computeCrewMetrics(crew as unknown as EntryRow[])
  const hydrologyPending = hydrology.filter((row) => ['待观测', '已观测'].includes(row.调度状态)).length
  const order = { error: 0, warn: 1, info: 2 } as const
  const orderedIssues = [...issues].sort(
    (a, b) => order[a.级别] - order[b.级别] || a.编号.localeCompare(b.编号),
  )

  return {
    版本: '2026.10.06.1',
    生成时间: `${REFERENCE_DATE} 12:00`,
    基准日期: REFERENCE_DATE,
    到期窗口天数: CERT_WARNING_DAYS,
    环节: STAGES.map((stage) => ({ key: stage.key, name: stage.name, 完成时间: `${REFERENCE_DATE} 12:00` })),
    issues: orderedIssues,
    metrics,
    hydrologyPending,
    总人数: crew.length,
  }
}

function toCrewEntries(crew: WorkingCrew[], issues: SelfCheckIssue[]): EntryRow[] {
  const errorIds = new Set(issues.filter((issue) => issue.级别 === 'error').map((issue) => issue.编号))
  return crew.map((row, index) => {
    const { _来源: _s, _产生时间: _t, _原始编号: _o, _合并来源: _m, ...fields } = row
    return {
      id: index + 1,
      status: row.在场状态,
      pending: row.在场状态 !== '已停工',
      abnormal: errorIds.has(row.人员编号),
      ...fields,
    }
  })
}

function toHydrologyEntries(rows: WorkingHydrology[]): EntryRow[] {
  const statusPending = (status: string) => status === '待观测' || status === '已观测'
  return rows.map((row, index) => {
    const { _来源: _s, _产生时间: _t, ...fields } = row
    return {
      id: index + 1,
      status: row.调度状态,
      pending: statusPending(row.调度状态),
      abnormal: false,
      ...fields,
    }
  })
}
