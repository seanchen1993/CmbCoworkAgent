/** Runtime analysis uses existing telemetry only; dates select membership, metrics are lifetime. */
export type RunAnalysisRange = { from: string; to: string }
export type RunAnalysisMembership = "active" | "executed" | "created"
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
  metric?: "all" | "main" | "noSkill" | "subagent"
  after?: unknown[] | null
}
export interface RunAnalysisSessions {
  rows: RunAnalysisSession[]
  total: number
  after: unknown[] | null
}
export const RUN_ANALYSIS_NOTES = {
  scope:
    "日期仅用于确定名单；指标均为项目/特性累计数据。默认进行中的全部项目，不受顶部“仅本期新建”影响。",
  span: "执行跨度=已上报记录最早执行开始至最晚执行结束，不代表业务完成或阶段停留时长；缺少边界时显示 —。累计执行耗时仅累加主动触发的主 Agent 轮次，避免父子重复。",
  skill:
    "未使用 Skill 的主 Agent 对话=主动触发主 Agent 轮次且未记录有效技能（继承技能算使用）。空值及历史缺失按未使用统计，历史漏采可能使结果偏高；阶段按轮次开始阶段归属。",
  cost: "工具/模型调用包含主子 Agent 实际开销；缺字段的历史记录未被补零，括号显示字段覆盖。子代理按稳定会话标识精确去重，轮次及类型按已识别为子代理的记录计数（含缺少稳定会话标识的记录）；缺少标识的历史记录无法还原数量，已识别数量为下限。",
  adoption:
    "采纳率沿用现有看板的全量有效生成口径；项目汇总先合并分子分母。Vibe采纳占比=Vibe采纳/(Harness采纳+Vibe采纳)，未归因不入分母。无代码样本显示 —。",
  stages:
    "阶段主对话/未用Skill按开始阶段归属；阶段耗时与调用为已上报值，历史缺失可能低估，覆盖度见主表；阶段耗时和调用沿用现有新旧阶段归属口径，一轮可能访问多个阶段。近似跨度按轮次开始阶段的已上报记录边界计算，不代表停留时长。"
} as const
