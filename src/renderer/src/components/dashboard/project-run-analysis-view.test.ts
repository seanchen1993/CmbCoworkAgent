import { describe, expect, it } from "vitest"
import { makeMockRunAnalysis } from "../../../../main/ipc/project-run-analysis-mock"
import {
  DEFAULT_RUN_ANALYSIS_FILTERS,
  RUN_ANALYSIS_PRESETS,
  attentionReasons,
  clearRunAnalysisFilter,
  filterRunAnalysis,
  groupRunAnalysis,
  runAnalysisExportRows,
  runAnalysisPreset,
  runAnalysisPresetCounts,
  runAnalysisFilterChips
} from "./project-run-analysis-view"
const range = { from: "2026-01-01T00:00:00.000Z", to: "2026-12-31T23:59:59.999Z" }
const data = makeMockRunAnalysis(range)

describe("runtime analysis full-range presentation", () => {
  it("combines configured conditions with AND and excludes missing/zero-denominator samples", () => {
    const f = { ...DEFAULT_RUN_ANALYSIS_FILTERS, adoptionMax: 0.5, noSkillMin: 12 }
    const row = { ...data.rows[1], codeStats: null }
    expect(attentionReasons(row, f, data.dataAsOf)).toBeNull()
    expect(
      attentionReasons({ ...data.rows[1], noSkillConversationCount: 1 }, f, data.dataAsOf)
    ).toBeNull()
    const stats = {
      ...data.rows[1].codeStats!,
      inclusiveEffectiveGeneratedLines: 99,
      inclusiveAdoptionRate: 0
    }
    expect(attentionReasons({ ...row, codeStats: stats }, f, data.dataAsOf)).toBeNull()
    expect(attentionReasons(data.rows[1], f, data.dataAsOf)).toHaveLength(2)
  })
  it("filters, sorts and exports the entire result before any display pagination", () => {
    const all = filterRunAnalysis(data, { ...DEFAULT_RUN_ANALYSIS_FILTERS }, "noSkill", true)
    expect(all.length).toBe(36)
    expect(runAnalysisExportRows(data, all)).toHaveLength(36)
    const afterFirstPage = data.rows[30]
    const matches = filterRunAnalysis(
      data,
      { ...DEFAULT_RUN_ANALYSIS_FILTERS, keyword: afterFirstPage.projectId },
      "idle",
      true
    )
    expect(matches.every((m) => m.row.projectId === afterFirstPage.projectId)).toBe(true)
    expect(matches).toHaveLength(3)
    for (const row of runAnalysisExportRows(data, matches)) {
      expect(row["数据截至"]).toBe(data.dataAsOf)
      expect(row["统计说明"]).toContain("累计")
    }
  })
  it("always orders absent values last in either direction, without interpreting them as safe zero", () => {
    for (const desc of [true, false]) {
      const sorted = filterRunAnalysis(data, { ...DEFAULT_RUN_ANALYSIS_FILTERS }, "adoption", desc)
      const firstNull = sorted.findIndex((m) => m.row.codeStats === null)
      expect(firstNull).toBeGreaterThan(0)
      expect(sorted.slice(firstNull).every((m) => m.row.codeStats === null)).toBe(true)
    }
  })
  it("keeps different project IDs with the same feature slug distinct and aggregates weighted rates", () => {
    const filtered = filterRunAnalysis(data, { ...DEFAULT_RUN_ANALYSIS_FILTERS }, "adoption", true)
    const groups = groupRunAnalysis(data, filtered, "adoption", true)
    expect(groups).toHaveLength(12)
    const g = groups[0]
    const source = data.rows.filter((r) => r.projectId === g.row.projectId)
    const numerator = source.reduce((n, r) => n + (r.codeStats?.adoptedLines ?? 0), 0)
    const denominator = source.reduce(
      (n, r) => n + (r.codeStats?.inclusiveEffectiveGeneratedLines ?? 0),
      0
    )
    expect(g.row.codeStats?.inclusiveAdoptionRate).toBeCloseTo(numerator / denominator)
    expect(g.row.subagentCount).toBe(5)
    expect(g.row.subagentKinds).toEqual({ task: 18, team: 12 })
    expect(g.row.featureStatus).toBeNull()
    expect(g.totalFeatures).toBe(3)
  })
  it("reports matching feature count separately from the full project aggregate", () => {
    const matches = filterRunAnalysis(
      data,
      { ...DEFAULT_RUN_ANALYSIS_FILTERS, keyword: "经营报表分析" },
      "tools",
      true
    )
    const groups = groupRunAnalysis(data, matches, "tools", true)
    expect(groups.every((g) => g.features.length === 1 && g.totalFeatures === 3)).toBe(true)
    for (const g of groups)
      expect(g.row.conversationCount).toBe(
        data.rows
          .filter((r) => r.projectId === g.row.projectId)
          .reduce((n, r) => n + r.conversationCount, 0)
      )
  })
  it("preset switches replace all numeric conditions and clearing restores the objective inventory", () => {
    expect(runAnalysisPreset("noSkill")).toMatchObject({
      noSkillMin: 12,
      adoptionMax: null,
      idleDays: null
    })
    expect(runAnalysisPreset("adoption")).toMatchObject({
      noSkillMin: null,
      adoptionMax: 0.3,
      minCodeLines: 100
    })
    expect(runAnalysisPreset("")).toEqual(DEFAULT_RUN_ANALYSIS_FILTERS)
  })
  it("switches quick filters without discarding the searched project, plugin, stage or status", () => {
    const current = {
      ...runAnalysisPreset("adoption"),
      keyword: "客户经营平台",
      plugin: JSON.stringify(["codex", "1.5.5"]),
      stage: "dev-编码实现",
      status: "进行中",
      minCodeLines: 300,
      modelMin: 400
    }
    const next = runAnalysisPreset("noSkill", current)
    expect(next).toMatchObject({
      keyword: current.keyword,
      plugin: current.plugin,
      stage: current.stage,
      status: current.status,
      noSkillMin: 12,
      adoptionMax: null,
      modelMin: null,
      minCodeLines: 100
    })
    expect(runAnalysisPreset("", next)).toEqual({
      ...DEFAULT_RUN_ANALYSIS_FILTERS,
      keyword: current.keyword,
      plugin: current.plugin,
      stage: current.stage,
      status: current.status
    })
    expect(current.adoptionMax).toBe(0.3)
    expect(RUN_ANALYSIS_PRESETS.find((p) => p.key === "adoption")).toMatchObject({
      sort: "adoption",
      desc: false
    })
  })
  it("quick counts cover the full range, respect basic filters and ignore selected numeric criteria", () => {
    const base = { ...DEFAULT_RUN_ANALYSIS_FILTERS, keyword: data.rows[30].projectId }
    const counts = runAnalysisPresetCounts(data, base)
    expect(runAnalysisPresetCounts(data, { ...base, toolMin: 99999999 })).toEqual(counts)
    for (const preset of RUN_ANALYSIS_PRESETS) {
      const matches = filterRunAnalysis(
        data,
        runAnalysisPreset(preset.key, base),
        preset.sort,
        preset.desc
      )
      expect(counts[preset.key]).toBe(matches.filter((m) => m.row.featureSlug !== null).length)
    }
    const baseCounts = runAnalysisPresetCounts(data, DEFAULT_RUN_ANALYSIS_FILTERS)
    expect(
      runAnalysisPresetCounts(
        {
          ...data,
          rows: [...data.rows, { ...data.rows[35], featureSlug: null }]
        },
        DEFAULT_RUN_ANALYSIS_FILTERS
      )
    ).toEqual(baseCounts)
  })
  it("exposes every effective filter, preserves zero thresholds and removes just the chosen chip", () => {
    const filters = {
      ...DEFAULT_RUN_ANALYSIS_FILTERS,
      keyword: "客户",
      status: "进行中",
      noSkillMin: 0,
      adoptionMax: 0.125,
      minCodeLines: 500
    }
    const chips = runAnalysisFilterChips(filters)
    expect(chips.find((c) => c.key === "adoptionMax")?.label).toBe(
      "采纳率 ≤ 12.5% · 有效生成 ≥ 500 行"
    )
    expect(chips.find((c) => c.key === "noSkillMin")?.label).toContain("≥ 0 轮")
    expect(chips.some((c) => c.key === "minCodeLines")).toBe(false)
    expect(clearRunAnalysisFilter(filters, "adoptionMax")).toEqual({
      ...filters,
      adoptionMax: null,
      minCodeLines: 100
    })
    expect(clearRunAnalysisFilter(filters, "keyword")).toEqual({ ...filters, keyword: "" })
    expect(runAnalysisFilterChips(DEFAULT_RUN_ANALYSIS_FILTERS)).toEqual([])
  })
})
