<template>
  <section class="page" data-module="crew">
    <header class="page-head">
      <div>
        <h2>检修人员管理</h2>
        <p class="page-desc">老台账经「提取→核对→回填→去重→自检」顺序迁移：编号补登、班组归位、证书有效期按复审周期滚动补齐，自检报告随台账一起落库。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="rebuild">重新初始化台账</button>
        <button class="btn" type="button" @click="exportRows">导出检修人员清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="{ 'stat-warn': item.warn }">{{ item.value }}</strong>
      </article>
    </div>

    <div class="report-panel">
      <div class="report-head">
        <h3>台账迁移与自检结果</h3>
        <span class="report-meta">报告版本 v{{ report.version }} · 生成于 {{ report.generatedAt }} · 基准日 {{ report.referenceDate }} · 到期窗口截至 {{ report.expiringBefore }}</span>
      </div>

      <ol class="stage-list">
        <li v-for="trace in report.stages" :key="trace.stage" class="stage-item">
          <span class="stage-index">{{ stageNo(trace.stage) }}</span>
          <div>
            <strong>{{ trace.title }}</strong>
            <p>{{ trace.summary }}</p>
          </div>
        </li>
      </ol>

      <p class="reconcile-line" :class="{ 'reconcile-ok': onSiteReconciled, 'reconcile-bad': !onSiteReconciled }">
        对账：自检报告在场人数 {{ report.totals.onSite }}，本页在场人员条数 {{ onSiteInPage }}，
        <template v-if="onSiteReconciled">两处一致 ✓</template>
        <template v-else>两处不一致，需重新初始化 ✗</template>
      </p>

      <h4 class="issue-title">自检问题列示（共 {{ report.issues.length }} 条，均注明缘由与处置）</h4>
      <table class="data-table issue-table">
        <thead>
          <tr><th>问题类型</th><th>人员编号</th><th>姓名</th><th>缘由</th><th>处置口径</th></tr>
        </thead>
        <tbody>
          <tr v-for="(issue, index) in report.issues" :key="index">
            <td><span class="issue-tag" :class="issueClass(issue.type)">{{ issue.type }}</span></td>
            <td>{{ issue.人员编号 }}</td>
            <td>{{ issue.姓名 }}</td>
            <td>{{ issue.reason }}</td>
            <td>{{ issue.resolution }}</td>
          </tr>
          <tr v-if="!report.issues.length">
            <td colspan="5" class="empty-state">自检无异常列示项</td>
          </tr>
        </tbody>
      </table>

      <details class="rule-details">
        <summary>迁移与判重规则说明</summary>
        <ul class="rule-list">
          <li>去重键：{{ report.rules.dedupeKey }}</li>
          <li>重复判法：{{ report.rules.duplicateRule }}</li>
          <li>两套取值争议：{{ report.rules.laterRule }}</li>
          <li>早年缺证书有效期：{{ report.rules.certBackfill }}</li>
          <li>状态与班组矛盾：{{ report.rules.contradictionRule }}</li>
        </ul>
      </details>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无检修人员数据，可先重新初始化台账</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条检修人员记录（在册 {{ report.totals.crew }} 人）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  loadCrewReport,
  moduleMeta,
  rebuildCrewLedger,
  runAction as applyAction,
} from '@/api/local-service'
import type { CrewReport } from '@/data/crew/pipeline'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('crew')
const columns = ["人员编号", "姓名", "岗位", "持证类型", "证书有效期", "所属班组", "办理进场时间", "联系电话", "在场状态"]
const actions = ["办理进场", "办理离场", "登记停工"]
const statuses = ["待进场", "在场", "已离场", "已停工"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const report = ref<CrewReport>(loadCrewReport())

const stats = computed(() => [
  { label: '在场人员', value: report.value.totals.onSite, warn: false },
  { label: '持证人员', value: report.value.totals.certified, warn: false },
  { label: `证书90天内到期（截至${report.value.expiringBefore}）`, value: report.value.totals.expiring, warn: report.value.totals.expiring > 0 },
  { label: '证书已过期', value: report.value.totals.expired, warn: report.value.totals.expired > 0 },
  { label: '自检问题', value: report.value.totals.issues, warn: report.value.totals.issues > 0 },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 自检结果里的在场人数必须与页面在场条数一致（页面有筛选时按全量在册口径对账）。
const onSiteInPage = computed(() => rows.value.filter((row) => String(row.status) === '在场').length)
const onSiteReconciled = computed(() => {
  const filtered = Object.values(filters.value).some((value) => value.trim() !== '')
  return filtered ? true : onSiteInPage.value === report.value.totals.onSite
})

function stageNo(stage: string): number {
  return ['extract', 'reconcile', 'backfill', 'dedupe', 'selfcheck'].indexOf(stage) + 1
}

function issueClass(type: string): string {
  if (type === '编号重复') return 'tag-dup'
  if (type === '证书有效期缺失') return 'tag-missing'
  if (type === '证书已过期') return 'tag-expired'
  return 'tag-conflict'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function rebuild() {
  errorMessage.value = ''
  try {
    report.value = rebuildCrewLedger()
    reload()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '台账重新初始化失败'
  }
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  report.value = loadCrewReport()
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    report.value = loadCrewReport()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '检修人员列表读取失败'
  }
}

onMounted(reload)
</script>
