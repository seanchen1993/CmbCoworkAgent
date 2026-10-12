import type { BotFilePreview, BotFilePreviewRequest } from "./bot-file-preview"
import type { BotReactInput, BotReactionState } from "./bot-reactions"
import type {
  BotSecretInput,
  BotSecretCatalog,
  BotSecretMetadata,
  BotSecretSaveInput
} from "./bot-secrets"
import type {
  BotConversation,
  BotGroupCreateInput,
  BotGroupUpdateInput,
  BotCreateInput,
  BotCloneInput,
  BotReadInput,
  BotReadState,
  BotPinnedOrder,
  BotReorderPinnedInput,
  BotEvent,
  BotInteraction,
  BotMemory,
  BotMessage,
  BotRoutine,
  BotRun,
  BotSendInput,
  BotSendReceipt,
  BotSkill,
  BotUpdateInput,
  BotWorkspaceSnapshot,
  CoworkBot,
  BotEffect,
  BotRecoveryInput,
  BotArtifact
} from "./bot-types"
import type {
  BotBrowserControl,
  BotBrowserFrame,
  BotBrowserTarget,
  BotHumanInput
} from "./bot-computer"
import type { BotUploadRequest, BotUploadProgress, BotFileChunk } from "./bot-files"
import type {
  BotTeachSession,
  BotSkillTrial,
  BotTeachHistoryPage,
  BotTeachVideoChunk
} from "./bot-teach"

