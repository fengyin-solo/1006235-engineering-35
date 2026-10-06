/**
 * 检修人员台账迁移流水线（纯逻辑，不依赖浏览器/DOM，本地与部署环境、Node 脚本跑的是同一份）。
 *
 * 阶段只能按顺序推进：提取 extract → 核对 reconcile → 回填 backfill → 去重 dedupe → 自检 selfcheck。
 * 跳级由 StageGate 直接拦下，并说明缺哪一步。
 */

// 基准日固定为本次迁移批次的业务日期：无论本地 dev、容器部署还是 Node 初始化脚本，
// 读到的「证书即将到期」都是同一口径，结果可重复。
export const REFERENCE_DATE = '2026-10-06'
export const EXPIRING_WINDOW_DAYS = 90
export const REPORT_VERSION = 1
export const PIPELINE_GENERATED_AT = '2026-10-06 08:00'

export const DEPARTED_TEAM = '撤场班组'
export const ACTIVE_TEAMS = ['机械检修班', '电气检修班', '金属结构班', '起重组']
export const ON_SITE = '在场'
export const DEPARTED = '已离场'

// 证件复审周期：应急类特种作业证 6 年换证，起重机械作业证 4 年复审。
const CERT_CYCLE_YEARS: { match: string; years: number }[] = [
  { match: '起重', years: 4 },
  { match: '高压', years: 6 },
  { match: '高处', years: 6 },
  { match: '焊接', years: 6 },
]

// 岗位 → 在役班组：早年漏填所属班组的按岗位归班。
const POST_TEAM_RULES: { match: string; team: string }[] = [
  { match: '起重', team: '起重组' },
  { match: '焊', team: '金属结构班' },
  { match: '金属结构', team: '金属结构班' },
  { match: '水轮机', team: '机械检修班' },
  { match: '机械', team: '机械检修班' },
  { match: '发电机', team: '电气检修班' },
  { match: '电气', team: '电气检修班' },
]

const STATUS_SYNONYMS: Record<string, string> = {
  在场: '在场',
  离场: '已离场',
  已离场: '已离场',
  撤场: '已离场',
  待进场: '待进场',
  未进场: '待进场',
  停工: '已停工',
  已停工: '已停工',
}

export const STAGES = ['extract', 'reconcile', 'backfill', 'dedupe', 'selfcheck'] as const
export type StageName = (typeof STAGES)[number]

const STAGE_TITLES: Record<StageName, string> = {
  extract: '提取老台账',
  reconcile: '核对口径',
  backfill: '按业务时间回填',
  dedupe: '编号去重',
  selfcheck: '落库前自检',
}

export class StageOrderError extends Error {}

/** 顺序门：阶段必须一个接一个推进，跳级直接拦下。 */
export class StageGate {
  private cursor = 0

  enter(stage: StageName): void {
    const index = STAGES.indexOf(stage)
    if (index !== this.cursor) {
      const missing = STAGES.slice(this.cursor, index)
        .map((item) => STAGE_TITLES[item])
        .join('、')
      throw new StageOrderError(
        `阶段「${STAGE_TITLES[stage]}」被跳级拦下：必须先完成 ${missing}，流水线只允许 提取→核对→回填→去重→自检 顺序推进。`,
      )
    }
    this.cursor += 1
  }
}

export type RawCrewRow = {
  人员编号?: string
  姓名?: string
  岗位?: string
  持证类型?: string
  证书有效期?: string
  所属班组?: string
  在场状态?: string
  联系电话?: string
  办理进场时间?: string
  _source?: string
  _sourceOrder?: number
  _sourceGeneratedAt?: string
  _updatedAt?: string
  _certFilled?: boolean
  _teamFilled?: boolean
  _entryFilled?: boolean
  _statusNormalized?: string
}

export type CrewSource = {
  name: string
  order: number
  generatedAt: string
  rows: RawCrewRow[]
}

