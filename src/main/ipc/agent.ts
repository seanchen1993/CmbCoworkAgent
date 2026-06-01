import { IpcMain, BrowserWindow, dialog } from "electron"
import { nowIsoLocal } from "../util/local-time"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { Command } from "@langchain/langgraph"
import {
  createAgentRuntime,
  getSkillEvolutionThreshold,
  type ModelRetryHooks
} from "../agent/runtime"
import { getThread } from "../db"
import { summarizeAndSave } from "../memory/summarizer"
import { getMemoryStore } from "../memory/store"
import { ChatOpenAI } from "@langchain/openai"
import {
  getCustomModelConfigs,
  isMemoryEnabled,
  getCustomSkillsDir,
  invalidateEnabledSkillsCache,
  isOnlineSkillEvolutionEnabled,
  isSkillAutoProposeEnabled,
  getGlobalRoutingMode,
  getEnabledHooks,
  getEnabledPluginHookMetadata,
  getEnabledSkillHookMetadata,
  getHooks,
  getWorkspaceHooks,
  getEnabledPluginHooks,
  getEnabledSkillHooks,
  getEnabledSkillsSources,
  getEnabledPluginSkillSourceMetadata,
  getDisabledSkillDirs,
  getHookLoggingConfig
} from "../storage"
import { resolveModel, rememberRoutingDecision, rememberRoutingFeedback } from "../routing"
import { notifyIfBackground, stripThink } from "../services/notify"
import { showPetCompletedTaskNotice } from "../pet"
import { trackEvent } from "../services/event-reporter"
import { trySendChatXReply } from "../services/chatx"
import { setAdoptionContext } from "../services/adoption-tracker"
import { TraceCollector } from "../agent/trace/collector"
import {
  requestSkillIntent,
  requestSkillConfirmation,
  sanitizeSkillId
} from "../agent/tools/skill-evolution-tool"
import { mkdirSync, writeFileSync } from "fs"
import { join, resolve } from "path"
import { v4 as uuid } from "uuid"
import { LocalSandbox } from "../agent/local-sandbox"
import { SkillUsageDetector } from "../agent/skill-evolution/usage-detector"
import { ToolCallCounter } from "../agent/skill-evolution/tool-call-counter"
import {
  resetSkillEvolutionSession,
  shouldResetSkillEvolutionSessionAfterIntent
} from "../agent/skill-evolution/session-state"
import {
  appendSkillProposalWindowTurn,
  buildSkillProposalWindowContext,
  getRecentSkillUsageNames,
  snapshotSkillProposalWindow,
  isSkillProposalWindowContext,
  type SkillProposalWindowContext
} from "../agent/skill-evolution/proposal-window"
import {
  buildWorthinessPrompt,
  getSkillProposalMode,
  parseWorthinessResponse,
  parseSkillProposal,
  shouldEvaluateSkillProposalWindow,
  shouldJudgeSkillWorthiness,
  shouldProposeSkill,
  type SkillProposal,
  type WorthinessResult
} from "../agent/skill-evolution/skill-proposal-logic"
import { isRetryableApiError, buildOrderedChain, type FailoverAttempt } from "../agent/failover"
import { type HookContext, type HookResultCallback } from "../hooks/runner"
import {
  createHookScope,
  normalizePathKey,
  normalizePluginId,
  normalizeSkillName,
  resolveEnabledHooksForRun,
  type HookScopeController
} from "../hooks/scope"
import type { HookConfig, HookEvent, HookResult } from "../hooks/types"
import { fireSessionStartOnce } from "../hooks/session-lifecycle"
import { runHooksEnriched } from "../hooks/required-skill"
import { isHookHaltError, throwIfHookHalt, type HookHaltError } from "../hooks/halt"
import { activateSkillLifecycle, formatSkillHookContext } from "../agent/skill-lifecycle/activation"
import { parseSkillUseBlock, type ParsedSkillUseBlock } from "../agent/skill-lifecycle/marker"
import { SkillLifecycleRegistry, type SkillLifecycleMatch } from "../agent/skill-lifecycle/registry"
import { createSkillUseTracker, type SkillUseTracker } from "../agent/skill-lifecycle/tracker"
import {
  runCompletionHooksWithRevision,
  type StopHookContext
} from "../agent/skill-lifecycle/completion-hooks"
import {
  discardAgentAutoCommitTracking,
  maybeAutoCommitAfterAgentRun,
  recordAgentTouchedFile,
  startAgentGitSnapshot,
  type AgentGitSnapshot
} from "../services/agent-auto-commit"
import { scheduleAutoInstallGitHooksForPath } from "../services/git-hook-service"
import {
  buildHarnessFeatureAgentContext
} from "../harness-board/service"
import type { AgentAutoCommitResult } from "../types"
import { formatAutoCommitLines } from "../../shared/auto-commit-format"
import { makeHookResultCallback, makeHookSkippedCallback } from "../hooks/result-callback"
import type { ScopeSkipCallback } from "../hooks/scope"
import { notifyHooksChanged } from "../hooks/notifications"
import type {
  AgentInvokeParams,
  AgentResumeParams,
  AgentInterruptParams,
  AgentCancelParams
} from "../types"

const MIN_CHARS_FOR_MEMORY = 200
const MAX_STOP_HOOK_REVISIONS = 2
const MAX_STOP_CONTEXT_TEXT_CHARS = 40_000
const STOP_HOOK_REVISION_PROMPT_PREFIX = "[[CMBDEVCLAW_STOP_HOOK_REVISION]]"

// Track active runs for cancellation
const activeRuns = new Map<string, AbortController>()

interface HarnessAgentContext {
  workingDirPromptAppendix?: string
  pluginOutputDir?: string
  systemId?: string
}

function getHarnessAgentContext(metadata: Record<string, unknown>): HarnessAgentContext {
  try {
    const featureContext = buildHarnessFeatureAgentContext(metadata)
    if (!featureContext) return {}

    return {
      workingDirPromptAppendix: featureContext.systemPromptInject,
      pluginOutputDir: featureContext.pluginOutputDir,
      systemId: featureContext.systemId
    }
  } catch (error) {
    console.warn("[HarnessBoard] Failed to build harness agent context:", error)
    return {}
  }
}

function sendHookHalt(window: BrowserWindow, channel: string, error: HookHaltError): void {
  window.webContents.send(channel, {
    type: "custom",
    data: {
      type: "hook_blocked",
      hookEvent: error.hookEvent,
      action: "halt",
      reason: error.reason,
      systemMessage: error.systemMessage
    }
  })
  window.webContents.send(channel, { type: "done" })
}

/**
 * Thread-scoped hook state shared across IPC handler boundaries. A new
 * `agent:invoke` starts a fresh turn, but keeps the session-level persistent
 * hook keys that were activated by earlier skill / plugin use in this thread.
 * `agent:resume` / `agent:interrupt` reuse the current turn state. Without
 * this Map, every IPC handler entry would reset hookScope etc. and scoped
 * hooks would stop firing after a HITL pause or later user message.
 */
interface TurnState {
  hookScope: HookScopeController
  skillUseTracker: SkillUseTracker
  skillHookKeys: Set<string>
  stopContextCollector: StopHookContextCollector
  runToken: string
  turnId?: string
}

const turnStates = new Map<string, TurnState>()

function createTurnState(initialUserMessage?: string, turnId?: string): TurnState {
  return {
    hookScope: createHookScope(),
    skillUseTracker: createSkillUseTracker(),
    skillHookKeys: new Set<string>(),
    stopContextCollector: new StopHookContextCollector(initialUserMessage),
    runToken: uuid(),
    turnId
  }
}

function resetTurnStateForNewInvoke(
  state: TurnState,
  initialUserMessage?: string,
  turnId?: string
): void {
  const snapshot = state.hookScope.snapshot()
  state.hookScope = createHookScope()
  state.hookScope.activatePersistentHookKeys(snapshot.persistentHookKeys ?? [])
  state.skillUseTracker = createSkillUseTracker()
  state.skillHookKeys = new Set<string>()
  state.stopContextCollector = new StopHookContextCollector(initialUserMessage)
  state.turnId = turnId
}

function getOrCreateTurnState(
  threadId: string,
  initialUserMessage?: string,
  turnId?: string
): TurnState {
  const existing = turnStates.get(threadId)
  if (existing) return existing
  const fresh = createTurnState(initialUserMessage, turnId)
  turnStates.set(threadId, fresh)
  return fresh
}

/**
 * Ensure `turnState.turnId` is non-empty so hook events emitted during this
 * run can be grouped on the renderer side. The `agent:invoke` path always
 * supplies the renderer-side user message id, but `agent:resume` /
 * `agent:interrupt` do not — and when the original turnState was disposed
 * (process restart, thread idle eviction), all hook events would otherwise
 * fall into the `__background__` bucket and look orphaned.
 *
 * Returns the (possibly newly-assigned) turnId so callers can pass it into
 * any non-turnState-scoped helpers without re-reading.
 */
function ensureTurnId(turnState: TurnState, threadId: string, label: string): string {
  if (!turnState.turnId) {
    turnState.turnId = `${label}:${threadId}:${Date.now()}`
  }
  return turnState.turnId
}

function disposeTurnState(threadId: string): void {
  turnStates.delete(threadId)
}

export function disposeAgentThreadState(threadId: string): void {
  disposeTurnState(threadId)
}

export function disposeAllAgentThreadStates(): void {
  turnStates.clear()
}

function disposeTurnRuntimeState(state: TurnState): void {
  state.skillUseTracker = createSkillUseTracker()
  state.skillHookKeys = new Set<string>()
  state.stopContextCollector = new StopHookContextCollector()
}

function startTurnStateRun(state: TurnState): string {
  state.runToken = uuid()
  return state.runToken
}

function shouldDisposeTurnState(threadId: string, runToken: string): boolean {
  return turnStates.get(threadId)?.runToken === runToken
}

/**
 * Snapshot every enabled hook (global + workspace + plugin + skill) so the
 * prune step can search across all sources for `persistAfterInterrupt: true`.
 * The lists are filtered for `enabled` already at the storage layer.
 */
function getAllEnabledHooksForInterrupt(workspacePath: string | undefined): HookConfig[] {
  return [
    ...getEnabledHooks(workspacePath),
    ...getEnabledPluginHookMetadata(),
    ...getEnabledSkillHookMetadata()
  ]
}

async function maybeRunSubagentStopHooksFromStreamPayload(params: {
  payload: unknown
  workspacePath?: string
  pluginOutputDir?: string
  systemId?: string
  threadId: string
  turnId?: string
  hookScope: HookScopeController
  firedToolCallIds: Set<string>
  onHookResult?: HookResultCallback
  /** Diagnostic-only callback for "matched event but filtered out by scope". */
  onHookSkipped?: ScopeSkipCallback
}): Promise<void> {
  const [msgChunk] = params.payload as [
    { id?: unknown; kwargs?: Record<string, unknown>; content?: unknown } | undefined
  ]
  if (!msgChunk) return

  const kwargs = (msgChunk.kwargs || {}) as Record<string, unknown>
  const classId: string[] = Array.isArray(msgChunk.id) ? msgChunk.id : []
  const className = classId[classId.length - 1] || ""
  const isTool = className.includes("Tool") || kwargs.type === "tool"
  const toolCallId = typeof kwargs.tool_call_id === "string" ? kwargs.tool_call_id : ""
  if (!isTool || kwargs.name !== "task" || !toolCallId) return
  if (params.firedToolCallIds.has(toolCallId)) return
  params.firedToolCallIds.add(toolCallId)

  const additionalKwargs = kwargs.additional_kwargs as Record<string, unknown> | undefined
  const isErr =
    kwargs.status === "error" || kwargs.is_error === true || additionalKwargs?.is_error === true
  const subagentStopContext: HookContext = {
    workspacePath: params.workspacePath,
    pluginOutputDir: params.pluginOutputDir,
    systemId: params.systemId,
    sessionId: params.threadId,
    turnId: params.turnId,
    subagent: {
      id: toolCallId,
      status: isErr ? "failed" : "completed"
    }
  }
  const result = await runHooksEnriched(
    resolveEnabledHooksForRun(
      params.workspacePath,
      "SubagentStop",
      subagentStopContext,
      params.hookScope,
      params.onHookSkipped
    ),
    "SubagentStop",
    subagentStopContext,
    params.onHookResult
  )
  throwIfHookHalt("SubagentStop", result, "SubagentStop hook stopped the turn")
}

/**
 * At a HITL interrupt boundary (resume / interrupt entry), drop activations
 * for skills / plugins that have no `persistAfterInterrupt: true` hook.
 * Anything kept stays scoped for the next stream; anything pruned reverts to
 * pre-interrupt fresh-state behaviour. `stopContextCollector` is intentionally
 * not pruned — it tracks turn-wide history regardless of skill scope.
 */
function pruneTurnStateAtInterrupt(state: TurnState, allHooks: readonly HookConfig[]): void {
  const keepPluginIds = new Set<string>()
  const keepSkillPaths = new Set<string>()
  const keepSkillNames = new Set<string>()
  for (const hook of allHooks) {
    if (hook.persistAfterInterrupt !== true) continue
    const scoped = hook as HookConfig & {
      pluginId?: string
      skillName?: string
      skillPath?: string
      skillRoot?: string
    }
    if (typeof scoped.pluginId === "string" && scoped.pluginId.length > 0) {
      keepPluginIds.add(normalizePluginId(scoped.pluginId))
    }
    const skillPath = scoped.skillPath ?? scoped.skillRoot ?? hook.hookSourceRoot
    if (typeof skillPath === "string" && skillPath.length > 0) {
      keepSkillPaths.add(normalizePathKey(skillPath))
    }
    if (typeof scoped.skillName === "string" && scoped.skillName.length > 0) {
      keepSkillNames.add(normalizeSkillName(scoped.skillName))
    }
  }

  state.hookScope.activatePersistentHooks(
    allHooks.filter((hook) => {
      if (hook.persistAfterInterrupt !== true) return false
      const scoped = hook as HookConfig & {
        pluginId?: string
        skillName?: string
        skillPath?: string
        skillRoot?: string
      }
      const hookPluginId = normalizePluginId(scoped.pluginId)
      const hookSkillPath = normalizePathKey(
        scoped.skillPath ?? scoped.skillRoot ?? hook.hookSourceRoot
      )
      const hookSkillName = normalizeSkillName(scoped.skillName)
      return (
        (hookPluginId && state.hookScope.activePluginIds.has(hookPluginId)) ||
        (hookSkillPath && state.hookScope.activeSkillPaths.has(hookSkillPath)) ||
        (hookSkillName && state.hookScope.activeSkillNames.has(hookSkillName))
      )
    })
  )

  state.hookScope.pruneActivations({
    keepPluginId: (id) => keepPluginIds.has(id),
    keepSkillPath: (path) => keepSkillPaths.has(path),
    keepSkillName: (name) => keepSkillNames.has(name)
  })
  state.skillUseTracker.pruneRecords((record) => {
    return (
      keepSkillPaths.has(normalizePathKey(record.rootDir)) ||
      keepSkillNames.has(normalizeSkillName(record.name))
    )
  })
  // skillHookKeys is keyed by the same normalized rootDir path the scope
  // uses, so we can filter against keepSkillPaths directly.
  for (const key of [...state.skillHookKeys]) {
    if (!keepSkillPaths.has(key)) state.skillHookKeys.delete(key)
  }
}

