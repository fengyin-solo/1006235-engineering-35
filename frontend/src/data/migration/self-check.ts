/** 自检结果类型：初始化时落库，重开页面读到的仍是同一份。 */

export type IssueLevel = 'error' | 'warn' | 'info'

export type IssueType =
  | 'duplicate-code' // 编号重复
  | 'code-format' // 编号格式不符
  | 'cert-backfill' // 证书有效期缺失后按业务时间补领
  | 'cert-missing' // 持证类型与有效期均缺失，待补证
  | 'cert-expired' // 证书已过期
  | 'team-backfill' // 所属班组缺失按岗位补齐
  | 'team-conflict' // 在场状态与所属班组矛盾
  | 'hydrology-follow' // 水情待办随人员结论改派

export type SelfCheckIssue = {
  类型: IssueType
  级别: IssueLevel
  模块: 'crew' | 'hydrology'
  编号: string
  姓名: string
  缘由: string
}

export type CrewMetrics = {
  在场人员: number
  持证人员: number
  证书即将到期: number
}

export type SelfCheckReport = {
  版本: string
  生成时间: string
  基准日期: string
  到期窗口天数: number
  环节: { key: string; name: string; 完成时间: string }[]
  issues: SelfCheckIssue[]
  metrics: CrewMetrics
  hydrologyPending: number
  总人数: number
}
