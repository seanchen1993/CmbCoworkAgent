import type { DashboardUserListItem } from "./use-dashboard"

export const ACTIVE_USER_EXPORT_HEADER = [
  "排名",
  "SAP ID",
  "YST ID",
  "用户名",
  "部门",
  "一级部门",
  "下级部门",
  "调用次数",
  "代码生成行数",
  "代码删除行数",
  "已测量原始生成行数",
  "已测量有效生成行数",
  "未提交生成行数",
  "总量有效生成行数",
  "已 Commit 采纳行数",
  "提交采纳率",
  "总量提交采纳率",
  "已 Push 原始生成行数",
  "已 Push 有效生成行数",
  "已 Push 采纳行数",
  "已 Push Commit 数",
  "入库采纳率",
  "总量入库采纳率",
  "输入 Token",
  "输出 Token",
  "总 Token",
  "平均耗时",
  "最近活跃"
]

function formatPercent(value: number | null): string {
  return value === null ? "" : `${(value * 100).toFixed(2)}%`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  return `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`
}

function formatDateTime(value?: string): string {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString("zh-CN")
}

export function buildActiveUserExportRows(users: DashboardUserListItem[]): (string | number)[][] {
  return users.map((user, index) => {
    const stats = user.codeStats
    return [
      index + 1,
      user.sapId,
      user.ystId || "",
      user.userName || "",
      user.upperOrgLv1 && user.upperOrgLv0
        ? `${user.upperOrgLv1}/${user.upperOrgLv0}`
        : user.orgName || "",
      user.upperOrgLv1 || "",
      user.upperOrgLv0 || "",
      user.count,
      stats?.generatedLines ?? "",
      stats?.deletedLines ?? "",
      stats?.measuredGeneratedLines ?? "",
      stats?.effectiveGeneratedLines ?? "",
      stats?.unmeasuredGeneratedLines ?? "",
      stats?.inclusiveEffectiveGeneratedLines ?? "",
      stats?.adoptedLines ?? "",
      formatPercent(stats?.measuredAdoptionRate ?? null),
      formatPercent(stats?.inclusiveAdoptionRate ?? null),
      stats?.pushedMeasuredGeneratedLines ?? "",
      stats?.pushedEffectiveGeneratedLines ?? "",
      stats?.pushedAdoptedLines ?? "",
      stats?.pushedCommitCount ?? "",
      formatPercent(stats?.pushedAdoptionRate ?? null),
      formatPercent(stats?.inclusivePushedAdoptionRate ?? null),
      user.totalInputTokens,
      user.totalOutputTokens,
      user.totalTokens,
      formatDuration(user.avgDurationMs),
      formatDateTime(user.lastActiveAt)
    ]
  })
}