interface ExplicitSkillActivation {
  parsed: ParsedSkillUseBlock
  skill?: SkillLifecycleMatch
  hookContext?: string
  blocked: boolean
  reason?: string
}

function normalizeSkillPathKey(input: string): string {
  const normalized = resolve(input).replace(/\\/g, "/").replace(/\/+$/, "")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function isSameOrChildSkillPath(targetPath: string, parentPath: string): boolean {
  const target = normalizeSkillPathKey(targetPath)
  const parent = normalizeSkillPathKey(parentPath)
  return target === parent || target.startsWith(`${parent}/`)
}

function isDisabledSkillMatch(skill: SkillLifecycleMatch): boolean {
  return getDisabledSkillDirs().some((dir) => isSameOrChildSkillPath(skill.rootDir, dir))
}

async function buildSkillLifecycleRegistryForHooks(): Promise<SkillLifecycleRegistry | null> {
  const rootSources = await getEnabledSkillsSources()
  const pluginSources = getEnabledPluginSkillSourceMetadata()
  const sources = [...rootSources, ...pluginSources]
  return sources.length > 0 ? new SkillLifecycleRegistry(sources) : null
}

async function activateExplicitSkillFromMessage({
  message,
  workspacePath,
  pluginOutputDir,
  systemId,
  sessionId,
  turnId,
  hookScope,
  firedSkillKeys,
  skillUseTracker,
  onHookResult,
  onHookSkippedFactory
}: {
  message: string
  workspacePath: string
  pluginOutputDir?: string
  systemId?: string
  sessionId: string
  turnId?: string
  hookScope: HookScopeController
  firedSkillKeys: Set<string>
  skillUseTracker: SkillUseTracker
  onHookResult?: HookResultCallback
  /**
   * Factory that builds a per-event scope-skip callback. `resolveHooks` is
   * called with the actual event, so we construct the callback there with
   * the matching event bound in its closure. Optional — diagnostic-only.
   */
  onHookSkippedFactory?: (event: HookEvent) => ScopeSkipCallback | undefined
}): Promise<ExplicitSkillActivation | null> {
  const parsed = parseSkillUseBlock(message)
  if (!parsed) return null

  const registry = await buildSkillLifecycleRegistryForHooks()
  const skill = registry?.resolveExplicit({
    skillName: parsed.skillName,
    skillPath: parsed.skillPath
  })

  if (!skill || isDisabledSkillMatch(skill)) {
    return {
      parsed,
      blocked: true,
      reason: `显式选择的技能不存在或已禁用：${parsed.skillName}`
    }
  }

  const result = await activateSkillLifecycle({
    skill,
    trigger: "explicit",
    toolName: "skill_select",
    toolArgs: {
      skillName: parsed.skillName,
      skillPath: parsed.skillPath
    },
    toolResult: JSON.stringify({
      selected: true,
      trigger: "explicit",
      skillName: skill.name,
      skillPath: skill.path
    }),
    workspacePath,
    pluginOutputDir,
    systemId,
    sessionId,
    turnId,
    hookScope,
    firedSkillKeys,
    skillUseTracker,
    resolveHooks: (event: HookEvent, context: HookContext): HookConfig[] =>
      resolveEnabledHooksForRun(
        workspacePath,
        event,
        context,
        hookScope,
        onHookSkippedFactory?.(event)
      ),
    onHookResult
  })

  return {
    parsed,
    skill,
    hookContext: formatSkillHookContext(skill, result.notes) ?? undefined,
    blocked: result.blocked,
    reason: result.reason
  }
}

interface ActiveHookSummary {
  global: number
  plugin: number
  skill: number
  workspace: number
  total: number
}

function getActiveHookSummary(workspacePath?: string): ActiveHookSummary {
  const global = getHooks().filter((hook) => hook.enabled).length
  const plugin = getEnabledPluginHooks().filter((hook) => hook.enabled).length
  const skill = getEnabledSkillHooks().filter((hook) => hook.enabled).length
  const workspace = workspacePath
    ? getWorkspaceHooks(workspacePath).filter((hook) => hook.enabled).length
    : 0
  return {
    global,
    plugin,
    skill,
    workspace,
    total: global + plugin + skill + workspace
  }
}

function formatActiveHookNotice(summary: ActiveHookSummary): string | null {
  // 全局 / 工作区 hook 进入本轮即生效；插件 / 技能 hook 走作用域化激活
  // （只有当其所属插件/技能本轮被使用时才会触发），不能与前两类合并展示，
  // 否则用户会以为所有 plugin/skill hook 都会跑。
  const baseTotal = summary.global + summary.workspace
  const scopedTotal = summary.plugin + summary.skill
  if (baseTotal === 0 && scopedTotal === 0) return null

  const segments: string[] = []
  if (baseTotal > 0) {
    const baseParts = [
      summary.global > 0 ? `全局 ${summary.global}` : "",
      summary.workspace > 0 ? `工作区 ${summary.workspace}` : ""
    ].filter(Boolean)
    segments.push(`本轮已启用 ${baseTotal} 个钩子（${baseParts.join("，")}）`)
  }
  if (scopedTotal > 0) {
    const scopedParts = [
      summary.plugin > 0 ? `插件 ${summary.plugin}` : "",
      summary.skill > 0 ? `技能 ${summary.skill}` : ""
    ].filter(Boolean)
    segments.push(`按需触发：${scopedParts.join("，")}（仅在对应插件/技能本轮被使用时生效）`)
  }
  return segments.join("；")
}

function sendHookNotice(window: BrowserWindow, channel: string, message: string): void {
  window.webContents.send(channel, {
    type: "custom",
    data: { type: "hook_notice", message }
  })
}

function sendActiveHookNotice(
  window: BrowserWindow,
  channel: string,
  workspacePath?: string
): void {
  if (!getHookLoggingConfig().enabled) return
  const message = formatActiveHookNotice(getActiveHookSummary(workspacePath))
  if (!message) return
  sendHookNotice(window, channel, message)
}

function sendAutoCommitResult(
  window: BrowserWindow,
  channel: string,
  result: AgentAutoCommitResult
): void {
  if (result.status === "disabled") return
  window.webContents.send(channel, {
    type: "custom",
    data: { type: "auto_commit_result", result }
  })
}

async function confirmAutoCommit(
  window: BrowserWindow,
  result: AgentAutoCommitResult
): Promise<boolean> {
  const lines = formatAutoCommitLines(result)
  const response = await dialog.showMessageBox(window, {
    type: "question",
    buttons: ["提交", "取消"],
    defaultId: 0,
    cancelId: 1,
    title: "确认自动提交",
    message: result.message || "是否提交本轮 Agent 改动？",
    detail: lines.join("\n")
  })
  return response.response === 0
}

async function finalizeAutoCommit({
  threadId,
  workspacePath,
  userPrompt,
  snapshot,
  window,
  channel
}: {
  threadId: string
  workspacePath: string | undefined
  userPrompt?: string
  snapshot: AgentGitSnapshot | null
  window: BrowserWindow
  channel: string
}): Promise<void> {
  const result = await maybeAutoCommitAfterAgentRun({
    threadId,
    workspacePath,
    userPrompt,
    snapshot,
    confirm: (preview) => confirmAutoCommit(window, preview)
  })
  sendAutoCommitResult(window, channel, result)
}

async function beginAutoCommitTracking(
  threadId: string,
  workspacePath: string | undefined
): Promise<{
  snapshot: AgentGitSnapshot | null
  onFileMutation?: (filePath: string) => void
}> {
  let snapshot: AgentGitSnapshot | null = null
  try {
    snapshot = await startAgentGitSnapshot(threadId, workspacePath)
  } catch (error) {
    console.warn("[AutoCommit] failed to capture start snapshot:", error)
  }
  return {
    snapshot,
    onFileMutation: workspacePath
      ? (filePath: string) => {
          recordAgentTouchedFile(threadId, workspacePath, filePath)
          scheduleAutoInstallGitHooksForPath(workspacePath, filePath)
        }
      : undefined
  }
}

interface SerializedHookMessage {
  id?: string[]
  content?: unknown
  kwargs?: {
    id?: string
    type?: string
    content?: unknown
    name?: string
    tool_call_id?: string
    tool_calls?: Array<{
      id?: string
      name?: string
      args?: Record<string, unknown>
    }>
  }
}

function serializeStreamData(data: unknown): unknown {
  return JSON.parse(JSON.stringify(data))
}

function trimStopContextText(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= MAX_STOP_CONTEXT_TEXT_CHARS) return trimmed
  return `${trimmed.slice(0, MAX_STOP_CONTEXT_TEXT_CHARS)}\n...(truncated)`
}

function extractStopContextText(raw: unknown): string {
  if (typeof raw === "string") return raw
  if (!Array.isArray(raw)) return ""
  return raw
    .map((block) => {
      if (typeof block === "string") return block
      if (!block || typeof block !== "object") return ""
      const item = block as { type?: string; text?: string; content?: string }
      if (typeof item.text === "string") return item.text
      if (typeof item.content === "string") return item.content
      return ""
    })
    .filter(Boolean)
    .join("")
}

function isStopHookRevisionPrompt(text: string): boolean {
  return text.trimStart().startsWith(STOP_HOOK_REVISION_PROMPT_PREFIX)
}

function stopContextRole(
  className: string,
  kwargs: SerializedHookMessage["kwargs"]
): "user" | "assistant" | "tool" | "system" | "unknown" {
  if (className.includes("Human")) return "user"
  if (className.includes("AI")) return "assistant"
  if (className.includes("Tool")) return "tool"
  if (className.includes("System")) return "system"
  if (kwargs?.type === "human") return "user"
  if (kwargs?.type === "ai") return "assistant"
  if (kwargs?.type === "tool") return "tool"
  if (kwargs?.type === "system") return "system"
  return "unknown"
}

class StopHookContextCollector {
  private userMessage?: string
  private readonly assistantChunks: string[] = []
  private latestFinalAssistantResponse = ""
  private readonly countedAiMessageIds = new Set<string>()
  private readonly toolCallCounter = new ToolCallCounter()
  private readonly skillUsageDetector = new SkillUsageDetector()

  constructor(userMessage?: string) {
    if (userMessage) this.userMessage = userMessage
  }

  processStreamChunk(mode: string, payload: unknown): void {
    try {
      if (mode === "messages") {
        this.processMessagePayload(payload)
        return
      }
      if (mode === "values") {
        this.processValuesPayload(payload)
      }
    } catch (error) {
      console.warn("[Hooks] Failed to collect Stop hook context:", error)
    }
  }

  snapshot(overrides: StopHookContext = {}): StopHookContext {
    const context: StopHookContext = {}
    const userMessage = overrides.userMessage ?? this.userMessage
    const assistantResponse =
      overrides.assistantResponse ??
      (this.latestFinalAssistantResponse || this.assistantChunks.join("").trim())
    const toolCalls =
      overrides.toolCalls && overrides.toolCalls.length > 0
        ? overrides.toolCalls
        : this.toolCallCounter.getNames()
    const usedSkills =
      overrides.usedSkills && overrides.usedSkills.length > 0
        ? overrides.usedSkills
        : this.skillUsageDetector.getUsedSkillNames()

    if (userMessage) context.userMessage = trimStopContextText(userMessage)
    if (assistantResponse) context.assistantResponse = trimStopContextText(assistantResponse)
    if (toolCalls.length > 0) context.toolCalls = toolCalls
    if (usedSkills.length > 0) context.usedSkills = usedSkills
    return context
  }

  private processMessagePayload(payload: unknown): void {
    const [msgChunk] = payload as [SerializedHookMessage]
    if (!msgChunk) return
    const kwargs = msgChunk.kwargs || {}
    const classId = Array.isArray(msgChunk.id) ? msgChunk.id : []
    const className = classId[classId.length - 1] || ""
    const role = stopContextRole(className, kwargs)
    const text = extractStopContextText(kwargs.content ?? msgChunk.content)

    if (role === "user" && text.trim() && !isStopHookRevisionPrompt(text)) {
      this.userMessage = text.trim()
    }
    if (role === "assistant") {
      if (text) this.assistantChunks.push(text)
      this.observeToolCalls(kwargs.tool_calls, kwargs.id ?? "")
    }
  }

  private processValuesPayload(payload: unknown): void {
    const state = payload as {
      skillsMetadata?: Array<{ name?: string; path?: string }>
      messages?: SerializedHookMessage[]
    }
    if (Array.isArray(state.skillsMetadata) && state.skillsMetadata.length > 0) {
      this.skillUsageDetector.onSkillsMetadata(state.skillsMetadata)
    }
    if (!Array.isArray(state.messages)) return

    let lastUserIndex = -1
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const msg = state.messages[i]
      const kwargs = msg?.kwargs || {}
      const classId = Array.isArray(msg?.id) ? msg.id : []
      const className = classId[classId.length - 1] || ""
      if (stopContextRole(className, kwargs) !== "user") continue
      const text = extractStopContextText(kwargs.content ?? msg.content).trim()
      if (text && !isStopHookRevisionPrompt(text)) {
        this.userMessage = text
        lastUserIndex = i
        break
      }
    }

    const finalResponses: string[] = []
    const startIndex = lastUserIndex >= 0 ? lastUserIndex + 1 : 0
    for (let i = startIndex; i < state.messages.length; i++) {
      const msg = state.messages[i]
      const kwargs = msg?.kwargs || {}
      const classId = Array.isArray(msg?.id) ? msg.id : []
      const className = classId[classId.length - 1] || ""
      const role = stopContextRole(className, kwargs)
      if (role !== "assistant") continue

      const aiMessageId = typeof kwargs.id === "string" ? kwargs.id : ""
      this.observeToolCalls(kwargs.tool_calls, aiMessageId)
      if (Array.isArray(kwargs.tool_calls) && kwargs.tool_calls.length > 0) continue

      const text = extractStopContextText(kwargs.content ?? msg.content).trim()
      if (text) finalResponses.push(text)
    }

    if (finalResponses.length > 0) {
      this.latestFinalAssistantResponse = finalResponses[finalResponses.length - 1]
    }
  }

  private observeToolCalls(
    toolCalls: Array<{ id?: string; name?: string; args?: Record<string, unknown> }> | undefined,
    aiMessageId: string
  ): void {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return
    if (aiMessageId && this.countedAiMessageIds.has(aiMessageId)) return
    if (aiMessageId) this.countedAiMessageIds.add(aiMessageId)

    for (let index = 0; index < toolCalls.length; index++) {
      const toolCall = toolCalls[index]
      this.toolCallCounter.register(toolCall, aiMessageId, index)
      if (toolCall.name !== "read_file") continue
      const readPathRaw =
        (typeof toolCall.args?.path === "string" && toolCall.args.path) ||
        (typeof toolCall.args?.file_path === "string" && toolCall.args.file_path) ||
        ""
      if (readPathRaw) this.skillUsageDetector.onReadFilePath(readPathRaw)
    }
  }
}

