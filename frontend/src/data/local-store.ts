import { runCrewPipeline, summarizeCrew } from './crew/pipeline'
import type { CrewReport, EntryRow as PipelineRow } from './crew/pipeline'
import { LEGACY_CREW_SOURCES, LEGACY_HYDROLOGY } from './crew/legacy'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydropower-plant-om:entries'
// 自检报告与台账放在同一个载荷里，一次 setItem 落库，不存在「库已更、报告没更」的中间态。
const REPORT_SLOT = '__crew_report__'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

type StoreCache = {
  entries: Record<string, EntryRow[]>
  report: CrewReport
}

/** 跑迁移流水线：本地 dev、部署容器、Node 初始化脚本调用的是同一份纯逻辑。 */
export function bootstrapCrewData(previousCrew?: EntryRow[]): {
  crew: PipelineRow[]
  hydrology: PipelineRow[]
  report: CrewReport
} {
  return runCrewPipeline({
    sources: LEGACY_CREW_SOURCES,
    hydrology: LEGACY_HYDROLOGY,
    previousCrew: isMigratedCrew(previousCrew) ? previousCrew : undefined,
  })
}

/** 已迁移台账的识别标记：每行都带办理进场时间；脚手架残档没有。 */
function isMigratedCrew(rows?: EntryRow[]): rows is EntryRow[] {
  return !!rows && rows.length > 0 && rows.every((row) => typeof row.办理进场时间 === 'string')
}

function isMigratedHydrology(rows?: EntryRow[]): boolean {
  return !!rows && rows.length > 0 && rows.every((row) => typeof row.上游水位 === 'number')
}

function freshPayload(previousCrew?: EntryRow[]): StoreCache {
  const result = bootstrapCrewData(previousCrew)
  const entries = clone(SEED_ROWS) as Record<string, EntryRow[]>
  entries.crew = result.crew as EntryRow[]
  entries.hydrology = result.hydrology as EntryRow[]
  return { entries, report: result.report }
}

function persist(cache: StoreCache): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  const payload = { ...cache.entries, [REPORT_SLOT]: cache.report }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
}

function readStorage(): StoreCache {
  if (typeof window === 'undefined' || !window.localStorage) {
    return freshPayload()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = freshPayload()
    persist(seeded)
    return seeded
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    const fallback = freshPayload()
    persist(fallback)
    return fallback
  }

  const storedReport = parsed[REPORT_SLOT] as CrewReport | undefined
  const storedCrew = parsed.crew as EntryRow[] | undefined
  const storedHydrology = parsed.hydrology as EntryRow[] | undefined
  // 本地环境重建后常见三种残态：脚手架样例人员、水情缺项、自检报告缺失。任一命中就补跑迁移。
  if (!storedReport || !isMigratedCrew(storedCrew) || !isMigratedHydrology(storedHydrology)) {
    const migrated = freshPayload(storedCrew)
    const next = { ...(parsed as Record<string, EntryRow[]>), ...migrated.entries }
    const cache: StoreCache = { entries: next, report: migrated.report }
    persist(cache)
    return cache
  }

  const { [REPORT_SLOT]: _report, ...entries } = parsed as Record<string, EntryRow[]>
  void _report
  return {
    entries: { ...(clone(SEED_ROWS) as Record<string, EntryRow[]>), ...entries },
    report: clone(storedReport),
  }
}

let cache: StoreCache | null = null

function store(): StoreCache {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function allRows(): Record<string, EntryRow[]> {
  return store().entries
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

/** 台账或水情清单变更后，按同一口径刷新自检报告里的人数，保证报告与页面条数永远对得上。 */
function syncReportTotals(): void {
  const current = store()
  const live = summarizeCrew(
    current.entries.crew ?? [],
    current.entries.hydrology ?? [],
  )
  current.report.totals.crew = live.crew
  current.report.totals.onSite = live.onSite
  current.report.totals.certified = live.certified
  current.report.totals.expiring = live.expiring
  current.report.totals.expired = live.expired
  current.report.totals.hydrologyPending = live.hydrologyPending
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const current = store()
  current.entries = { ...current.entries, [key]: rows }
  syncReportTotals()
  persist(current)
}

export function resetRows(key: string): EntryRow[] {
  // 检修人员与水情清单是同一条迁移链路的产物，重置时整条链路一起回到初始批次。
  if (key === 'crew' || key === 'hydrology') {
    const fresh = freshPayload()
    const current = store()
    current.entries.crew = fresh.entries.crew
    current.entries.hydrology = fresh.entries.hydrology
    current.report = fresh.report
    persist(current)
    return current.entries[key]
  }
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

/**
 * 显式重新初始化：把本机在册台账作为「最晚产生的一套」再跑一遍流水线。
 * 反复执行人员集合不变、不会长出重复人员，两个入口读到的口径仍一致。
 */
export function reinitializeCrew(): CrewReport {
  const current = store()
  const previous = isMigratedCrew(current.entries.crew) ? current.entries.crew : undefined
  const fresh = freshPayload(previous)
  current.entries.crew = fresh.entries.crew
  current.entries.hydrology = fresh.entries.hydrology
  current.report = fresh.report
  persist(current)
  return clone(current.report)
}

export function crewReport(): CrewReport {
  return clone(store().report)
}

export function storageKey(): string {
  return STORAGE_KEY
}
