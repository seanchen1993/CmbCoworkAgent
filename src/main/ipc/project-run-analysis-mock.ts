import type {
  RunAnalysisData,
  RunAnalysisOptions,
  RunAnalysisRange,
  RunAnalysisStage
} from "../../shared/project-run-analysis"
import { emptyRunAnalysisMetrics } from "./project-run-analysis"
import { makeDashboardCodeStats } from "./dashboard-code-stats"

/** Explicit development fixture; no generated values enter the production branch. */
export function makeMockRunAnalysis(
  range: RunAnalysisRange,
  options: RunAnalysisOptions = {}
): RunAnalysisData {
  const now = Date.now(),
    day = 86400000
  const rooms =
    typeof options.upperOrgLv1 === "string" ? [options.upperOrgLv1] : (options.upperOrgLv1 ?? [])
  const rows = Array.from({ length: 36 }, (_, i) => {
    const first = new Date(now - (i + 2) * day).toISOString(),
      last = new Date(now - i * day).toISOString()
    const codeStats =
      i % 5 === 0
        ? null
        : makeDashboardCodeStats({
            generatedLines: 1000 + i * 10,
            deletedLines: 30,
            measuredGeneratedLines: 800,
            effectiveGeneratedLines: 750,
            adoptedLines: 100 + i * 15,
            pushedAdoptedLines: 50 + i * 8,
            pushedEffectiveGeneratedLines: 750
          })
    return {
      ...emptyRunAnalysisMetrics(),
      projectId: `demo-${Math.floor(i / 3)}`,
      projectName: `演示 · ${["客户经营平台", "授信审批优化", "数据运营工作台", "渠道服务改造"][Math.floor(i / 3) % 4]} ${Math.floor(i / 3) + 1}`,
      systemName: "开发示例",
      adapterName: "业务研发插件",
      adapterVersion: "1.0",
      creator: "示例成员",
      room: rooms[0] ?? "示例研发室",
      projectCreatedAt: new Date(now - Math.floor(i / 3) * day).toISOString(),
      lifecycleStatus: "active",
      snapshotAt: new Date(now - 20 * 60000).toISOString(),
      projectSubagentCount: 5,
      snapshotFeatureCount: 3,
      featureSlug: `feature-${i % 3}`,
      featureTitle: ["登录能力完善", "经营报表分析", "接口联调验证"][i % 3],
      currentStage: ["dev-编码实现", "test-测试", "design-方案设计"][i % 3],
      currentStatus: i % 4 === 0 ? "待处理" : "进行中",
      featureStatus: "进行中",
      inSnapshot: true,
      traceCount: i % 7 === 0 ? 0 : 40,
      conversationCount: i % 7 === 0 ? 0 : 30,
      noSkillConversationCount: i % 7 === 0 ? 0 : i % 2 === 0 ? 12 : 20,
      firstExecutedAt: i % 7 === 0 ? null : first,
      lastExecutedAt: i % 7 === 0 ? null : last,
      lastEndedAt: i % 7 === 0 ? null : last,
      executionSpanMs: i % 7 === 0 ? null : (i + 2) * day,
      totalDurationMs: i % 7 === 0 ? null : (i + 1) * 3600000,
      toolCalls: i % 7 === 0 ? null : 200 + i * 30,
      modelCalls: i % 7 === 0 ? null : 80 + i * 10,
      toolReportedTraceCount: 30,
      modelReportedTraceCount: 30,
      subagentCount: 2,
      subagentTurns: 10,
      subagentIdentifiedTraceCount: 10,
      subagentClassifiedTraceCount: 35,
      subagentKinds: { task: 6, team: 4 },
      executedInRange:
        i % 7 !== 0 &&
        Date.parse(last) >= Date.parse(range.from) &&
        Date.parse(last) <= Date.parse(range.to),
      codeStats,
      harnessAdoptedLines: 100,
      vibeAdoptedLines: i * 20,
      vibeAdoptedShare: (i * 20) / (100 + i * 20)
    }
  }).filter(
    (r) =>
      (!options.adapterName || r.adapterName === options.adapterName) &&
      (options.membership !== "executed" || r.executedInRange) &&
      (options.membership !== "created" ||
        (Date.parse(r.projectCreatedAt) >= Date.parse(range.from) &&
          Date.parse(r.projectCreatedAt) <= Date.parse(range.to)))
  )
  return {
    rows,
    range,
    membership: options.membership ?? "active",
    projectCount: new Set(rows.map((r) => r.projectId)).size,
    featureCount: rows.length,
    queryStartedAt: new Date(now).toISOString(),
    dataAsOf: new Date(now).toISOString()
  }
}
export function makeMockRunAnalysisStages(): RunAnalysisStage[] {
  return ["design-方案设计", "dev-编码实现", "test-测试"].map((nodeName, i) => ({
    ...emptyRunAnalysisMetrics(),
    nodeName,
    traceCount: 14,
    conversationCount: 10,
    noSkillConversationCount: i + 2,
    firstExecutedAt: new Date(Date.now() - 3 * 86400000).toISOString(),
    lastExecutedAt: new Date().toISOString(),
    lastEndedAt: new Date().toISOString(),
    executionSpanMs: 3 * 86400000,
    totalDurationMs: 3600000,
    attributedDurationMs: 3600000,
    toolCalls: 100,
    modelCalls: 20,
    attributedToolCalls: 100,
    attributedModelCalls: 20
  }))
}