// ─────────────────────────────────────────────────────────
// Auto skill proposal: generate a skill from conversation context
// ─────────────────────────────────────────────────────────

const SKILL_PROPOSAL_SYSTEM_PROMPT = `You are an expert at capturing reusable agent skills from conversation history.

Given a conversation between a user and an AI agent, your job is to extract a GENERALIZED, reusable skill.
Your primary task is to identify the underlying repeatable WORKFLOW or METHOD — not to describe the specific task instance.
Strip out all one-off details (file names, component names, specific bug descriptions, exact error messages, ticket IDs) and abstract to the task family.

Output ONLY valid JSON (no markdown, no explanation) with this exact shape:
{
  "name": "Short Human-Readable Name (3-6 words)",
  "skillId": "snake_case_identifier",
  "description": "One sentence: WHEN should this skill be loaded? Describe the recurring task pattern, not the one-off artifact.",
  "content": "Full SKILL.md content (including YAML frontmatter)"
}

SKILL.md format:
---
name: skill-name
description: Trigger description
version: 1.0.0
---

# Overview
Brief description of the generalized workflow.

## When to use
Recurring trigger patterns and task families.

## Steps / Guidelines
Concrete, generalizable instructions the agent should follow.

Generalization rules (CRITICAL — read carefully):
Target the right abstraction level — not too narrow, not too broad:
- TOO NARROW (bad):  "当用户要找 ChatContainer.tsx 里的 null pointer bug 时" — single file + single bug
- TOO BROAD (bad):   "当用户遇到任何代码问题时" — no useful specificity
- JUST RIGHT (good): "当用户要系统排查 React 组件的渲染或状态类 bug 时" — task family with clear domain boundary

More examples:
- BAD name:  "Fix ChatContainer Null Pointer Bug" | GOOD name: "React Component Bug Investigation"
- BAD steps: "1. Open ChatContainer.tsx 2. Check line 47" | GOOD steps: "1. Identify component boundary 2. Check state/prop flow"
- BAD trigger: "用户说 ChatContainer 崩溃" | GOOD trigger: "用户要排查 React 组件异常行为"

What to keep vs. strip:
- STRIP: specific file names, component names, exact error strings, line numbers, ticket IDs, one-off data values
- KEEP: framework names (React, Electron), patterns (IPC, state management), domain types (bug investigation, deployment, refactor)
- A skill scoped to a stable tool/framework (e.g. "Electron IPC debugging") is valid and reusable — don't over-generalize it to "any debugging"

Steps should describe the METHOD (how to approach the problem class), not the SOLUTION to this specific instance.
If the conversation is narrow, lift it one level: "how we fixed X" → "systematic approach to X-type problems".

Other rules:
- description is the MOST important field — it controls when the skill is injected in future sessions
- Output ONLY valid JSON, no other text`

/**
 * Broadcast a skill generation progress event to all renderer windows.
 * `phase`:
 *   "start"    — generation beginning (clears previous output)
 *   "token"    — incremental token chunk
 *   "done"     — generation complete, full raw text in `text`
 *   "error"    — generation failed
 */
function emitSkillGenerating(
  threadId: string,
  phase: "start" | "token" | "done" | "error",
  text = ""
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("skill:generating", { threadId, phase, text })
  }
}

/**
 * 生成宠物完成气泡中展示的任务名称。
 *
 * 优先使用用户显式命名过的线程标题；如果仍是默认线程名，则退回到本轮用户消息摘要。
 */
function getCompletedTaskTitle(threadTitle: string | undefined, message: string): string {
  const title = threadTitle?.trim()
  if (title && !/^Thread\s+\d{1,2}\/\d{1,2}\/\d{4}$/i.test(title)) return title
  const prompt = stripThink(message).replace(/\s+/g, " ").trim()
  if (!prompt) return "任务"
  return prompt.length > 18 ? `${prompt.slice(0, 18)}...` : prompt
}

/**
 * Build ModelRetryHooks that forward retry status to the renderer as custom
 * stream events on the given channel. Used to display the inline "retrying…"
 * indicator in the chat view.
 */
function buildModelRetryHooks(window: BrowserWindow, channel: string): ModelRetryHooks {
  const safeSend = (payload: unknown): void => {
    try {
      if (window.isDestroyed()) return
      window.webContents.send(channel, payload)
    } catch {
      /* ignore — window may be gone */
    }
  }
  return {
    onRetry: (info) => {
      safeSend({
        type: "custom",
        data: {
          type: "model_retry",
          attempt: info.attempt,
          maxRetries: info.maxRetries,
          reason: info.reason,
          delayMs: info.delayMs
        }
      })
    },
    onRetrySuccess: () => {
      safeSend({
        type: "custom",
        data: { type: "model_retry_clear" }
      })
    }
  }
}

/**
 * Max fetch attempts per model based on the current global routing mode.
 *
 * - pinned (no auto-routing): 7 attempts = 6 retries. User has committed to
 *   a single model; retry harder before giving up since there's no automatic
 *   fallback to another tier.
 * - auto: 6 attempts = 5 retries. Failover handles persistent failures by
 *   switching to the next candidate model, so each attempt retries a bit less.
 */
function getMaxRetryAttemptsForRoutingMode(): number {
  return getGlobalRoutingMode() === "pinned" ? 7 : 6
}

/**
 * Ask the LLM whether this conversation is worth saving as a skill.
 * Called unconditionally for every threshold-passing conversation.
 * Returns true if worthy, false if not (or if no model / parse error).
 */
async function judgeSkillWorthiness(
  threadId: string,
  context: SkillProposalWindowContext
): Promise<WorthinessResult | null> {
  const configs = getCustomModelConfigs()
  const config = configs[0]
  if (!config?.apiKey) {
    console.log(
      `[SkillEvolution][${threadId}] Worthiness LLM skipped: missing model config or API key`
    )
    return null
  }

  const model = new ChatOpenAI({
    model: config.model,
    apiKey: config.apiKey,
    configuration: { baseURL: config.baseUrl },
    maxTokens: config.maxOutputTokens,
    temperature: config.temperature,
    topP: config.topP,
    modelKwargs: {
      ...(config.topK && config.topK > 0 ? { top_k: config.topK } : {})
    }
  })

  const userPrompt = `## Conversation window since last skill-evolution reset (${context.turnCount} turns)
${context.transcript.slice(0, 3200)}

## Tools used (${context.toolCallCount} total)
${context.toolCallSummary}

Is this conversation worth saving as a reusable skill?`

  try {
    console.log(
      `[SkillEvolution][${threadId}] Worthiness LLM invoke start ${JSON.stringify({
        toolCallCount: context.toolCallCount,
        threshold: getSkillEvolutionThreshold(),
        turnCount: context.turnCount,
        errorCount: context.errorCount,
        toolCallSummary: context.toolCallSummary
      })}`
    )
    const response = await model.invoke([
      new SystemMessage(buildWorthinessPrompt(context.toolCallCount, getSkillEvolutionThreshold())),
      new HumanMessage(userPrompt)
    ])
    const raw = typeof response.content === "string" ? response.content : ""
    console.log(
      `[SkillEvolution][${threadId}] Worthiness LLM raw ${JSON.stringify({
        preview: raw.slice(0, 400)
      })}`
    )
    const result = parseWorthinessResponse(raw)
    if (!result) {
      console.warn(
        `[SkillEvolution][${threadId}] Failed to parse worthiness response:`,
        raw.slice(0, 200)
      )
      return null
    }
    console.log(
      `[SkillEvolution][${threadId}] Worthiness LLM invoke done ${JSON.stringify({
        worthy: result.worthy,
        reason: result.reason
      })}`
    )
    return result
  } catch (e) {
    console.warn(`[SkillEvolution][${threadId}] Failed to judge worthiness:`, e)
    return null
  }
}

/**
 * Use the default configured LLM to generate a skill proposal from the
 * given conversation context.  Streams tokens to the renderer via
 * `skill:generating` events so the user can see progress in real time.
 * Returns null if no model is configured or the LLM response cannot be parsed.
 */
async function generateSkillProposal(
  threadId: string,
  context: SkillProposalWindowContext
): Promise<SkillProposal | null> {
  // Always emit "start" first so the renderer card resets to generating state,
  // both on the initial run and on manual retry.
  emitSkillGenerating(threadId, "start")

  const configs = getCustomModelConfigs()
  const config = configs[0]
  if (!config?.apiKey) {
    emitSkillGenerating(threadId, "error", "未配置模型或 API Key，无法生成技能草稿")
    return null
  }

  const userPrompt = `# Conversation window to analyze

## Transcript (${context.turnCount} turns)
${context.transcript.slice(0, 4000)}

## Tools used (${context.toolCallCount} total)
${context.toolCallSummary}

Based on this conversation, generate a reusable skill. Output JSON only.`

  try {
    const model = new ChatOpenAI({
      model: config.model,
      apiKey: config.apiKey,
      configuration: { baseURL: config.baseUrl },
      maxTokens: config.maxOutputTokens,
      temperature: config.temperature,
      topP: config.topP,
      modelKwargs: {
        ...(config.topK && config.topK > 0 ? { top_k: config.topK } : {})
      },
      streaming: true
    })

    // Per-token idle timeout: if no new chunk arrives within this window the
    // internal model has likely stalled mid-stream without closing the connection.
    const TOKEN_IDLE_TIMEOUT_MS = 60_000

    const abortController = new AbortController()
    let timedOut = false
    let idleTimer = setTimeout(() => {
      timedOut = true
      abortController.abort()
    }, TOKEN_IDLE_TIMEOUT_MS)
    const resetIdleTimer = (): void => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        timedOut = true
        abortController.abort()
      }, TOKEN_IDLE_TIMEOUT_MS)
    }

    let fullText = ""
    const stream = await model.stream(
      [new SystemMessage(SKILL_PROPOSAL_SYSTEM_PROMPT), new HumanMessage(userPrompt)],
      { signal: abortController.signal }
    )

    try {
      for await (const chunk of stream) {
        resetIdleTimer()
        const token = typeof chunk.content === "string" ? chunk.content : ""
        if (token) {
          fullText += token
          emitSkillGenerating(threadId, "token", token)
        }
      }
    } catch (streamErr) {
      clearTimeout(idleTimer)
      if (timedOut) {
        throw new Error(
          `技能草稿生成超时（${TOKEN_IDLE_TIMEOUT_MS / 1000}s 内无新内容），请点击重试`
        )
      }
      throw streamErr
    }
    clearTimeout(idleTimer)

    emitSkillGenerating(threadId, "done", fullText)

    // Strip <think>...</think> reasoning blocks and markdown fences, then parse JSON
    const proposal = parseSkillProposal(fullText)
    if (!proposal) {
      console.warn("[Agent] Failed to parse skill proposal JSON")
      // Emit error so the renderer card transitions out of "generating" state
      emitSkillGenerating(threadId, "error", "技能草稿解析失败，请重试")
      return null
    }
    return proposal
  } catch (e) {
    console.warn("[Agent] Failed to generate skill proposal:", e)
    emitSkillGenerating(threadId, "error", e instanceof Error ? e.message : String(e))
    return null
  }
}

/**
 * Write an approved skill proposal to disk and notify the renderer.
 */
async function writeSkillToDisk(skillId: string, content: string, name: string): Promise<void> {
  const skillDir = join(getCustomSkillsDir(), skillId)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, "SKILL.md"), content, "utf-8")
  invalidateEnabledSkillsCache()
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("skills:changed")
  }
  notifyHooksChanged("skill-written")
  console.log(`[Agent] Wrote skill "${name}" to ${skillDir}`)
}

/**
 * Show the detail confirm dialog and, on adoption, write the skill to disk.
 * Extracted so it can be shared between the normal flow and manual retry.
 */
async function confirmAndWriteSkillProposal(
  threadId: string,
  proposal: SkillProposal
): Promise<void> {
  const skillId = sanitizeSkillId(proposal.skillId || proposal.name)
  if (!skillId) return

  const confirmId = uuid()
  const adopted = await requestSkillConfirmation({
    threadId,
    requestId: confirmId,
    skillId,
    name: proposal.name,
    description: proposal.description,
    content: proposal.content
  })

  if (!adopted) {
    console.log(`[Agent][${threadId}] User rejected skill detail for "${proposal.name}"`)
    return
  }

  try {
    trackEvent("skill.proposal.accepted", "skill", {
      threadId,
      skillId,
      skillName: proposal.name
    })
  } catch (e) {
    console.warn("[event] failed to emit skill.proposal.accepted:", e)
  }
  await writeSkillToDisk(skillId, proposal.content, proposal.name)
}

/**
 * Shared tail of the skill proposal flow (used by both modes):
 *   1. Ask user intent via banner
 *   2. On yes → LLM generates skill (streaming)
 *   3. Show detail confirm dialog
 *   4. On adopt → write to disk
 */
async function runSkillProposalFlow(
  threadId: string,
  context: SkillProposalWindowContext,
  intentMode: "mode_a_rule" | "mode_b_llm",
  recommendationReason?: string
): Promise<void> {
  const latestUserMessage =
    context.turns[context.turns.length - 1]?.userMessage ?? context.transcript

  // Step 1 — Intent banner: ask user whether they want to save as a skill.
  // We include the proposal context so the renderer can cache it for manual retry.
  const intentId = uuid()
  const wantsSkill = await requestSkillIntent({
    threadId,
    requestId: intentId,
    summary: latestUserMessage.slice(0, 120),
    toolCallCount: context.toolCallCount,
    mode: intentMode,
    recommendationReason,
    context
  })

  if (shouldResetSkillEvolutionSessionAfterIntent(wantsSkill ? "accept" : "skip")) {
    resetSkillEvolutionSession(threadId)
  }

  if (!wantsSkill) {
    console.log(`[Agent][${threadId}] User declined skill intent`)
    return
  }

  // Step 2 — LLM generates skill draft (streaming, visible in right panel)
  // generateSkillProposal() is responsible for emitting skill:generating events
  // (including the terminal "error" event) before returning null, so the renderer
  // card will always transition to a final state.
  console.log(`[Agent][${threadId}] User confirmed intent, generating skill proposal…`)
  const proposal = await generateSkillProposal(threadId, context)
  if (!proposal) {
    console.log(`[Agent][${threadId}] Could not generate skill proposal (no model or parse error)`)
    return
  }

  // Step 3+4 — Detail confirm dialog → write to disk
  await confirmAndWriteSkillProposal(threadId, proposal)
}

/**
 * After a conversation meets the tool-call threshold, decide whether to
 * propose a skill and, if so, run the shared proposal flow.
 *
 * Mode A (toggle ON):
 *   threshold reached -> enter proposal flow directly
 *
 * Mode B (toggle OFF):
 *   threshold reached -> ask worthiness LLM -> only continue when worthy=true
 *
 * Both modes then share the same user-facing flow:
 *   Intent Banner → LLM generates draft → Detail confirm → Write to disk
 */
