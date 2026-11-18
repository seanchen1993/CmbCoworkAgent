import type {
  RunAnalysisData,
  RunAnalysisFeature,
  RunAnalysisPluginStages,
  RunAnalysisOptions,
  RunAnalysisRange,
  RunAnalysisStage,
  RunAnalysisSessionRequest
} from "../../shared/project-run-analysis"
import { emptyRunAnalysisMetrics } from "./project-run-analysis"
import { makeDashboardCodeStats } from "./dashboard-code-stats"

const businessStages = ["design-方案设计", "dev-编码实现", "test-测试"]
const dataStages = ["取数", "校验"]
export function mockStageNames(projectId?: string): string[] {
  const index = projectId?.match(/demo-(\d+)$/)?.[1]
  return index !== undefined && Number(index) % 3 === 2 ? dataStages : businessStages
}
export function mockRunAnalysisSessionIndexes({
  metric,
  nodeName,
  projectId
}: Pick<RunAnalysisSessionRequest, "metric" | "nodeName"> & { projectId?: string }): number[] {
  const names = mockStageNames(projectId)
  return Array.from({ length: 30 }, (_, i) => i).filter(
    (i) =>
      (nodeName === undefined || nodeName === names[i % names.length]) &&
      (metric !== "noSkill" || i < 12) &&
      (metric !== "completedNode" || i % 5 === 0) &&
      (metric !== "unattributedSkill" || i < 3)
  )
}

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
    const projectIndex = Math.floor(i / 3)
    const projectId = `demo-${projectIndex}`
    const names = mockStageNames(projectId)
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
      projectId,
      projectCode:
        projectIndex % 4 === 0 ? null : `LEAN-${String(projectIndex + 1).padStart(6, "0")}`,
      projectFromLean: projectIndex % 4 === 0 ? null : projectIndex % 4 !== 1,
      projectName: `演示 · ${["客户经营平台", "授信审批优化", "数据运营工作台", "渠道服务改造"][Math.floor(i / 3) % 4]} ${Math.floor(i / 3) + 1}`,
      systemName: "开发示例",
      adapterName: names === dataStages ? "数据研发插件" : "业务研发插件",
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
      currentStage: names[(i + 1) % names.length],
      currentStatus: i % 4 === 0 ? "待处理" : "进行中",
      featureStatus: "进行中",
      inSnapshot: true,
      traceCount: i % 7 === 0 ? 0 : 40,
      conversationCount: i % 7 === 0 ? 0 : 30,
      noSkillConversationCount: i % 7 === 0 ? 0 : i % 2 === 0 ? 12 : 20,
      completedNodeConversationCount:
        i % 7 === 0 ? 0 : mockRunAnalysisSessionIndexes({ metric: "completedNode" }).length,
      unattributedSkillConversationCount:
        i % 7 === 0 ? 0 : mockRunAnalysisSessionIndexes({ metric: "unattributedSkill" }).length,
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
      (!options.fromLeanOnly || r.projectFromLean === true) &&
      (!options.adapterName || r.adapterName === options.adapterName) &&
      (options.membership !== "executed" || r.executedInRange) &&
      (options.membership !== "created" ||
        (Date.parse(r.projectCreatedAt) >= Date.parse(range.from) &&
          Date.parse(r.projectCreatedAt) <= Date.parse(range.to)))
  )
  return {
    rows,
    workflowStageNamesByProject: Object.fromEntries(
      [...new Set(rows.map((r) => r.projectId))].map((id) => [id, mockStageNames(id)])
    ),
    range,
    membership: options.membership ?? "active",
    projectCount: new Set(rows.map((r) => r.projectId)).size,
    featureCount: rows.length,
    queryStartedAt: new Date(now).toISOString(),
    dataAsOf: new Date(now).toISOString()
  }
}
export function makeMockRunAnalysisStages(projectId?: string): RunAnalysisStage[] {
  return mockStageNames(projectId).map((nodeName, i) => ({
    ...emptyRunAnalysisMetrics(),
    nodeName,
    traceCount: 14,
    conversationCount: mockRunAnalysisSessionIndexes({ projectId, nodeName }).length,
    noSkillConversationCount: i + 2,
    completedNodeConversationCount: mockRunAnalysisSessionIndexes({
      nodeName,
      projectId,
      metric: "completedNode"
    }).length,
    unattributedSkillConversationCount: mockRunAnalysisSessionIndexes({
      nodeName,
      projectId,
      metric: "unattributedSkill"
    }).length,
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

export function makeMockRunAnalysisPluginStages(
  features: RunAnalysisFeature[]
): RunAnalysisPluginStages["stages"] {
  return features.flatMap(({ projectId, featureSlug, conversationCount }) =>
    conversationCount
      ? makeMockRunAnalysisStages(projectId).map((row) => ({
          projectId,
          featureSlug,
          nodeName: row.nodeName,
          conversationCount: row.conversationCount,
          nodeStatusReported: row.conversationCount,
          skillAttributionReported: row.conversationCount,
          completedNode: row.completedNodeConversationCount ?? 0,
          unattributedSkill: row.unattributedSkillConversationCount ?? 0
        }))
      : []
  )
}
