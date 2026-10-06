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
      <span>共 {{ total }} 条水情记录，其中待调度 {{ hydrologyPending }} 条（待办值守人员随检修人员台账结论改派）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  hydrologySummary,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('hydrology')
const columns = ["记录编号", "观测时间", "上游水位", "下游水位", "入库流量", "出库流量", "值守人员", "调度状态"]
const actions = ["提交观测", "下达调度", "提交复核"]
const statuses = ["待观测", "已观测", "已调度", "已复核"]
const stats = ref([
  { label: "今日入库流量(m³/s)", value: 0 },
  { label: "今日出库流量(m³/s)", value: 0 },
  { label: "待调度记录", value: 0 },
])

const rows = ref<EntryRow[]>([])
const total = ref(0)
const hydrologyPending = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
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
    const summary = hydrologySummary()
    hydrologyPending.value = summary.pending
    stats.value = [
      { label: "今日入库流量(m³/s)", value: Number(summary.todayInflow) || 0 },
      { label: "今日出库流量(m³/s)", value: Number(summary.todayOutflow) || 0 },
      { label: "待调度记录", value: summary.pending },
    ]
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '水情调度列表读取失败'
  }
}

onMounted(reload)
</script>