export type RawHydrologyRow = {
  记录编号: string
  观测时间: string
  上游水位: number
  下游水位: number
  入库流量: number
  出库流量: number
  值守人员: string
  调度状态: string
}

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type IssueType = '编号重复' | '证书有效期缺失' | '在场状态与所属班组矛盾' | '证书已过期'

export type CrewIssue = {
  type: IssueType
  人员编号: string
  姓名: string
  reason: string
  resolution: string
}

export type HydrologyChange = {
  记录编号: string
  观测时间: string
  from: string
  to: string
  reason: string
}

export type StageTrace = { stage: StageName; title: string; summary: string }

export type CrewReport = {
  version: number
  generatedAt: string
  referenceDate: string
  expiringBefore: string
  stages: StageTrace[]
  totals: {
    crew: number
    onSite: number
    certified: number
    expiring: number
    expired: number
    issues: number
    hydrologyPending: number
    hydrologyReassigned: number
  }
  issues: CrewIssue[]
  hydrologyChanges: HydrologyChange[]
  rules: {
    dedupeKey: string
    duplicateRule: string
    laterRule: string
    certBackfill: string
    contradictionRule: string
  }
}

export type PipelineResult = {
  crew: EntryRow[]
  hydrology: EntryRow[]
  report: CrewReport
}

export type PipelineInput = {
  sources: CrewSource[]
  hydrology: RawHydrologyRow[]
  /**
   * 本机已迁移过的台账：反复初始化时仅用于「找回」曾给缺号老人员分配过的正式编号
   * （按姓名+联系电话认人），保证同一人每次分到同一个编号；它不会作为额外记录参与去重。
   * 迁移结果因此是固化老台账的纯函数，连跑任意遍逐字节一致，不会长出重复人员。
   */
  previousCrew?: EntryRow[]
}

type Findings = {
  duplicates: CrewIssue[]
  missingCert: CrewIssue[]
  contradictions: CrewIssue[]
  expired: CrewIssue[]
  hydrologyChanges: HydrologyChange[]
}

