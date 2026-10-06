import { computeCrewMetrics, runPipeline } from './migration/pipeline'
import { LEGACY_CREW, LEGACY_HYDROLOGY } from './migration/legacy'
import { PIPELINE_VERSION } from './migration/rules'
import type { SelfCheckReport } from './migration/self-check'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydropower-plant-om:entries'
const REPORT_KEY = 'hydropower-plant-om:crew-self-check'
const BOOT_KEY = 'hydropower-plant-om:boot'

// 检修人员与水情记录不再走静态示例数据，由迁移链路按固化老台账生成。
const PIPELINED_MODULES = ['crew', 'hydrology'] as const

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

type Database = Record<string, EntryRow[]>

function buildFreshDatabase(
  crew: EntryRow[],
  hydrology: EntryRow[],
  existing: Partial<Database> | null,
): Database {
  // 其它模块沿用旧库数据（没有再回退到示例数据）；台账与水情清单随链路一起替换。
  const base: Database = {}
  for (const key of Object.keys(SEED_ROWS)) {
    if ((PIPELINED_MODULES as readonly string[]).includes(key)) {
      continue
    }
    base[key] = clone(existing?.[key] ?? SEED_ROWS[key])
  }
  base.crew = crew
  base.hydrology = hydrology
  return base
}

function hasWindowStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

let cache: Database | null = null
let reportCache: SelfCheckReport | null = null
let booted = false

/**
 * 初始化入口：本地开发与部署环境都走这里。
 * - 无库 / 链路版本升级：按同一套规则重新生成检修人员与水情清单并落库；
 * - 已有同版本库：直接沿用，反复初始化幂等，不会多出重复人员。
 */
export function ensureBoot(): void {
  if (booted) {
    return
  }
  const pipeline = runPipeline(LEGACY_CREW, LEGACY_HYDROLOGY)

  if (!hasWindowStorage()) {
    cache = { crew: pipeline.crew, hydrology: pipeline.hydrology, ...cloneSeeds() }
    reportCache = pipeline.report
    booted = true
    return
  }
  const storage = window.localStorage
  const metaRaw = storage.getItem(BOOT_KEY)
  let meta: { version?: string } = {}
  try {
    meta = metaRaw ? (JSON.parse(metaRaw) as { version?: string }) : {}
  } catch {
    meta = {}
  }

  const entriesRaw = storage.getItem(STORAGE_KEY)
  let existing: Partial<Database> = {}
  if (entriesRaw) {
    try {
      existing = JSON.parse(entriesRaw) as Partial<Database>
    } catch {
      existing = {}
    }
  }

  if (meta.version !== PIPELINE_VERSION) {
    // 首次打开或链路升级：台账与业务清单一起换掉，自检结果同时落库。
    const db = buildFreshDatabase(pipeline.crew, pipeline.hydrology, existing)
    storage.setItem(STORAGE_KEY, JSON.stringify(db))
    storage.setItem(REPORT_KEY, JSON.stringify(pipeline.report))
    storage.setItem(BOOT_KEY, JSON.stringify({ version: PIPELINE_VERSION, bootedAt: pipeline.report.生成时间 }))
    cache = db
    reportCache = pipeline.report
  } else {
    // 同版本重开：浏览器里的改动优先（与其它模块一致）；台账与水情清单缺失时回退链路结论。
    cache = {
      ...buildFreshDatabase(pipeline.crew, pipeline.hydrology, null),
      ...(existing as Database),
    }
    const reportRaw = storage.getItem(REPORT_KEY)
    reportCache = reportRaw ? (JSON.parse(reportRaw) as SelfCheckReport) : pipeline.report
  }
  booted = true
}

function cloneSeeds(): Database {
  const db: Database = {}
  for (const [key, rows] of Object.entries(SEED_ROWS)) {
    if (!(PIPELINED_MODULES as readonly string[]).includes(key)) {
      db[key] = clone(rows)
    }
  }
  return db
}

/** 重新跑一遍初始化：结论幂等，落库后重开页面读到的仍是同一份。 */
export function reinitialize(): SelfCheckReport {
  const pipeline = runPipeline(LEGACY_CREW, LEGACY_HYDROLOGY)
  const existing = cache ?? {}
  const db = buildFreshDatabase(pipeline.crew, pipeline.hydrology, existing)
  cache = db
  reportCache = pipeline.report
  if (hasWindowStorage()) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(db))
    window.localStorage.setItem(REPORT_KEY, JSON.stringify(pipeline.report))
    window.localStorage.setItem(BOOT_KEY, JSON.stringify({ version: PIPELINE_VERSION, bootedAt: pipeline.report.生成时间 }))
  }
  return pipeline.report
}

export function allRows(): Database {
  ensureBoot()
  return cache as Database
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (hasWindowStorage()) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  // 检修人员状态流转后，自检报告的指标随台账同步更新；问题清单保留初始化时的结论。
  if (key === 'crew' && reportCache) {
    reportCache = { ...reportCache, metrics: computeCrewMetrics(rows) }
    if (hasWindowStorage()) {
      window.localStorage.setItem(REPORT_KEY, JSON.stringify(reportCache))
    }
  }
}

export function resetRows(key: string): EntryRow[] {
  // 检修人员与水情记录的「重置」是重新走迁移链路，而不是回到残缺的静态示例。
  if ((PIPELINED_MODULES as readonly string[]).includes(key as (typeof PIPELINED_MODULES)[number])) {
    reinitialize()
    return listRows(key)
  }
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function selfCheckReport(): SelfCheckReport {
  ensureBoot()
  return reportCache as SelfCheckReport
}

export function storageKey(): string {
  return STORAGE_KEY
}
