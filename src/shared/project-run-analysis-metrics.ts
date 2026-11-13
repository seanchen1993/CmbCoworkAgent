import type {
  RunAnalysisCodeStats,
  RunAnalysisData,
  RunAnalysisFeature
} from "./project-run-analysis"
import { RUN_ANALYSIS_NOTES } from "./project-run-analysis"

export const NUMERIC_FILTERS = {
  idleDays: { label: "距最近执行", unit: "天", factor: 1 },
  spanDays: { label: "执行跨度", unit: "天", factor: 1 },
  adoptionRate: { label: "采纳率", unit: "%", factor: 100 },
  codeLines: { label: "有效生成行数", unit: "行", factor: 1 },
  vibeShare: { label: "Vibe采纳占比", unit: "%", factor: 100 },
  noSkill: { label: "未使用 Skill 主对话", unit: "轮", factor: 1 },
  tools: { label: "工具调用", unit: "次", factor: 1 },
  models: { label: "模型调用", unit: "次", factor: 1 }
} as const
export type NumericFilterKey = keyof typeof NUMERIC_FILTERS
export const COMPARISON_LABELS = {
  gte: "≥",
  gt: ">",
  lte: "≤",
  lt: "<",
  eq: "=",
  between: "区间",
  missing: "未记录",
  present: "有记录"
} as const
export type NumericOperator = keyof typeof COMPARISON_LABELS
export interface NumericCondition {
  operator: NumericOperator
  value: number | null
  upper?: number | null
}
export interface RunAnalysisFilters {
  keyword: string
  stage: string
  status: string
  plugin: string
  numeric: Partial<Record<NumericFilterKey, NumericCondition>>
}
export const DEFAULT_RUN_ANALYSIS_FILTERS: RunAnalysisFilters = {
  keyword: "",
  stage: "",
  status: "",
  plugin: "",
  numeric: {}
}
export function numericConditionActive(c: NumericCondition): boolean {
  return (
    c.operator === "missing" ||
    c.operator === "present" ||
    c.value != null ||
    (c.operator === "between" && c.upper != null)
  )
}
export function runAnalysisFilterErrors(f: RunAnalysisFilters): string[] {
  return Object.entries(f.numeric).flatMap(([key, c]) => {
    if (!c || !numericConditionActive(c)) return []
    const meta = NUMERIC_FILTERS[key as NumericFilterKey]
    if (!meta || !(c.operator in COMPARISON_LABELS)) return ["筛选条件无效"]
    if (c.operator === "missing" || c.operator === "present") return []
    const valid = (n: unknown) =>
      typeof n === "number" && Number.isFinite(n) && n >= 0 && (meta.factor !== 100 || n <= 1)
    if (!valid(c.value) || (c.operator === "between" && !valid(c.upper)))
      return [`${meta.label}：请填写有效${c.operator === "between" ? "上下限" : "数值"}`]
    if (c.operator === "between" && c.value! > c.upper!) return [`${meta.label}：下限不能大于上限`]
    return []
  })
}
export function matchesNumeric(value: number | null, c: NumericCondition): boolean {
  const known = value !== null && Number.isFinite(value)
  if (c.operator === "missing") return !known
  if (c.operator === "present") return known
  if (!known || c.value === null || !Number.isFinite(c.value)) return false
  switch (c.operator) {
    case "gt":
      return value! > c.value
    case "gte":
      return value! >= c.value
    case "lt":
      return value! < c.value
    case "lte":
      return value! <= c.value
    case "eq":
      return (
        Math.abs(value! - c.value) <=
        Number.EPSILON * Math.max(1, Math.abs(value!), Math.abs(c.value))
      )
    case "between":
      return c.upper != null && value! >= c.value && value! <= c.upper
  }
}
export function numericFilterLabel(key: NumericFilterKey, c: NumericCondition): string {
  const { label, unit, factor } = NUMERIC_FILTERS[key]
  const format = (n: number | null | undefined) =>
    n == null ? "…" : String(Number((n * factor).toFixed(4)))
  if (c.operator === "missing" || c.operator === "present")
    return `${label}：${COMPARISON_LABELS[c.operator]}`
  return c.operator === "between"
    ? `${label} ${format(c.value)}–${format(c.upper)} ${unit}（含边界）`
    : `${label} ${COMPARISON_LABELS[c.operator]} ${format(c.value)} ${unit}`
}
export const RUN_ANALYSIS_PRESETS = [
  {
    key: "idle",
    label: "长期未执行",
    description: "距最近执行 ≥ 14 天",
    sort: "idle",
    desc: true
  },
  {
    key: "span",
    label: "执行跨度长",
    description: "首次至最后执行 ≥ 30 天",
    sort: "span",
    desc: true
  },
  {
    key: "adoption",
    label: "采纳率低",
    description: "采纳率 ≤ 30% · 有效生成 ≥ 100 行",
    sort: "adoption",
    desc: false
  },
  {
    key: "vibe",
    label: "VibeCoding 占比高",
    description: "VibeCoding 采纳行数占比 ≥ 70%",
    sort: "vibe",
    desc: true
  },
  {
    key: "noSkill",
    label: "未使用 Skill 对话多",
    description: "未使用 Skill 的主对话 ≥ 12 轮",
    sort: "noSkill",
    desc: true
  },
  {
    key: "calls",
    label: "工具调用多",
    description: "工具调用 ≥ 1,000 次",
    sort: "tools",
    desc: true
  }
] as const
export function runAnalysisPreset(
  key: string,
  current: RunAnalysisFilters = DEFAULT_RUN_ANALYSIS_FILTERS
): RunAnalysisFilters {
  // Quick filters replace numeric criteria only, preserving the user's selected context.
  const base: RunAnalysisFilters = {
    ...DEFAULT_RUN_ANALYSIS_FILTERS,
    keyword: current.keyword,
    plugin: current.plugin,
    stage: current.stage,
    status: current.status
  }
  const condition = (value: number, operator: NumericOperator = "gte"): NumericCondition => ({
    operator,
    value
  })
  if (key === "idle") base.numeric = { idleDays: condition(14) }
  if (key === "span") base.numeric = { spanDays: condition(30) }
  if (key === "adoption")
    base.numeric = { adoptionRate: condition(0.3, "lte"), codeLines: condition(100) }
  if (key === "vibe") base.numeric = { vibeShare: condition(0.7) }
  if (key === "noSkill") base.numeric = { noSkill: condition(12) }
  if (key === "calls") base.numeric = { tools: condition(1000) }
  return base
}
export function runAnalysisPresetCounts(
  data: RunAnalysisData,
  filters: RunAnalysisFilters
): Record<(typeof RUN_ANALYSIS_PRESETS)[number]["key"], number> {
  // Six linear passes over the already loaded aggregates, without sorting or ES requests.
  return Object.fromEntries(
    RUN_ANALYSIS_PRESETS.map(({ key }) => {
      const criteria = runAnalysisPreset(key, filters)
      const count = data.rows.reduce(
        (n, row) =>
          n +
          (row.featureSlug !== null && attentionReasons(row, criteria, data.dataAsOf) !== null
            ? 1
            : 0),
        0
      )
      return [key, count]
    })
  ) as Record<(typeof RUN_ANALYSIS_PRESETS)[number]["key"], number>
}
export function runAnalysisFilterChips(
  filters: RunAnalysisFilters
): { key: RunAnalysisFilterKey; label: string }[] {
  const chips: { key: RunAnalysisFilterKey; label: string }[] = []
  const add = (key: RunAnalysisFilterKey, label: string) => chips.push({ key, label })
  if (filters.keyword.trim()) add("keyword", `搜索：${filters.keyword.trim()}`)
  if (filters.stage)
    add("stage", `阶段：${filters.stage === "__missing__" ? "未记录" : filters.stage}`)
  if (filters.status)
    add("status", `状态：${filters.status === "__missing__" ? "未记录" : filters.status}`)
  if (filters.plugin) {
    const [name, version] = JSON.parse(filters.plugin) as [string | null, string | null]
    add("plugin", `插件：${name ?? "未知插件"}${version ? ` @${version}` : ""}`)
  }
  for (const [key, c] of Object.entries(filters.numeric)) {
    if (c && numericConditionActive(c))
      add(key as NumericFilterKey, numericFilterLabel(key as NumericFilterKey, c))
  }
  return chips
}
export type RunAnalysisFilterKey = Exclude<keyof RunAnalysisFilters, "numeric"> | NumericFilterKey
export function clearRunAnalysisFilter(
  filters: RunAnalysisFilters,
  key: RunAnalysisFilterKey
): RunAnalysisFilters {
  if (key in NUMERIC_FILTERS) {
    const numeric = { ...filters.numeric }
    delete numeric[key as NumericFilterKey]
    return { ...filters, numeric }
  }
  return { ...filters, [key]: "" }
}
export function numericFilterValue(
  row: RunAnalysisFeature,
  key: NumericFilterKey,
  asOf: string
): number | null {
  switch (key) {
    case "idleDays":
      return idleDays(row, asOf)
    case "spanDays":
      return row.executionSpanMs === null ? null : row.executionSpanMs / 86400000
    case "adoptionRate":
      return row.codeStats?.inclusiveAdoptionRate ?? null
    case "codeLines":
      return row.codeStats?.inclusiveEffectiveGeneratedLines ?? null
    case "vibeShare":
      return row.vibeAdoptedShare
    case "noSkill":
      return row.conversationCount > 0 ? row.noSkillConversationCount : null
    case "tools":
      return row.toolCalls
    case "models":
      return row.modelCalls
  }
}
export function idleDays(row: RunAnalysisFeature, asOf: string): number | null {
  if (!row.lastExecutedAt) return null
  const ms = Date.parse(asOf) - Date.parse(row.lastExecutedAt)
  return Number.isFinite(ms) ? Math.max(0, ms / 86400000) : null
}
export function attentionReasons(
  row: RunAnalysisFeature,
  f: RunAnalysisFilters,
  asOf: string
): string[] | null {
  const q = f.keyword.trim().toLocaleLowerCase()
  if (
    q &&
    ![row.projectId, row.projectName, row.systemName, row.featureSlug, row.featureTitle].some((v) =>
      v?.toLocaleLowerCase().includes(q)
    )
  )
    return null
  if (f.plugin && JSON.stringify([row.adapterName, row.adapterVersion]) !== f.plugin) return null
  if (f.stage && (row.currentStage ?? "__missing__") !== f.stage) return null
  if (f.status && (row.currentStatus ?? "__missing__") !== f.status) return null
  const reasons: string[] = []
  for (const [key, condition] of Object.entries(f.numeric)) {
    if (!condition || !numericConditionActive(condition)) continue
    if (!matchesNumeric(numericFilterValue(row, key as NumericFilterKey, asOf), condition))
      return null
    reasons.push(numericFilterLabel(key as NumericFilterKey, condition))
  }
  return reasons
}