function clean(value: unknown): string {
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

function parseDate(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function formatDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function addYears(iso: string, years: number): string {
  const date = parseDate(iso)
  date.setFullYear(date.getFullYear() + years)
  return formatDate(date)
}

function diffDays(fromIso: string, toIso: string): number {
  const ms = parseDate(toIso).getTime() - parseDate(fromIso).getTime()
  return Math.round(ms / 86_400_000)
}

function isDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(parseDate(value).getTime())
}

function certCycleYears(certType: string): number {
  const hit = CERT_CYCLE_YEARS.find((rule) => certType.includes(rule.match))
  return hit ? hit.years : 6
}

/** 岗位 → 在役班组：早年漏填所属班组的按岗位归班；自检与页面动作共用这一条规则。 */
export function teamForPost(post: string): string {
  const hit = POST_TEAM_RULES.find((rule) => post.includes(rule.match))
  return hit ? hit.team : ''
}

/** 样例残档判定：本地重建后残留的「检修人员样例N」不进入迁移。 */
function isScaffold(row: RawCrewRow): boolean {
  return clean(row.姓名).includes('样例') || clean(row.持证类型).includes('样例')
}

/** 同一人员两行记录的争议字段。 */
function conflictingFields(a: RawCrewRow, b: RawCrewRow): string[] {
  const fields = ['姓名', '岗位', '持证类型', '证书有效期', '所属班组', '在场状态', '办理进场时间'] as const
  return fields.filter((field) => {
    const va = clean(a[field])
    const vb = clean(b[field])
    return va !== '' && vb !== '' && va !== vb
  })
}

/**
 * 晚者判定：先比逐条记录的更新时间；更新时间相同再比台账套别的产生时间（较晚产生的一套为准）。
 */
function isLaterThan(candidate: RawCrewRow, baseline: RawCrewRow): boolean {
  const candidateUpdated = clean(candidate._updatedAt) || clean(candidate._sourceGeneratedAt)
  const baselineUpdated = clean(baseline._updatedAt) || clean(baseline._sourceGeneratedAt)
  if (candidateUpdated !== baselineUpdated) return candidateUpdated > baselineUpdated
  return (candidate._sourceOrder ?? 0) > (baseline._sourceOrder ?? 0)
}

function rollCertExpiry(entryDate: string, certType: string, reference: string): string {
  const years = certCycleYears(certType)
  let expiry = addYears(entryDate, years)
  // 老证按周期一路复审滚动，取第一个不早于基准日的到期日。
  while (expiry < reference) {
    expiry = addYears(expiry, years)
  }
  return expiry
}

export function runCrewPipeline(input: PipelineInput): PipelineResult {
  const gate = new StageGate()
  const traces: StageTrace[] = []
  const findings: Findings = {
    duplicates: [],
    missingCert: [],
    contradictions: [],
    expired: [],
    hydrologyChanges: [],
  }
  const reference = REFERENCE_DATE

  // —— 阶段 1：提取。两套固化老台账汇集，剔除样例残档。 ——
  gate.enter('extract')
  const extracted: RawCrewRow[] = []
  let droppedScaffolds = 0
  for (const source of [...input.sources].sort((a, b) => a.order - b.order)) {
    for (const raw of source.rows) {
      if (isScaffold(raw)) {
        droppedScaffolds += 1
        continue
      }
      extracted.push({
        ...raw,
        _source: source.name,
        _sourceOrder: source.order,
        _sourceGeneratedAt: source.generatedAt,
        _updatedAt: clean(raw._updatedAt) || source.generatedAt,
      })
    }
  }
  // 已迁移台账只建一张「认人索引」：姓名+联系电话 → 上次分配的编号，不加入待迁移集合。
  const codeByPerson = new Map<string, string>()
  for (const row of input.previousCrew ?? []) {
    const name = clean(row.姓名)
    const phone = clean(row.联系电话)
    const code = clean(row.人员编号)
    if (name && phone && code) {
      codeByPerson.set(`${name}|${phone}`, code)
    }
  }
  traces.push({
    stage: 'extract',
    title: STAGE_TITLES.extract,
    summary: `汇集 ${input.sources.map((item) => `《${item.name}》${item.rows.length} 条`).join('、')}，剔除样例残档 ${droppedScaffolds} 条，进入迁移 ${extracted.length} 条${
      codeByPerson.size ? `；参照本机已迁移台账 ${codeByPerson.size} 人的认人索引，重跑时沿用既有编号` : ''
    }。`,
  })

  // —— 阶段 2：核对。人员编号补号、在场状态同义口径归一。 ——
  gate.enter('reconcile')
  let assignedCodes = 0
  let recoveredCodes = 0
  let normalizedStatus = 0
  for (const row of extracted) {
    row.人员编号 = clean(row.人员编号).toUpperCase()
    if (!row.人员编号) {
      // 优先沿用上一轮迁移时分配给同一人的正式编号（按姓名+联系电话认人）。
      const recovered = codeByPerson.get(`${clean(row.姓名)}|${clean(row.联系电话)}`)
      if (recovered) {
        row.人员编号 = recovered
        recoveredCodes += 1
      } else {
        row.人员编号 = `CREW-XXXX-${String(assignedCodes + 1).padStart(2, '0')}`
        assignedCodes += 1
      }
    }
    const rawStatus = clean(row.在场状态)
    const mapped = STATUS_SYNONYMS[rawStatus] ?? rawStatus
    if (mapped && mapped !== rawStatus) {
      row.在场状态 = mapped
      row._statusNormalized = `${rawStatus}→${mapped}`
      normalizedStatus += 1
    } else {
      row.在场状态 = mapped
    }
  }
  // 占位缺号续编正式编号：序号基准取全册已有最大号，跨次初始化也不撞号。
  const numbered = extracted.map((row) => clean(row.人员编号)).filter((code) => /^CREW-\d{4}$/.test(code))
  const maxSeq = numbered.reduce((max, code) => Math.max(max, Number(code.slice(5))), 1000)
  let nextSeq = maxSeq
  for (const row of extracted) {
    if (/^CREW-XXXX-\d+$/.test(clean(row.人员编号))) {
      nextSeq += 1
      row.人员编号 = `CREW-${String(nextSeq).padStart(4, '0')}`
    }
  }
  traces.push({
    stage: 'reconcile',
    title: STAGE_TITLES.reconcile,
    summary: `人员编号大写归一；老台账漏登编号新补 ${assignedCodes} 个${recoveredCodes ? `、沿用既有编号 ${recoveredCodes} 个` : ''}；在场状态同义口径归一 ${normalizedStatus} 条（如「离场」记作「已离场」、「撤场」记作「已离场」、「未进场」记作「待进场」）。`,
  })

  // —— 阶段 3：回填。老台账按办理进场时间排序，早年缺项按条补齐。 ——
  gate.enter('backfill')
  const knownEntryDates = extracted.map((row) => clean(row.办理进场时间)).filter(isDateString).sort()
  const earliestEntry = knownEntryDates[0] ?? reference
  let entryFilled = 0
  let certFilled = 0
  for (const row of extracted) {
    if (!isDateString(clean(row.办理进场时间))) {
      row.办理进场时间 = earliestEntry
      row._entryFilled = true
      entryFilled += 1
    }
    if (!isDateString(clean(row.证书有效期))) {
      row.证书有效期 = rollCertExpiry(clean(row.办理进场时间), clean(row.持证类型), reference)
      row._certFilled = true
      certFilled += 1
    }
    // 所属班组的缺项不在此处理：缺班组属于「在场状态与所属班组矛盾」，留到自检列示并修复。
  }
  extracted.sort((a, b) => {
    const byEntry = clean(a.办理进场时间).localeCompare(clean(b.办理进场时间))
    if (byEntry !== 0) return byEntry
    return clean(a.人员编号).localeCompare(clean(b.人员编号))
  })
  traces.push({
    stage: 'backfill',
    title: STAGE_TITLES.backfill,
    summary: `全册按办理进场时间排序；缺进场时间补 ${entryFilled} 条（取全册最早业务时间 ${earliestEntry}），缺证书有效期按复审周期滚动补 ${certFilled} 条。`,
  })

  // —— 阶段 4：去重。人员编号是唯一业务键，较晚产生的一套为准，取值统一到胜方。 ——
  gate.enter('dedupe')
  const winners = new Map<string, RawCrewRow>()
  for (const row of extracted) {
    const code = clean(row.人员编号)
    const current = winners.get(code)
    if (!current) {
      winners.set(code, row)
      continue
    }
    const [later, earlier] = isLaterThan(row, current) ? [row, current] : [current, row]
    const conflicts = conflictingFields(later, earlier)
    findings.duplicates.push({
      type: '编号重复',
      人员编号: code,
      姓名: clean(later.姓名) || clean(earlier.姓名),
      reason: `同一人员编号在《${earlier._source}》（记录更新于 ${earlier._updatedAt}，${earlier.在场状态}/${earlier.证书有效期}）与《${later._source}》（记录更新于 ${later._updatedAt}，${later.在场状态}/${later.证书有效期}）各登记一次${
        conflicts.length ? `；争议字段：${conflicts.join('、')}` : ''
      }。`,
      resolution: `按「较晚产生的一套为准」保留《${later._source}》${later._updatedAt} 的记录，编号 ${code} 全册取值统一为该条；早套记录不再保留。`,
    })
    // 晚者缺项沿用早者非空值；争议值一律取晚者。
    const merged: RawCrewRow = { ...later }
    for (const field of ['姓名', '岗位', '持证类型', '证书有效期', '所属班组', '在场状态', '联系电话', '办理进场时间'] as const) {
      if (!clean(merged[field]) && clean(earlier[field])) {
        merged[field] = earlier[field]
      }
    }
    winners.set(code, merged)
  }
  const deduped = [...winners.values()]
  traces.push({
    stage: 'dedupe',
    title: STAGE_TITLES.dedupe,
    summary: `以归一化人员编号为唯一键判重，命中重复编号 ${findings.duplicates.length} 组，合并后在册 ${deduped.length} 人；争议取值已统一到较晚产生的一套。`,
  })

  // —— 阶段 5：自检。矛盾修复、过期识别、编号/缺项/对账不变量校验。 ——
  gate.enter('selfcheck')
  for (const row of deduped) {
    if (row._certFilled) {
      const years = certCycleYears(clean(row.持证类型))
      findings.missingCert.push({
        type: '证书有效期缺失',
        人员编号: clean(row.人员编号),
        姓名: clean(row.姓名),
        reason: `《${row._source}》中未登记证书有效期（办理进场时间 ${row._entryFilled ? `亦缺，已按全册最早业务时间补为 ${row.办理进场时间}` : row.办理进场时间}）。`,
        resolution: `按「${clean(row.持证类型)}」${years} 年复审周期，自办理进场时间滚动至首个不早于 ${reference} 的到期日，补为 ${row.证书有效期}。`,
      })
    }

    const status = clean(row.在场状态)
    const team = clean(row.所属班组)
    const inActiveTeam = ACTIVE_TEAMS.includes(team)
    let contradiction = ''
    let resolution = ''
    if (status === DEPARTED && team !== DEPARTED_TEAM) {
      contradiction = `在场状态为「已离场」，所属班组却是「${team || '空'}」（在役班组），状态与班组矛盾。`
      resolution = `已离场人员统一归入「${DEPARTED_TEAM}」，所属班组由「${team || '空'}」改为「${DEPARTED_TEAM}」。`
      row.所属班组 = DEPARTED_TEAM
    } else if (status === ON_SITE && team === DEPARTED_TEAM) {
      contradiction = `所属班组为「${DEPARTED_TEAM}」，在场状态却登记为「在场」，撤场班组不允许在场。`
      resolution = `按撤场口径办理离场，在场状态由「在场」改为「已离场」。`
      row.在场状态 = DEPARTED
    } else if (status !== DEPARTED && !inActiveTeam) {
      contradiction = `在场状态为「${status}」，但所属班组为「${team || '空'}」，不在册在役班组（${ACTIVE_TEAMS.join('、')}）。`
      const mapped = teamForPost(clean(row.岗位))
      if (mapped) {
        row.所属班组 = mapped
        row._teamFilled = true
        resolution = `按岗位「${clean(row.岗位)}」归入「${mapped}」。`
      } else {
        resolution = '该条班组无法按岗位补齐，需人工核实。'
      }
    }
    if (contradiction) {
      findings.contradictions.push({
        type: '在场状态与所属班组矛盾',
        人员编号: clean(row.人员编号),
        姓名: clean(row.姓名),
        reason: contradiction,
        resolution,
      })
    }

    // 过期列示只盯还未离场的人员：已离场人员的老证过期不再是现场待办。
    if (clean(row.证书有效期) < reference && clean(row.在场状态) !== DEPARTED) {
      findings.expired.push({
        type: '证书已过期',
        人员编号: clean(row.人员编号),
        姓名: clean(row.姓名),
        reason: `「${clean(row.持证类型)}」有效期至 ${row.证书有效期}，早于基准日 ${reference}，证书已过期。`,
        resolution: row.在场状态 === ON_SITE ? '列为异常并停止安排现场作业，督促复审换证。' : '列示过期记录，重新进场前必须完成复审换证。',
      })
    }
  }

  const hydrology = reconcileHydrology(input.hydrology, deduped, findings)

  const issues: CrewIssue[] = [
    ...findings.duplicates,
    ...findings.missingCert,
    ...findings.contradictions,
    ...findings.expired,
  ]

  const onSite = deduped.filter((row) => clean(row.在场状态) === ON_SITE)
  // 过期口径只统计未离场人员：已离场人员的老证不再构成现场异常，与自检列示保持同一口径。
  const expiredRows = deduped.filter(
    (row) => clean(row.证书有效期) < reference && clean(row.在场状态) !== DEPARTED,
  )
  const certified = deduped.filter(
    (row) => clean(row.持证类型) !== '' && clean(row.证书有效期) >= reference,
  )
  const expiring = certified.filter((row) => {
    const days = diffDays(reference, clean(row.证书有效期))
    return days >= 0 && days <= EXPIRING_WINDOW_DAYS
  })

  // 落库前不变量：任何一条不满足，流水线失败，不允许带着脏数据进库。
  const codes = deduped.map((row) => row.人员编号)
  if (new Set(codes).size !== codes.length) {
    throw new Error('自检失败：去重后仍存在重复人员编号。')
  }
  if (deduped.some((row) => !isDateString(clean(row.证书有效期)))) {
    throw new Error('自检失败：仍有证书有效期缺失或不是 YYYY-MM-DD。')
  }
  if (
    deduped.some((row) => {
      const status = clean(row.在场状态)
      const team = clean(row.所属班组)
      if (status === DEPARTED) return team !== DEPARTED_TEAM
      if (status === ON_SITE || status === '待进场' || status === '已停工') return !ACTIVE_TEAMS.includes(team)
      return false
    })
  ) {
    throw new Error('自检失败：仍存在在场状态与所属班组矛盾的记录。')
  }

  const crewRows: EntryRow[] = deduped.map((row, index) => ({
    id: index + 1,
    status: clean(row.在场状态),
    pending: clean(row.在场状态) !== '已停工',
    abnormal: clean(row.证书有效期) < reference && clean(row.在场状态) !== DEPARTED,
    人员编号: clean(row.人员编号),
    姓名: clean(row.姓名),
    岗位: clean(row.岗位),
    持证类型: clean(row.持证类型),
    证书有效期: clean(row.证书有效期),
    所属班组: clean(row.所属班组),
    办理进场时间: clean(row.办理进场时间),
    联系电话: clean(row.联系电话) || '—',
    在场状态: clean(row.在场状态),
    数据来源: clean(row._source),
  }))

  const expiringDate = parseDate(reference)
  expiringDate.setDate(expiringDate.getDate() + EXPIRING_WINDOW_DAYS)
  const expiringBefore = formatDate(expiringDate)

  const report: CrewReport = {
    version: REPORT_VERSION,
    generatedAt: PIPELINE_GENERATED_AT,
    referenceDate: reference,
    expiringBefore,
    stages: traces,
    totals: {
      crew: crewRows.length,
      onSite: onSite.length,
      certified: certified.length,
      expiring: expiring.length,
      expired: expiredRows.length,
      issues: issues.length,
      hydrologyPending: hydrology.filter((row) => row.pending).length,
      hydrologyReassigned: findings.hydrologyChanges.length,
    },
    issues,
    hydrologyChanges: findings.hydrologyChanges,
    rules: {
      dedupeKey: '归一化后的「人员编号」（去空格、大写）是唯一业务键',
      duplicateRule: '同一人员编号出现两条及以上即判为重复，无论姓名/班组是否一致',
      laterRule: '两套取值并存有争议时，先比逐条记录更新时间、再比台账套别产生时间，较晚产生的一套为准并全册统一',
      certBackfill: `早年缺证书有效期的，自办理进场时间按证件复审周期（电工/高处/焊接 ${6} 年、起重 4 年）滚动至首个不早于基准日的到期日`,
      contradictionRule: `已离场必须归入「${DEPARTED_TEAM}」；「${DEPARTED_TEAM}」不允许登记在场；在役状态必须属于在役班组`,
    },
  }

  traces.push({
    stage: 'selfcheck',
    title: STAGE_TITLES.selfcheck,
    summary: `在册 ${report.totals.crew} 人，在场 ${report.totals.onSite} 人，持证 ${report.totals.certified} 人，${EXPIRING_WINDOW_DAYS} 天内到期 ${report.totals.expiring} 人，列示问题 ${issues.length} 条；水情待办改派 ${findings.hydrologyChanges.length} 条；全部不变量通过。`,
  })

  return { crew: crewRows, hydrology, report }
}

/**
 * 水情待办联动：待办（非「已复核」记录）的值守人员必须是在场且持证有效的检修人员；
 * 引用已离场/非台账人员的，统一改派给在场持证值班负责人。台账与业务清单一起变。
 */
function reconcileHydrology(
  rawRows: RawHydrologyRow[],
  crew: RawCrewRow[],
  findings: Findings,
): EntryRow[] {
  const eligible = crew.filter(
    (row) =>
      clean(row.在场状态) === ON_SITE &&
      clean(row.持证类型) !== '' &&
      clean(row.证书有效期) >= REFERENCE_DATE,
  )
  const duty =
    eligible.find((row) => clean(row.岗位).includes('发电机')) ??
    eligible.find((row) => clean(row.姓名) === '郑海涛') ??
    eligible[0]
  const dutyName = duty ? clean(duty.姓名) : ''

  return [...rawRows]
    .sort((a, b) => a.观测时间.localeCompare(b.观测时间) || a.记录编号.localeCompare(b.记录编号))
    .map((raw, index) => {
      let keeper = raw.值守人员
      const isTodo = raw.调度状态 !== '已复核'
      const keeperRow = crew.find((row) => clean(row.姓名) === keeper)
      const keeperValid = eligible.some((row) => clean(row.姓名) === keeper)
      if (isTodo && !keeperValid) {
        let reason = ''
        if (!keeperRow) {
          reason = `值守人员「${keeper}」不在检修人员台账中，按台账结论改派。`
        } else if (clean(keeperRow.在场状态) !== ON_SITE) {
          reason = `值守人员「${keeper}」在场状态为「${keeperRow.在场状态}」，不能继续担待办，按台账结论改派。`
        } else {
          reason = `值守人员「${keeper}」证书已过期（有效期至 ${keeperRow.证书有效期}），不满足在场持证要求，按台账结论改派。`
        }
        findings.hydrologyChanges.push({
          记录编号: raw.记录编号,
          观测时间: raw.观测时间,
          from: keeper,
          to: dutyName,
          reason,
        })
        keeper = dutyName
      }
      return {
        id: index + 1,
        status: raw.调度状态,
        pending: raw.调度状态 !== '已复核',
        abnormal: false,
        记录编号: raw.记录编号,
        观测时间: raw.观测时间,
        上游水位: raw.上游水位,
        下游水位: raw.下游水位,
        入库流量: raw.入库流量,
        出库流量: raw.出库流量,
        值守人员: keeper,
        调度状态: raw.调度状态,
      }
    })
}

/** 按当前在册数据实时重算人数口径：页面卡片、自检报告、另一个入口（运营概览）都取这一份。 */
export function summarizeCrew(crew: EntryRow[], hydrology: EntryRow[]): CrewReport['totals'] {
  const valid = crew.filter((row) => clean(row.持证类型) !== '' && clean(row.证书有效期) >= REFERENCE_DATE)
  return {
    crew: crew.length,
    onSite: crew.filter((row) => clean(row.在场状态) === ON_SITE).length,
    certified: valid.length,
    expiring: valid.filter((row) => diffDays(REFERENCE_DATE, clean(row.证书有效期)) <= EXPIRING_WINDOW_DAYS).length,
    expired: crew.filter(
      (row) => clean(row.证书有效期) < REFERENCE_DATE && clean(row.在场状态) !== DEPARTED,
    ).length,
    issues: 0,
    hydrologyPending: hydrology.filter((row) => row.pending).length,
    hydrologyReassigned: 0,
  }
}
