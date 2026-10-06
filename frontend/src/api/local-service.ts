import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows, selfCheckReport } from '@/data/local-store'
import { computeCrewMetrics } from '@/data/migration/pipeline'
import { REFERENCE_DATE } from '@/data/migration/rules'
import type { SelfCheckReport } from '@/data/migration/self-check'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  // 检修人员：页面统计以「在场状态」为准，状态流转时同步过去，两套取值不允许再打架。
  if (key === 'crew') {
    updated.在场状态 = target
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const crew = rows.crew ?? []
  const crewMetrics = computeCrewMetrics(crew)
  const hydrologyPending = (rows.hydrology ?? []).filter((row) =>
    ['待观测', '已观测'].includes(String(row.status)),
  ).length
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
    { label: '检修在场人员', value: crewMetrics.在场人员 },
    { label: '水情待办', value: hydrologyPending },
  ]
  return { cards, modules }
}

/** 检修人员三项指标：与初始化自检落库的口径完全一致。 */
export function crewSummary(): SelfCheckReport['metrics'] {
  return computeCrewMetrics(listRows('crew'))
}

/** 水情指标：今日取入库/出库流量取基准日最后一条；待调度记录数随检修人员结论联动。 */
export function hydrologySummary(): { todayInflow: string; todayOutflow: string; pending: number } {
  const rows = listRows('hydrology')
  const today = rows
    .filter((row) => String(row.观测时间) === REFERENCE_DATE)
    .sort((a, b) => String(a.记录编号).localeCompare(String(b.记录编号)))
  const latest = today[today.length - 1]
  return {
    todayInflow: latest ? String(latest.入库流量) : '—',
    todayOutflow: latest ? String(latest.出库流量) : '—',
    pending: rows.filter((row) => ['待观测', '已观测'].includes(String(row.status))).length,
  }
}

/** 读取初始化时落库的自检结果（重开页面仍是同一份）。 */
export function crewSelfCheck(): SelfCheckReport {
  return selfCheckReport()
}