export interface BotHostStatus {
  protocol: number
  buildId?: string
  /** Persisted data generation, independent of process restarts. */
  dataEpoch?: string
  hostId: string
  platform: string
  sharedWorkspace?: string
  runtimeReady: boolean
  error: string | null
  capabilities?: string[]
  limits?: { bots: number; routines?: number }
  storage?: import("./bot-storage").BotStorageStatus
  computer?: import("./bot-computer").BotComputerStatus
}
export interface BotConnector {
  id: string
  name: string
  source: "connector" | "plugin"
  capability?: "mcp" | "mods"
}
/** Desktop lifecycle control is not a model tool or a Host domain RPC. */
export interface BotHostControlAPI {
  restart(input: { hostId: string }): Promise<BotHostStatus>
}
export interface CoworkBotAPI {
  primaryBot(): Promise<import("./bot-primary").BotPrimaryState>
  changePrimaryBot(
    input: import("./bot-primary").BotPrimaryChange
  ): Promise<import("./bot-primary").BotPrimaryState>
  ensurePrimaryBot(
    input: import("./bot-primary").BotPrimaryEnsure
  ): Promise<import("./bot-primary").BotPrimaryEnsureResult>
  changePrimaryCheckIn(
    input: import("./bot-primary").BotPrimaryCheckInChange
  ): Promise<import("./bot-primary").BotPrimaryState>
  localToolPermission(): Promise<import("./bot-local-tool-permission").BotLocalToolPolicy>
  changeLocalToolPermission(
    input: import("./bot-local-tool-permission").BotLocalToolPolicyChange
  ): Promise<import("./bot-local-tool-permission").BotLocalToolPolicy>
  resolveLocalToolPermission(
    input: import("./bot-local-tool-permission").BotLocalToolAnswer
  ): Promise<BotInteraction>
  getErrorTrays(): Promise<import("./bot-error-trays").BotErrorTraySnapshot>
  dismissErrorTray(
    input: import("./bot-error-trays").BotDismissErrorTray
  ): Promise<import("./bot-error-trays").BotErrorTraySnapshot>
  clearErrorTrays(
    input: import("./bot-error-trays").BotClearErrorTrays
  ): Promise<import("./bot-error-trays").BotErrorTraySnapshot>
  usageBudget(
    input: import("./bot-usage-budget").BotUsageBudgetAddress
  ): Promise<import("./bot-usage-budget").BotUsageBudgetView>
  changeUsageBudget(
    input: import("./bot-usage-budget").BotUsageBudgetChange
  ): Promise<import("./bot-usage-budget").BotUsageBudgetPolicy>
  pluginPanes(
    input: import("./bot-plugin-panes").BotPluginPaneAddress
  ): Promise<import("./bot-plugin-panes").BotPluginPaneView>
  pluginPaneAction(input: import("./bot-plugin-panes").BotPluginPaneAction): Promise<BotSendReceipt>
  checkModel(
    input: import("./bot-model-check").BotModelCheckInput
  ): Promise<import("./bot-model-check").BotModelCheckResult>
  cancelModelCheck(input: { nonce: string }): Promise<void>
  changeNotifications(
    input: import("./bot-notifications").BotNotificationChange
  ): Promise<import("./bot-notifications").BotNotificationSettings>
  avatar(input: import("./bot-avatar").BotAvatarAddress): Promise<string | null>
  changeAvatar(
    input: import("./bot-avatar").BotAvatarChange
  ): Promise<import("./bot-avatar").BotAvatarChanged>
  thread(input: {
    conversationId: string
    rootId: string
  }): Promise<import("./bot-threads").BotThread>
  threadSummaries(input: {
    conversationId: string
    rootIds: string[]
  }): Promise<import("./bot-threads").BotThreadSummary[]>
  search(
    input: import("./bot-search").BotSearchInput
  ): Promise<import("./bot-search").BotSearchPage>
  referenceCandidates(
    input: import("./bot-entity-references").BotEntityCandidateRequest
  ): Promise<import("./bot-entity-references").BotEntityReference[]>
  skillCandidates(input: {
    conversationId: string
    recipients?: string[]
  }): Promise<import("./bot-skill-references").BotSkillCandidate[]>
  react(input: BotReactInput): Promise<BotReactionState>
  reactions(input: { conversationId: string; messageIds: string[] }): Promise<BotReactionState[]>
  beginUpload(input: BotUploadRequest): Promise<BotUploadProgress>
  uploadChunk(input: { id: string; offset: number; base64: string }): Promise<BotUploadProgress>
  finishUpload(id: string): Promise<BotArtifact>
  cancelUpload(id: string): Promise<void>
  fileChunk(input: { id: string; offset: number }): Promise<BotFileChunk>
  teachHistory(input: { botId: string; before?: string }): Promise<BotTeachHistoryPage>
  teachVideoChunk(input: { id: string; offset: number }): Promise<BotTeachVideoChunk>
  teachDelete(input: { id: string; revision: number }): Promise<void>
  connectors(): Promise<BotConnector[]>
  backupSchedule(): Promise<import("./bot-backup-schedule").BotBackupScheduleView>
  changeBackupSchedule(
    input: import("./bot-backup-schedule").BotBackupScheduleChange
  ): Promise<import("./bot-backup-schedule").BotBackupScheduleState>
  teachRetry(input: import("./bot-teach").BotTeachRetryInput): Promise<BotTeachSession>
  skillDependencies(
    input: import("./bot-skill-references").BotSkillSelection
  ): Promise<import("./bot-skill-dependencies").BotSkillDependencyView>
  checkSkillDependencies(
    input: import("./bot-skill-dependencies").BotCheckSkillDependencies
  ): Promise<import("./bot-skill-dependencies").BotSkillDependencyReceipt>
  skillTrials(botId: string): Promise<BotSkillTrial[]>
  trialSkill(input: import("./bot-skill-trial").BotSkillTrialInput): Promise<BotSkillTrial>
  reviewSkillTrial(input: {
    expectedDataEpoch?: string
    id: string
    verdict: "passed" | "failed"
    note: string
  }): Promise<BotSkillTrial>
  teachStatus(botId: string): Promise<BotTeachSession | null>
  teachStart(input: import("./bot-teach").BotTeachStartInput): Promise<BotTeachSession>
  teachPause(input: { id: string; paused: boolean }): Promise<BotTeachSession>
  teachStop(input: { id: string; save: boolean }): Promise<BotTeachSession>
  emitEvent(input: {
    nonce: string
    topic: string
    payload: string
    version?: import("./bot-event-state").BotEventVersion
  }): Promise<{ runIds: string[] }>
  webhook(
    input: import("./bot-webhooks").BotWebhookAddress
  ): Promise<import("./bot-webhooks").BotWebhookView>
  changeWebhook(
    input: import("./bot-webhooks").BotWebhookChange
  ): Promise<import("./bot-webhooks").BotWebhookChanged>
  restartWebhook(
    input: import("./bot-webhooks").BotWebhookAddress
  ): Promise<import("./bot-webhooks").BotWebhookView>
  runRoutine(input: import("./bot-routines").BotRunRoutineInput): Promise<BotRun>
  artifacts(conversationId: string): Promise<BotArtifact[]>
  deleteFile(
    input: import("./bot-file-lifecycle").BotFileDeleteInput
  ): Promise<import("./bot-file-lifecycle").BotFileDeleted>
  filePreview(input: BotFilePreviewRequest): Promise<BotFilePreview>
  provideSecret(input: BotSecretInput): Promise<void>
  secrets(botId: string): Promise<BotSecretCatalog>
  saveSecret(input: BotSecretSaveInput): Promise<BotSecretMetadata>
  deleteSecret(input: { botId: string; id: string; revision: number }): Promise<void>
  cancelFilePreview(input: { conversationId: string; requestId: string }): Promise<void>
  upload(input: {
    nonce: string
    conversationId: string
    name: string
    mime: string
    base64: string
  }): Promise<BotArtifact>
  download(id: string): Promise<{ artifact: BotArtifact; base64: string }>
  peerExchange(
    input: import("./bot-peer-exchange").BotPeerExchangeRequest
  ): Promise<import("./bot-peer-exchange").BotPeerExchange>
  runHistory(
    input: import("./bot-run-history").BotRunHistoryRequest
  ): Promise<import("./bot-run-history").BotRunHistory>
  effectDetail(
    input: import("./bot-run-history").BotEffectDetailRequest
  ): Promise<import("./bot-run-history").BotEffectDetail>
  interactionDetail(
    input: import("./bot-run-history").BotInteractionDetailRequest
  ): Promise<import("./bot-run-history").BotInteractionDetail>
  effects(runId: string): Promise<BotEffect[]>
  worktreeDetail(
    input: import("./bot-run-history").BotRunAddress
  ): Promise<import("./bot-worktree").BotWorktreeDetail>
  worktreeMerge(
    input: import("./bot-worktree").BotWorktreeMerge
  ): Promise<import("./bot-worktree").BotWorktreeSummary>
  worktreeCleanup(
    input: import("./bot-worktree").BotWorktreeCleanup
  ): Promise<import("./bot-worktree").BotWorktreeSummary>
  workflowControl(
    input: import("./bot-workflow-control").BotWorkflowControl
  ): Promise<import("./bot-workflow-control").BotWorkflowControlReceipt>
  recover(input: BotRecoveryInput): Promise<BotRun>
  computerOpen(
    address: string | import("./bot-run-history").BotRunAddress
  ): Promise<BotBrowserControl>
  computerFrame(
    address: string | import("./bot-run-history").BotRunAddress
  ): Promise<BotBrowserFrame>
  computerTake(
    target: BotBrowserTarget & {
      conversationId?: string
      threadRootId?: string
      replaceHuman?: boolean
    }
  ): Promise<BotBrowserTarget>
  computerRelease(target: BotBrowserTarget): Promise<BotBrowserTarget>
  computerInput(input: { target: BotBrowserTarget; input: BotHumanInput }): Promise<void>
  nativeComputerOpen(
    address: string | import("./bot-run-history").BotRunAddress
  ): Promise<import("./bot-native-desktop").BotNativeDesktopTarget>
  nativeComputerWindows(target: import("./bot-native-desktop").BotNativeDesktopTarget): Promise<
    Array<{
      viewId: string
      title: string
      window: import("./bot-native-desktop").NativeDesktopWindow
    }>
  >
  nativeComputerSelect(input: {
    target: import("./bot-native-desktop").BotNativeDesktopTarget
    viewId: string
  }): Promise<import("./bot-native-desktop").BotNativeDesktopTarget>
  nativeComputerObserve(
    target: import("./bot-native-desktop").BotNativeDesktopTarget
  ): Promise<import("./bot-native-desktop").NativeDesktopObservation>
  nativeComputerPrepareSecret(input: {
    target: import("./bot-native-desktop").BotNativeDesktopTarget
    elementId: string
  }): Promise<import("./bot-native-desktop").BotNativeDesktopSecretDestination>
  nativeComputerProvideSecret(input: {
    target: import("./bot-native-desktop").BotNativeDesktopTarget
    token: string
    value: string
  }): Promise<void>
  nativeComputerFrame(
    address: string | import("./bot-run-history").BotRunAddress
  ): Promise<import("./bot-native-desktop").BotNativeDesktopFrame>
  nativeComputerTake(input: {
    target: import("./bot-native-desktop").BotNativeDesktopTarget
    replaceHuman?: boolean
  }): Promise<import("./bot-native-desktop").BotNativeDesktopTarget>
  nativeComputerRelease(
    target: import("./bot-native-desktop").BotNativeDesktopTarget
  ): Promise<import("./bot-native-desktop").BotNativeDesktopTarget>
  nativeComputerInput(input: {
    target: import("./bot-native-desktop").BotNativeDesktopTarget
    input: import("./bot-native-desktop").BotNativeDesktopHumanInput
  }): Promise<void>
  status(): Promise<BotHostStatus>
  snapshot(input?: import("./bot-run-output").BotSnapshotRequest): Promise<BotWorkspaceSnapshot>
  runOutput(
    input: import("./bot-run-output").BotRunOutputRequest
  ): Promise<import("./bot-run-output").BotRunOutputPage>
  openRuns(
    input: import("./bot-work-pages").BotWorkPageRequest
  ): Promise<import("./bot-work-pages").BotOpenRunsPage>
  pendingInteractions(
    input: import("./bot-work-pages").BotWorkPageRequest
  ): Promise<import("./bot-work-pages").BotPendingWorkPage>
  pendingCard(
    input: import("./bot-work-pages").BotPendingCardRequest
  ): Promise<import("./bot-work-pages").BotPendingCard>
  trackedWork(
    input: import("./bot-work-pages").BotTrackedWorkRequest
  ): Promise<import("./bot-work-pages").BotTrackedWorkStates>
  notificationEvents(
    input: import("./bot-work-notifications").BotNotificationEventsRequest
  ): Promise<import("./bot-work-notifications").BotNotificationEventPage>
  events(after: number): Promise<BotEvent[]>
  create(input: BotCreateInput): Promise<{ bot: CoworkBot; conversationId: string }>
  clone(input: BotCloneInput): Promise<{ bot: CoworkBot; conversationId: string }>
  importThreadContext(
    input: import("./bot-context-import").BotContextImport
  ): Promise<import("./bot-context-import").BotContextImportReceipt>
  setReadState(input: BotReadInput): Promise<BotReadState>
  reorderPinned(input: BotReorderPinnedInput): Promise<BotPinnedOrder>
  update(input: BotUpdateInput): Promise<CoworkBot>
  delete(input: { id: string; revision: number; expectedDataEpoch?: string }): Promise<void>
  createGroup(input: BotGroupCreateInput): Promise<BotConversation>
  updateGroup(input: BotGroupUpdateInput): Promise<BotConversation>
  send(input: BotSendInput): Promise<BotSendReceipt>
  message(input: { conversationId: string; id: string }): Promise<BotMessage>
  messages(input: {
    conversationId: string
    threadRootId?: string
    before?: number
    after?: number
    limit?: number
  }): Promise<BotMessage[]>
  cancel(runId: string): Promise<BotRun>
  answerIntroductionQuestion(
    input: import("./bot-introduction-question").BotIntroductionQuestionReply
  ): Promise<import("./bot-introduction-question").BotIntroductionQuestionReceipt>
  answer(input: {
    id: string
    revision: number
    answer: string
    /** Required for typed ordinary forms; older question callers retain their contract. */
    expectedDataEpoch?: string
    computerHelpTarget?: import("./bot-computer-help").BotComputerHelpReturn
    remember?: boolean
  }): Promise<BotInteraction>
  approvalRules(botId: string): Promise<import("./bot-approval-rules").BotApprovalRules>
  autoReviewSettings(botId: string): Promise<import("./bot-auto-review").BotAutoReviewSettings>
  changeAutoReview(
    input: import("./bot-auto-review").BotAutoReviewChange
  ): Promise<import("./bot-auto-review").BotAutoReviewSettings>
  changeApprovalRule(
    input: import("./bot-approval-rules").BotApprovalRuleChange
  ): Promise<import("./bot-approval-rules").BotApprovalRules>
  memoryPolicy(botId: string): Promise<import("./bot-memory").BotMemoryPolicy>
  setMemoryPolicy(
    input: import("./bot-memory").BotMemoryPolicyInput
  ): Promise<import("./bot-memory").BotMemoryPolicy>
  retryMemory(
    input: import("./bot-memory").BotMemoryRetryInput
  ): Promise<import("./bot-memory").BotMemoryPolicy>
  sharedMemories(input: import("./bot-memory").BotSharedMemoryAddress): Promise<BotMemory[]>
  saveSharedMemory(input: import("./bot-memory").BotSharedMemorySave): Promise<BotMemory>
  deleteSharedMemory(input: import("./bot-memory").BotSharedMemoryDelete): Promise<{ id: string }>
  memories(botId: string): Promise<BotMemory[]>
  saveMemory(input: import("./bot-memory").BotMemorySaveInput): Promise<BotMemory>
  deleteMemory(
    input: import("./bot-memory").BotMemoryDeleteInput
  ): Promise<import("./bot-memory").BotMemoryDeleteReceipt>
  installedSkills(botId: string): Promise<{
    ready: boolean
    warning: string | null
    skills: Pick<BotSkill, "id" | "name" | "version" | "sourceName" | "verified">[]
  }>
  inspectInstalledSkill(input: { botId: string; id: string; version: number }): Promise<BotSkill>
  skillLibrary(): Promise<import("./bot-skill-library").BotLibrarySkill[]>
  setSkillEnabled(
    input: import("./bot-skill-library").BotSkillEnablementInput
  ): Promise<import("./bot-skill-library").BotSkillEnablementReceipt>
  publishSkill(
    input: import("./bot-skill-library").BotPublishSkill
  ): Promise<import("./bot-skill-library").BotLibrarySkill>
  withdrawSkill(input: import("./bot-skill-library").BotWithdrawSkill): Promise<{ id: string }>
  asyncTasks(
    input: import("./bot-async-tasks").BotAsyncTasksRequest
  ): Promise<import("./bot-async-tasks").BotAsyncTasksPage>
  shellJob(
    input: import("./bot-shell-jobs").BotShellJobRead
  ): Promise<import("./bot-shell-jobs").BotShellJobView>
  stopShellJob(
    input: import("./bot-shell-jobs").BotShellJobStop
  ): Promise<import("./bot-shell-jobs").BotShellJobView>
  availableSkills(botId: string): Promise<import("./bot-types").BotSkillSummary[]>
  skills(botId: string): Promise<BotSkill[]>
  skillMaintenance(
    input: import("./bot-skill-maintenance").BotSkillMaintenanceAddress
  ): Promise<import("./bot-skill-maintenance").BotSkillMaintenanceView>
  configureSkillMaintenance(
    input: import("./bot-skill-maintenance").BotSkillMaintenancePolicyInput
  ): Promise<import("./bot-skill-maintenance").BotSkillMaintenancePolicy>
  changeSkillMaintenance(
    input: import("./bot-skill-maintenance").BotSkillMaintenanceChange
  ): Promise<import("./bot-skill-maintenance").BotSkillMaintenanceEntry>
  runSkillMaintenance(
    input: import("./bot-skill-maintenance").BotSkillMaintenanceRun
  ): Promise<import("./bot-skill-maintenance").BotSkillMaintenanceResult>
  saveSkill(input: import("./bot-skill-save").BotSaveSkillInput): Promise<BotSkill>
  deleteSkill(
    input: import("./bot-skill-deletion").BotDeleteSkillInput
  ): Promise<import("./bot-skill-deletion").BotDeleteSkillReceipt>
  routines(botId: string): Promise<BotRoutine[]>
  routineHistory(
    input: import("./bot-routines").BotRoutineHistoryRequest
  ): Promise<import("./bot-routines").BotRoutineHistory>
  routineDispatchHistory(
    input: import("./bot-routine-dispatch").BotRoutineDispatchRequest
  ): Promise<import("./bot-routine-dispatch").BotRoutineDispatchHistory>
  deleteRoutine(
    input: import("./bot-routines").BotDeleteRoutineInput
  ): Promise<import("./bot-routines").BotDeleteRoutineReceipt>
  saveRoutine(input: import("./bot-routines").BotSaveRoutineInput): Promise<BotRoutine>
}
export type BotRpcMethod = keyof CoworkBotAPI
