import * as XLSX from "xlsx"
import {
  addStageTurnCounts,
  emptyStageTurnCounts,
  runAnalysisKey,
  RUN_ANALYSIS_MEMBERSHIP_LABELS,
  RUN_ANALYSIS_NOTES,
  type RunAnalysisData,
  type RunAnalysisPluginStages,
  type StageTurnCounts
} from "../../../../shared/project-run-analysis"
import {
  formatRunAnalysisExportTime,
  runAnalysisExportRows,
  runAnalysisFilterChips,
  RUN_ANALYSIS_SORT_LABELS,
  type RunAnalysisMatch,
  type RunAnalysisProjectMatch,
  type RunAnalysisFilters,
  type RunAnalysisSort
} from "./project-run-analysis-view"

type Row = Record<string, unknown>
function tableSheet(rows: Row[]): XLSX.WorkSheet {
  const headers = Object.keys(rows[0] ?? {})
  const sheet = XLSX.utils.json_to_sheet(rows)
  const widths: XLSX.ColInfo[] = []
  const width = (v: unknown) =>
    Array.from(String(v ?? "")).reduce((n, c) => n + (c.charCodeAt(0) > 255 ? 2 : 1), 0)
  headers.forEach((header, c) => {
    const format =
      header.endsWith("率") || header.endsWith("占比")
        ? "0.0%"
        : /（天）|（小时）/.test(header)
          ? "0.0"
          : null
    let wch = Math.max(12, width(header) + 2)
    rows.forEach((row, i) => {
      wch = Math.max(wch, width(row[header]) + 2)
      if (format) {
        const cell = sheet[XLSX.utils.encode_cell({ r: 1 + i, c })]
        if (cell?.t === "n") cell.z = format
      }
    })
    widths[c] = { wch: Math.min(48, wch) }
  })
  sheet["!cols"] = widths
  return sheet
}

