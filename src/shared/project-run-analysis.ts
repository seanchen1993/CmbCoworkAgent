/** Runtime analysis uses existing telemetry only; dates select membership, metrics are lifetime. */
export type RunAnalysisRange = { from: string; to: string }
// Keep "active" for previously saved Agent contexts and internal callers.
export type RunAnalysisMembership = "active" | "executed" | "created" | "all"
export const RUN_ANALYSIS_MEMBERSHIP_LABELS: Record<RunAnalysisMembership, string> = {
  active: "进行中的全部项目",
  executed: "所选日期内有执行（含归档）",
  created: "所选日期内新建项目（含归档）",
  all: "全部项目"
}
export interface RunAnalysisOptions {
  upperOrgLv1?: string | string[] | null
  fromLeanOnly?: boolean | null
  adapterName?: string | null
  adapterVersion?: string | null
  membership?: RunAnalysisMembership
  refresh?: boolean
}
export interface RunAnalysisCodeStats {
  generatedLines: number
  deletedLines: number
  measuredGeneratedLines: number
  effectiveGeneratedLines: number
  unmeasuredGeneratedLines: number
  inclusiveEffectiveGeneratedLines: number
  adoptedLines: number
  pushedMeasuredGeneratedLines: number
  pushedEffectiveGeneratedLines: number
  pushedAdoptedLines: number
  pushedCommitCount: number
  measuredAdoptionRate: number | null
  inclusiveAdoptionRate: number | null
  pushedAdoptionRate: number | null
  inclusivePushedAdoptionRate: number | null
  adoptionRate: number | null
}
export interface RunAnalysisMetrics {
  traceCount: number
  conversationCount: number
  noSkillConversationCount: number
  completedNodeConversationCount: number | null
  unattributedSkillConversationCount: number | null
  firstExecutedAt: string | null
  lastExecutedAt: string | null
  lastEndedAt: string | null
  executionSpanMs: number | null
  totalDurationMs: number | null
  toolCalls: number | null
  modelCalls: number | null
  toolReportedTraceCount: number
  modelReportedTraceCount: number
  subagentCount: number
  subagentTurns: number
  subagentIdentifiedTraceCount: number
  subagentClassifiedTraceCount: number
  subagentKinds: Record<string, number>
  executedInRange: boolean
}
export interface RunAnalysisFeature extends RunAnalysisMetrics {
  projectId: string
  projectName: string
  /** Project metadata code (the enterprise project code when linked); absent in legacy snapshots. */
  projectCode: string | null
  /** Current enterprise/Lean association; null means the snapshot did not report it. */
  projectFromLean: boolean | null
  systemName: string | null
  adapterName: string | null
  adapterVersion: string | null
  creator: string | null
  room: string | null
  projectCreatedAt: string | null
  lifecycleStatus: string | null
  snapshotAt: string | null
  projectSubagentCount: number
  snapshotFeatureCount: number
  featureSlug: string | null
  featureTitle: string
  currentStage: string | null
  currentStatus: string | null
  featureStatus: string | null
  inSnapshot: boolean
  codeStats: RunAnalysisCodeStats | null
  harnessAdoptedLines: number
  vibeAdoptedLines: number
  vibeAdoptedShare: number | null
}
export interface RunAnalysisData {
  /** Workflow stage names in plugin order, when reported by the project snapshot. */
  workflowStageNamesByProject?: Record<string, string[]>
  rows: RunAnalysisFeature[]
  projectCount: number
  featureCount: number
  range: RunAnalysisRange
  membership: RunAnalysisMembership
  dataAsOf: string
  queryStartedAt: string
}
export interface RunAnalysisStage extends RunAnalysisMetrics {
  nodeName: string | null
  attributedDurationMs?: number | null
  attributedToolCalls?: number | null
  attributedModelCalls?: number | null
}
export const runAnalysisKey = (project: string, feature: string | null): string =>
  JSON.stringify([project, feature])
