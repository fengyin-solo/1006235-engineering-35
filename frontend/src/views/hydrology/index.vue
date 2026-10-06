<template>
  <section class="page" data-module="hydrology">
    <header class="page-head">
      <div>
        <h2>水情调度管理</h2>
        <p class="page-desc">维护水情记录，围绕记录编号、观测时间、上游水位、下游水位做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记水情记录</button>
        <button class="btn" type="button" @click="exportRows">导出水情调度清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div v-if="reassignments.length" class="report-panel">
      <div class="report-head">
        <h3>值守人员改派（随检修人员台账自检结论联动）</h3>
        <span class="report-meta">待办记录的值守人员必须在场且持证有效，共改派 {{ reassignments.length }} 条，台账与本清单同一次落库</span>
      </div>
      <table class="data-table issue-table">
        <thead>
          <tr><th>记录编号</th><th>观测时间</th><th>原值守</th><th>改派为</th><th>缘由</th></tr>
        </thead>
        <tbody>
          <tr v-for="(item, index) in reassignments" :key="index">
            <td>{{ item.记录编号 }}</td>
            <td>{{ item.观测时间 }}</td>
            <td>{{ item.from }}</td>
            <td>{{ item.to }}</td>
            <td>{{ item.reason }}</td>
          </tr>
        </tbody>
      </table>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无水情调度数据，可先登记水情记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条水情调度记录</span>
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
  runAction as applyAction,
} from '@/api/local-service'
import type { CrewReport, HydrologyChange } from '@/data/crew/pipeline'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('hydrology')
const columns = ["记录编号", "观测时间", "上游水位", "下游水位", "入库流量", "出库流量", "值守人员", "调度状态"]
const actions = ["提交观测", "下达调度", "提交复核"]
const statuses = ["待观测", "已观测", "已调度", "已复核"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const report = ref<CrewReport>(loadCrewReport())
const reassignments = computed<HydrologyChange[]>(() => report.value.hydrologyChanges)

// 今日口径取最新观测时间的记录；待办数直接取自检报告，与运营概览的「水情待办」同源。
const stats = computed(() => {
  const latestTime = rows.value.reduce((max, row) => {
    const value = String(row.观测时间 ?? '')
    return value > max ? value : max
  }, '')
  const todays = rows.value.filter((row) => String(row.观测时间) === latestTime)
  const numberAt = (field: string) => (list: EntryRow[]) =>
    list.reduce((sum, row) => sum + Number(row[field] ?? 0), 0)
  return [
    { label: `今日入库流量（${latestTime || '—'}）`, value: numberAt('入库流量')(todays) },
    { label: '今日出库流量', value: numberAt('出库流量')(todays) },
    { label: '待调度记录', value: report.value.totals.hydrologyPending },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '水情记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
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
    errorMessage.value = error instanceof Error ? error.message : '水情调度列表读取失败'
  }
}

onMounted(reload)
</script>