function pluginSheetName(adapter: string | null, existing: string[]): string {
  const safeName = Array.from(adapter || "未知插件", (ch) =>
    ch.charCodeAt(0) < 32 || "\\/:?*[]".includes(ch) ? "-" : ch
  ).join("")
  const base = `插件-${safeName}`
  const taken = new Set(existing.map((name) => name.toLowerCase()))
  for (let i = 1; ; i++) {
    const suffix = i === 1 ? "" : ` (${i})`
    // Excel limits sheet names to 31 UTF-16 units. Keep surrogate pairs intact.
    const stem = base.slice(0, 31 - suffix.length).replace(/[\uD800-\uDBFF']+$/u, "")
    const candidate = stem + suffix
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

function pluginFeatureRows(
  data: RunAnalysisData,
  matches: RunAnalysisMatch[],
  stages: RunAnalysisPluginStages["stages"]
): Row[] {
  const stageNames = new Set<string | null>()
  for (const id of new Set(matches.map(({ row }) => row.projectId))) {
    const catalog = data.workflowStageNamesByProject
    if (catalog && Object.hasOwn(catalog, id)) {
      for (const name of catalog[id]) stageNames.add(name)
    }
  }
  const byFeature = new Map<string, Map<string | null, StageTurnCounts>>()
  const historicalNames = new Set<string>()
  for (const stage of stages) {
    const key = runAnalysisKey(stage.projectId, stage.featureSlug)
    const counts = byFeature.get(key) ?? new Map<string | null, StageTurnCounts>()
    if (counts.has(stage.nodeName)) throw new Error("特性阶段数据重复，请刷新后重新导出")
    counts.set(stage.nodeName, stage)
    byFeature.set(key, counts)
    if (stage.nodeName !== null && !stageNames.has(stage.nodeName))
      historicalNames.add(stage.nodeName)
  }
  for (const name of [...historicalNames].sort((a, b) => a.localeCompare(b, "zh-CN")))
    stageNames.add(name)
  let unknown = "未记录阶段"
  if (stages.some((stage) => stage.nodeName === null)) {
    while (stageNames.has(unknown)) unknown += "（缺失）"
    stageNames.add(null)
  }

  const details = runAnalysisExportRows(data, matches)
  const zero = emptyStageTurnCounts()
  const rows = matches.map(({ row }, i) => {
    const key = runAnalysisKey(row.projectId, row.featureSlug)
    const counts = byFeature.get(key)
    byFeature.delete(key)
    const total = emptyStageTurnCounts()
    // Lead with the feature identity and its stage columns, then the existing detail fields.
    const result: Row = {
      项目名称: row.projectName,
      项目编号: row.projectCode,
      特性名称: row.featureTitle
    }
    for (const stage of stageNames) {
      const turns = counts?.get(stage) ?? zero
      addStageTurnCounts(total, turns)
      const name = stage ?? unknown
      result[`${name} · 主对话（轮）`] = turns.conversationCount
      result[`${name} · 节点完成后（次）`] = observedCount(
        turns.conversationCount,
        turns.nodeStatusReported,
        turns.completedNode
      )
      result[`${name} · 无 Skill 归因（次）`] = observedCount(
        turns.conversationCount,
        turns.skillAttributionReported,
        turns.unattributedSkill
      )
    }
    // Validate each feature separately: offsetting discrepancies can cancel in a plugin total.
    if (
      total.conversationCount !== row.conversationCount ||
      observedCount(total.conversationCount, total.nodeStatusReported, total.completedNode) !==
        row.completedNodeConversationCount ||
      observedCount(
        total.conversationCount,
        total.skillAttributionReported,
        total.unattributedSkill
      ) !== row.unattributedSkillConversationCount
    )
      throw new Error("对话数据已更新，请刷新项目分析后重新导出")
    return Object.assign(result, details[i])
  })
  if (byFeature.size) throw new Error("特性名单已变化，请刷新后重新导出")
  return rows
}

function observedCount(turns: number, reported: number, count: number): number | null {
  return turns > 0 && reported === 0 ? null : count
}

export function downloadRunAnalysisWorkbook({
  data,
  matches,
  groups,
  filters,
  sort,
  desc,
  plugins
}: {
  data: RunAnalysisData
  matches: RunAnalysisMatch[]
  groups?: RunAnalysisProjectMatch[]
  filters: RunAnalysisFilters
  sort: RunAnalysisSort
  desc: boolean
  plugins: RunAnalysisPluginStages[]
}): void {
  const book = XLSX.utils.book_new()
  const appendRows = (name: string, rows: Row[]) => {
    const sheet = tableSheet(rows)
    XLSX.utils.book_append_sheet(book, sheet, name)
    return sheet
  }
  appendRows("匹配特性", runAnalysisExportRows(data, matches))
  if (groups)
    appendRows(
      "项目汇总",
      groups.map((g) => {
        const row = runAnalysisExportRows(data, [g])[0]
        // These columns describe a feature, not the whole project.
        for (const key of ["特性名称", "当前阶段", "当前状态"]) delete row[key]
        return {
          ...row,
          名单内特性数: g.totalFeatures,
          匹配特性数: g.features.filter((f) => f.row.featureSlug !== null).length,
          匹配特性: g.features.map((f) => f.row.featureTitle).join("；")
        }
      })
    )
  appendRows("统计口径", [
    { 项目: "查看范围", 说明: RUN_ANALYSIS_MEMBERSHIP_LABELS[data.membership] },
    ...(data.membership === "executed" || data.membership === "created"
      ? [
          {
            项目: "名单日期",
            说明: `${formatRunAnalysisExportTime(data.range.from)} 至 ${formatRunAnalysisExportTime(data.range.to)}`
          }
        ]
      : []),
    {
      项目: "筛选条件",
      说明:
        runAnalysisFilterChips(filters)
          .map((chip) => chip.label)
          .join("；") || "无"
    },
    {
      项目: "排序",
      说明: `${RUN_ANALYSIS_SORT_LABELS[sort]} · ${desc ? "从高到低" : "从低到高"}`
    },
    { 项目: "数据截至（北京时间）", 说明: formatRunAnalysisExportTime(data.dataAsOf) },
    {
      项目: "指标范围",
      说明: "匹配特性展示各特性的累计指标；项目汇总展示入选项目在名单范围内全部特性的累计指标，采纳率按总行数计算。"
    },
    {
      项目: "插件分表",
      说明: "同名插件的各版本合并。每行是一个匹配特性。阶段列按插件工作流顺序排列，历史快照缺少工作流时使用已上报的阶段。各轮主对话按开始阶段计数，缺少阶段的轮次单列。"
    },
    { 项目: "节点完成后", 说明: RUN_ANALYSIS_NOTES.completedNode },
    { 项目: "无 Skill 归因", 说明: RUN_ANALYSIS_NOTES.unattributedSkill },
    {
      项目: "阶段计数",
      说明: "同一轮可以同时计入两项。该特性在该阶段没有主对话时填 0。有主对话时，按已上报的节点状态或 Skill 归因计数，对应字段全部缺失时留空。"
    },
    { 项目: "执行跨度", 说明: RUN_ANALYSIS_NOTES.span },
    { 项目: "采纳率", 说明: RUN_ANALYSIS_NOTES.adoption },
    { 项目: "调用次数", 说明: RUN_ANALYSIS_NOTES.cost },
    {
      项目: "数值格式",
      说明: "所有时间为北京时间；采纳率、占比为百分比。空白表示未记录或不适用，0表示统计值为零。"
    }
  ])

  const byPlugin = new Map<string | null, RunAnalysisMatch[]>()
  for (const match of matches) {
    const rows = byPlugin.get(match.row.adapterName)
    if (rows) rows.push(match)
    else byPlugin.set(match.row.adapterName, [match])
  }
  for (const { adapterName, stages } of plugins.sort((a, b) =>
    (a.adapterName ?? "").localeCompare(b.adapterName ?? "", "zh-CN")
  )) {
    const pluginMatches = byPlugin.get(adapterName)
    if (!pluginMatches) throw new Error("插件名单已变化，请刷新项目分析后重新导出")
    byPlugin.delete(adapterName)
    const sheet = appendRows(
      pluginSheetName(adapterName, book.SheetNames),
      pluginFeatureRows(data, pluginMatches, stages)
    )
    if (sheet["!ref"]) sheet["!autofilter"] = { ref: sheet["!ref"] }
  }
  if (byPlugin.size) throw new Error("插件阶段数据不完整，请刷新后重新导出")
  XLSX.writeFile(book, `项目分析-${new Date(data.dataAsOf).toISOString().slice(0, 10)}.xlsx`)
}
