import type {
  Thread,
  ModelConfig,
  Provider,
  StreamEvent,
  HITLDecision,
  SkillMetadata,
  McpConnectorConfig,
  McpConnectorUpsert,
  ScheduledTask,
  ScheduledTaskUpsert,
  HeartbeatConfig,
  LspConfig,
  LspDiagnostic,
  LspLocation,
  LspHoverResult,
  LspSymbol,
  LspCallHierarchyItem,
  LspCallHierarchyIncomingCall,
  LspCallHierarchyOutgoingCall,
  LspStatus,
  ChatXConfig,
  HookLoggingConfig,
  PluginHookMetadata,
  PluginDetail,
  PluginMetadata,
  SkillHookMetadata,
  AgentAutoCommitSettings,
  AgentAutoCommitWorkspaceCard,
  UserInputRequest,
  UserInputResponse,
  ConfigurePreferredIdeRequest,
  ConfigurePreferredIdeResult,
  IdeSettings,
  OpenIdeRequest,
  PreferredIde
} from "../main/types"
import { UserInfoConfig } from "../main/storage"
import type { HookConfig, HookUpsert } from "../main/hooks/types"
import type {
  ManagedSavedCodeExecTool,
  SavedCodeExecPreviewPayload,
  SavedCodeExecPreviewResult,
  SavedCodeExecRewritePayload,
  SavedCodeExecRewriteResult,
  SavedCodeExecToolUpdatePayload
} from "../main/ipc/code-exec-tools"
import type { CoordinatorWorkerSnapshot } from "../main/agent/coordinator-worker-manager"
import type {
  HarnessEnterpriseProjectDetailInput,
  HarnessEnterpriseProjectDetailResult,
  HarnessEnterpriseProjectSearchInput,
  HarnessEnterpriseProjectSearchResult,
  HarnessProjectCreateInput,
  HarnessFeatureCreateInput,
  HarnessFeatureCreateResult,
  HarnessProjectDetailViewModel,
  HarnessProjectListItem,
  HarnessProjectMetadata,
  HarnessProjectMetadataUpdateInput,
  HarnessRunDetailViewModel,
  HarnessSkipNodeInput,
  HarnessSkipNodeResult,
  HarnessAdapterRegistryItem,
  HarnessDynamicWorkflowConfig,
  HarnessWatchRefChangedEvent
} from "../shared/harness-board-types"
import type {
  FeatureGateCheckOptions,
  FeatureGateCheckResult,
  FeatureGateKey
} from "../shared/feature-gates"
import type {
  TaskMmdCompileModelInfo,
  TaskMmdSettings,
  TaskMmdSnapshot
} from "../main/agent/task-mmd/types"
import type { GitCommitHistoryRecord } from "../shared/git-commit-history"
import type { TaskCardsListResult, TaskCardsQuery } from "../shared/task-card-types"

interface ElectronAPI {
  openExternal: (url: string) => Promise<void>
  openLoginWindow: () => void
  closeLoginWindow: () => void
  openLoginPage: () => void
  closeLoginPage: () => void
  onNotifyMsg: (callback: (msg: string) => void) => void
  ipcRenderer: {
    send: (channel: string, ...args: unknown[]) => void
    on: (channel: string, listener: (...args: unknown[]) => void) => () => void
    once: (channel: string, listener: (...args: unknown[]) => void) => void
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  }
  process: {
    platform: NodeJS.Platform
    versions: NodeJS.ProcessVersions
  }
}

interface PetManifest {
  // 宠物资源清单，来自 pets/<directoryId>/pet.json。
  id: string
  directoryId: string
  source: "builtin" | "custom"
  key: string
  canDelete: boolean
  name?: string
  displayName?: string
  description?: string
  spritesheetPath: string
  frameWidth?: number
  frameHeight?: number
  columns?: number
  rows?: number
  states?: Record<string, { y: number; frames: number; fps?: number }>
}

interface PetSettings {
  enabled: boolean
  selectedPetKey: string | null
}

type PetState =
  // 与主进程 PetState 保持一致，renderer 只能通过 preload 发送这些状态。
  | "idle"
  | "busy"
  | "waiting"
  | "done"
  | "error"
  | "crying"
  | "prompt"
  | "running"
  | "interaction"
  | "hover"

interface DashboardTraceNode {
  id: string
  type: "trace" | "llm" | "tool" | "tool_result" | "message" | "error" | "cancel"
  parentId: string | null
  name?: string
  status?: "running" | "success" | "error" | "cancelled" | "unknown"
  startedAt: string
  endedAt?: string
  input?: unknown
  output?: unknown
  metadata?: Record<string, unknown>
}

interface DashboardTraceDetail {
  traceId: string
  threadId: string
  startedAt: string
  endedAt?: string
  durationMs: number
  userMessage: string
  sapId?: string
  ystId?: string
  userName?: string
  orgName?: string
  userIp?: string
  modelId?: string
  modelName?: string
  outcome: string
  totalToolCalls: number
  modelCallCount: number
  userInputRequestCount: number
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  appVersion?: string
  usedSkills: string[]
  evolvedSkills: string[]
  triggerSource?: string
  nodes?: DashboardTraceNode[]
  rawAvailable: boolean
  rawError?: string
}

type DashboardTraceViewMode = "thread" | "trace"
type DashboardTraceTriggerScope = "active" | "all"

interface DashboardCommitDetail {
  eventId: string
  eventTime: string
  userName: string
  sapId?: string
  ystId?: string
  orgName?: string
  upperOrgLv0?: string
  upperOrgLv1?: string
  userIp?: string
  repoPath?: string
  repositoryName?: string
  repositoryFullName?: string
  repositoryWebUrl?: string
  commitSha?: string
  commitUrl?: string
  pushed: boolean
  pushedAt?: string
  branch?: string
  filesChanged: number
  insertions: number
  deletions: number
  triggeredBy?: string
  threadId?: string
  threadIds: string[]
  usedSkills: string[]
  skillCount: number
  codeGeneratedLines: number
  codeEffectiveGeneratedLines: number
  codeAdoptedLines: number
  codeAdoptionRate: number | null
}

interface DashboardCommitDetailsOptions {
  page?: number
  pageSize?: number
  pushedOnly?: boolean
  upperOrgLv1?: string | null
  userKeyword?: string | null
  orgLv1List?: string[]
}

interface DashboardNonGitAdoptionReportsOptions {
  page?: number
  pageSize?: number
  upperOrgLv1?: string | null
  userKeyword?: string | null
  orgLv1List?: string[]
  projectMode?: boolean
  projectId?: string | null
  featureSlug?: string | null
  usedSkillsOnly?: boolean
}

interface DashboardNonGitAdoptionReportItem {
  eventId: string
  eventTime: string
  generatedAt: string
  pushedAt?: string
  measuredAt?: string
  userName: string
  sapId?: string
  ystId?: string
  orgName?: string
  upperOrgLv0?: string
  upperOrgLv1?: string
  userIp?: string
  source?: string
  harnessProjectId?: string
  harnessFeatureSlug?: string
  harnessAdapterName?: string
  harnessAdapterVersion?: string
  genEventId?: string
  threadId?: string
  threadIds: string[]
  fileHint?: string
  tool?: string
  language?: string
  modelName?: string
  measureSource?: string
  verdict?: string
  pushed: boolean
  usedSkills: string[]
  generatedLineCount: number
  effectiveGeneratedLineCount: number
  adoptedLineCount: number
  adoptionRate: number | null
}

interface DashboardNonGitAdoptionReportsData {
  total: number
  page: number
  pageSize: number
  items: DashboardNonGitAdoptionReportItem[]
}

interface DashboardCommitAdoptionPair {
  genEventId: string
  file: string | null
  tool: string | null
  language: string | null
  usedSkills: string[]
  modelName: string | null
  generatedAt: string | null
  verdict: string | null
  reason: string | null
  generatedLineCount: number | null
  effectiveGeneratedLineCount: number | null
  adoptedLineCount: number | null
  measureSource: string | null
  pushed: boolean
  measuredAt: string | null
  threadId: string | null
}

interface DashboardCommitAdoptionEvents {
  commitSha: string
  pairs: DashboardCommitAdoptionPair[]
  reconciliation: {
    sumEffective: number
    sumAdopted: number
    rate: number | null
  }
}

interface LocalAdoptionLine {
  lineNumber: number
  text: string
  adopted: boolean
}

interface LocalGenAdoptionLines {
  genEventId: string
  available: boolean
  reason?: string
  relPath?: string
  generatedLineCount?: number
  matchedLineCount?: number
  truncated?: boolean
  lines?: LocalAdoptionLine[]
}

interface DashboardSkillEvalOptions {
  limit?: number
  recentPage?: number
  recentPageSize?: number
  skillPage?: number
  skillPageSize?: number
  skillSearch?: string
  skillName?: string
  skillVersion?: string
  skillNames?: string[]
  upperOrgLv1?: string | string[] | null
  defaultRecentToLatestSkill?: boolean
  recentOnly?: boolean
  listOnly?: boolean
  statsOnly?: boolean
}