async function autoProposeSKill(
  threadId: string,
  context: SkillProposalWindowContext
): Promise<void> {
  const autoProposeEnabled = isSkillAutoProposeEnabled()
  const mode = getSkillProposalMode(autoProposeEnabled)

  console.log(
    `[SkillEvolution][${threadId}] Decision start ${JSON.stringify({
      mode,
      toolCallCount: context.toolCallCount,
      turnCount: context.turnCount,
      errorCount: context.errorCount,
      toolCallSummary: context.toolCallSummary
    })}`
  )

  let llmWorthy = false
  let worthinessReason: string | undefined
  if (shouldJudgeSkillWorthiness(mode)) {
    const worthiness = await judgeSkillWorthiness(threadId, context)
    llmWorthy = worthiness?.worthy ?? false
    worthinessReason = worthiness?.reason
    try {
      trackEvent("skill.proposal.judged", "skill", {
        threadId,
        toolCallCount: context.toolCallCount,
        worthy: llmWorthy,
        reason: worthinessReason
      })
    } catch (e) {
      console.warn("[event] failed to emit skill.proposal.judged:", e)
    }
  } else {
    console.log(`[SkillEvolution][${threadId}] Mode A selected, skipping worthiness LLM`)
  }

  const shouldPropose = shouldProposeSkill(mode, llmWorthy)

  if (!shouldPropose) {
    console.log(
      `[SkillEvolution][${threadId}] Decision skip ${JSON.stringify({
        mode,
        llmWorthy,
        reason: "proposal_flow_not_triggered"
      })}`
    )
    return
  }

  console.log(
    `[SkillEvolution][${threadId}] Decision enter proposal flow ${JSON.stringify({
      mode,
      llmWorthy,
      toolCallCount: context.toolCallCount,
      turnCount: context.turnCount
    })}`
  )
  try {
    trackEvent("skill.proposal.triggered", "skill", {
      threadId,
      toolCallCount: context.toolCallCount,
      turnCount: context.turnCount,
      mode,
      llmWorthy
    })
  } catch (e) {
    console.warn("[event] failed to emit skill.proposal.triggered:", e)
  }
  await runSkillProposalFlow(threadId, context, mode, worthinessReason)
}