export type RunAnalysisSort =
  | "idle"
  | "span"
  | "duration"
  | "adoption"
  | "vibe"
  | "noSkill"
  | "tools"
  | "models"
export function runAnalysisSortValue(
  row: RunAnalysisFeature,
  key: RunAnalysisSort,
  asOf: string
): number | null {
  return key === "idle"
    ? idleDays(row, asOf)
    : key === "span"
      ? row.executionSpanMs
      : key === "duration"
        ? row.totalDurationMs
        : key === "adoption"
          ? (row.codeStats?.inclusiveAdoptionRate ?? null)
          : key === "vibe"
            ? row.vibeAdoptedShare
            : key === "noSkill"
              ? row.conversationCount > 0
                ? row.noSkillConversationCount
                : null
              : key === "tools"
                ? row.toolCalls
                : row.modelCalls
}
export function compareRunAnalysis(
  a: RunAnalysisFeature,
  b: RunAnalysisFeature,
  sort: RunAnalysisSort,
  desc: boolean,
  asOf: string
): number {
  const av = runAnalysisSortValue(a, sort, asOf),
    bv = runAnalysisSortValue(b, sort, asOf)
  if (av === null && bv !== null) return 1
  if (bv === null && av !== null) return -1
  return (
    (av !== null && bv !== null ? (av - bv) * (desc ? -1 : 1) : 0) ||
    a.projectId.localeCompare(b.projectId) ||
    (a.featureSlug ?? "").localeCompare(b.featureSlug ?? "")
  )
}
export interface RunAnalysisMatch {
  row: RunAnalysisFeature
  reasons: string[]
}
export function filterRunAnalysis(
  data: RunAnalysisData,
  filters: RunAnalysisFilters,
  sort: RunAnalysisSort,
  desc: boolean
): RunAnalysisMatch[] {
  if (runAnalysisFilterErrors(filters).length) return []
  return data.rows
    .flatMap((row) => {
      const reasons = attentionReasons(row, filters, data.dataAsOf)
      return reasons === null ? [] : [{ row, reasons }]
    })
    .sort((a, b) => compareRunAnalysis(a.row, b.row, sort, desc, data.dataAsOf))
}
export const sumRunAnalysisCode = (rows: RunAnalysisFeature[]): RunAnalysisCodeStats | null => {
  const stats = rows.flatMap((r) => (r.codeStats ? [r.codeStats] : []))
  if (!stats.length) return null
  const sum = (key: keyof RunAnalysisCodeStats): number =>
    stats.reduce((n, s) => n + (typeof s[key] === "number" ? (s[key] as number) : 0), 0)
  const generatedLines = sum("generatedLines"),
    deletedLines = sum("deletedLines"),
    effectiveGeneratedLines = sum("effectiveGeneratedLines"),
    measuredGeneratedLines = sum("measuredGeneratedLines"),
    adoptedLines = sum("adoptedLines"),
    pushedAdoptedLines = sum("pushedAdoptedLines"),
    pushedEffectiveGeneratedLines = sum("pushedEffectiveGeneratedLines")
  const unmeasuredGeneratedLines = Math.max(0, generatedLines - measuredGeneratedLines),
    inclusiveEffectiveGeneratedLines = effectiveGeneratedLines + unmeasuredGeneratedLines
  const measuredAdoptionRate =
    effectiveGeneratedLines > 0 ? adoptedLines / effectiveGeneratedLines : null
  return {
    generatedLines,
    deletedLines,
    effectiveGeneratedLines,
    measuredGeneratedLines,
    adoptedLines,
    unmeasuredGeneratedLines,
    inclusiveEffectiveGeneratedLines,
    pushedAdoptedLines,
    pushedEffectiveGeneratedLines,
    pushedMeasuredGeneratedLines: sum("pushedMeasuredGeneratedLines"),
    pushedCommitCount: 0,
    measuredAdoptionRate,
    adoptionRate: measuredAdoptionRate,
    inclusiveAdoptionRate:
      inclusiveEffectiveGeneratedLines > 0 ? adoptedLines / inclusiveEffectiveGeneratedLines : null,
    pushedAdoptionRate:
      pushedEffectiveGeneratedLines > 0 ? pushedAdoptedLines / pushedEffectiveGeneratedLines : null,
    inclusivePushedAdoptionRate:
      inclusiveEffectiveGeneratedLines > 0
        ? pushedAdoptedLines / inclusiveEffectiveGeneratedLines
        : null
  }
}
export interface RunAnalysisProjectMatch extends RunAnalysisMatch {
  features: RunAnalysisMatch[]
  totalFeatures: number
}
export function groupRunAnalysis(
  data: RunAnalysisData,
  matches: RunAnalysisMatch[],
  sort: RunAnalysisSort,
  desc: boolean
): RunAnalysisProjectMatch[] {
  const matching = new Map<string, RunAnalysisMatch[]>(),
    all = new Map<string, RunAnalysisFeature[]>()
  for (const match of matches) {
    const items = matching.get(match.row.projectId) ?? []
    items.push(match)
    matching.set(match.row.projectId, items)
  }
  for (const row of data.rows) {
    const items = all.get(row.projectId) ?? []
    items.push(row)
    all.set(row.projectId, items)
  }
  return [...matching]
    .map(([projectId, features]) => {
      const rows = all.get(projectId)!,
        head = rows[0]
      const sum = (key: keyof RunAnalysisFeature): number =>
        rows.reduce((n, r) => n + (typeof r[key] === "number" ? (r[key] as number) : 0), 0)
      const sumNullable = (key: keyof RunAnalysisFeature): number | null =>
        rows.some((r) => typeof r[key] === "number") ? sum(key) : null
      const first =
        rows.flatMap((r) => (r.firstExecutedAt ? [r.firstExecutedAt] : [])).sort()[0] ?? null
      const last =
        rows
          .flatMap((r) => (r.lastExecutedAt ? [r.lastExecutedAt] : []))
          .sort()
          .at(-1) ?? null
      const end =
        rows
          .flatMap((r) => (r.lastEndedAt ? [r.lastEndedAt] : []))
          .sort()
          .at(-1) ?? null
      const harness = sum("harnessAdoptedLines"),
        vibe = sum("vibeAdoptedLines")
      const row: RunAnalysisFeature = {
        ...head,
        featureSlug: null,
        featureTitle: "项目范围汇总",
        currentStage: null,
        currentStatus: null,
        featureStatus: null,
        firstExecutedAt: first,
        lastExecutedAt: last,
        lastEndedAt: end,
        executionSpanMs:
          first && end && Date.parse(end) >= Date.parse(first)
            ? Date.parse(end) - Date.parse(first)
            : null,
        traceCount: sum("traceCount"),
        conversationCount: sum("conversationCount"),
        noSkillConversationCount: sum("noSkillConversationCount"),
        totalDurationMs: sumNullable("totalDurationMs"),
        toolCalls: sumNullable("toolCalls"),
        modelCalls: sumNullable("modelCalls"),
        toolReportedTraceCount: sum("toolReportedTraceCount"),
        modelReportedTraceCount: sum("modelReportedTraceCount"),
        subagentKinds: rows.reduce<Record<string, number>>((kinds, r) => {
          for (const [kind, turns] of Object.entries(r.subagentKinds))
            kinds[kind] = (kinds[kind] ?? 0) + turns
          return kinds
        }, {}),
        subagentCount: head.projectSubagentCount,
        subagentTurns: sum("subagentTurns"),
        subagentIdentifiedTraceCount: sum("subagentIdentifiedTraceCount"),
        subagentClassifiedTraceCount: sum("subagentClassifiedTraceCount"),
        codeStats: sumRunAnalysisCode(rows),
        harnessAdoptedLines: harness,
        vibeAdoptedLines: vibe,
        vibeAdoptedShare: harness + vibe > 0 ? vibe / (harness + vibe) : null
      }
      return {
        row,
        features,
        totalFeatures: rows.filter((r) => r.featureSlug !== null).length,
        reasons: [...new Set(features.flatMap((f) => f.reasons))]
      }
    })
    .sort((a, b) => compareRunAnalysis(a.row, b.row, sort, desc, data.dataAsOf))
}
export function runAnalysisSummary(data: RunAnalysisData, matches: RunAnalysisMatch[]): string {
  const projects = new Set(matches.map((m) => m.row.projectId)).size
  const reasons = new Map<string, number>()
  for (const m of matches) for (const r of m.reasons) reasons.set(r, (reasons.get(r) ?? 0) + 1)
  return `项目分析：当前筛选匹配${projects}个项目、${matches.filter((m) => m.row.featureSlug !== null).length}个特性。名单范围：${{ active: "进行中的全部项目", executed: "所选时间内有执行的项目/特性", created: "本期新建项目" }[data.membership]}；${data.range.from} 至 ${data.range.to}。指标为累计口径，数据截至${data.dataAsOf}。${[...reasons].map(([r, n]) => `${r}：${n}个特性`).join("；")}`
}
export function runAnalysisExportRows(
  data: RunAnalysisData,
  matches: RunAnalysisMatch[]
): Record<string, unknown>[] {
  return matches.map(({ row: r, reasons }) => ({
    名单范围: data.membership,
    范围开始: data.range.from,
    范围结束: data.range.to,
    查询开始: data.queryStartedAt,
    数据截至: data.dataAsOf,
    快照时间: r.snapshotAt,
    项目ID: r.projectId,
    项目: r.projectName,
    系统: r.systemName,
    插件: r.adapterName,
    版本: r.adapterVersion,
    创建人: r.creator,
    室: r.room,
    项目创建时间: r.projectCreatedAt,
    生命周期状态: r.lifecycleStatus,
    当前快照特性数: r.snapshotFeatureCount,
    特性Slug: r.featureSlug,
    特性: r.featureTitle,
    属于当前快照: r.inSnapshot,
    当前阶段: r.currentStage,
    当前状态: r.currentStatus,
    特性状态: r.featureStatus,
    首次执行: r.firstExecutedAt,
    最近执行: r.lastExecutedAt,
    最晚结束: r.lastEndedAt,
    执行跨度小时: r.executionSpanMs === null ? null : r.executionSpanMs / 3600000,
    累计执行小时: r.totalDurationMs === null ? null : r.totalDurationMs / 3600000,
    距最近执行天: idleDays(r, data.dataAsOf),
    主Agent对话: r.conversationCount,
    未用Skill主Agent对话: r.noSkillConversationCount,
    未用Skill主对话占比:
      r.conversationCount > 0 ? r.noSkillConversationCount / r.conversationCount : null,
    工具调用: r.toolCalls,
    模型调用: r.modelCalls,
    工具字段覆盖: `${r.toolReportedTraceCount}/${r.traceCount}`,
    模型字段覆盖: `${r.modelReportedTraceCount}/${r.traceCount}`,
    已识别子代理数: r.subagentCount,
    子代理轮次: r.subagentTurns,
    子代理类型轮次: JSON.stringify(r.subagentKinds),
    已识别子代理记录: r.subagentIdentifiedTraceCount,
    类型覆盖: `${r.subagentClassifiedTraceCount}/${r.traceCount}`,
    生成行: r.codeStats?.generatedLines ?? null,
    已测量有效生成行: r.codeStats?.effectiveGeneratedLines ?? null,
    全量有效生成行: r.codeStats?.inclusiveEffectiveGeneratedLines ?? null,
    未测量生成行: r.codeStats?.unmeasuredGeneratedLines ?? null,
    提交采纳行: r.codeStats?.adoptedLines ?? null,
    入库采纳行: r.codeStats?.pushedAdoptedLines ?? null,
    全量采纳率: r.codeStats?.inclusiveAdoptionRate ?? null,
    Harness采纳行: r.harnessAdoptedLines,
    Vibe采纳行: r.vibeAdoptedLines,
    Vibe采纳占比: r.vibeAdoptedShare,
    关注原因: reasons.join("；"),
    统计说明: Object.values(RUN_ANALYSIS_NOTES).join(" ")
  }))
}
