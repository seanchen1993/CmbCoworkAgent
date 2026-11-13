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
  runAnalysisFilterErrors,
  matchesNumeric,
  type RunAnalysisFilters,
  runAnalysisFilterChips
} from "./project-run-analysis-view"
const range = { from: "2026-01-01T00:00:00.000Z", to: "2026-12-31T23:59:59.999Z" }
const data = makeMockRunAnalysis(range)

describe("runtime analysis full-range presentation", () => {
  it("combines configured conditions with AND and excludes missing/zero-denominator samples", () => {
    const f: RunAnalysisFilters = {
      ...DEFAULT_RUN_ANALYSIS_FILTERS,
      numeric: {
        adoptionRate: { operator: "lte", value: 0.5 },
        codeLines: { operator: "gte", value: 100 },
        noSkill: { operator: "gte", value: 12 }
      }
    }
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
    expect(attentionReasons(data.rows[1], f, data.dataAsOf)).toHaveLength(3)
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
  it("presets replace numeric conditions while preserving basic filters", () => {
    const current: RunAnalysisFilters = {
      ...runAnalysisPreset("adoption"),
      keyword: "客户",
      stage: "dev",
      status: "进行中",
      plugin: "[null,null]"
    }
    const next = runAnalysisPreset("noSkill", current)
    expect(next).toEqual({ ...current, numeric: { noSkill: { operator: "gte", value: 12 } } })
    expect(runAnalysisPreset("", next)).toEqual({
      ...DEFAULT_RUN_ANALYSIS_FILTERS,
      keyword: current.keyword,
      stage: current.stage,
      status: current.status,
      plugin: current.plugin
    })
    expect(current.numeric.adoptionRate).toEqual({ operator: "lte", value: 0.3 })
    expect(runAnalysisPreset("adoption").numeric.codeLines?.value).toBe(100)
  })
  it("quick counts cover all pages and ignore the current numeric conditions", () => {
    const base = { ...DEFAULT_RUN_ANALYSIS_FILTERS, keyword: data.rows[30].projectId }
    const counts = runAnalysisPresetCounts(data, base)
    expect(
      runAnalysisPresetCounts(data, {
        ...base,
        numeric: { tools: { operator: "gt", value: 999999 } }
      })
    ).toEqual(counts)
    for (const preset of RUN_ANALYSIS_PRESETS) {
      const matches = filterRunAnalysis(
        data,
        runAnalysisPreset(preset.key, base),
        preset.sort,
        preset.desc
      )
      expect(counts[preset.key]).toBe(matches.filter((m) => m.row.featureSlug !== null).length)
    }
  })
  it("keeps sample size independent from adoption and exposes/removes each active condition", () => {
    const filters: RunAnalysisFilters = {
      ...DEFAULT_RUN_ANALYSIS_FILTERS,
      numeric: {
        adoptionRate: { operator: "lt", value: 0.125 },
        codeLines: { operator: "gte", value: 500 },
        noSkill: { operator: "eq", value: 0 }
      }
    }
    const chips = runAnalysisFilterChips(filters)
    expect(chips.find((c) => c.key === "adoptionRate")?.label).toBe("采纳率 < 12.5 %")
    expect(chips.find((c) => c.key === "noSkill")?.label).toContain("= 0 轮")
    expect(chips.find((c) => c.key === "codeLines")?.label).toContain("≥ 500 行")
    expect(clearRunAnalysisFilter(filters, "adoptionRate").numeric).toEqual({
      codeLines: filters.numeric.codeLines,
      noSkill: filters.numeric.noSkill
    })
    expect(runAnalysisFilterChips(DEFAULT_RUN_ANALYSIS_FILTERS)).toEqual([])
    const r = {
      ...data.rows[1],
      codeStats: { ...data.rows[1].codeStats!, inclusiveEffectiveGeneratedLines: 99 }
    }
    expect(
      attentionReasons(
        r,
        {
          ...DEFAULT_RUN_ANALYSIS_FILTERS,
          numeric: { codeLines: { operator: "gte", value: 100 } }
        },
        data.dataAsOf
      )
    ).toBeNull()
  })
  it("handles strict and inclusive boundaries, zero and missing values", () => {
    expect(matchesNumeric(10, { operator: "gt", value: 10 })).toBe(false)
    expect(matchesNumeric(10, { operator: "gte", value: 10 })).toBe(true)
    expect(matchesNumeric(10, { operator: "lt", value: 10 })).toBe(false)
    expect(matchesNumeric(10, { operator: "lte", value: 10 })).toBe(true)
    expect(matchesNumeric(0, { operator: "eq", value: 0 })).toBe(true)
    expect(matchesNumeric(null, { operator: "lte", value: 10 })).toBe(false)
    expect(matchesNumeric(null, { operator: "missing", value: null })).toBe(true)
    expect(matchesNumeric(0, { operator: "present", value: null })).toBe(true)
    for (const n of [10, 20])
      expect(matchesNumeric(n, { operator: "between", value: 10, upper: 20 })).toBe(true)
    expect(matchesNumeric(21, { operator: "between", value: 10, upper: 20 })).toBe(false)
  })
  it("validates incomplete/reversed ranges and invalid percentages rather than changing thresholds", () => {
    for (const condition of [
      { operator: "between" as const, value: 5, upper: 3 },
      { operator: "between" as const, value: 5, upper: null },
      { operator: "gte" as const, value: NaN }
    ]) {
      const f = { ...DEFAULT_RUN_ANALYSIS_FILTERS, numeric: { tools: condition } }
      expect(runAnalysisFilterErrors(f)).not.toHaveLength(0)
      expect(filterRunAnalysis(data, f, "tools", true)).toEqual([])
    }
    expect(
      runAnalysisFilterErrors({
        ...DEFAULT_RUN_ANALYSIS_FILTERS,
        numeric: { adoptionRate: { operator: "lt", value: 1.01 } }
      })
    ).not.toHaveLength(0)
    expect(
      runAnalysisFilterErrors({
        ...DEFAULT_RUN_ANALYSIS_FILTERS,
        numeric: { tools: { operator: "between", value: null, upper: null } }
      })
    ).toEqual([])
  })
  it("applies less-than filters before pagination and exports the same rows", () => {
    const f: RunAnalysisFilters = {
      ...DEFAULT_RUN_ANALYSIS_FILTERS,
      numeric: { noSkill: { operator: "lt", value: 19 } }
    }
    const result = filterRunAnalysis(data, f, "noSkill", false)
    expect(result.length).toBeGreaterThan(0)
    expect(
      result.every((m) => m.row.noSkillConversationCount < 19 && m.row.conversationCount > 0)
    ).toBe(true)
    expect(runAnalysisExportRows(data, result)).toHaveLength(result.length)
  })
})