export type RunAnalysisFeatureTarget = Pick<RunAnalysisFeature, "projectId" | "featureSlug">
export interface RunAnalysisStageExportRequest {
  asOf: string
  targets: Pick<RunAnalysisFeature, "projectId" | "featureSlug" | "adapterName">[]
}
export interface StageTurnCounts {
  conversationCount: number
  completedNode: number
  unattributedSkill: number
  nodeStatusReported: number
  skillAttributionReported: number
}
export const emptyStageTurnCounts = (): StageTurnCounts => ({
  conversationCount: 0,
  completedNode: 0,
  unattributedSkill: 0,
  nodeStatusReported: 0,
  skillAttributionReported: 0
})
export function addStageTurnCounts(total: StageTurnCounts, row: StageTurnCounts): void {
  total.conversationCount += row.conversationCount
  total.completedNode += row.completedNode
  total.unattributedSkill += row.unattributedSkill
  total.nodeStatusReported += row.nodeStatusReported
  total.skillAttributionReported += row.skillAttributionReported
}
export interface RunAnalysisPluginStages {
  adapterName: string | null
  stages: (RunAnalysisFeatureTarget & StageTurnCounts & { nodeName: string | null })[]
}
export interface RunAnalysisStages {
  rows: RunAnalysisStage[]
  dataAsOf: string
}
export interface RunAnalysisSession {
  traceId: string
  threadId: string | null
  startedAt: string | null
  endedAt: string | null
  durationMs: number | null
  nodeName: string | null
  userName: string | null
  usedSkills: string[]
}
export interface RunAnalysisSessionRequest extends RunAnalysisOptions {
  projectId: string
  featureSlug: string | null
  nodeName?: string | null
  metric?: "all" | "main" | "noSkill" | "completedNode" | "unattributedSkill" | "subagent"
  after?: unknown[] | null
}
export interface RunAnalysisSessions {
  rows: RunAnalysisSession[]
  total: number
  after: unknown[] | null
}
export const RUN_ANALYSIS_NOTES = {
  scope:
    "日期仅用于确定名单；指标均为项目/特性累计数据。默认所选日期内有执行（含归档）；全部项目含已归档项目，不受日期限制。名单范围不受顶部“仅本期新建”影响。",
  span: "执行跨度=已上报记录最早执行开始至最晚执行结束，不代表业务完成或阶段停留时长；缺少边界时显示 —。累计执行耗时仅累加主动触发的主 Agent 轮次，避免父子重复。",
  skill:
    "统计本轮未记录 Skill 的主动触发主 Agent 对话。仅沿用同一会话先前 Skill 的轮次也计入。历史记录缺少 Skill 字段时同样计入，阶段按轮次开始时的节点归属。",
  completedNode: "主 Agent 轮次开始时，当前节点已经完成。按已上报节点状态累计次数。",
  unattributedSkill:
    "主 Agent 轮次没有代码 Skill 归因时计一次，含纯对话。沿用同一会话活跃 Skill 的轮次已有归因。仅统计已上报归因结果的轮次。",
  cost: "工具/模型调用为已上报记录的累计次数，包含主、子 Agent 的调用。历史漏报可能导致统计不完整；没有记录时显示 —。",
  adoption:
    "提交采纳率（Commit）=提交采纳行数/全量有效生成行数；入库采纳率（Push）=已Push采纳行数/全量有效生成行数。全量有效生成包含已测量有效生成及尚未测量的生成代码。项目汇总先合并分子分母。Vibe采纳占比=Vibe采纳/(Harness采纳+Vibe采纳)，未归因不入分母。无代码样本显示 —。",
  stages:
    "阶段主对话/未用Skill按开始阶段归属；阶段耗时与调用为已上报值，历史缺失可能低估，覆盖度见主表；阶段耗时和调用沿用现有新旧阶段归属口径，一轮可能访问多个阶段。近似跨度按轮次开始阶段的已上报记录边界计算，不代表停留时长。"
} as const