interface DashboardCodeStats {
  generatedLines: number
  deletedLines: number
  effectiveGeneratedLines: number
  measuredGeneratedLines: number
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

interface DashboardSkillDetail {
  stats: DashboardCodeStats
  traces: DashboardTraceDetail[]
  tracePage: number
  tracePageSize: number
  totalTraces: number
  traceViewMode?: DashboardTraceViewMode
  traceTriggerScope?: DashboardTraceTriggerScope
}

interface DashboardUserListItem {
  sapId: string
  ystId?: string
  userName: string
  orgName?: string
  upperOrgLv0?: string
  upperOrgLv1?: string
  count: number
  lastActiveAt?: string
  avgDurationMs: number
  totalToolCalls: number
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
}

interface DashboardUserListData {
  items: DashboardUserListItem[]
  pageSize: number
  nextAfterKey?: Record<string, string | number>
  totalActiveUsers: number
}

interface DashboardUncommittedRankingItem {
  sapId: string
  ystId?: string
  userName: string
  orgName?: string
  upperOrgLv0?: string
  upperOrgLv1?: string
  generatedLines: number
  measuredGeneratedLines: number
  uncommittedLines: number
  uncommittedRate: number | null
}

interface DashboardUncommittedRankingData {
  items: DashboardUncommittedRankingItem[]
  totalGeneratedLines: number
  totalMeasuredGeneratedLines: number
  totalUncommittedLines: number
  limit: number
}

interface DashboardUncommittedDetailBreakdown {
  key: string
  gens: number
  lines: number
}

interface DashboardUncommittedDetailSample {
  eventId: string
  eventTime: string
  tool?: string
  language?: string
  lineCount: number
  fileHint?: string
  threadId?: string
  harnessProjectId?: string
  harnessFeatureSlug?: string
  modelName?: string
}

interface DashboardUncommittedDetailData {
  sapId: string
  userName: string
  scannedGens: number
  scanCapped: boolean
  uncommittedGens: number
  uncommittedLines: number
  byTool: DashboardUncommittedDetailBreakdown[]
  byLanguage: DashboardUncommittedDetailBreakdown[]
  byProject: DashboardUncommittedDetailBreakdown[]
  byThread: DashboardUncommittedDetailBreakdown[]
  samples: DashboardUncommittedDetailSample[]
}

interface DashboardUserDetail {
  sapId: string
  ystId?: string
  userName: string
  orgName?: string
  upperOrgLv0?: string
  upperOrgLv1?: string
  totalCalls: number
  avgDurationMs: number
  totalToolCalls: number
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  bySkill: Array<{ skill: string; count: number }>
  byModel: Array<{ model: string; count: number }>
  byOutcome: Array<{ outcome: string; count: number }>
  traces: DashboardTraceDetail[]
  tracePage: number
  tracePageSize: number
  /** 当前视图模式下的翻页总数：thread → 会话数；trace → trace 总数。 */
  total: number
  traceViewMode?: DashboardTraceViewMode
  traceTriggerScope?: DashboardTraceTriggerScope
}

interface DashboardUserListOptions {
  pageSize?: number
  afterKey?: Record<string, string | number> | null
  keyword?: string | null
  upperOrgLv1?: string | null
}

interface DashboardAllUserItem {
  sapId: string
  userName: string
  orgName: string
  upperOrgLv0?: string
  upperOrgLv1?: string
}

interface DashboardUserDetailOptions {
  traceLimit?: number
  tracePage?: number
  tracePageSize?: number
  mode?: DashboardTraceViewMode
  viewMode?: DashboardTraceViewMode
  triggerScope?: DashboardTraceTriggerScope
  projectMode?: boolean
}

interface DashboardProjectModeFeature {
  slug: string
  title: string
  location?: string
  statusLabel?: string
  currentNodeStatusLabel?: string
  summary?: string
}

interface DashboardProjectModeSkillCount {
  skill: string
  count: number
  isPlugin?: boolean
  pluginName?: string
}

interface DashboardProjectModeSkillAdoption extends DashboardCodeStats {
  skill: string
  isPlugin?: boolean
  pluginName?: string
  commitCount: number
}

interface DashboardProjectModeToolUsage {
  byTool: Array<{ tool: string; count: number }>
  byToolAll: Array<{ tool: string; count: number }>
  byToolFilteredAll: Array<{ tool: string; count: number }>
  byToolAllFull: Array<{ tool: string; count: number }>
  totalTools: number
  totalToolCalls: number
}

interface DashboardProjectModeTopUser {
  sapId: string
  ystId?: string
  userName: string
  orgName: string
  count: number
}

interface DashboardProjectModeOrgDistributionItem {
  key: string
  org: string
  count: number
  children: DashboardProjectModeOrgDistributionItem[]
}

interface DashboardProjectModeAdapterShareItem {
  name: string
  count: number
}

interface DashboardProjectModeAnalytics {
  topUsers: DashboardProjectModeTopUser[]
  byOrg: DashboardProjectModeOrgDistributionItem[]
  byAdapter: DashboardProjectModeAdapterShareItem[]
}

interface DashboardProjectModeProject {
  projectId: string
  name: string
  description?: string
  systemName?: string
  workspacePath?: string
  adapterName?: string
  adapterVersion?: string
  creatorSapId?: string
  creatorYstId?: string
  creatorUserName?: string
  creatorOrgName?: string
  creatorUpperOrgLv0?: string
  creatorUpperOrgLv1?: string
  lifecycleStatus?: string
  lifecycleCreatedAt?: string
  compatible?: boolean
  compatibilityStatus?: string
  featureCount: number
  conversationCount: number
  hasError: boolean
  features: DashboardProjectModeFeature[]
  topSkills: DashboardProjectModeSkillCount[]
  codeStats: DashboardCodeStats | null
  stageBuckets: DashboardStageBuckets
}

type DashboardProjectModeProjectStatus = "active" | "archived"

interface DashboardProjectModeProjectCounts {
  total: number
  active: number
  archived: number
  totalFeatureCount: number
  activeFeatureCount: number
  archivedFeatureCount: number
}

type DashboardProjectModeProjectSortKey =
  | "featureCount"
  | "createdAt"
  | "conversationCount"
  | "generatedLines"
  | "archivedAt"
type DashboardProjectModeProjectSortOrder = "asc" | "desc"

interface DashboardProjectModeProjectPageData {
  projects: DashboardProjectModeProject[]
  total: number
  page: number
  pageSize: number
  status: DashboardProjectModeProjectStatus
  keyword: string
  adapterName: string
  creatorKeyword: string
  creatorOrgKeyword: string
  sortBy: DashboardProjectModeProjectSortKey | null
  sortOrder: DashboardProjectModeProjectSortOrder
  /**
   * True when more projects matched than the metric-sort enumeration cap, so the
   * ranking + total only cover the first N projects and the UI should warn that
   * the list / metrics are incomplete. Always false on the snapshot-paginated path.
   */
  truncated: boolean
}

interface DashboardProjectModeProjectPageOptions {
  upperOrgLv1?: string | string[] | null
  fromLeanOnly?: boolean | null
  status?: DashboardProjectModeProjectStatus | null
  page?: number
  pageSize?: number
  keyword?: string | null
  adapterName?: string | null
  /** 配合 adapterName 精确到插件版本（「按版本」口径点击项目数）；空 = 不限版本。 */
  adapterVersion?: string | null
  creatorKeyword?: string | null
  creatorOrgKeyword?: string | null
  sortBy?: DashboardProjectModeProjectSortKey | null
  sortOrder?: DashboardProjectModeProjectSortOrder | null
}

interface DashboardStageBucketStat {
  conversationCount: number
  codeStats: DashboardCodeStats | null
}

interface DashboardStageBuckets {
  pluginConstrained: DashboardStageBucketStat
  vibecoding: DashboardStageBucketStat
  unattributed: DashboardStageBucketStat
}

interface DashboardProjectModeAdapter {
  name: string
  version?: string
  projectCount: number
  featureCount: number
  conversationCount: number
  codeStats: DashboardCodeStats | null
  stageBuckets: DashboardStageBuckets
}

interface DashboardProjectModeData {
  summary: {
    projectCount: number
    featureCount: number
    activeProjectCount: number
    conversationCount: number
    totalToolCalls: number
    totalInputTokens: number
    totalOutputTokens: number
    totalTokens: number
    skillCallCount: number
    distinctSkillCount: number
    codeStats: DashboardCodeStats | null
    skillCodeStats?: DashboardCodeStats | null
  }
  adapters: DashboardProjectModeAdapter[]
  topSkills: DashboardProjectModeSkillCount[]
  bySkillAdoption: DashboardProjectModeSkillAdoption[]
  tools: DashboardProjectModeToolUsage
  analytics: DashboardProjectModeAnalytics
  projectCounts: DashboardProjectModeProjectCounts
  projectPage: DashboardProjectModeProjectPageData
  projects: DashboardProjectModeProject[]
  /**
   * 「仅精益项目」开关下精益项目 id 集被截断、遥测汇总可能不完整。开关关闭时恒为 false。
   */
  leanTruncated: boolean
  /** 当前范围内出现过的外部上报来源（properties.source 去重值）；供生产效能代码指标 source 下拉。 */
  availableSources?: string[]
}

interface DashboardProjectModeTracesOptions {
  limit?: number
  page?: number
  pageSize?: number
  tracePage?: number
  tracePageSize?: number
  mode?: DashboardTraceViewMode
  viewMode?: DashboardTraceViewMode
  triggerScope?: DashboardTraceTriggerScope
  featureSlug?: string
  nodeName?: string
  nodeStatus?: string
  /** stage×skill 桶过滤（插件约束（Harness）/ VibeCoding / 未归因），用于按桶查看对话。 */
  stageBucket?: "plugin_constrained" | "vibecoding" | "unattributed"
}

interface DashboardProjectModeTracesData {
  traces: DashboardTraceDetail[]
  tracePage: number
  tracePageSize: number
  /** 当前视图模式下的翻页总数：thread → 会话数；trace → trace 总数。 */
  total: number
  traceViewMode: DashboardTraceViewMode
  traceTriggerScope: DashboardTraceTriggerScope
}

interface DashboardProjectModeNodeStatus {
  status: string
  conversationCount: number
  codeStats: DashboardCodeStats | null
}

interface DashboardProjectModeFeatureNode {
  nodeName: string
  conversationCount: number
  codeStats: DashboardCodeStats | null
  byStatus: DashboardProjectModeNodeStatus[]
  /** Stage×skill 三桶拆分（插件约束（Harness）/ VibeCoding / 未归因）。 */
  stageBuckets: DashboardStageBuckets
}

interface DashboardPluginAggregate {
  adapterName: string
  conversationCount: number
  projectCount: number
  codeStats: DashboardCodeStats | null
  byNode: DashboardProjectModeFeatureNode[]
}

interface CustomAPI {
  agent: {
    invoke: (
      threadId: string,
      message: string,
      onEvent: (event: StreamEvent) => void,
      modelId?: string,
      agentMode?: "normal" | "coordinator" | "workflow",
      coordinatorInternalNotification?: boolean,
      userMessageId?: string
    ) => () => void
    streamAgent: (
      threadId: string,
      message: string,
      command: unknown,
      onEvent: (event: StreamEvent) => void,
      modelId?: string,
      agentMode?: "normal" | "coordinator" | "workflow",
      coordinatorInternalNotification?: boolean,
      userMessageId?: string
    ) => () => void
    interrupt: (
      threadId: string,
      decision: HITLDecision,
      onEvent?: (event: StreamEvent) => void
    ) => () => void
    goalControl: (
      threadId: string,
      message: string
    ) => Promise<{
      handled: boolean
      terminatedCurrentRun: boolean
      notice?: {
        message: string
        goalId: string | null
        activeWindowId: string | null
        eventId: number | null
        createdAt: number
      }
    }>
    cancel: (threadId: string, options?: { cancelWorkers?: boolean }) => Promise<void>
    getCoordinatorWorkers: (
      threadId: string,
      options?: { subscribeUpdates?: boolean }
    ) => Promise<CoordinatorWorkerSnapshot[]>
    unbindCoordinatorWorkers: (threadId: string) => Promise<void>
    hasCoordinatorWorkerNotifications: (threadId: string) => Promise<boolean>
    onCoordinatorWorkerStream: (
      threadId: string,
      callback: (event: {
        type: "stream"
        mode: "messages" | "values"
        data: unknown
        workerTurn?: number
      }) => void
    ) => () => void
    onCoordinatorWorkerHook: (threadId: string, callback: (envelope: unknown) => void) => () => void
    setCoordinatorWorkerStreamFocus: (
      threadId: string,
      workerThreadId: string | null,
      options?: {
        expectedWorkerThreadId?: string | null
        focusToken?: string | null
        expectedFocusToken?: string | null
      }
    ) => Promise<void>
    isCoordinatorModeForced: () => Promise<boolean>
  }
  workflows: {
    listRuns: (threadId: string) => Promise<unknown[]>
    getRun: (threadId: string, runId: string) => Promise<unknown | null>
    cancelRun: (threadId: string, runId?: string) => Promise<boolean>
    /** Register/deregister per-agent "viewing interest" (the focus panel is showing this
     * running agent) so the display-only live tap only serializes/broadcasts that agent. */
    setAgentStreamInterest: (
      threadId: string,
      runId: string,
      agentIndex: number,
      interested: boolean
    ) => Promise<boolean>
    /** Lazily read one FINISHED subagent's persisted complete tool flow on demand; null
     * when there is no sidecar (cached/instant agent, pruned run, or pre-feature run). */
    getAgentToolStream: (
      threadId: string,
      runId: string,
      agentIndex: number
    ) => Promise<unknown[] | null>
    hydrate: (threadId: string) => Promise<unknown>
    /** Durable per-thread channel; survives past the launching turn. Returns unsubscribe. */
    onWorkflowEvents: (threadId: string, callback: (payload: unknown) => void) => () => void
    /** Display-only live subagent tool-stream (keyed by parent threadId; payload carries
     * runId+agentIndex). Best-effort, not persisted. Returns unsubscribe. */
    onWorkflowAgentStream: (threadId: string, callback: (payload: unknown) => void) => () => void
  }
  threads: {
    list: () => Promise<Thread[]>
    get: (threadId: string) => Promise<Thread | null>
    create: (metadata?: Record<string, unknown>) => Promise<Thread>
    update: (threadId: string, updates: Partial<Thread>) => Promise<Thread>
    mergeThreadValues: (threadId: string, patch: Record<string, unknown>) => Promise<Thread>
    delete: (threadId: string) => Promise<void>
    exportSession: (
      threadId: string
    ) => Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }>
    getHistory: (threadId: string) => Promise<unknown[]>
    getLatestCheckpoint: (threadId: string) => Promise<unknown | null>
    getGoalEvents: (
      threadId: string,
      options?: { restore?: boolean; limit?: number }
    ) => Promise<
      Array<{
        event_id: number
        thread_id: string
        goal_id: string | null
        active_window_id: string | null
        message: string
        created_at: Date | string | number
      }>
    >
    getGoalState: (
      threadId: string,
      options?: { includeEvents?: boolean }
    ) => Promise<{
      goal: {
        threadId: string
        goalId: string
        activeWindowId: string
        objective: string
        completionCondition: string
        context: {
          explicitSkill?: { name: string; path: string }
          transportSummary?: string
        }
        status: "active" | "paused" | "complete"
        turnsUsed: number
        maxTurns: number
        lastVerdict: string | null
        lastReason: string | null
        pausedReason: string | null
        consecutiveParseFailures: number
        ledger: {
          progress: string[]
          evidence: string[]
          blockers: string[]
        }
        createdAt: number
        updatedAt: number
      } | null
      events: Array<{
        event_id: number
        thread_id: string
        goal_id: string | null
        active_window_id: string | null
        message: string
        created_at: Date | string | number
      }>
    }>
    generateTitle: (message: string) => Promise<string>
    onThreadsChanged: (callback: () => void) => () => void
  }
  models: {
    list: () => Promise<ModelConfig[]>
    listProviders: () => Promise<Provider[]>
    getDefault: () => Promise<string>
    setDefault: (modelId: string) => Promise<void>
    getGoalSettings: () => Promise<{ evaluatorModelId?: string }>
    setGoalSettings: (settings: { evaluatorModelId?: string }) => Promise<void>
    getTokenLimits: () => Promise<{
      defaultMaxTokens: number
      minMaxTokens: number
      maxMaxTokens: number
      defaultMaxOutputTokens: number
      minMaxOutputTokens: number
      maxMaxOutputTokens: number
      defaultTemperature: number
      maxTemperature: number
      defaultTopP: number
      maxTopP: number
      defaultTopK: number
      minTopK: number
      maxTopK: number
    }>
    getCustomConfigs: () => Promise<
      Array<{
        id: string
        name: string
        baseUrl: string
        model: string
        hasApiKey: boolean
        maxTokens: number
        maxOutputTokens: number
        temperature: number
        topP: number
        topK: number
        interleavedThinking?: boolean
        enableThinking?: boolean
        enableThinkingEffort?: boolean
        thinkingEffort?: "high" | "max"
        tier?: "premium" | "economy"
      }>
    >
    getCustomConfig: (id?: string) => Promise<{
      id: string
      name: string
      baseUrl: string
      model: string
      hasApiKey: boolean
      maxTokens: number
      maxOutputTokens: number
      temperature: number
      topP: number
      topK: number
      interleavedThinking?: boolean
      enableThinking?: boolean
      enableThinkingEffort?: boolean
      thinkingEffort?: "high" | "max"
      tier?: "premium" | "economy"
    } | null>
    setCustomConfig: (config: {
      id: string
      name: string
      baseUrl: string
      model: string
      apiKey?: string
      maxTokens?: number
      maxOutputTokens?: number
      temperature?: number
      topP?: number
      topK?: number
      interleavedThinking?: boolean
      enableThinking?: boolean
      enableThinkingEffort?: boolean
      thinkingEffort?: "high" | "max"
      tier?: "premium" | "economy"
    }) => Promise<void>
    // Backward-compatible alias, prefer upsertCustomConfig in new code.
    upsertCustomConfig: (config: {
      id?: string
      name: string
      baseUrl: string
      model: string
      apiKey?: string
      maxTokens?: number
      maxOutputTokens?: number
      temperature?: number
      topP?: number
      topK?: number
      interleavedThinking?: boolean
      enableThinking?: boolean
      enableThinkingEffort?: boolean
      thinkingEffort?: "high" | "max"
      tier?: "premium" | "economy"
    }) => Promise<{ id: string }>
    upsertUserInfo: (config: UserInfoConfig) => Promise<{ id: string }>
    getUserInfo: () => Promise<UserInfoConfig | null>
    deleteCustomConfig: (id: string) => Promise<void>
    testConnection: (params: {
      id?: string
      baseUrl?: string
      model?: string
      apiKey?: string
      maxOutputTokens?: number
      temperature?: number
      topP?: number
      topK?: number
      enableThinking?: boolean
      enableThinkingEffort?: boolean
      thinkingEffort?: "high" | "max"
    }) => Promise<{ success: boolean; error?: string; latencyMs?: number }>
  }
  ide: {
    getPreferred: () => Promise<PreferredIde>
    getSettings: () => Promise<IdeSettings>
    setPreferred: (preferredIde: PreferredIde) => Promise<PreferredIde>
    configurePreferred: (
      request: ConfigurePreferredIdeRequest
    ) => Promise<ConfigurePreferredIdeResult>
    open: (request: OpenIdeRequest) => Promise<{
      editor: string
      mode: "workspace+file+line" | "workspace+file" | "workspace"
    }>
  }
  workspace: {
    get: (threadId?: string) => Promise<string | null>
    set: (threadId: string | undefined, path: string | null) => Promise<string | null>
    select: (threadId?: string) => Promise<string | null>
    loadFromDisk: (threadId: string) => Promise<{
      success: boolean
      files: Array<{
        path: string
        is_dir: boolean
        size?: number
        modified_at?: string
      }>
      workspacePath?: string
      error?: string
    }>
    ensureWatching: (threadId: string) => Promise<{ success: boolean; restarted?: boolean }>
    setActiveThread: (threadId: string | null) => Promise<{ success: boolean; restarted?: boolean }>
    readFile: (
      threadId: string,
      filePath: string
    ) => Promise<{
      success: boolean
      content?: string
      size?: number
      modified_at?: string
      error?: string
    }>
    readBinaryFile: (
      threadId: string,
      filePath: string
    ) => Promise<{
      success: boolean
      content?: string
      size?: number
      modified_at?: string
      error?: string
    }>
    readExternalFile: (filePath: string) => Promise<{
      success: boolean
      content?: string
      size?: number
      modified_at?: string
      error?: string
    }>
    readExternalBinaryFile: (filePath: string) => Promise<{
      success: boolean
      content?: string
      size?: number
      modified_at?: string
      error?: string
    }>
    clearWorktreeContext: (threadId: string) => Promise<void>
    saveWorktreeContext: (
      threadId: string,
      gitRoot: string,
      branch: string,
      baseBranch?: string,
      baseCommit?: string
    ) => Promise<void>
    recordLlmModifiedFiles: (
      threadId: string,
      files: string[]
    ) => Promise<{
      success: boolean
      files?: string[]
      error?: string
    }>
    getGitPanelState: (threadId: string) => Promise<{
      success: boolean
      isWorktree: boolean
      isGitRepo?: boolean
      taskId: string
      repositories?: Array<{ path: string; displayPath: string; gitRoot: string }>
      files: Array<{
        path: string
        previousPath?: string
        status?: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked"
        diff: string
        diffLoaded?: boolean
        additions: number
        deletions: number
      }>
      changedFiles?: string[]
      changedFilesTotal?: number
      omittedFileCount?: number
      totals: { additions: number; deletions: number; fileCount: number }
      hasPendingDiff: boolean
      hasPushableCommit: boolean
      pendingCommits?: Array<{ hash: string; message: string; date: string }>
      trackedFiles?: string[]
      worktreeBranch?: string | null
      suggestedCommitMessage?: string
      error?: string
    }>
    getGitPanelMeta: (threadId: string, options?: { worktreePath?: string }) => Promise<{
      success: boolean
      isWorktree: boolean
      isGitRepo?: boolean
      taskId: string
      changedFilesTotal?: number
      hasPendingDiff: boolean
      hasPushableCommit: boolean
      pendingCommits?: Array<{ hash: string; message: string; date: string }>
      trackedFiles?: string[]
      worktreeBranch?: string | null
      error?: string
    }>
    getGitPanelDiffs: (
      threadId: string,
      options?: {
        includeDiffs?: boolean
        includeChangedFiles?: boolean
        statusUntrackedMode?: "all" | "normal" | "no"
        visibleFileLimit?: number
        worktreePath?: string
      }
    ) => Promise<{
      success: boolean
      isWorktree: boolean
      isGitRepo?: boolean
      taskId: string
      files: Array<{
        path: string
        previousPath?: string
        status?: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked"
        diff: string
        diffLoaded?: boolean
        additions: number
        deletions: number
      }>
      changedFiles?: string[]
      changedFilesTotal?: number
      omittedFileCount?: number
      totals: { additions: number; deletions: number; fileCount: number }
      hasPendingDiff: boolean
      suggestedCommitMessage?: string
      error?: string
    }>
    getGitPanelFileDiff: (
      threadId: string,
      filePath: string,
      options?: { worktreePath?: string }
    ) => Promise<{
      success: boolean
      isWorktree: boolean
      isGitRepo?: boolean
      taskId: string
      file?: {
        path: string
        previousPath?: string
        status?: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked"
        diff: string
        diffLoaded?: boolean
        additions: number
        deletions: number
      }
      error?: string
    }>
    getGitChangedFilesSummary: (threadId: string) => Promise<{
      success: boolean
      isWorktree: boolean
      isGitRepo?: boolean
      taskId: string
      files: Array<{
        path: string
        previousPath?: string
        status?: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked"
      }>
      changedFilesTotal: number
      omittedFileCount: number
      hasPendingDiff: boolean
      error?: string
    }>
    getGitPanelSummary: (threadId: string) => Promise<{
      success: boolean
      isWorktree: boolean
      isGitRepo?: boolean
      hasPendingDiff: boolean
      changedFiles: number
    }>
    isGit: (
      folderPath: string,
      options?: { includeWorktrees?: boolean; threadId?: string }
    ) => Promise<{
      isGit: boolean
      gitRoot: string | null
      worktrees: Array<{ path: string; branch: string; isMain: boolean; createdAt?: Date }>
      isWorktreePath: boolean
      repositories?: Array<{ path: string; displayPath: string; gitRoot: string }>
    }>
    listWorktrees: (
      gitRoot: string
    ) => Promise<Array<{ path: string; branch: string; isMain: boolean; createdAt?: Date }>>
    removeWorktree: (
      gitRoot: string,
      worktreePath: string
    ) => Promise<{
      success: boolean
      error?: string
    }>
    createWorktree: (
      gitRoot: string,
      branch: string
    ) => Promise<{
      success: boolean
      path?: string
      branch?: string
      baseBranch?: string
      baseCommit?: string
      error?: string
    }>
    commitWorktree: (
      threadId: string,
      message: string,
      filePaths?: string[],
      options?: { worktreePath?: string }
    ) => Promise<{
      success: boolean
      error?: string
    }>
    pushWorktree: (threadId: string, options?: { worktreePath?: string }) => Promise<{
      success: boolean
      autoCommitted?: boolean
      error?: string
      steps?: Array<{
        step: "pull" | "commit" | "push" | "verify" | "final"
        status: "ok" | "failed" | "skipped"
        detail: string
      }>
    }>
    pullWorktree: (threadId: string, options?: { worktreePath?: string }) => Promise<{
      success: boolean
      detail?: string
      error?: string
    }>
    rejectWorktreeChanges: (
      threadId: string,
      filePaths?: string[],
      options?: { worktreePath?: string }
    ) => Promise<{
      success: boolean
      revertedFileCount?: number
      error?: string
    }>
    rejectWorktreeFile: (
      threadId: string,
      filePath: string,
      options?: { worktreePath?: string }
    ) => Promise<{
      success: boolean
      error?: string
    }>
    onFilesChanged: (
      callback: (data: { threadId: string; workspacePath: string }) => void
    ) => () => void
  }
  pet: {
    // 列出内置 pets/ 与 OPENWORK_DIR/pets 下可用宠物。
    list: () => Promise<PetManifest[]>
    getSpriteDataUrl: (
      directoryId: string,
      source?: "builtin" | "custom"
    ) => Promise<{ success: boolean; dataUrl?: string; error?: string }>
    // 将业务状态同步到独立宠物窗口；动画渲染不在 renderer 主 UI 中执行。
    setState: (state: PetState) => void
    // 告知主进程主应用已打开/获得焦点，用于清空宠物完成任务提醒队列。
    clearCompletedTasks: () => void
    getSettings: () => Promise<PetSettings>
    updateSettings: (settings: Partial<PetSettings>) => Promise<PetSettings>
    uploadCustomFolder: () => Promise<{ success: boolean; pet?: PetManifest; error?: string }>
    deleteCustom: (directoryId: string) => Promise<{ success: boolean; error?: string }>
  }
  file: {
    parse: (
      filePath: string,
      maxLength?: number
    ) => Promise<{
      success: boolean
      attachment?: {
        filename: string
        filePath: string
        content: string
        mimeType: string
        size: number
        truncated: boolean
      }
      error?: string
    }>
    getFilePath: (file: File) => string
    select: () => Promise<{ canceled: boolean; filePaths: string[] }>
    selectDirectory: (options?: {
      title?: string
    }) => Promise<{ canceled: boolean; filePaths: string[] }>
    supportedExtensions: () => Promise<string[]>
  }
  skills: {
    list: () => Promise<SkillMetadata[]>
    listPlugins: () => Promise<SkillMetadata[]>
    read: (skillPath: string) => Promise<{ success: boolean; content?: string; error?: string }>
    write: (skillPath: string, content: string) => Promise<{ success: boolean; error?: string }>
    readBinary: (
      skillPath: string
    ) => Promise<{ success: boolean; content?: string; mimeType?: string; error?: string }>
    listFiles: (
      skillPath: string
    ) => Promise<{ success: boolean; files?: string[]; error?: string }>
    readTextBundle: (skillPath: string) => Promise<{
      success: boolean
      files?: Array<{ path: string; content: string }>
      skipped?: Array<{ path: string; reason: string }>
      error?: string
    }>
    getDisabled: () => Promise<string[]>
    setDisabled: (skillNames: string[]) => Promise<void>
    backupForCloudEvolution: (payload: {
      skillPath: string
      candidateId: string
      skillName: string
      sourceVersion?: string | null
      targetVersion?: string | null
    }) => Promise<{ success: boolean; backupId?: string; backupPath?: string; error?: string }>
    restoreCloudEvolutionBackup: (
      backupId: string
    ) => Promise<{ success: boolean; skillName?: string; error?: string }>
    applyPluginSkillEvolution: (payload: {
      skillPath: string
      candidateId: string
      skillName: string
      buffer: ArrayBuffer
      fileName: string
      sourceVersion?: string | null
      targetVersion?: string | null
    }) => Promise<{ success: boolean; backupId?: string; error?: string }>
    rollbackPluginSkillEvolution: (
      backupId: string
    ) => Promise<{ success: boolean; skillName?: string; error?: string }>
    exportCloudEvolutionBackup: (
      backupId: string,
      targetDir: string
    ) => Promise<{ success: boolean; exportedPath?: string; error?: string }>
    upload: (
      buffer: ArrayBuffer,
      fileName: string,
      options?: { allowNestedNameDuplicates?: boolean }
    ) => Promise<{
      success: boolean
      skillName?: string
      error?: string
      nestedNameConflicts?: Array<{ name: string; relativePath: string }>
    }>
    extractMarkdownFromZip: (
      buffer: ArrayBuffer,
      fileName?: string
    ) => Promise<{ success: boolean; filePath?: string; content?: string; error?: string }>
    exportForMarket: (
      skillPath: string,
      options?: { includeNestedSkills?: boolean }
    ) => Promise<{ success: boolean; fileName?: string; buffer?: ArrayBuffer; error?: string }>
    delete: (skillPath: string) => Promise<{ success: boolean; error?: string }>
    onChanged: (callback: (payload: { reason?: string }) => void) => () => void
  }
  mcp: {
    list: () => Promise<McpConnectorConfig[]>
    create: (config: McpConnectorUpsert) => Promise<{ id: string }>
    update: (config: McpConnectorUpsert & { id: string }) => Promise<{ id: string }>
    delete: (id: string) => Promise<void>
    setEnabled: (id: string, enabled: boolean) => Promise<void>
    testConnection: (params: {
      id?: string
      config?: McpConnectorUpsert
      url?: string
      advanced?: McpConnectorConfig["advanced"]
    }) => Promise<{ success: boolean; tools?: string[]; error?: string }>
  }
  memory: {
    listProjects: (request?: { workspacePath?: string | null }) => Promise<
      Array<{
        projectId: string
        displayName: string
        memoryDir: string
        gitRoot?: string
        fileCount: number
        totalSize: number
        indexSize: number
        isCurrent: boolean
      }>
    >
    listFiles: (request?: {
      scope?: "global" | "project"
      workspacePath?: string | null
      projectId?: string | null
    }) => Promise<
      Array<{
        name: string
        size: number
        modifiedAt: string
        type: "user" | "feedback" | "project" | "reference" | null
        displayName: string | null
        description: string | null
        recallCount: number
      }>
    >
    readFile: (
      name: string,
      request?: {
        scope?: "global" | "project"
        workspacePath?: string | null
        projectId?: string | null
      }
    ) => Promise<string>
    deleteFile: (
      name: string,
      request?: {
        scope?: "global" | "project"
        workspacePath?: string | null
        projectId?: string | null
      }
    ) => Promise<void>
    getEnabled: () => Promise<boolean>
    setEnabled: (enabled: boolean) => Promise<void>
    getDreamEnabled: () => Promise<boolean>
    setDreamEnabled: (enabled: boolean) => Promise<void>
    getStats: (request?: {
      scope?: "global" | "project"
      workspacePath?: string | null
      projectId?: string | null
    }) => Promise<{
      fileCount: number
      totalSize: number
      indexSize: number
      enabled: boolean
      dreamEnabled: boolean
      dreamState: { lastRunAt: number; sessionsSinceLastRun: number }
      scope: "global" | "project"
      memoryDir: string
      projectId?: string
      gitRoot?: string
    }>
    consolidate: (request?: {
      scope?: "global" | "project"
      workspacePath?: string | null
      projectId?: string | null
    }) => Promise<{
      archived: number
      merged: number
      created: number
      skipped: number
    }>
    onChanged: (callback: () => void) => () => void
  }
  taskMmd: {
    getSettings: () => Promise<TaskMmdSettings>
    setSettings: (patch: Partial<TaskMmdSettings>) => Promise<TaskMmdSettings>
    getSnapshot: (threadId: string) => Promise<TaskMmdSnapshot>
    clearThread: (threadId: string) => Promise<void>
    getDirectorySize: (threadId: string) => Promise<number>
    getCompileModelInfo: (threadId: string) => Promise<TaskMmdCompileModelInfo>
    onChanged: (callback: (payload: { threadId?: string }) => void) => () => void
  }
  autoCommit: {
    getSettings: () => Promise<AgentAutoCommitSettings>
    saveSettings: (updates: Partial<AgentAutoCommitSettings>) => Promise<AgentAutoCommitSettings>
    getWorkspaceCard: (workspacePath: string) => Promise<AgentAutoCommitWorkspaceCard>
    saveWorkspaceCard: (
      workspacePath: string,
      cardNumber?: string
    ) => Promise<AgentAutoCommitWorkspaceCard>
  }
  taskCards: {
    list: (query?: TaskCardsQuery) => Promise<TaskCardsListResult>
  }
  lsp: {
    getConfig: () => Promise<LspConfig>
    saveConfig: (updates: Partial<LspConfig>) => Promise<void>
    resetConfig: () => Promise<LspConfig>
    start: (projectRoot: string) => Promise<void>
    stop: (projectRoot: string) => Promise<void>
    isRunning: (projectRoot: string) => Promise<boolean>
    getStatus: (projectRoot: string | null) => Promise<LspStatus>
    getDownloadTarget: () => Promise<{ name: string; filenames: string[] }>
    getDownloadState: () => Promise<{
      isDownloading: boolean
      progress: { percent: number; transferred: number; total: number } | null
    }>
    downloadVsix: () => Promise<{ success: boolean; path?: string; error?: string }>
    importVsix: () => Promise<{ success: boolean; path?: string; error?: string }>
    saveDownloadedVsix: (
      buffer: ArrayBuffer,
      fileName?: string
    ) => Promise<{ success: boolean; path?: string; error?: string }>
    onDownloadState: (
      callback: (state: {
        isDownloading: boolean
        progress: { percent: number; transferred: number; total: number } | null
      }) => void
    ) => () => void
    definition: (params: {
      projectRoot: string
      filePath: string
      line: number
      column: number
    }) => Promise<LspLocation[]>
    references: (params: {
      projectRoot: string
      filePath: string
      line: number
      column: number
    }) => Promise<LspLocation[]>
    hover: (params: {
      projectRoot: string
      filePath: string
      line: number
      column: number
    }) => Promise<LspHoverResult | null>
    implementation: (params: {
      projectRoot: string
      filePath: string
      line: number
      column: number
    }) => Promise<LspLocation[]>
    documentSymbols: (params: { projectRoot: string; filePath: string }) => Promise<LspSymbol[]>
    workspaceSymbol: (params: { projectRoot: string; query: string }) => Promise<LspSymbol[]>
    diagnostics: (params: { projectRoot: string; filePath?: string }) => Promise<LspDiagnostic[]>
    prepareCallHierarchy: (params: {
      projectRoot: string
      filePath: string
      line: number
      column: number
    }) => Promise<LspCallHierarchyItem[]>
    incomingCalls: (params: {
      projectRoot: string
      filePath: string
      line: number
      column: number
    }) => Promise<LspCallHierarchyIncomingCall[]>
    outgoingCalls: (params: {
      projectRoot: string
      filePath: string
      line: number
      column: number
    }) => Promise<LspCallHierarchyOutgoingCall[]>
    detectJavaProject: (dirPath: string) => Promise<boolean>
    onDiagnostics: (callback: (diagnostics: LspDiagnostic[]) => void) => () => void
    onChanged: (callback: () => void) => () => void
  }
  terminal: {
    create: (opts: {
      workDir?: string
      args?: string[]
      cols?: number
      rows?: number
      claudeModelId?: string
      syncSkills?: boolean
      syncMemory?: boolean
      launchSource?: "select_dir" | "restart"
    }) => Promise<string>
    write: (id: string, data: string) => void
    resize: (id: string, cols: number, rows: number) => void
    dispose: (id: string) => Promise<void>
    selectDir: () => Promise<string | null>
    ack: (id: string, bytes: number) => void
    onData: (id: string, callback: (data: string, bytes: number) => void) => () => void
    onExit: (id: string, callback: (code: number | null) => void) => () => void
  }
  keepAwake: {
    get: () => Promise<boolean>
    set: (enabled: boolean) => Promise<void>
  }
  scheduledTasks: {
    list: () => Promise<ScheduledTask[]>
    create: (config: ScheduledTaskUpsert) => Promise<{ id: string }>
    update: (config: ScheduledTaskUpsert & { id: string }) => Promise<{ id: string }>
    delete: (id: string) => Promise<void>
    setEnabled: (id: string, enabled: boolean) => Promise<void>
    runNow: (id: string) => Promise<void>
    cancel: (id: string) => Promise<void>
    isRunning: (id: string) => Promise<boolean>
    onChanged: (callback: () => void) => () => void
    listenToStream: (
      threadId: string,
      callback: (event: { type: string; [key: string]: unknown }) => void
    ) => () => void
  }
  heartbeat: {
    getConfig: () => Promise<HeartbeatConfig>
    saveConfig: (updates: Partial<HeartbeatConfig>) => Promise<void>
    getContent: () => Promise<string>
    saveContent: (content: string) => Promise<void>
    runNow: () => Promise<void>
    cancel: () => Promise<void>
    isRunning: () => Promise<boolean>
    resetConfig: () => Promise<HeartbeatConfig>
    onChanged: (callback: () => void) => () => void
    listenToStream: (
      threadId: string,
      callback: (event: { type: string; [key: string]: unknown }) => void
    ) => () => void
  }
  plugins: {
    list: () => Promise<PluginMetadata[]>
    install: (
      buffer: ArrayBuffer,
      fileName: string,
      origin?: "market" | "local",
      version?: string
    ) => Promise<{ success: boolean; pluginName?: string; error?: string }>
    installFromDir: () => Promise<{ success: boolean; pluginName?: string; error?: string }>
    exportForMarket: (
      id: string,
      options?: { version?: string | null }
    ) => Promise<{ success: boolean; fileName?: string; buffer?: ArrayBuffer; error?: string }>
    delete: (id: string) => Promise<{ success: boolean; error?: string }>
    setEnabled: (id: string, enabled: boolean) => Promise<void>
    setOriginsBatch: (
      updates: Array<{ id: string; origin: "market" | "local" }>
    ) => Promise<{ success: boolean; error?: string }>
    getDetail: (id: string) => Promise<PluginDetail>
    inspectZip: (buffer: ArrayBuffer) => Promise<PluginDetail>
    listHooks: () => Promise<PluginHookMetadata[]>
    setHookEnabled: (
      pluginId: string,
      hookId: string,
      enabled: boolean
    ) => Promise<{ success: boolean; error?: string }>
    listFiles: (pluginId: string) => Promise<{
      success: boolean
      files?: Array<{ path: string; relativePath: string; editable: boolean }>
      root?: string
      pluginEditable?: boolean
      error?: string
    }>
    readFile: (
      pluginId: string,
      filePath: string
    ) => Promise<{ success: boolean; content?: string; editable?: boolean; error?: string }>
    writeFile: (
      pluginId: string,
      filePath: string,
      content: string
    ) => Promise<{ success: boolean; error?: string }>
  }
  chatx: {
    getConfig: () => Promise<ChatXConfig>
    saveConfig: (updates: Partial<ChatXConfig>) => Promise<void>
    restart: () => Promise<void>
    cancelByThread: (threadId: string) => Promise<boolean>
  }
  sandbox: {
    getMode: () => Promise<"none" | "unelevated" | "readonly" | "elevated">
    setMode: (mode: "none" | "unelevated" | "readonly" | "elevated") => Promise<void>
    checkElevatedSetup: () => Promise<{ setupComplete: boolean }>
    runElevatedSetup: (workspacePaths?: string[]) => Promise<{ success: boolean; error?: string }>
    getYoloMode: () => Promise<boolean>
    setYoloMode: (yolo: boolean) => Promise<void>
    getPendingApprovals: (threadId: string) => Promise<unknown[]>
    isNuxNeeded: () => Promise<boolean>
    completeNux: (mode: "elevated" | "unelevated" | "none") => Promise<void>
    getApprovalRules: () => Promise<Array<{ pattern: string; decision: string }>>
    deleteApprovalRule: (pattern: string) => Promise<void>
    sendApprovalDecision: (decision: {
      requestId: string
      type: "approve" | "approve_session" | "approve_permanent" | "reject" | "error"
      tool_call_id: string
      savedToolName?: string
      savedToolDescription?: string
      commitResult?: { success: boolean; commitMessage?: string; error?: string }
      pushResult?: { success: boolean; error?: string }
    }) => void
    onApprovalRequest: (threadId: string, callback: (request: unknown) => void) => () => void
    onApprovalTimeout: (
      threadId: string,
      callback: (data: { requestId: string }) => void
    ) => () => void
    onApprovalCancel: (
      threadId: string,
      callback: (data: { requestId: string; reason?: string }) => void
    ) => () => void
    onChanged: (callback: () => void) => () => void
  }
  userInput: {
    sendResponse: (response: UserInputResponse) => void
    onRequest: (threadId: string, callback: (request: UserInputRequest) => void) => () => void
    onCancel: (
      threadId: string,
      callback: (data: { requestId: string; reason?: string }) => void
    ) => () => void
  }
  skillEvolution: {
    /** Phase 1 — intent banner: "Want to save this as a skill?" */
    onIntentRequest: (
      callback: (req: {
        threadId?: string
        requestId: string
        summary: string
        toolCallCount: number
        turnCount: number
        mode: "mode_a_rule" | "mode_b_llm"
        recommendationReason?: string
        /** Opaque context payload — cache in renderer and pass back on retry */
        context: unknown
      }) => void
    ) => () => void
    intentResponse: (requestId: string, accepted: boolean) => Promise<void>
    /**
     * Manually retry a failed skill generation. Skips the intent banner and
     * jumps straight to generate → confirm → write.
     */
    retryGeneration: (
      threadId: string,
      retryContext: { context: unknown; intentMode: string }
    ) => Promise<void>
    /** Phase 2 — full detail dialog: show skill preview for final adoption */
    onConfirmRequest: (
      callback: (req: {
        threadId?: string
        requestId: string
        skillId: string
        name: string
        description: string
        content: string
      }) => void
    ) => () => void
    confirmResponse: (requestId: string, approved: boolean, content?: string) => Promise<void>
    /** Listen to streaming generation progress from the main process */
    onGenerating: (
      callback: (event: {
        threadId?: string
        phase: "start" | "token" | "done" | "error"
        text: string
      }) => void
    ) => () => void
  }
  optimizer: {
    run: (opts?: {
      threadId?: string
      traceLimit?: number
      mode?: "auto" | "selected"
      traceIds?: string[]
    }) => Promise<{
      startedAt: string
      endedAt: string
      tracesAnalyzed: number
      candidates: Array<{
        candidateId: string
        action: "create" | "patch"
        skillId: string
        name: string
        description: string
        proposedContent: string
        rationale: string
        sourceTraceIds: string[]
        generatedAt: string
        status: "pending" | "approved" | "rejected"
      }>
      summary: string
    }>
    onRunProgress: (
      cb: (payload: {
        runId: string
        traceId: string
        index: number
        total: number
        status: "pending" | "running" | "completed" | "failed"
        message?: string
        candidateCount?: number
      }) => void
    ) => () => void
    onStreamStart: (cb: () => void) => () => void
    onStreamChunk: (cb: (payload: { chunk: string }) => void) => () => void
    onStreamEnd: (cb: (payload: { success: boolean; error?: string }) => void) => () => void
    getCandidates: () => Promise<
      Array<{
        candidateId: string
        action: "create" | "patch"
        skillId: string
        name: string
        description: string
        proposedContent: string
        rationale: string
        sourceTraceIds: string[]
        generatedAt: string
        status: "pending" | "approved" | "rejected"
      }>
    >
    approve: (
      candidateId: string,
      proposedContent?: string
    ) => Promise<{ success: boolean; skillId?: string; error?: string }>
    reject: (candidateId: string) => Promise<{ success: boolean }>
    clear: () => Promise<void>
    getTraces: (opts?: { threadId?: string; limit?: number }) => Promise<
      Array<{
        traceId: string
        threadId: string
        startedAt: string
        durationMs: number
        userMessage: string
        totalToolCalls: number
        totalInputTokens: number
        totalOutputTokens: number
        totalTokens: number
        outcome: string
        usedSkills: string[]
        evolvedSkills: string[]
        triggerSource?: string
      }>
    >
    onAutoTriggered: (
      cb: (payload: { threadId: string; toolCallCount: number }) => void
    ) => () => void
    getTraceDetail: (traceId: string) => Promise<{
      traceId: string
      threadId: string
      startedAt: string
      endedAt: string
      durationMs: number
      userMessage: string
      modelId: string
      totalToolCalls: number
      outcome: string
      errorMessage?: string
      usedSkills: string[]
      evolvedSkills: string[]
      triggerSource?: string
      nodes?: Array<{
        id: string
        type: "trace" | "llm" | "tool" | "tool_result" | "message" | "error" | "cancel"
        parentId: string | null
        name?: string
        status?: "running" | "success" | "error" | "cancelled" | "unknown"
        startedAt: string
        endedAt?: string
        input?: unknown
        output?: unknown
        metadata?: Record<string, unknown>
      }>
      modelCalls?: Array<{
        messageId?: string
        startedAt: string
        inputMessages: Array<{
          role: "system" | "user" | "assistant" | "tool" | "unknown"
          content: string
          name?: string
          toolCallId?: string
        }>
        outputMessage: {
          role: "system" | "user" | "assistant" | "tool" | "unknown"
          content: string
          name?: string
          toolCallId?: string
        }
        toolCalls: Array<{
          name: string
          args: Record<string, unknown>
          result?: string
          durationMs?: number
        }>
        tokenUsage?: {
          inputTokens?: number
          outputTokens?: number
          totalTokens?: number
          cacheReadTokens?: number
          cacheCreationTokens?: number
        }
      }>
      steps: Array<{
        index: number
        startedAt: string
        assistantText: string
        toolCalls: Array<{
          name: string
          args: Record<string, unknown>
          result?: string
          durationMs?: number
        }>
      }>
    } | null>
    deleteTraces: (traceIds: string[]) => Promise<{
      deletedIds: string[]
      failed: Array<{ traceId: string; error: string }>
    }>
    getOnlineSkillEvolutionEnabled: () => Promise<boolean>
    setOnlineSkillEvolutionEnabled: (enabled: boolean) => Promise<void>
    getAutoPropose: () => Promise<boolean>
    setAutoPropose: (enabled: boolean) => Promise<void>
    getThreshold: () => Promise<number>
    setThreshold: (value: number) => Promise<void>
    getTurnThreshold: () => Promise<number>
    setTurnThreshold: (value: number) => Promise<void>
  }
  hooks: {
    list: () => Promise<HookConfig[]>
    skills: {
      list: () => Promise<SkillHookMetadata[]>
    }
    onChanged: (callback: (data: { reason?: string; at: string }) => void) => () => void
    create: (config: HookUpsert) => Promise<{ id: string }>
    update: (config: HookUpsert & { id: string }) => Promise<{ id: string }>
    delete: (id: string) => Promise<void>
    setEnabled: (id: string, enabled: boolean) => Promise<void>
    workspace: {
      list: (workspacePath: string) => Promise<HookConfig[]>
      untrusted: (
        workspacePath: string
      ) => Promise<{ fileName: string; filePath: string; event: string; command: string }[]>
      trustAll: (workspacePath: string) => Promise<void>
      trustFile: (workspacePath: string, fileName: string, filePath: string) => Promise<void>
      runSetupMaintenance: (workspacePath: string) => Promise<void>
      onChanged: (
        callback: (data: { threadId: string; workspacePath: string }) => void
      ) => () => void
    }
    logging: {
      get: () => Promise<HookLoggingConfig>
      save: (updates: Partial<HookLoggingConfig>) => Promise<HookLoggingConfig>
      getLogDir: () => Promise<string>
      openLogDir: () => Promise<{ success: boolean; error?: string }>
      onChanged: (callback: (config: HookLoggingConfig) => void) => () => void
    }
  }
  codeExecTools: {
    list: () => Promise<ManagedSavedCodeExecTool[]>
    getSettings: () => Promise<{ codeExecEnabled: boolean }>
    setCodeExecEnabled: (enabled: boolean) => Promise<void>
    setEnabled: (id: string, enabled: boolean) => Promise<ManagedSavedCodeExecTool>
    setLastPreviewParams: (
      id: string,
      params: Record<string, unknown>
    ) => Promise<ManagedSavedCodeExecTool>
    rewrite: (payload: SavedCodeExecRewritePayload) => Promise<SavedCodeExecRewriteResult>
    update: (payload: SavedCodeExecToolUpdatePayload) => Promise<ManagedSavedCodeExecTool>
    delete: (id: string) => Promise<void>
    runPreview: (payload: SavedCodeExecPreviewPayload) => Promise<SavedCodeExecPreviewResult>
  }
  routing: {
    getMode: () => Promise<"auto" | "pinned">
    setMode: (mode: "auto" | "pinned") => Promise<void>
  }
  featureGates: {
    isEnabled: (
      name: FeatureGateKey,
      options?: FeatureGateCheckOptions
    ) => Promise<FeatureGateCheckResult>
  }
  dashboard: {
    isAllowed: () => Promise<boolean>
    isProjectModeAllowed: () => Promise<boolean>
    isAnalysisAgentAllowed: () => Promise<boolean>
    isTraceEvolverReviewAdmin: () => Promise<boolean>
    isUncommittedAnalysisAllowed: () => Promise<boolean>
    isAwardsAdmin: () => Promise<boolean>
    awardsSkillContributions: (
      range: { from: string; to: string },
      skillNames: string[]
    ) => Promise<{ success: boolean; data?: unknown; error?: string }>
    awardsUserApplications: (range: {
      from: string
      to: string
    }) => Promise<{ success: boolean; data?: unknown; error?: string }>
    awardsTeamBenchmark: (range: {
      from: string
      to: string
    }) => Promise<{ success: boolean; data?: unknown; error?: string }>
    awardsTeamSkillCoverage: (
      range: { from: string; to: string },
      groups: Array<{ shi: string; skillNames: string[] }>
    ) => Promise<{ success: boolean; data?: unknown; error?: string }>
    esQuery: (input: {
      indexAlias: "event" | "trace"
      operation: "search" | "msearch" | "count" | "mapping" | "field_caps"
      body?: unknown
      context?: {
        scope?: "platform" | "project"
        upperOrgLv1?: string | string[] | null
        projectId?: string | null
        featureSlug?: string | null
      }
    }) => Promise<{ success: boolean; data?: unknown; error?: string }>
    analysisAgent: (input: {
      question: string
      messages?: Array<{ role: "user" | "assistant"; content: string }>
      context?: {
        scope?: "platform" | "project"
        range?: { from: string; to: string }
        upperOrgLv1?: string | string[] | null
        projectId?: string | null
        featureSlug?: string | null
        panelSnapshot?: Record<string, unknown> | null
      }
    }) => Promise<{ success: boolean; data?: unknown; error?: string }>
    projectMode: (
      range: { from: string; to: string },
      granularity: "day" | "week" | "month" | "custom",
      opts?: { upperOrgLv1?: string | string[] | null; fromLeanOnly?: boolean | null }
    ) => Promise<{ success: boolean; data?: DashboardProjectModeData; error?: string }>
    projectModeCodeStats: (
      range: { from: string; to: string },
      opts: { upperOrgLv1?: string | string[] | null; fromLeanOnly?: boolean | null } | undefined,
      source: string | null
    ) => Promise<{
      success: boolean
      data?: { codeStats: DashboardCodeStats | null; skillCodeStats: DashboardCodeStats | null }
      error?: string
    }>
    projectModeProjects: (
      range: { from: string; to: string },
      options?: DashboardProjectModeProjectPageOptions
    ) => Promise<{ success: boolean; data?: DashboardProjectModeProjectPageData; error?: string }>
    projectModeTraces: (
      projectId: string,
      range: { from: string; to: string },
      options?: DashboardProjectModeTracesOptions
    ) => Promise<{ success: boolean; data?: DashboardProjectModeTracesData; error?: string }>
    projectModeFeatureNodes: (
      projectId: string,
      featureSlug: string,
      range: { from: string; to: string }
    ) => Promise<{ success: boolean; data?: DashboardProjectModeFeatureNode[]; error?: string }>
    pluginAggregate: (
      adapterName: string,
      range: { from: string; to: string }
    ) => Promise<{ success: boolean; data?: DashboardPluginAggregate; error?: string }>
    projectModeFeatureCommits: (
      projectId: string,
      featureSlug: string,
      range: { from: string; to: string },
      options?: DashboardCommitDetailsOptions
    ) => Promise<{
      success: boolean
      data?: {
        total: number
        page: number
        pageSize: number
        pushedOnly: boolean
        items: DashboardCommitDetail[]
      }
      error?: string
    }>
    projectModeProjectCommits: (
      projectId: string,
      range: { from: string; to: string },
      options?: DashboardCommitDetailsOptions
    ) => Promise<{
      success: boolean
      data?: {
        total: number
        page: number
        pageSize: number
        pushedOnly: boolean
        items: DashboardCommitDetail[]
      }
      error?: string
    }>
    overview: (
      range: { from: string; to: string },
      granularity: "day" | "week" | "month" | "custom",
      opts?: { upperOrgLv1?: string | string[] | null }
    ) => Promise<{ success: boolean; data?: unknown; error?: string }>
    modelStats: (
      range: { from: string; to: string },
      granularity: "day" | "week" | "month" | "custom",
      opts?: { upperOrgLv1?: string | string[] | null }
    ) => Promise<{ success: boolean; data?: unknown; error?: string }>
    orgOptions: (range: {
      from: string
      to: string
    }) => Promise<{ success: boolean; data?: string[]; error?: string }>
    userStats: (
      range: { from: string; to: string },
      granularity: "day" | "week" | "month" | "custom",
      opts?: { upperOrgLv1?: string | string[] | null }
    ) => Promise<{ success: boolean; data?: unknown; error?: string }>
    userList: (
      range: { from: string; to: string },
      options?: DashboardUserListOptions
    ) => Promise<{ success: boolean; data?: DashboardUserListData; error?: string }>
    userDetail: (
      sapId: string,
      range: { from: string; to: string },
      options?: DashboardUserDetailOptions
    ) => Promise<{ success: boolean; data?: DashboardUserDetail; error?: string }>
    uncommittedRanking: (
      range: { from: string; to: string },
      options?: {
        upperOrgLv1?: string | string[] | null
        projectMode?: boolean
        projectId?: string | null
        featureSlug?: string | null
        usedSkillsOnly?: boolean
        source?: string | null
        userKeyword?: string | null
      }
    ) => Promise<{ success: boolean; data?: DashboardUncommittedRankingData; error?: string }>
    uncommittedDetail: (
      sapId: string,
      range: { from: string; to: string },
      options?: {
        upperOrgLv1?: string | string[] | null
        projectMode?: boolean
        projectId?: string | null
        featureSlug?: string | null
        usedSkillsOnly?: boolean
        source?: string | null
        userKeyword?: string | null
      }
    ) => Promise<{ success: boolean; data?: DashboardUncommittedDetailData; error?: string }>
    skillUsageSummary: (
      range: { from: string; to: string },
      granularity: "day" | "week" | "month" | "custom",
      // 可选：指定技能名后，后端按技能名聚合返回用户数。
      skillNames?: string[]
    ) => Promise<{ success: boolean; data?: unknown; error?: string }>
    skillUserStats: (
      range: { from: string; to: string },
      granularity: "day" | "week" | "month" | "custom",
      skillName: string
    ) => Promise<{ success: boolean; data?: unknown; error?: string }>
    skillEvalSummary: (
      range: { from: string; to: string },
      options?: DashboardSkillEvalOptions
    ) => Promise<{ success: boolean; data?: unknown; error?: string }>
    userProfiles: (
      sapIds: string[]
    ) => Promise<{ success: boolean; data?: unknown; error?: string }>
    queryAllUser: () => Promise<{
      success: boolean
      data?: DashboardAllUserItem[]
      error?: string
    }>
    productivity: (
      range: { from: string; to: string },
      granularity: "day" | "week" | "month" | "custom",
      opts?: { upperOrgLv1?: string | string[] | null }
    ) => Promise<{ success: boolean; data?: unknown; error?: string }>
    feedback: (
      range: { from: string; to: string },
      granularity: "day" | "week" | "month" | "custom",
      opts?: { upperOrgLv1?: string | string[] | null }
    ) => Promise<{ success: boolean; data?: unknown; error?: string }>
    advancedFeatures: (
      range: { from: string; to: string },
      granularity: "day" | "week" | "month" | "custom",
      opts?: { upperOrgLv1?: string | string[] | null }
    ) => Promise<{ success: boolean; data?: unknown; error?: string }>
    skillRecentTraces: (
      skill: string,
      range: { from: string; to: string },
      limit?: number,
      mode?: DashboardTraceViewMode,
      triggerScope?: DashboardTraceTriggerScope
    ) => Promise<{ success: boolean; data?: DashboardTraceDetail[]; error?: string }>
    threadTraces: (
      threadId: string,
      options?: { scope?: "platform" | "project" }
    ) => Promise<{ success: boolean; data?: DashboardTraceDetail[]; error?: string }>
    marketSkillRecentTraces: (
      skill: string,
      range: { from: string; to: string },
      limit?: number,
      mode?: DashboardTraceViewMode,
      triggerScope?: DashboardTraceTriggerScope
    ) => Promise<{ success: boolean; data?: DashboardTraceDetail[]; error?: string }>
    skillDetail: (
      skill: string,
      range: { from: string; to: string },
      options?:
        | number
        | {
            page?: number
            pageSize?: number
            limit?: number
            mode?: DashboardTraceViewMode
            viewMode?: DashboardTraceViewMode
            triggerScope?: DashboardTraceTriggerScope
          }
    ) => Promise<{ success: boolean; data?: DashboardSkillDetail; error?: string }>
    commitDetails: (
      range: { from: string; to: string },
      options?: DashboardCommitDetailsOptions
    ) => Promise<{
      success: boolean
      data?: {
        total: number
        page: number
        pageSize: number
        pushedOnly: boolean
        items: DashboardCommitDetail[]
      }
      error?: string
    }>
    nonGitAdoptionReports: (
      range: { from: string; to: string },
      options?: DashboardNonGitAdoptionReportsOptions
    ) => Promise<{ success: boolean; data?: DashboardNonGitAdoptionReportsData; error?: string }>
    commitAdoptionEvents: (
      commitSha: string
    ) => Promise<{ success: boolean; data?: DashboardCommitAdoptionEvents; error?: string }>
    exportSkillTraces: (payload: {
      skill: string
      range: { from: string; to: string }
      page: number
      pageSize: number
      totalTraces: number
      traces: DashboardTraceDetail[]
    }) => Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }>
    exportExcel: (
      sheets: Array<{ name: string; header: string[]; rows: (string | number)[][] }>,
      options?: { fileName?: string }
    ) => Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }>
  }
  adoption: {
    commitLines: (
      commitSha: string,
      genEventIds: string[]
    ) => Promise<{ success: boolean; data?: LocalGenAdoptionLines[]; error?: string }>
  }
  harnessBoard: {
    registry: () => Promise<HarnessAdapterRegistryItem[]>
    listProjects: () => Promise<HarnessProjectListItem[]>
    createProject: (input: HarnessProjectCreateInput) => Promise<HarnessProjectMetadata>
    searchEnterpriseProjects: (
      input: HarnessEnterpriseProjectSearchInput
    ) => Promise<HarnessEnterpriseProjectSearchResult>
    getEnterpriseProjectDetails: (
      input: HarnessEnterpriseProjectDetailInput
    ) => Promise<HarnessEnterpriseProjectDetailResult>
    createFeature: (input: HarnessFeatureCreateInput) => Promise<HarnessFeatureCreateResult>
    getDynamicWorkflowConfig: (projectId: string) => Promise<HarnessDynamicWorkflowConfig | null>
    updateProject: (
      projectId: string,
      input: HarnessProjectMetadataUpdateInput
    ) => Promise<HarnessProjectMetadata>
    archiveProject: (projectId: string) => Promise<HarnessProjectMetadata>
    deleteProject: (projectId: string) => Promise<HarnessProjectMetadata>
    getProjectDetail: (projectId: string) => Promise<HarnessProjectDetailViewModel>
    getProjectDetails: (
      projectIds: string[],
      options?: { watchRefs?: boolean }
    ) => Promise<Record<string, HarnessProjectDetailViewModel>>
    getRunDetail: (projectId: string, slug: string) => Promise<HarnessRunDetailViewModel>
    skipNode: (input: HarnessSkipNodeInput) => Promise<HarnessSkipNodeResult>
    getDialogTips: (projectId: string, slug: string) => Promise<string | null>
    onWatchRefsChanged: (callback: (event: HarnessWatchRefChangedEvent) => void) => () => void
  }
  update: {
    check: () => Promise<
      | { hasUpdate: false }
      | {
          hasUpdate: true
          version: string
          updateType: string
          releaseNotes: string
          size: number
          mandatory: boolean
          currentStatus?: string
          currentProgress?: {
            percent: number
            transferred: number
            total: number
            speed: string
            phase: "downloading" | "verifying" | "extracting"
            message: string
          } | null
          currentError?: string | null
        }
    >
    download: () => Promise<{ success: boolean }>
    install: () => Promise<void>
    dismiss: () => Promise<{ success: boolean }>
    rollback: () => Promise<void>
    getStatus: () => Promise<{
      status: string
      update: {
        version: string
        updateType: string
        releaseNotes: string
        size: number
        mandatory: boolean
      } | null
      progress: {
        percent: number
        transferred: number
        total: number
        speed: string
        phase: "downloading" | "verifying" | "extracting"
        message: string
      } | null
      errorMessage: string | null
      canRollback: boolean
    }>
    getStartupResult: () => Promise<{ updatedFrom?: string; updatedTo?: string }>
    onAvailable: (
      callback: (info: {
        version: string
        updateType: string
        releaseNotes: string
        size: number
        mandatory: boolean
        autoDownloading?: boolean
      }) => void
    ) => () => void
    onProgress: (
      callback: (progress: {
        percent: number
        transferred: number
        total: number
        speed: string
        phase: "downloading" | "verifying" | "extracting"
        message: string
      }) => void
    ) => () => void
    onDownloaded: (
      callback: (info: {
        version: string
        updateType: string
        releaseNotes?: string
        size?: number
        mandatory?: boolean
      }) => void
    ) => () => void
    onError: (callback: (err: { message: string; silent?: boolean }) => void) => () => void
  }
  git: {
    currentBranch: (
      cwd?: string
    ) => Promise<{
      isGitRepo: boolean
      branch: string | null
      isWorktree: boolean
      isMultiRepo?: boolean
      repositories?: Array<{ path: string; displayPath: string; gitRoot: string }>
      error?: string
    }>
    listBranches: (
      cwd?: string,
      options?: { refreshRemote?: boolean }
    ) => Promise<{ success: boolean; branches: string[]; error?: string }>
    switchBranch: (branch: string, cwd?: string) => Promise<{ success: boolean; error?: string }>
    createBranch: (branch: string, cwd?: string) => Promise<{ success: boolean; error?: string }>
  }
  gitPanel: {
    getCommitHistory: (threadId: string) => Promise<{
      success: boolean
      projectPath: string | null
      records: GitCommitHistoryRecord[]
      error?: string
    }>
    recordCommitHistory: (
      threadId: string,
      fullMessage: string
    ) => Promise<{
      success: boolean
      record: GitCommitHistoryRecord | null
      error?: string
    }>
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: CustomAPI
  }
}
