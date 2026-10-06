<template>
  <section class="page" data-module="crew">
    <header class="page-head">
      <div>
        <h2>检修人员管理</h2>
        <p class="page-desc">维护检修人员，围绕人员编号、姓名、岗位、持证类型做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记检修人员</button>
        <button class="btn" type="button" @click="reinit">重新初始化台账</button>
        <button class="btn" type="button" @click="exportRows">导出检修人员清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section class="selfcheck-panel">
      <header class="selfcheck-head">
        <h3>初始化自检结果</h3>
        <span class="selfcheck-meta">
          链路版本 {{ report?.版本 }} · 基准日期 {{ report?.基准日期 }} · 生成于 {{ report?.生成时间 }} ·
          共 {{ report?.总人数 }} 人，列示 {{ report?.issues.length ?? 0 }} 条
        </span>
      </header>
      <ol v-if="report && report.issues.length" class="issue-list">
        <li v-for="(issue, index) in report.issues" :key="index" class="issue-item" :class="`level-${issue.级别}`">
          <span class="issue-level">{{ levelLabel(issue.级别) }}</span>
          <span class="issue-module">{{ issue.模块 === 'crew' ? '检修人员' : '水情记录' }}</span>
          <span class="issue-ref">{{ issue.编号 }}<template v-if="issue.姓名"> · {{ issue.姓名 }}</template></span>
          <span class="issue-reason">{{ issue.缘由 }}</span>
        </li>
      </ol>
      <p v-else class="issue-empty">自检通过：编号无重复、证书有效期齐全、在场状态与所属班组无矛盾。</p>
      <footer class="selfcheck-foot">
        <span>自检在场人数 {{ report?.metrics.在场人员 }} 与本页在场条数 {{ onSiteCount }} 一致；</span>
        <span>运营概览入口的「检修在场人员」取同一口径。</span>
      </footer>
    </section>

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
          <td :colspan="columns.length + 2" class="empty-state">暂无检修人员数据，可先登记检修人员</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条检修人员记录（其中在场 {{ onSiteCount }} 条，与自检结果一致）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  crewSelfCheck,
  crewSummary,
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { reinitialize } from '@/data/local-store'
import type { SelfCheckReport } from '@/data/migration/self-check'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('crew')
const columns = ["人员编号", "姓名", "岗位", "持证类型", "证书有效期", "所属班组", "办理进场时间", "联系电话", "在场状态"]
const actions = ["办理进场", "办理离场", "登记停工"]
const statuses = ["待进场", "在场", "已离场", "已停工"]
const stats = ref([
  { label: "在场人员", value: 0 },
  { label: "持证人员", value: 0 },
  { label: "证书即将到期", value: 0 },
])

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const report = ref<SelfCheckReport | null>(null)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const onSiteCount = computed(() => rows.value.filter((row) => String(row.在场状态) === '在场').length)

function levelLabel(level: string): string {
  return level === 'error' ? '问题' : level === 'warn' ? '关注' : '说明'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '检修人员登记入口尚未接入审批流'
}

function reinit() {
  errorMessage.value = ''
  reinitialize()
  reload()
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
    const summary = crewSummary()
    stats.value = [
      { label: "在场人员", value: summary.在场人员 },
      { label: "持证人员", value: summary.持证人员 },
      { label: "证书即将到期", value: summary.证书即将到期 },
    ]
    report.value = crewSelfCheck()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '检修人员列表读取失败'
  }
}

onMounted(reload)
</script>
