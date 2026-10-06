/** 检修人员 / 水情记录迁移链路的统一规则与口径。 */

/** 链路版本：示例数据与初始化过程按版本固化，本地与部署环境跑的是同一份逻辑。 */
export const PIPELINE_VERSION = '2026.10.06.1'

/** 自检基准日期：到期提醒、「今日」取值都以它为准，保证跨环境结果一致。 */
export const REFERENCE_DATE = '2026-10-06'

/** 证书到期提醒窗口：未来 90 天内到期计入「证书即将到期」。 */
export const CERT_WARNING_DAYS = 90

/** 早年缺项补领口径：没有证书有效期的，按办理进场时间加 4 年回填，并标注为补领。 */
export const CERT_BACKFILL_YEARS = 4

/** 在编班组：在场人员只能挂这些班组。 */
export const ON_PANEL_TEAMS = ['机械检修一班', '机械检修二班', '电气检修班', '自动控制班'] as const

/** 已撤编班组：老台账里挂这些班组的在场人员一律按岗位改派。 */
export const DISBANDED_TEAMS = ['老检修队'] as const

/** 岗位缺班组时的默认归属。 */
export const POST_DEFAULT_TEAM: Record<string, string> = {
  机械检修工: '机械检修一班',
  电气检修工: '电气检修班',
  自动化工: '自动控制班',
}

export const CREW_CODE_PATTERN = /^CREW-\d{4}$/

/** 允许的在场状态，与 modules.ts 中 crew 的状态表保持一致。 */
export const SITE_STATUSES = ['待进场', '在场', '已离场', '已停工'] as const

/**
 * 迁移环节必须按此顺序推进，后一环节依赖前一环节的结论。
 * 跳级执行由 pipeline 的守卫直接拦下。
 */
export const STAGES = [
  { key: 'normalize', name: '字段规范化' },
  { key: 'dedupe', name: '人员编号去重' },
  { key: 'backfill', name: '缺项按业务时间补齐' },
  { key: 'reconcile', name: '在场与班组矛盾核定' },
  { key: 'hydrology-follow', name: '水情待办随结论改派' },
  { key: 'self-check', name: '自检落库' },
] as const

export type StageKey = (typeof STAGES)[number]['key']

/** 日期工具：输入输出统一 YYYY-MM-DD，避免时区造成跨环境不一致。 */
export function toDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day)
}

export function addYears(value: string, years: number): string {
  const [year, month, day] = value.split('-')
  return `${Number(year) + years}-${month}-${day}`
}

export function diffDays(from: string, to: string): number {
  const ms = toDate(to).getTime() - toDate(from).getTime()
  return Math.round(ms / 86400000)
}