export function registerAgentHandlers(ipcMain: IpcMain): void {
  console.log("[Agent] Registering agent handlers...")

  // Manual retry for skill generation — triggered when the user clicks the retry button
  // in the right panel after a generation failure.  Skips the intent banner (user already
  // accepted), jumps straight to generate → confirm → write.
  ipcMain.handle(
    "skill:retryGeneration",
    async (_event, payload: { threadId: string; context: unknown; intentMode: string }) => {
      const { threadId, context, intentMode } = payload

      if (!threadId) return
      if (!isSkillProposalWindowContext(context)) {
        emitSkillGenerating(threadId, "error", "技能草稿上下文无效，请等待下次重新触发")
        return
      }
      if (intentMode !== "mode_a_rule" && intentMode !== "mode_b_llm") {
        emitSkillGenerating(threadId, "error", "技能触发模式无效，请等待下次重新触发")
        return
      }

      console.log(
        `[SkillEvolution][${threadId}] Manual retry requested ${JSON.stringify({
          intentMode,
          toolCallCount: context.toolCallCount,
          turnCount: context.turnCount
        })}`
      )

      try {
        const proposal = await generateSkillProposal(threadId, context)
        if (!proposal) return
        await confirmAndWriteSkillProposal(threadId, proposal)
      } catch (e) {
        console.warn(`[SkillEvolution][${threadId}] Retry flow failed:`, e)
        emitSkillGenerating(threadId, "error", e instanceof Error ? e.message : String(e))
      }
    }
  )

  // Handle agent invocation with streaming
  ipcMain.on(
    "agent:invoke",
    async (event, { threadId, message, modelId, userMessageId }: AgentInvokeParams) => {
    const channel = `agent:stream:${threadId}`
    const window = BrowserWindow.fromWebContents(event.sender)

    console.log("[Agent] Received invoke request:", {
      threadId,
      message: message.substring(0, 50),
      modelId
    })

    if (!window) {
      console.error("[Agent] No window found")
      return
    }

    // Abort any existing stream for this thread before starting a new one
    // This prevents concurrent streams which can cause checkpoint corruption
    const existingController = activeRuns.get(threadId)
    if (existingController) {
      console.log("[Agent] Aborting existing stream for thread:", threadId)
      existingController.abort()
      activeRuns.delete(threadId)
    }

    const abortController = new AbortController()
    activeRuns.set(threadId, abortController)
    const turnState = getOrCreateTurnState(threadId, message, userMessageId)
    resetTurnStateForNewInvoke(turnState, message, userMessageId)
    const { hookScope, skillUseTracker, skillHookKeys, stopContextCollector } = turnState
    const runToken = startTurnStateRun(turnState)
    let turnStateShouldDispose = false

    // Abort the stream if the window is closed/destroyed
    const onWindowClosed = (): void => {
      console.log("[Agent] Window closed, aborting stream for thread:", threadId)
      abortController.abort()
    }
    window.once("closed", onWindowClosed)

    // Start trace collection for this invocation (modelId resolved later)
    const tracer = new TraceCollector(threadId, message, modelId ?? "unknown", {
      triggerSource: "chat"
    })
    const skillUsageDetector = new SkillUsageDetector()
    const toolCallCounter = new ToolCallCounter()
    let assistantText = ""
    const recentCompletedTurns = snapshotSkillProposalWindow(threadId).slice(-2)

    const computeCodeGenAttributionSkills = (currentRunSkills: string[]): string[] => {
      const inheritedTurns =
        currentRunSkills.length > 0 ? recentCompletedTurns.slice(-1) : recentCompletedTurns

      return Array.from(
        new Set([...currentRunSkills, ...inheritedTurns.flatMap((turn) => turn.usedSkills)])
      )
    }

    const syncUsedSkillsContext = (): void => {
      const currentRunSkills = skillUsageDetector.getUsedSkillNames()
      tracer.setUsedSkills(currentRunSkills)
      tracer.setEvolvedSkills(skillUsageDetector.getUsedEvolvedSkillNames())
      setAdoptionContext(threadId, {
        usedSkills: computeCodeGenAttributionSkills(currentRunSkills)
      })
    }

    syncUsedSkillsContext()
    // stopContextCollector lives in turnState (destructured above) so it survives HITL pauses.

    const sendHookNotice = (notice: string): void => {
      window.webContents.send(channel, {
        type: "custom",
        data: { type: "hook_notice", message: notice }
      })
    }

    const sendStreamError = (error: string): void => {
      window.webContents.send(channel, {
        type: "error",
        error
      })
    }

    const sendHookBlocked = (
      event: HookEvent,
      result: HookResult,
      fallbackReason: string
    ): void => {
      const reason =
        result.stopReason || result.reason || result.stderr || result.stdout || fallbackReason
      const action = result.continue === false ? "halt" : "block"
      window.webContents.send(channel, {
        type: "custom",
        data: {
          type: "hook_blocked",
          hookEvent: event,
          action,
          reason,
          systemMessage: result.systemMessage
        }
      })
      turnStateShouldDispose = true
      window.webContents.send(channel, { type: "done" })
    }

    const onHookResult = makeHookResultCallback(window, channel, turnState.turnId)
    // Per-event scope-skip factory: diagnostic mode only. The gate lives in
    // `buildHookSkippedRecord`, so constructing this factory is always cheap; the
    // hot path bails out when Hook diagnostic mode is off.
    const onHookSkippedFactory = (event: HookEvent): ScopeSkipCallback =>
      makeHookSkippedCallback(window, channel, event, turnState.turnId)

    const appendTurnToProposalWindow = (
      status: "success" | "error",
      errorMessage?: string
    ): SkillProposalWindowContext => {
      appendSkillProposalWindowTurn(threadId, {
        userMessage: message,
        assistantText,
        toolCallNames: toolCallCounter.getNames(),
        toolCallCount: toolCallCounter.getCount(),
        status,
        errorMessage,
        usedSkills: skillUsageDetector.getUsedSkillNames(),
        finishedAt: nowIsoLocal()
      })

      const context = buildSkillProposalWindowContext(snapshotSkillProposalWindow(threadId))
      console.log(
        `[SkillEvolution][${threadId}] Window append ${JSON.stringify({
          status,
          currentTurnToolCallCount: toolCallCounter.getCount(),
          windowTurnCount: context.turnCount,
          windowToolCallCount: context.toolCallCount,
          usedSkills: context.usedSkills
        })}`
      )
      return context
    }

    // Hoisted so catch/finally block can access them
    let sessionWorkspacePath: string | undefined
    let invokeRoutingResult: Awaited<ReturnType<typeof resolveModel>> | null = null
    let toolErrorCount = 0
    // High-water mark of input tokens — hoisted for catch/finally access
    let highWaterInputTokens = 0
    // Actual model used after failover — hoisted for catch/finally routing feedback
    let usedModelId: string | undefined

    try {
      // Get workspace path from thread metadata - REQUIRED
      const thread = getThread(threadId)
      let metadata: Record<string, unknown> = {}
      if (thread?.metadata) {
        try {
          metadata = JSON.parse(thread.metadata)
        } catch {
          console.warn("[Agent] Failed to parse thread metadata, using empty object")
        }
      }
      console.log("[Agent] Thread metadata:", metadata)

      const workspacePath = metadata.workspacePath as string | undefined
      sessionWorkspacePath = workspacePath ?? undefined
      const harnessAgentContext = getHarnessAgentContext(metadata)

      if (!workspacePath) {
        window.webContents.send(channel, {
          type: "error",
          error: "WORKSPACE_REQUIRED",
          message: "Please select a workspace folder before sending messages."
        })
        await tracer.finish("error", "WORKSPACE_REQUIRED")
        turnStateShouldDispose = true
        return
      }

      const explicitSkillActivation = await activateExplicitSkillFromMessage({
        message,
        workspacePath,
        pluginOutputDir: harnessAgentContext.pluginOutputDir,
        systemId: harnessAgentContext.systemId,
        sessionId: threadId,
        turnId: turnState.turnId,
        hookScope,
        firedSkillKeys: skillHookKeys,
        skillUseTracker,
        onHookResult,
        onHookSkippedFactory
      })
      if (explicitSkillActivation?.blocked) {
        const reason = explicitSkillActivation.reason || "显式选择的技能被 Hook 拦截"
        window.webContents.send(channel, {
          type: "error",
          error: reason
        })
        await tracer.finish("error", reason)
        turnStateShouldDispose = true
        return
      }
      if (explicitSkillActivation?.skill) {
        skillUsageDetector.onSkillsMetadata([
          {
            name: explicitSkillActivation.skill.name,
            path: explicitSkillActivation.skill.path
          }
        ])
        skillUsageDetector.onReadFilePath(explicitSkillActivation.skill.path)
        syncUsedSkillsContext()
      }

      // Fire SessionStart once per thread lifetime (not per turn). SessionEnd fires when the
      // thread is deleted (threads:delete) or the app is quitting.
      fireSessionStartOnce(
        threadId,
        sessionWorkspacePath,
        onHookResult,
        hookScope,
        onHookSkippedFactory("SessionStart"),
        turnState.turnId,
        harnessAgentContext.pluginOutputDir,
        harnessAgentContext.systemId
      )
      sendActiveHookNotice(window, channel, workspacePath)

      // Fire UserPromptSubmit hook — may block the message, halt the turn, rewrite the prompt,
      // or inject additional context that the LLM should see alongside the user's message.
      const promptSubmitContext: HookContext = {
        toolArgs: { message },
        userPrompt: message,
        workspacePath: workspacePath ?? undefined,
        sessionId: threadId,
        turnId: turnState.turnId,
        pluginOutputDir: harnessAgentContext.pluginOutputDir,
        systemId: harnessAgentContext.systemId
      }
      const promptSubmitResult = await runHooksEnriched(
        resolveEnabledHooksForRun(
          workspacePath ?? undefined,
          "UserPromptSubmit",
          promptSubmitContext,
          hookScope,
          onHookSkippedFactory("UserPromptSubmit")
        ),
        "UserPromptSubmit",
        promptSubmitContext,
        onHookResult
      )
      if (promptSubmitResult?.blocked || promptSubmitResult?.continue === false) {
        sendHookBlocked("UserPromptSubmit", promptSubmitResult, "消息被 Hook 策略拦截")
        await tracer.finish("cancelled", "UserPromptSubmit hook stopped the turn")
        turnStateShouldDispose = true
        return
      }
      // Apply hook-supplied prompt rewrite / context injection. `message` remains the raw
      // user input for tracing and proposal capture; `effectiveMessage` is what the LLM sees.
      let effectiveMessage = message
      const updatedMessage =
        promptSubmitResult?.updatedInput?.message ??
        promptSubmitResult?.updatedInput?.prompt ??
        promptSubmitResult?.updatedInput?.userPrompt
      if (typeof updatedMessage === "string" && updatedMessage.length > 0) {
        effectiveMessage = updatedMessage
      }
      if (explicitSkillActivation?.parsed && !parseSkillUseBlock(effectiveMessage)) {
        effectiveMessage = [effectiveMessage.trimEnd(), explicitSkillActivation.parsed.block]
          .filter(Boolean)
          .join("\n\n")
      }
      const promptContextBlocks = [
        explicitSkillActivation?.hookContext,
        promptSubmitResult?.additionalContext
      ].filter((item): item is string => Boolean(item?.trim()))
      if (promptContextBlocks.length > 0) {
        effectiveMessage = `${promptContextBlocks.join("\n\n")}\n\n${effectiveMessage}`
      }
      if (promptSubmitResult?.systemMessage) {
        window.webContents.send(channel, {
          type: "custom",
          data: { type: "hook_notice", message: promptSubmitResult.systemMessage }
        })
      }

      // Sync FTS index with any memory files changed since last invocation
      if (isMemoryEnabled()) {
        try {
          const memoryStore = await getMemoryStore()
          memoryStore.syncMemoryFiles()
        } catch {
          /* non-critical */
        }
      }

      const autoCommit = await beginAutoCommitTracking(threadId, workspacePath)

      const requestedModelId = modelId || (metadata.model as string | undefined)
      invokeRoutingResult = await resolveModel({
        taskSource: "chat",
        message,
        threadId,
        requestedModelId,
        routingMode: getGlobalRoutingMode()
      }).catch(() => null)
      let effectiveModelId = invokeRoutingResult?.resolvedModelId ?? requestedModelId

      // Persist routing decision for thread continuity (sticky/force logic next turn)
      if (invokeRoutingResult) rememberRoutingDecision(threadId, invokeRoutingResult)

      // Attach routing funnel record to trace (setRoutingTrace is internally safe, never throws)
      if (invokeRoutingResult?.routingTrace) {
        tracer.setRoutingTrace(invokeRoutingResult.routingTrace)
      }

      // Emit routing result so the frontend can display which model was selected
      if (invokeRoutingResult) {
        window.webContents.send(channel, {
          type: "custom",
          data: {
            type: "routing_result",
            resolvedModelId: invokeRoutingResult.resolvedModelId,
            resolvedTier: invokeRoutingResult.resolvedTier,
            routeReason: invokeRoutingResult.routeReason
          }
        })
      }

      const humanMessage = new HumanMessage(effectiveMessage)
      const streamConfig = {
        configurable: { thread_id: threadId },
        signal: abortController.signal,
        streamMode: ["messages", "values"] as ("messages" | "values")[],
        recursionLimit: 1000
      }

      // ── Failover loop: try models in order, resume from checkpoint on retryable errors ──
      const primaryTier = invokeRoutingResult?.resolvedTier ?? "premium"
      const orderedChain = buildOrderedChain(
        effectiveModelId,
        invokeRoutingResult?.fallbackChain,
        primaryTier,
        invokeRoutingResult?.layer !== "pinned"
      )
      const failoverAttempts: FailoverAttempt[] = []
      usedModelId = effectiveModelId
      let isFirstAttempt = true
      let agent: Awaited<ReturnType<typeof createAgentRuntime>> | null = null
      let stream: AsyncIterable<unknown> | null = null

      for (const candidateId of orderedChain) {
        if (abortController.signal.aborted) break
        try {
          agent = await createAgentRuntime({
            threadId,
            workspacePath,
            modelId: candidateId,
            abortSignal: abortController.signal,
            enableRequestUserInput: true,
            noSkillEvolutionTool: true,
            retryHooks: buildModelRetryHooks(window, channel),
            maxRetryAttempts: getMaxRetryAttemptsForRoutingMode(),
            onHookResult,
            hookTurnId: turnState.turnId,
            onHookSkippedFactory,
            hookScope,
            skillHookKeys,
            skillUseTracker,
            ...harnessAgentContext,
            onFileMutation: autoCommit.onFileMutation
          })
          // First attempt sends the message; subsequent attempts resume from checkpoint
          const input = isFirstAttempt ? { messages: [humanMessage] } : null
          stream = await agent.stream(input, streamConfig)
          usedModelId = candidateId
          break
        } catch (err) {
          if (!isRetryableApiError(err)) throw err
          failoverAttempts.push({ modelId: candidateId, error: String(err), timestamp: Date.now() })
          console.warn(`[Agent][Failover] ${candidateId} failed: ${err}, trying next...`)
          // Keep isFirstAttempt=true: init-time errors (createAgentRuntime / agent.stream)
          // happen before any graph tick, so HumanMessage is NOT yet checkpointed.
          // Next candidate must still send { messages: [humanMessage] }.
          if (!abortController.signal.aborted) {
            await new Promise((r) => setTimeout(r, 500))
          }
        }
      }

      // P3: user cancellation during failover should not be reported as hard error
      if (abortController.signal.aborted) {
        // Fall through to outer abort handling
        throw Object.assign(new Error("aborted"), { name: "AbortError" })
      }

      if (!stream || !agent) {
        const allErrors = failoverAttempts.map((a) => `${a.modelId}: ${a.error}`).join("; ")
        throw new Error(`All models failed: ${allErrors}`)
      }

      // Notify frontend if failover happened — update model display + context window
      const notifyFailover = (): void => {
        if (failoverAttempts.length > 0 && usedModelId !== effectiveModelId) {
          const usedCfgId = usedModelId?.startsWith("custom:")
            ? usedModelId.slice("custom:".length)
            : usedModelId
          const usedCfg = getCustomModelConfigs().find((c) => c.id === usedCfgId)
          window.webContents.send(channel, {
            type: "custom",
            data: {
              type: "routing_result",
              resolvedModelId: usedModelId,
              resolvedTier: usedCfg?.tier ?? "premium",
              routeReason: `failover from ${failoverAttempts[0].modelId}`
            }
          })
          window.webContents.send(channel, {
            type: "custom",
            data: { type: "model_failover", attempts: failoverAttempts, activeModelId: usedModelId }
          })
          // P2: persist failover model + sticky in a single atomic write
          rememberRoutingDecision(
            threadId,
            {
              resolvedModelId: usedModelId!,
              resolvedTier: usedCfg?.tier ?? "premium",
              routeReason: `failover from ${failoverAttempts[0].modelId}`,
              fallbackChain: [],
              layer: "pinned"
            },
            usedModelId!
          )
          // Update effectiveModelId for downstream trace/feedback
          effectiveModelId = usedModelId
        }
      }
      notifyFailover()

      // Update tracer with resolved modelId.
      // Set modelName from config.model (the real API model name, e.g. "MiniMax-M2.7") as an
      // initial fallback — it will be overwritten later by the actual model name from the API
      // response metadata once the first AI message arrives (see response_metadata.model_name below).
      if (effectiveModelId) {
        tracer.setModelId(effectiveModelId)
        const cfgIdForName = effectiveModelId.startsWith("custom:")
          ? effectiveModelId.slice("custom:".length)
          : effectiveModelId
        const cfgForName = getCustomModelConfigs().find((c) => c.id === cfgIdForName)
        // Use config.model (the actual API model name) as fallback, not config.name (display label)
        if (cfgForName?.model) tracer.setModelName(cfgForName.model)
      }

      // ── Tool-call extraction (tested in __tests__/tool-call-extraction.test.ts)
      //
      // "messages" mode delivers one [msgChunk, metadata?] tuple per LangGraph message.
      // AI messages carry a complete tool_calls array even in streaming mode —
      // confirmed by stream-converter.ts and unit tests.
      //
      // Deduplication: same AI message ID can appear in multiple chunks
      // (e.g. once as AIMessageChunk, once as AIMessage in a values snapshot).
      // We track seen IDs to count each unique tool invocation exactly once.
      // ─────────────────────────────────────────────────────────────────────────

      const _countedAiMsgIds = new Set<string>()
      const _countedModelMsgIds = new Set<string>()
      const _countedToolResultMsgIds = new Set<string>()
      // Track which subagent tool-call IDs we've already emitted SubagentStop for (dedupe)
      const _subagentStopFired = new Set<string>()
      const _llmNodeByMessageId = new Map<string, string>()
      const _toolNodeByRef = new Map<string, string>()
      const MODEL_INPUT_WINDOW = 12
      const MAX_TRACE_CONTENT = 2000

      const trimContent = (s: string): string =>
        s.length > MAX_TRACE_CONTENT ? `${s.slice(0, MAX_TRACE_CONTENT)}\n…(truncated)` : s

      const normalizeMessageText = (s: string): string => s.replace(/\r\n/g, "\n").trim()

      // Providers may surface usage as top-level `usage_metadata` or under
      // `response_metadata.token_usage` / `response_metadata.usage`.
      // Normalize all variants so trace capture and UI stay aligned.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const getUsageMetadata = (kwargs: any): unknown =>
        kwargs?.usage_metadata ??
        kwargs?.response_metadata?.token_usage ??
        kwargs?.response_metadata?.usage

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const extractText = (raw: any): string => {
        if (typeof raw === "string") return trimContent(raw)
        if (!Array.isArray(raw)) return ""
        const text = raw
          .map((b) => {
            if (typeof b === "string") return b
            if (!b || typeof b !== "object") return ""
            if (typeof b.text === "string") return b.text
            if (typeof b.content === "string") return b.content
            return ""
          })
          .filter(Boolean)
          .join("\n")
        return trimContent(text)
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toRole = (
        className: string,
        kwargs: any
      ): "system" | "user" | "assistant" | "tool" | "unknown" => {
        if (className.includes("Human")) return "user"
        if (className.includes("AI")) return "assistant"
        if (className.includes("System")) return "system"
        if (className.includes("Tool")) return "tool"
        if (kwargs?.type === "human") return "user"
        if (kwargs?.type === "ai") return "assistant"
        if (kwargs?.type === "system") return "system"
        if (kwargs?.type === "tool") return "tool"
        return "unknown"
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const normalizeTokenUsage = (
        usage: any
      ):
        | {
            inputTokens?: number
            outputTokens?: number
            totalTokens?: number
            cacheReadTokens?: number
            cacheCreationTokens?: number
          }
        | undefined => {
        if (!usage || typeof usage !== "object") return undefined
        const toNum = (v: unknown): number | undefined =>
          typeof v === "number" && Number.isFinite(v) ? v : undefined
        const inputTokens = toNum(usage.input_tokens ?? usage.inputTokens)
        const outputTokens = toNum(usage.output_tokens ?? usage.outputTokens)
        const totalTokens = toNum(usage.total_tokens ?? usage.totalTokens)
        const cacheReadTokens = toNum(
          usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cacheReadTokens
        )
        const cacheCreationTokens = toNum(
          usage.cache_creation_input_tokens ??
            usage.cacheCreationInputTokens ??
            usage.cacheCreationTokens
        )
        if (
          inputTokens === undefined &&
          outputTokens === undefined &&
          totalTokens === undefined &&
          cacheReadTokens === undefined &&
          cacheCreationTokens === undefined
        )
          return undefined
        return { inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheCreationTokens }
      }

      const extractTextBlocks = (raw: unknown): string => {
        if (typeof raw === "string") return raw
        if (Array.isArray(raw)) {
          return (raw as Array<{ type?: string; text?: string }>)
            .filter((b) => b?.type === "text")
            .map((b) => b.text ?? "")
            .join("")
        }
        return ""
      }

      const forwardStreamChunk = (mode: string, payload: unknown): void => {
        window.webContents.send(channel, {
          type: "stream",
          mode,
          data: payload
        })
      }

      const processMessagesSideEffects = async (payload: unknown): Promise<void> => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const [msgChunk] = payload as [any]
          if (!msgChunk) return

          const kwargs = (msgChunk.kwargs || {}) as Record<string, unknown>
          const classId: string[] = Array.isArray(msgChunk.id) ? msgChunk.id : []
          const className = classId[classId.length - 1] || ""
          const isAI = className.includes("AI")
          await maybeRunSubagentStopHooksFromStreamPayload({
            payload,
            workspacePath: sessionWorkspacePath,
            threadId,
            turnId: turnState.turnId,
            hookScope,
            pluginOutputDir: harnessAgentContext.pluginOutputDir,
            systemId: harnessAgentContext.systemId,
            firedToolCallIds: _subagentStopFired,
            onHookResult,
            onHookSkipped: onHookSkippedFactory("SubagentStop")
          })

          if (!isAI) return

          const rawContent = kwargs.content ?? msgChunk.content
          const visibleText = extractTextBlocks(rawContent)
          if (visibleText) assistantText += visibleText

          // Tool-call extraction — deduped by message ID.
          const toolCalls = kwargs.tool_calls as
            | Array<{
                id?: string
                name?: string
                args?: Record<string, unknown>
              }>
            | undefined
          const msgId = (kwargs.id as string) || ""
          if (!toolCalls || toolCalls.length === 0) return
          if (msgId && _countedAiMsgIds.has(msgId)) return
          if (msgId) _countedAiMsgIds.add(msgId)

          tracer.beginStep()
          for (let tcIndex = 0; tcIndex < toolCalls.length; tcIndex++) {
            const tc = toolCalls[tcIndex]
            const tcName = tc.name ?? "unknown"
            tracer.recordToolCall({ name: tcName, args: tc.args ?? {} })
            const counted = toolCallCounter.register(tc, msgId, tcIndex)

            if (tcName === "read_file") {
              const readPathRaw =
                (typeof tc.args?.path === "string" && tc.args.path) ||
                (typeof tc.args?.file_path === "string" && tc.args.file_path) ||
                ""
              if (readPathRaw) {
                const hit = skillUsageDetector.onReadFilePath(readPathRaw)
                // Sync tracer + adoption context immediately when the hit set
                // grows. Without this, a write_file/edit_file that follows in
                // the *same* values batch would snapshot an empty usedSkills
                // and the resulting code_gen would be missing skill attribution.
                if (hit) {
                  syncUsedSkillsContext()
                }
              }
            }

            if (counted) {
              const turnCount = toolCallCounter.getCount()
              console.log(`[Agent] Turn tool call #${turnCount} (${tcName}) in thread ${threadId}`)
            }
          }
          tracer.endStep(visibleText)
        } catch (e) {
          if (isHookHaltError(e)) throw e
          console.error("[Agent] Tool-call extraction error:", e)
        }
      }

      const processValuesSideEffects = async (payload: unknown): Promise<void> => {
        try {
          const state = payload as {
            skillsMetadata?: Array<{ name?: string; path?: string; version?: string }>
            messages?: Array<{
              id?: string[]
              kwargs?: {
                id?: string
                type?: string
                content?: unknown
                name?: string
                tool_call_id?: string
                usage_metadata?: unknown
                response_metadata?: {
                  token_usage?: unknown
                  usage?: unknown
                  model_name?: string
                  model?: string
                }
                status?: string
                is_error?: boolean
                additional_kwargs?: Record<string, unknown>
                tool_calls?: Array<{
                  id?: string
                  name?: string
                  args?: Record<string, unknown>
                }>
              }
            }>
          }
          const skillsMetadata = Array.isArray(state.skillsMetadata) ? state.skillsMetadata : []
          if (skillsMetadata.length > 0) {
            skillUsageDetector.onSkillsMetadata(skillsMetadata)
            syncUsedSkillsContext()
          }

          if (!Array.isArray(state.messages)) return

          const currentMessageTexts = new Set(
            [message, effectiveMessage].map(normalizeMessageText).filter(Boolean)
          )
          let currentTurnStartIndex = -1
          let latestUserMessageIndex = -1
          for (let i = state.messages.length - 1; i >= 0; i--) {
            const msg = state.messages[i]
            const kwargs = msg?.kwargs || {}
            const classId = Array.isArray(msg?.id) ? msg.id : []
            const className = classId[classId.length - 1] || ""
            const role = toRole(className, kwargs)
            if (role !== "user") continue
            if (latestUserMessageIndex < 0) latestUserMessageIndex = i
            if (currentMessageTexts.has(normalizeMessageText(extractText(kwargs.content)))) {
              currentTurnStartIndex = i
              break
            }
          }

          const valuesStartIndex =
            currentTurnStartIndex >= 0
              ? currentTurnStartIndex + 1
              : latestUserMessageIndex >= 0
                ? latestUserMessageIndex + 1
                : 0

          for (let i = valuesStartIndex; i < state.messages.length; i++) {
            const msg = state.messages[i]
            const tcs = msg?.kwargs?.tool_calls

            const kwargs = msg?.kwargs || {}
            const classId = Array.isArray(msg?.id) ? msg.id : []
            const className = classId[classId.length - 1] || ""
            const isAI = className.includes("AI") || kwargs.type === "ai"
            const isToolMessage = className.includes("Tool") || kwargs.type === "tool"
            const aiMsgId = typeof kwargs.id === "string" ? kwargs.id : ""
            if (isAI && aiMsgId && !_countedModelMsgIds.has(aiMsgId)) {
              _countedModelMsgIds.add(aiMsgId)

              // Extract the real model name from API response metadata (e.g. "MiniMax-M2.7")
              // This takes precedence over the user-configured model name (config.model)
              const apiModelName =
                kwargs.response_metadata?.model_name ?? kwargs.response_metadata?.model
              if (typeof apiModelName === "string" && apiModelName) {
                tracer.setModelName(apiModelName)
              }

              const inputSlice = state.messages
                .slice(Math.max(0, i - MODEL_INPUT_WINDOW), i)
                .map((m) => {
                  const k = m?.kwargs || {}
                  const cid = Array.isArray(m?.id) ? m.id : []
                  const cname = cid[cid.length - 1] || ""
                  return {
                    role: toRole(cname, k),
                    content: extractText(k.content),
                    ...(typeof k.name === "string" ? { name: k.name } : {}),
                    ...(typeof k.tool_call_id === "string" ? { toolCallId: k.tool_call_id } : {})
                  }
                })
                .filter((m) => m.content || m.role === "tool")

              const outputToolCalls = Array.isArray(tcs)
                ? tcs.map((tc) => ({
                    name: tc?.name ?? "unknown",
                    args: tc?.args ?? {}
                  }))
                : []

              const llmNodeId = tracer.beginLlmNode({
                messageId: aiMsgId,
                startedAt: nowIsoLocal(),
                input: inputSlice,
                metadata: {
                  toolCallCount: outputToolCalls.length
                }
              })
              _llmNodeByMessageId.set(aiMsgId, llmNodeId)

              const usageForTrace = normalizeTokenUsage(getUsageMetadata(kwargs))

              // Track high-water mark of input tokens for context window capacity guard
              if (usageForTrace?.inputTokens && usageForTrace.inputTokens > highWaterInputTokens) {
                highWaterInputTokens = usageForTrace.inputTokens
              }

              tracer.recordModelCall({
                messageId: aiMsgId,
                startedAt: nowIsoLocal(),
                inputMessages: inputSlice,
                outputMessage: {
                  role: "assistant",
                  content: extractText(kwargs.content)
                },
                toolCalls: outputToolCalls,
                tokenUsage: usageForTrace
              })

              tracer.endLlmNode({
                nodeId: llmNodeId,
                output: extractText(kwargs.content),
                status: "success",
                metadata: {
                  tokenUsage: usageForTrace
                }
              })
            }

            if (Array.isArray(tcs)) {
              for (let tcIndex = 0; tcIndex < tcs.length; tcIndex++) {
                const tc = tcs[tcIndex]
                const tcId = typeof tc?.id === "string" ? tc.id : ""
                const toolRef =
                  tcId || `${aiMsgId || "ai_unknown"}:${tcIndex}:${JSON.stringify(tc?.args ?? {})}`
                const counted = toolCallCounter.register(tc, aiMsgId, tcIndex)
                if (!_toolNodeByRef.has(toolRef)) {
                  const parentId = aiMsgId ? _llmNodeByMessageId.get(aiMsgId) : undefined
                  const toolNodeId = tracer.addToolNode({
                    name: tc?.name ?? "unknown",
                    input: tc?.args ?? {},
                    parentId,
                    llmMessageId: aiMsgId || undefined,
                    toolCallId: tcId || undefined,
                    metadata: { index: tcIndex }
                  })
                  _toolNodeByRef.set(toolRef, toolNodeId)
                }

                if (counted) {
                  const turnCount = toolCallCounter.getCount()
                  console.log(
                    `[Agent] Turn tool call #${turnCount} (${tc?.name ?? "unknown"}) in thread ${threadId} [values]`
                  )
                }

                if (tc?.name !== "read_file") continue
                const readPathRaw =
                  (typeof tc.args?.path === "string" && tc.args.path) ||
                  (typeof tc.args?.file_path === "string" && tc.args.file_path) ||
                  ""
                if (readPathRaw) {
                  const hit = skillUsageDetector.onReadFilePath(readPathRaw)
                  // See the read_file branch in processMessagesSideEffects —
                  // a following write/edit in this same messages loop would
                  // otherwise see a stale usedSkills snapshot.
                  if (hit) {
                    syncUsedSkillsContext()
                  }
                }
              }
            }

            if (isToolMessage) {
              await maybeRunSubagentStopHooksFromStreamPayload({
                payload: [msg],
                workspacePath: sessionWorkspacePath,
                threadId,
                turnId: turnState.turnId,
                hookScope,
                pluginOutputDir: harnessAgentContext.pluginOutputDir,
                systemId: harnessAgentContext.systemId,
                firedToolCallIds: _subagentStopFired,
                onHookResult,
                onHookSkipped: onHookSkippedFactory("SubagentStop")
              })
              const toolMsgId =
                typeof kwargs.id === "string"
                  ? kwargs.id
                  : `${kwargs.tool_call_id ?? "tool"}:${i}:${extractText(kwargs.content)}`
              if (_countedToolResultMsgIds.has(toolMsgId)) continue
              const toolCallId = typeof kwargs.tool_call_id === "string" ? kwargs.tool_call_id : ""
              _countedToolResultMsgIds.add(toolMsgId)
              const parentId = toolCallId ? _toolNodeByRef.get(toolCallId) : undefined
              const toolOutput = extractText(kwargs.content)
              // Detect tool error: explicit status field, is_error flag, or error-prefix in output
              const additionalKwargs = kwargs.additional_kwargs as
                | Record<string, unknown>
                | undefined
              const isToolError =
                kwargs.status === "error" ||
                kwargs.is_error === true ||
                additionalKwargs?.is_error === true ||
                /^(error:|mcp tool error:|tool error:|failed:)/i.test(toolOutput.trim())
              if (isToolError) toolErrorCount += 1
              tracer.addToolResultNode({
                parentId,
                toolCallId: toolCallId || undefined,
                output: toolOutput,
                status: isToolError ? "error" : "success",
                metadata: {
                  messageId: toolMsgId
                }
              })
            }
          }

          const finalMsgs = state.messages.filter((m) => {
            const cn = Array.isArray(m.id) ? m.id[m.id.length - 1] || "" : ""
            const kw = m.kwargs || {}
            return (
              cn.includes("AI") &&
              (!kw.tool_calls || !Array.isArray(kw.tool_calls) || kw.tool_calls.length === 0)
            )
          })
          const last = finalMsgs[finalMsgs.length - 1]
          if (last) {
            const kw = last.kwargs || {}
            const text = extractTextBlocks(kw.content).trim()
            if (text) lastFinalText = text
          }
        } catch (e) {
          if (isHookHaltError(e)) throw e
          console.error("[Agent] Values side-effect processing error:", e)
        }
      }

      const processChunkSideEffects = async (mode: string, payload: unknown): Promise<void> => {
        if (mode === "messages") {
          await processMessagesSideEffects(payload)
          return
        }
        if (mode === "values") {
          await processValuesSideEffects(payload)
        }
      }

      let lastFinalText = "" // 最终回复（不含中间工具推理），用于 ChatX HTTP 回复

      // P1: Mid-stream failover — if the stream fails with a retryable error,
      // try remaining models in the chain using resume semantics.
      const remainingCandidates = orderedChain.slice(
        usedModelId ? orderedChain.indexOf(usedModelId) + 1 : orderedChain.length
      )
      let activeStream: AsyncIterable<unknown> = stream

      const consumeStreamWithSideEffects = async (
        source: AsyncIterable<unknown>
      ): Promise<void> => {
        for await (const chunk of source) {
          if (abortController.signal.aborted) break

          const [mode, data] = chunk as unknown as [string, unknown]

          // Serialize first — live BaseMessage objects must be serialized before
          // we can inspect the LangChain class path (msgChunk.id becomes the
          // class array ["langchain_core","messages","AIMessageChunk"] only after
          // toJSON() / JSON.stringify; on the live object, .id is the msg-id string).
          const serialized = serializeStreamData(data)
          // UI forwarding is the primary path. Most processing below is best-effort;
          // SubagentStop hooks are awaited so `continue:false` can halt the parent turn.
          forwardStreamChunk(mode, serialized)
          await processChunkSideEffects(mode, serialized)
          stopContextCollector.processStreamChunk(mode, serialized)
        }
      }

      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          await consumeStreamWithSideEffects(activeStream)
          break // Stream completed successfully
        } catch (midStreamErr) {
          if (!isRetryableApiError(midStreamErr) || remainingCandidates.length === 0) {
            throw midStreamErr
          }
          if (abortController.signal.aborted) throw midStreamErr

          const failedModelId = usedModelId ?? "unknown"
          failoverAttempts.push({
            modelId: failedModelId,
            error: String(midStreamErr),
            timestamp: Date.now()
          })
          console.warn(
            `[Agent][Failover] Mid-stream ${failedModelId} failed: ${midStreamErr}, trying next...`
          )

          if (!abortController.signal.aborted) {
            await new Promise((r) => setTimeout(r, 500))
          }

          // Try next candidate with resume semantics
          const nextCandidate = remainingCandidates.shift()!
          agent = await createAgentRuntime({
            threadId,
            workspacePath,
            modelId: nextCandidate,
            abortSignal: abortController.signal,
            enableRequestUserInput: true,
            noSkillEvolutionTool: true,
            retryHooks: buildModelRetryHooks(window, channel),
            maxRetryAttempts: getMaxRetryAttemptsForRoutingMode(),
            onHookResult,
            hookTurnId: turnState.turnId,
            onHookSkippedFactory,
            hookScope,
            skillHookKeys,
            skillUseTracker,
            ...harnessAgentContext,
            onFileMutation: autoCommit.onFileMutation
          })
          activeStream = await agent.stream(null, streamConfig) // resume from checkpoint
          usedModelId = nextCandidate
          notifyFailover()
        }
      }

      if (!abortController.signal.aborted) {
        const completionOutcome = await runCompletionHooksWithRevision({
          threadId,
          workspacePath: workspacePath ?? undefined,
          turnId: turnState.turnId,
          pluginOutputDir: harnessAgentContext.pluginOutputDir,
          systemId: harnessAgentContext.systemId,
          abortSignal: abortController.signal,
          getStopContext: () =>
            stopContextCollector.snapshot({
              userMessage: message,
              assistantResponse: lastFinalText || assistantText.trim(),
              toolCalls: toolCallCounter.getNames(),
              usedSkills: skillUsageDetector.getUsedSkillNames()
            }),
          runRevision: async (revisionPrompt) => {
            if (!agent)
              throw new Error("Cannot revise after Stop hook: agent runtime is unavailable")
            const revisionStream = await agent.stream(
              { messages: [new HumanMessage(revisionPrompt)] },
              streamConfig
            )
            await consumeStreamWithSideEffects(revisionStream)
          },
          sendNotice: sendHookNotice,
          sendError: sendStreamError,
          hookScope,
          skillUseTracker,
          maxRevisionAttempts: MAX_STOP_HOOK_REVISIONS,
          revisionPromptPrefix: STOP_HOOK_REVISION_PROMPT_PREFIX,
          onHookResult,
          onHookSkippedFactory
        })

        if (completionOutcome === "failed") {
          await tracer.finish("error", "Stop hook blocked completion")
          turnStateShouldDispose = true
          return
        }
        // "halted" falls through to the normal done path so the renderer stops
        // its loading indicator. The hook already explained why via sendNotice.

        await finalizeAutoCommit({
          threadId,
          workspacePath,
          userPrompt: message,
          snapshot: autoCommit.snapshot,
          window,
          channel
        })
        turnStateShouldDispose = true
        window.webContents.send(channel, { type: "done" })
        notifyIfBackground("✅ 任务完成", lastFinalText || assistantText.trim() || "对话已完成")
        showPetCompletedTaskNotice(
          threadId,
          getCompletedTaskTitle(thread?.title ?? undefined, message)
        )

        // Finish trace
        syncUsedSkillsContext()
        await tracer.finish("success")

        // Write routing feedback so next turn can use sticky/force logic
        if (invokeRoutingResult) {
          rememberRoutingFeedback(threadId, {
            resolvedTier: invokeRoutingResult.resolvedTier,
            resolvedModelId: usedModelId ?? invokeRoutingResult.resolvedModelId,
            outcome: "success",
            toolCallCount: toolCallCounter.getCount(),
            toolErrorCount,
            lastInputTokens: highWaterInputTokens > 0 ? highWaterInputTokens : undefined
          })
        }

        if (isOnlineSkillEvolutionEnabled()) {
          const proposalContext = appendTurnToProposalWindow("success")
          const recentUsedSkills = getRecentSkillUsageNames(threadId)
          const blockingUsedSkills = Array.from(
            new Set([...proposalContext.usedSkills, ...recentUsedSkills])
          )

          // Check if this turn crossed the skill-evolution threshold.
          const sessionToolCallCount = proposalContext.toolCallCount
          const threshold = getSkillEvolutionThreshold()
          if (shouldEvaluateSkillProposalWindow(sessionToolCallCount, threshold)) {
            const mode = getSkillProposalMode(isSkillAutoProposeEnabled())
            console.log(
              `[SkillEvolution][${threadId}] Threshold reached ${JSON.stringify({
                toolCallCount: sessionToolCallCount,
                windowToolCallCount: proposalContext.toolCallCount,
                threshold,
                mode,
                usedSkills: proposalContext.usedSkills,
                recentUsedSkills,
                turnCount: proposalContext.turnCount,
                errorCount: proposalContext.errorCount,
                toolCallSummary: proposalContext.toolCallSummary
              })}`
            )
            if (blockingUsedSkills.length > 0) {
              const names = ` [${blockingUsedSkills.join(", ")}]`
              console.log(
                `[SkillEvolution][${threadId}] Threshold skip because used skills were detected${names}`
              )
            } else {
              console.log(
                `[SkillEvolution][${threadId}] Threshold passed without used skills, evaluating proposal mode`
              )
              await autoProposeSKill(threadId, proposalContext).catch((e) =>
                console.warn("[Agent] autoProposeSKill failed:", e)
              )
            }
          }
        } else {
          resetSkillEvolutionSession(threadId)
        }

        // If this is a ChatX-linked thread, also send reply via HTTP (only final answer, no tool reasoning)
        const chatxReply = lastFinalText || stripThink(assistantText).trim()
        if (metadata.chatxRobotChatId && chatxReply) {
          trySendChatXReply(metadata.chatxRobotChatId as string, chatxReply)
        }

        const conversation = assistantText.trim()
          ? `User: ${message}\n\nAssistant: ${assistantText}`
          : ""

        if (isMemoryEnabled() && conversation.length >= MIN_CHARS_FOR_MEMORY) {
          const memoryStore = await getMemoryStore()
          const allConfigs = getCustomModelConfigs()

          // Use routing to pick memory summarization model (economy in auto mode)
          const memRoutingResult = await resolveModel({
            taskSource: "memory_summarize",
            threadId,
            requestedModelId: modelId ?? undefined,
            routingMode: getGlobalRoutingMode()
          }).catch(() => null)
          const memModelId = memRoutingResult?.resolvedModelId
          const memCfgId =
            memModelId?.replace("custom:", "") ?? modelId?.replace("custom:", "") ?? ""
          const config = allConfigs.find((c) => c.id === memCfgId) || allConfigs[0]

          if (!config) {
            console.warn("[Agent] No model config available — skipping memory summarization")
          } else if (config?.apiKey) {
            summarizeAndSave({
              model: new ChatOpenAI({
                model: config.model,
                apiKey: config.apiKey,
                configuration: { baseURL: config.baseUrl },
                maxTokens: config.maxOutputTokens,
                temperature: config.temperature,
                topP: config.topP,
                modelKwargs: {
                  ...(config.topK && config.topK > 0 ? { top_k: config.topK } : {})
                }
              }),
              conversation,
              memoryDir: memoryStore.getMemoryDir()
            }).catch((e) => console.warn("[Agent] Memory summarize failed:", e))
          }
        }
      }
    } catch (error) {
      if (isHookHaltError(error)) {
        console.warn("[Agent] Hook halted turn:", error.reason)
        sendHookHalt(window, channel, error)
        syncUsedSkillsContext()
        tracer.finish("cancelled", error.reason).catch(() => {})
        if (invokeRoutingResult) {
          rememberRoutingFeedback(threadId, {
            resolvedTier: invokeRoutingResult.resolvedTier,
            resolvedModelId: usedModelId ?? invokeRoutingResult.resolvedModelId,
            outcome: "cancelled",
            toolCallCount: toolCallCounter.getCount(),
            toolErrorCount,
            lastInputTokens: highWaterInputTokens > 0 ? highWaterInputTokens : undefined
          })
        }
        turnStateShouldDispose = true
        return
      }
      // Ignore abort-related errors (expected when stream is cancelled)
      const isAbortError =
        error instanceof Error &&
        (error.name === "AbortError" ||
          error.message.includes("aborted") ||
          error.message.includes("Controller is already closed"))

      if (!isAbortError) {
        const errMsg = error instanceof Error ? error.message : "Unknown error"
        console.error("[Agent] Error:", error)
        window.webContents.send(channel, {
          type: "error",
          error: errMsg
        })
        notifyIfBackground("❌ 任务失败", errMsg)
        if (isOnlineSkillEvolutionEnabled()) {
          appendTurnToProposalWindow("error", errMsg)
        } else {
          resetSkillEvolutionSession(threadId)
        }
        syncUsedSkillsContext()
        tracer.finish("error", errMsg).catch(() => {})
        if (invokeRoutingResult) {
          rememberRoutingFeedback(threadId, {
            resolvedTier: invokeRoutingResult.resolvedTier,
            resolvedModelId: usedModelId ?? invokeRoutingResult.resolvedModelId,
            outcome: "error",
            toolCallCount: toolCallCounter.getCount(),
            toolErrorCount,
            lastInputTokens: highWaterInputTokens > 0 ? highWaterInputTokens : undefined
          })
        }
        turnStateShouldDispose = true
      } else {
        syncUsedSkillsContext()
        tracer.finish("cancelled").catch(() => {})
        if (invokeRoutingResult) {
          rememberRoutingFeedback(threadId, {
            resolvedTier: invokeRoutingResult.resolvedTier,
            resolvedModelId: usedModelId ?? invokeRoutingResult.resolvedModelId,
            outcome: "cancelled",
            toolCallCount: toolCallCounter.getCount(),
            toolErrorCount,
            lastInputTokens: highWaterInputTokens > 0 ? highWaterInputTokens : undefined
          })
        }
        turnStateShouldDispose = true
      }
    } finally {
      if (activeRuns.get(threadId) === abortController) {
        activeRuns.delete(threadId)
      }
      if (turnStateShouldDispose && shouldDisposeTurnState(threadId, runToken)) {
        disposeTurnRuntimeState(turnState)
      }
      discardAgentAutoCommitTracking(threadId)
      // Clean up sandbox ACLs granted during this run (unelevated mode keeps them
      // across commands for performance, so we revoke them when the run ends).
      // Uses threadId to only release this run's ref-counts, not other concurrent runs'.
      LocalSandbox.revokeGrantedAclsForRun(threadId).catch((err) => {
        console.warn("[Agent] ACL cleanup error:", err)
      })
      // SessionEnd is NOT fired here — it belongs to thread lifecycle (delete / app quit),
      // not turn completion. See fireSessionEnd call in threads:delete handler.
    }
  })

  // Handle agent resume (after interrupt approval/rejection via useStream)
  ipcMain.on("agent:resume", async (event, { threadId, command, modelId }: AgentResumeParams) => {
    const channel = `agent:stream:${threadId}`
    const window = BrowserWindow.fromWebContents(event.sender)

    console.log("[Agent] Received resume request:", { threadId, command, modelId })

    if (!window) {
      console.error("[Agent] No window found for resume")
      return
    }

    // Get workspace path from thread metadata
    const thread = getThread(threadId)
    const metadata = thread?.metadata ? JSON.parse(thread.metadata) : {}
    const workspacePath = metadata.workspacePath as string | undefined
    const harnessAgentContext = getHarnessAgentContext(metadata)

    if (!workspacePath) {
      window.webContents.send(channel, {
        type: "error",
        error: "Workspace path is required"
      })
      disposeTurnState(threadId)
      return
    }

    // Abort any existing stream before resuming
    const existingController = activeRuns.get(threadId)
    if (existingController) {
      existingController.abort()
      activeRuns.delete(threadId)
    }

    const abortController = new AbortController()
    activeRuns.set(threadId, abortController)
    // Resume = same logical turn as the original `agent:invoke`. Reuse the
    // existing turn-state if it's still alive, then prune skill / plugin
    // scopes that didn't opt in to `persistAfterInterrupt`. Falls back to a
    // fresh state if the turn-state was disposed (e.g. process restart between
    // invoke and resume).
    const turnState = getOrCreateTurnState(threadId)
    const runToken = startTurnStateRun(turnState)
    pruneTurnStateAtInterrupt(turnState, getAllEnabledHooksForInterrupt(workspacePath))
    // Resume IPC payload has no userMessageId; without a fallback, all hook
    // events from this run would land in the renderer's "__background__"
    // bucket. Synthesize a deterministic id so the chip can still group them.
    ensureTurnId(turnState, threadId, "resume")
    const { hookScope, skillUseTracker, skillHookKeys, stopContextCollector } = turnState
    let turnStateShouldDispose = false
    const sendHookNotice = (notice: string): void => {
      window.webContents.send(channel, {
        type: "custom",
        data: { type: "hook_notice", message: notice }
      })
    }
    const sendStreamError = (error: string): void => {
      window.webContents.send(channel, {
        type: "error",
        error
      })
    }
    const onHookResult = makeHookResultCallback(window, channel, turnState.turnId)
    const onHookSkippedFactory = (event: HookEvent): ScopeSkipCallback =>
      makeHookSkippedCallback(window, channel, event, turnState.turnId)

    const onWindowClosed = (): void => {
      console.log("[Agent] Window closed, aborting resume stream for thread:", threadId)
      abortController.abort()
    }
    window.once("closed", onWindowClosed)
    sendActiveHookNotice(window, channel, workspacePath)
    const autoCommit = await beginAutoCommitTracking(threadId, workspacePath)

    try {
      const requestedModelIdResume = modelId || (metadata.model as string | undefined)
      const resumeRoutingResult = await resolveModel({
        taskSource: "chat",
        threadId,
        continuation: "resume",
        requestedModelId: requestedModelIdResume,
        routingMode: getGlobalRoutingMode()
      }).catch(() => null)
      const effectiveResumeModelId = resumeRoutingResult?.resolvedModelId ?? requestedModelIdResume

      const resumeStreamConfig = {
        configurable: { thread_id: threadId },
        signal: abortController.signal,
        streamMode: ["messages", "values"] as ("messages" | "values")[],
        recursionLimit: 1000
      }

      // Resume from checkpoint by streaming with Command containing the decision
      // The HITL middleware expects one decision per pending tool call
      const decisionType = command?.resume?.decision || "approve"
      const pendingCount = command?.resume?.pendingCount ?? 1
      const decisions = Array.from({ length: pendingCount }, () => ({ type: decisionType }))
      const resumeValue = { decisions }

      // ── Failover loop for resume ──
      const resumePrimaryTier = resumeRoutingResult?.resolvedTier ?? "premium"
      const resumeOrderedChain = buildOrderedChain(
        effectiveResumeModelId,
        resumeRoutingResult?.fallbackChain,
        resumePrimaryTier,
        resumeRoutingResult?.layer !== "pinned"
      )
      const resumeFailoverAttempts: FailoverAttempt[] = []
      let resumeUsedModelId = effectiveResumeModelId
      let resumeStream: AsyncIterable<unknown> | null = null
      let resumeAgentRuntime: Awaited<ReturnType<typeof createAgentRuntime>> | null = null

      for (const candidateId of resumeOrderedChain) {
        if (abortController.signal.aborted) break
        try {
          const resumeAgent = await createAgentRuntime({
            threadId,
            workspacePath,
            modelId: candidateId,
            abortSignal: abortController.signal,
            enableRequestUserInput: true,
            noSkillEvolutionTool: true,
            retryHooks: buildModelRetryHooks(window, channel),
            maxRetryAttempts: getMaxRetryAttemptsForRoutingMode(),
            onHookResult,
            hookTurnId: turnState.turnId,
            onHookSkippedFactory,
            hookScope,
            skillHookKeys,
            skillUseTracker,
            ...harnessAgentContext,
            onFileMutation: autoCommit.onFileMutation
          })
          resumeStream = await resumeAgent.stream(
            new Command({ resume: resumeValue }),
            resumeStreamConfig
          )
          resumeAgentRuntime = resumeAgent
          resumeUsedModelId = candidateId
          break
        } catch (err) {
          if (!isRetryableApiError(err)) throw err
          resumeFailoverAttempts.push({
            modelId: candidateId,
            error: String(err),
            timestamp: Date.now()
          })
          console.warn(`[Agent][Failover][Resume] ${candidateId} failed: ${err}, trying next...`)
          if (!abortController.signal.aborted) {
            await new Promise((r) => setTimeout(r, 500))
          }
        }
      }

      // P3: cancellation during failover
      if (abortController.signal.aborted) {
        throw Object.assign(new Error("aborted"), { name: "AbortError" })
      }

      if (!resumeStream) {
        const allErrors = resumeFailoverAttempts.map((a) => `${a.modelId}: ${a.error}`).join("; ")
        throw new Error(`All models failed during resume: ${allErrors}`)
      }

      // Notify frontend + persist routing state if failover happened
      const notifyResumeFailover = (): void => {
        if (resumeFailoverAttempts.length > 0 && resumeUsedModelId !== effectiveResumeModelId) {
          const usedCfgId = resumeUsedModelId?.startsWith("custom:")
            ? resumeUsedModelId.slice("custom:".length)
            : resumeUsedModelId
          const usedCfg = getCustomModelConfigs().find((c) => c.id === usedCfgId)
          window.webContents.send(channel, {
            type: "custom",
            data: {
              type: "routing_result",
              resolvedModelId: resumeUsedModelId,
              resolvedTier: usedCfg?.tier ?? "premium",
              routeReason: `failover from ${resumeFailoverAttempts[0].modelId}`
            }
          })
          window.webContents.send(channel, {
            type: "custom",
            data: {
              type: "model_failover",
              attempts: resumeFailoverAttempts,
              activeModelId: resumeUsedModelId
            }
          })
          // P2: persist failover model + sticky in a single atomic write
          rememberRoutingDecision(
            threadId,
            {
              resolvedModelId: resumeUsedModelId!,
              resolvedTier: usedCfg?.tier ?? "premium",
              routeReason: `failover from ${resumeFailoverAttempts[0].modelId}`,
              fallbackChain: [],
              layer: "pinned"
            },
            resumeUsedModelId!
          )
        }
      }
      notifyResumeFailover()

      // P1: Mid-stream failover for resume
      const resumeRemainingCandidates = resumeOrderedChain.slice(
        resumeUsedModelId
          ? resumeOrderedChain.indexOf(resumeUsedModelId) + 1
          : resumeOrderedChain.length
      )
      let activeResumeStream: AsyncIterable<unknown> = resumeStream
      const resumeSubagentStopFired = new Set<string>()

      const consumeResumeStream = async (source: AsyncIterable<unknown>): Promise<void> => {
        for await (const chunk of source) {
          if (abortController.signal.aborted) break
          const [mode, data] = chunk as unknown as [string, unknown]
          const serialized = serializeStreamData(data)
          window.webContents.send(channel, {
            type: "stream",
            mode,
            data: serialized
          })
          if (mode === "messages") {
            await maybeRunSubagentStopHooksFromStreamPayload({
              payload: serialized,
              workspacePath,
              threadId,
              turnId: turnState.turnId,
              hookScope,
              pluginOutputDir: harnessAgentContext.pluginOutputDir,
              systemId: harnessAgentContext.systemId,
              firedToolCallIds: resumeSubagentStopFired,
              onHookResult,
              onHookSkipped: onHookSkippedFactory("SubagentStop")
            })
          }
          stopContextCollector.processStreamChunk(mode, serialized)
        }
      }

      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          await consumeResumeStream(activeResumeStream)
          break
        } catch (midErr) {
          if (!isRetryableApiError(midErr) || resumeRemainingCandidates.length === 0) throw midErr
          if (abortController.signal.aborted) throw midErr

          resumeFailoverAttempts.push({
            modelId: resumeUsedModelId ?? "unknown",
            error: String(midErr),
            timestamp: Date.now()
          })
          console.warn(
            `[Agent][Failover][Resume] Mid-stream ${resumeUsedModelId} failed: ${midErr}, trying next...`
          )
          if (!abortController.signal.aborted) await new Promise((r) => setTimeout(r, 500))

          const nextCandidate = resumeRemainingCandidates.shift()!
          const nextAgent = await createAgentRuntime({
            threadId,
            workspacePath,
            modelId: nextCandidate,
            abortSignal: abortController.signal,
            enableRequestUserInput: true,
            noSkillEvolutionTool: true,
            retryHooks: buildModelRetryHooks(window, channel),
            maxRetryAttempts: getMaxRetryAttemptsForRoutingMode(),
            onHookResult,
            hookTurnId: turnState.turnId,
            onHookSkippedFactory,
            hookScope,
            skillHookKeys,
            skillUseTracker,
            ...harnessAgentContext,
            onFileMutation: autoCommit.onFileMutation
          })
          activeResumeStream = await nextAgent.stream(
            new Command({ resume: resumeValue }),
            resumeStreamConfig
          )
          resumeAgentRuntime = nextAgent
          resumeUsedModelId = nextCandidate
          notifyResumeFailover()
        }
      }

      if (!abortController.signal.aborted) {
        const completionOutcome = await runCompletionHooksWithRevision({
          threadId,
          workspacePath: workspacePath ?? undefined,
          turnId: turnState.turnId,
          pluginOutputDir: harnessAgentContext.pluginOutputDir,
          systemId: harnessAgentContext.systemId,
          abortSignal: abortController.signal,
          getStopContext: () => stopContextCollector.snapshot(),
          runRevision: async (revisionPrompt) => {
            if (!resumeAgentRuntime)
              throw new Error("Cannot revise after Stop hook: agent runtime is unavailable")
            const revisionStream = await resumeAgentRuntime.stream(
              { messages: [new HumanMessage(revisionPrompt)] },
              resumeStreamConfig
            )
            await consumeResumeStream(revisionStream)
          },
          sendNotice: sendHookNotice,
          sendError: sendStreamError,
          hookScope,
          skillUseTracker,
          maxRevisionAttempts: MAX_STOP_HOOK_REVISIONS,
          revisionPromptPrefix: STOP_HOOK_REVISION_PROMPT_PREFIX,
          onHookResult,
          onHookSkippedFactory
        })

        if (completionOutcome === "failed") {
          turnStateShouldDispose = true
          return
        }
        // "halted" falls through to the done path so the renderer stops loading.

        await finalizeAutoCommit({
          threadId,
          workspacePath,
          userPrompt: stopContextCollector.snapshot().userMessage ?? "continue agent task",
          snapshot: autoCommit.snapshot,
          window,
          channel
        })
        turnStateShouldDispose = true
        window.webContents.send(channel, { type: "done" })
      }
    } catch (error) {
      if (isHookHaltError(error)) {
        console.warn("[Agent] Resume hook halted turn:", error.reason)
        sendHookHalt(window, channel, error)
        turnStateShouldDispose = true
        return
      }
      const isAbortError =
        error instanceof Error &&
        (error.name === "AbortError" ||
          error.message.includes("aborted") ||
          error.message.includes("Controller is already closed"))

      if (!isAbortError) {
        console.error("[Agent] Resume error:", error)
        window.webContents.send(channel, {
          type: "error",
          error: error instanceof Error ? error.message : "Unknown error"
        })
      }
      turnStateShouldDispose = true
    } finally {
      if (activeRuns.get(threadId) === abortController) {
        activeRuns.delete(threadId)
      }
      if (turnStateShouldDispose && shouldDisposeTurnState(threadId, runToken)) {
        disposeTurnRuntimeState(turnState)
      }
      discardAgentAutoCommitTracking(threadId)
    }
  })

  // Handle HITL interrupt response
  // NOTE: With the orchestrator-based approval system, execute commands are no
  // longer interrupted via HITL middleware. This handler remains for backward
  // compatibility and non-execute tool interrupts.
  ipcMain.on("agent:interrupt", async (event, { threadId, decision }: AgentInterruptParams) => {
    const channel = `agent:stream:${threadId}`
    const window = BrowserWindow.fromWebContents(event.sender)

    if (!window) {
      console.error("[Agent] No window found for interrupt response")
      return
    }

    // Get workspace path from thread metadata - REQUIRED
    const thread = getThread(threadId)
    const metadata = thread?.metadata ? JSON.parse(thread.metadata) : {}
    const workspacePath = metadata.workspacePath as string | undefined
    const modelId = metadata.model as string | undefined
    const harnessAgentContext = getHarnessAgentContext(metadata)

    if (!workspacePath) {
      window.webContents.send(channel, {
        type: "error",
        error: "Workspace path is required"
      })
      disposeTurnState(threadId)
      return
    }

    // Abort any existing stream before continuing
    const existingController = activeRuns.get(threadId)
    if (existingController) {
      existingController.abort()
      activeRuns.delete(threadId)
    }

    const abortController = new AbortController()
    activeRuns.set(threadId, abortController)
    // Same-turn resume from a tool-call interrupt — reuse turn-state and
    // prune non-persistent skills (mirrors `agent:resume`).
    const turnState = getOrCreateTurnState(threadId)
    const runToken = startTurnStateRun(turnState)
    pruneTurnStateAtInterrupt(turnState, getAllEnabledHooksForInterrupt(workspacePath))
    // Interrupt IPC payload also lacks userMessageId; same rationale as the
    // resume path above. Synthesize a fallback so hook events from this run
    // don't all collapse into the "__background__" bucket.
    ensureTurnId(turnState, threadId, "interrupt")
    const { hookScope, skillUseTracker, skillHookKeys, stopContextCollector } = turnState
    let turnStateShouldDispose = false
    const sendHookNotice = (notice: string): void => {
      window.webContents.send(channel, {
        type: "custom",
        data: { type: "hook_notice", message: notice }
      })
    }
    const sendStreamError = (error: string): void => {
      window.webContents.send(channel, {
        type: "error",
        error
      })
    }
    const onHookResult = makeHookResultCallback(window, channel, turnState.turnId)
    const onHookSkippedFactory = (event: HookEvent): ScopeSkipCallback =>
      makeHookSkippedCallback(window, channel, event, turnState.turnId)

    const onWindowClosed = (): void => {
      console.log("[Agent] Window closed, aborting interrupt stream for thread:", threadId)
      abortController.abort()
    }
    window.once("closed", onWindowClosed)
    sendActiveHookNotice(window, channel, workspacePath)
    const autoCommit = await beginAutoCommitTracking(threadId, workspacePath)

    try {
      const interruptRoutingResult = await resolveModel({
        taskSource: "chat",
        threadId,
        continuation: "interrupt",
        requestedModelId: modelId ?? undefined,
        routingMode: getGlobalRoutingMode()
      }).catch(() => null)
      const effectiveInterruptModelId =
        interruptRoutingResult?.resolvedModelId ?? modelId ?? undefined

      const interruptStreamConfig = {
        configurable: { thread_id: threadId },
        signal: abortController.signal,
        streamMode: ["messages", "values"] as ("messages" | "values")[],
        recursionLimit: 1000
      }

      if (decision.type === "approve") {
        // ── Failover loop for interrupt-continue ──
        const intPrimaryTier = interruptRoutingResult?.resolvedTier ?? "premium"
        const intOrderedChain = buildOrderedChain(
          effectiveInterruptModelId,
          interruptRoutingResult?.fallbackChain,
          intPrimaryTier,
          interruptRoutingResult?.layer !== "pinned"
        )
        const intFailoverAttempts: FailoverAttempt[] = []
        let intUsedModelId = effectiveInterruptModelId
        let intStream: AsyncIterable<unknown> | null = null
        let intAgentRuntime: Awaited<ReturnType<typeof createAgentRuntime>> | null = null

        for (const candidateId of intOrderedChain) {
          if (abortController.signal.aborted) break
          try {
            const intAgent = await createAgentRuntime({
              threadId,
              workspacePath,
              modelId: candidateId,
              abortSignal: abortController.signal,
              enableRequestUserInput: true,
              noSkillEvolutionTool: true,
              retryHooks: buildModelRetryHooks(window, channel),
              maxRetryAttempts: getMaxRetryAttemptsForRoutingMode(),
              onHookResult,
              hookTurnId: turnState.turnId,
              onHookSkippedFactory,
              hookScope,
              skillHookKeys,
              skillUseTracker,
              ...harnessAgentContext,
              onFileMutation: autoCommit.onFileMutation
            })
            intStream = await intAgent.stream(null, interruptStreamConfig)
            intAgentRuntime = intAgent
            intUsedModelId = candidateId
            break
          } catch (err) {
            if (!isRetryableApiError(err)) throw err
            intFailoverAttempts.push({
              modelId: candidateId,
              error: String(err),
              timestamp: Date.now()
            })
            console.warn(
              `[Agent][Failover][Interrupt] ${candidateId} failed: ${err}, trying next...`
            )
            if (!abortController.signal.aborted) {
              await new Promise((r) => setTimeout(r, 500))
            }
          }
        }

        // P3: cancellation during failover
        if (abortController.signal.aborted) {
          throw Object.assign(new Error("aborted"), { name: "AbortError" })
        }

        if (!intStream) {
          const allErrors = intFailoverAttempts.map((a) => `${a.modelId}: ${a.error}`).join("; ")
          throw new Error(`All models failed during interrupt-continue: ${allErrors}`)
        }

        // Notify frontend + persist routing state if failover happened
        const notifyIntFailover = (): void => {
          if (intFailoverAttempts.length > 0 && intUsedModelId !== effectiveInterruptModelId) {
            const usedCfgId = intUsedModelId?.startsWith("custom:")
              ? intUsedModelId.slice("custom:".length)
              : intUsedModelId
            const usedCfg = getCustomModelConfigs().find((c) => c.id === usedCfgId)
            window.webContents.send(channel, {
              type: "custom",
              data: {
                type: "routing_result",
                resolvedModelId: intUsedModelId,
                resolvedTier: usedCfg?.tier ?? "premium",
                routeReason: `failover from ${intFailoverAttempts[0].modelId}`
              }
            })
            window.webContents.send(channel, {
              type: "custom",
              data: {
                type: "model_failover",
                attempts: intFailoverAttempts,
                activeModelId: intUsedModelId
              }
            })
            // P2: persist failover model + sticky in a single atomic write
            rememberRoutingDecision(
              threadId,
              {
                resolvedModelId: intUsedModelId!,
                resolvedTier: usedCfg?.tier ?? "premium",
                routeReason: `failover from ${intFailoverAttempts[0].modelId}`,
                fallbackChain: [],
                layer: "pinned"
              },
              intUsedModelId!
            )
          }
        }
        notifyIntFailover()

        // P1: Mid-stream failover for interrupt-continue
        const intRemainingCandidates = intOrderedChain.slice(
          intUsedModelId ? intOrderedChain.indexOf(intUsedModelId) + 1 : intOrderedChain.length
        )
        let activeIntStream: AsyncIterable<unknown> = intStream
        const interruptSubagentStopFired = new Set<string>()

        const consumeInterruptStream = async (source: AsyncIterable<unknown>): Promise<void> => {
          for await (const chunk of source) {
            if (abortController.signal.aborted) break
            const [mode, data] = chunk as unknown as [string, unknown]
            const serialized = serializeStreamData(data)
            window.webContents.send(channel, {
              type: "stream",
              mode,
              data: serialized
            })
            if (mode === "messages") {
              await maybeRunSubagentStopHooksFromStreamPayload({
                payload: serialized,
                workspacePath,
                threadId,
                turnId: turnState.turnId,
                hookScope,
                pluginOutputDir: harnessAgentContext.pluginOutputDir,
                systemId: harnessAgentContext.systemId,
                firedToolCallIds: interruptSubagentStopFired,
                onHookResult,
                onHookSkipped: onHookSkippedFactory("SubagentStop")
              })
            }
            stopContextCollector.processStreamChunk(mode, serialized)
          }
        }

        // eslint-disable-next-line no-constant-condition
        while (true) {
          try {
            await consumeInterruptStream(activeIntStream)
            break
          } catch (midErr) {
            if (!isRetryableApiError(midErr) || intRemainingCandidates.length === 0) throw midErr
            if (abortController.signal.aborted) throw midErr

            intFailoverAttempts.push({
              modelId: intUsedModelId ?? "unknown",
              error: String(midErr),
              timestamp: Date.now()
            })
            console.warn(
              `[Agent][Failover][Interrupt] Mid-stream ${intUsedModelId} failed: ${midErr}, trying next...`
            )
            if (!abortController.signal.aborted) await new Promise((r) => setTimeout(r, 500))

            const nextCandidate = intRemainingCandidates.shift()!
            const nextAgent = await createAgentRuntime({
              threadId,
              workspacePath,
              modelId: nextCandidate,
              abortSignal: abortController.signal,
              enableRequestUserInput: true,
              noSkillEvolutionTool: true,
              retryHooks: buildModelRetryHooks(window, channel),
              maxRetryAttempts: getMaxRetryAttemptsForRoutingMode(),
              onHookResult,
              hookTurnId: turnState.turnId,
              onHookSkippedFactory,
              hookScope,
              skillHookKeys,
              skillUseTracker,
              ...harnessAgentContext,
              onFileMutation: autoCommit.onFileMutation
            })
            activeIntStream = await nextAgent.stream(null, interruptStreamConfig)
            intAgentRuntime = nextAgent
            intUsedModelId = nextCandidate
            notifyIntFailover()
          }
        }

        if (!abortController.signal.aborted) {
          const completionOutcome = await runCompletionHooksWithRevision({
            threadId,
            workspacePath: workspacePath ?? undefined,
            turnId: turnState.turnId,
            pluginOutputDir: harnessAgentContext.pluginOutputDir,
            systemId: harnessAgentContext.systemId,
            abortSignal: abortController.signal,
            getStopContext: () => stopContextCollector.snapshot(),
            runRevision: async (revisionPrompt) => {
              if (!intAgentRuntime)
                throw new Error("Cannot revise after Stop hook: agent runtime is unavailable")
              const revisionStream = await intAgentRuntime.stream(
                { messages: [new HumanMessage(revisionPrompt)] },
                interruptStreamConfig
              )
              await consumeInterruptStream(revisionStream)
            },
            sendNotice: sendHookNotice,
            sendError: sendStreamError,
            hookScope,
            skillUseTracker,
            maxRevisionAttempts: MAX_STOP_HOOK_REVISIONS,
            revisionPromptPrefix: STOP_HOOK_REVISION_PROMPT_PREFIX,
            onHookResult,
            onHookSkippedFactory
          })

          if (completionOutcome === "failed") {
            turnStateShouldDispose = true
            return
          }
          // "halted" falls through to the done path so the renderer stops loading.

          await finalizeAutoCommit({
            threadId,
            workspacePath,
            userPrompt: stopContextCollector.snapshot().userMessage ?? "continue agent task",
            snapshot: autoCommit.snapshot,
            window,
            channel
          })
          turnStateShouldDispose = true
          window.webContents.send(channel, { type: "done" })
        }
      } else if (decision.type === "reject") {
        // For reject, we need to send a Command with reject decision
        // For now, just send done - the agent will see no resumption happened
        turnStateShouldDispose = true
        window.webContents.send(channel, { type: "done" })
      }
      // edit case handled similarly to approve with modified args
    } catch (error) {
      if (isHookHaltError(error)) {
        console.warn("[Agent] Interrupt hook halted turn:", error.reason)
        sendHookHalt(window, channel, error)
        turnStateShouldDispose = true
        return
      }
      const isAbortError =
        error instanceof Error &&
        (error.name === "AbortError" ||
          error.message.includes("aborted") ||
          error.message.includes("Controller is already closed"))

      if (!isAbortError) {
        console.error("[Agent] Interrupt error:", error)
        window.webContents.send(channel, {
          type: "error",
          error: error instanceof Error ? error.message : "Unknown error"
        })
      }
      turnStateShouldDispose = true
    } finally {
      if (activeRuns.get(threadId) === abortController) {
        activeRuns.delete(threadId)
      }
      if (turnStateShouldDispose && shouldDisposeTurnState(threadId, runToken)) {
        disposeTurnRuntimeState(turnState)
      }
      discardAgentAutoCommitTracking(threadId)
    }
  })

  // Handle cancellation
  ipcMain.handle("agent:cancel", async (_event, { threadId }: AgentCancelParams) => {
    const controller = activeRuns.get(threadId)
    console.log(
      `[Agent] cancel: threadId=${threadId}, hasController=${!!controller}, activeRuns=[${Array.from(activeRuns.keys()).join(", ")}]`
    )
    // Cancel any background tasks belonging to this thread (e.g. builds, tests)
    LocalSandbox.cancelBackgroundTasks(threadId)
    if (controller) {
      controller.abort()
      activeRuns.delete(threadId)
      console.log(`[Agent] cancel: aborted controller for thread ${threadId}`)
    } else {
      console.warn(`[Agent] cancel: no active run found for thread ${threadId}`)
    }
  })
}
