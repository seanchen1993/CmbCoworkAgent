import { v4 as uuid } from "uuid"
import { getThread, mergeThreadValues, upsertThreadMessages } from "../db"
import {
  startAgentRun,
  type AgentRunDelivery
} from "../agent/agent-run-service"
import { emitAppAttention } from "../app-attention-events"
import { listAllSkills, listPluginSkills } from "../ipc/skills"
import { normalizeSkillId } from "../skills/ids"
import { createThreadService } from "../services/thread-service"
import { generateTitle } from "../services/title-generator"
import { getDisabledSkills } from "../storage"
import type { AgentInvokeParams, SkillMetadata } from "../types"
import { getHarnessProjectAdapterSnapshot } from "./service"
import { resolveAgentStreamRequestChannel } from "../../shared/agent-stream-channel"
import { formatSkillUseBlock } from "../../shared/skill-use-block"
import {
  AUTO_MODE_MANAGED_STREAM_STARTED_CHANNEL,
  AUTO_MODE_PENDING_DRAFT_THREAD_VALUE_KEY,
  HARNESS_SOURCE,
  type HarnessAdapterSnapshot,
  type AutoModeNextAction,
  type AutoNextStepAction,
  type ManagedAutoSendStreamStartEvent,
  type ManagedActionResult,
  type PendingAutoDraft
} from "../../shared/harness-board-types"

export interface ManagedActionExecutionContext {
  eventId: string
  sourceThreadId: string
  projectId: string
  featureId: string
  messages: string
}

export interface ExecuteManagedActionsInput {
  context: ManagedActionExecutionContext
  actions: AutoNextStepAction[]
  delivery: AgentRunDelivery
}

export interface ExecuteManagedActionsResult {
  results: ManagedActionResult[]
  pendingDrafts: PendingAutoDraft[]
}

interface PreparedHarnessMessage {
  modelMessage: string
  displayMessage: string
  userMessageId: string
}

function parseThreadMetadata(threadId: string): Record<string, unknown> {
  const thread = getThread(threadId)
  if (!thread) throw new Error(`未找到会话：${threadId}`)
  if (!thread.metadata) return {}
  try {
    const parsed = JSON.parse(thread.metadata) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    throw new Error(`会话 metadata 无法解析：${threadId}`)
  }
}

function getSourceWorkspacePath(sourceThreadId: string): string {
  const workspacePath = parseThreadMetadata(sourceThreadId).workspacePath
  if (typeof workspacePath !== "string" || !workspacePath.trim()) {
    throw new Error("来源会话缺少 workspacePath")
  }
  return workspacePath.trim()
}

function normalizePluginIdentity(value: string | null | undefined): string {
  return normalizeSkillId(value ?? "")
}

function isPluginSkill(skill: SkillMetadata): boolean {
  return Boolean(skill.pluginId?.trim() || skill.pluginName?.trim())
}

function isPreferredPluginSkill(
  skill: SkillMetadata,
  preferredPlugin: HarnessAdapterSnapshot | null
): boolean {
  if (!preferredPlugin) return false
  const preferredId = normalizePluginIdentity(preferredPlugin.id)
  const preferredName = normalizePluginIdentity(preferredPlugin.name)
  return Boolean(
    (preferredId && normalizePluginIdentity(skill.pluginId) === preferredId) ||
    (preferredName && normalizePluginIdentity(skill.pluginName) === preferredName)
  )
}

function isLocalSkillDisabled(
  skill: SkillMetadata,
  disabledSkillIds: ReadonlySet<string>
): boolean {
  if (isPluginSkill(skill)) return false
  const id = normalizeSkillId(skill.id || skill.relativePath || skill.name)
  const name = normalizeSkillId(skill.name)
  for (const disabledId of disabledSkillIds) {
    if (id && (id === disabledId || id.startsWith(`${disabledId}/`))) return true
  }
  return Boolean(name && disabledSkillIds.has(name))
}

async function resolveHarnessSkill(
  projectId: string,
  slashSkill: string
): Promise<SkillMetadata | null> {
  const normalizedSlashSkill = normalizeSkillId(slashSkill)
  if (!normalizedSlashSkill) return null

  const [localSkills, pluginSkills] = await Promise.all([listAllSkills(), listPluginSkills()])
  const disabledSkillIds = new Set(getDisabledSkills().map(normalizeSkillId))
  const preferredPlugin = getHarnessProjectAdapterSnapshot(projectId)
  const matches = [...localSkills, ...pluginSkills].filter((skill) => {
    if (normalizeSkillId(skill.name) !== normalizedSlashSkill) return false
    if (isLocalSkillDisabled(skill, disabledSkillIds)) return false
    if (!preferredPlugin) return true
    return !isPluginSkill(skill) || isPreferredPluginSkill(skill, preferredPlugin)
  })
  return (
    matches.find((skill) => isPreferredPluginSkill(skill, preferredPlugin)) ?? matches[0] ?? null
  )
}

async function prepareHarnessMessage(
  projectId: string,
  nextAction: AutoModeNextAction
): Promise<PreparedHarnessMessage> {
  const userMessage = nextAction.userMessage?.trim() ?? ""
  const slashSkill = nextAction.slashSkill?.trim() ?? ""
  let skillBlock = ""
  if (slashSkill) {
    const skill = await resolveHarnessSkill(projectId, slashSkill)
    if (!skill) {
      throw new Error(`未找到当前 Harness 插件可用的 Skill：${slashSkill}`)
    }
    skillBlock = formatSkillUseBlock({
      name: skill.name,
      path: skill.path,
      description: skill.description,
      metadata: skill.metadata,
      allowedTools: skill.allowedTools
    })
  }
  const modelMessage = [userMessage, skillBlock].filter(Boolean).join("\n\n")
  return {
    modelMessage,
    displayMessage: modelMessage,
    userMessageId: uuid()
  }
}

function resolveAgentRunDelivery(preferred: AgentRunDelivery): AgentRunDelivery {
  if (preferred.isAvailable()) return preferred
  throw new Error("没有可用的应用主窗口，无法启动托管 Agent")
}

function buildManagedAgentRunRequest(
  threadId: string,
  message: PreparedHarnessMessage
): AgentInvokeParams {
  const metadata = parseThreadMetadata(threadId)
  const modelId = typeof metadata.model === "string" ? metadata.model.trim() : ""
  const agentMode =
    metadata.agentMode === "normal" ||
    metadata.agentMode === "coordinator" ||
    metadata.agentMode === "workflow"
      ? metadata.agentMode
      : undefined
  return {
    threadId,
    streamRequestId: `managed-${uuid()}`,
    message: message.modelMessage,
    userMessageId: message.userMessageId,
    ...(modelId ? { modelId } : {}),
    ...(agentMode ? { agentMode } : {})
  }
}

async function startManagedAgentRun(
  threadId: string,
  prepared: PreparedHarnessMessage,
  delivery: AgentRunDelivery
): Promise<void> {
  const request = buildManagedAgentRunRequest(threadId, prepared)
  const resolvedDelivery = resolveAgentRunDelivery(delivery)
  const persistedCount = upsertThreadMessages(threadId, [
    {
      id: prepared.userMessageId,
      role: "user",
      content: prepared.displayMessage,
      created_at: new Date()
    }
  ])
  if (persistedCount !== 1) {
    throw new Error(`无法保存托管用户消息：${threadId}`)
  }
  const streamRequestId = request.streamRequestId
  if (!streamRequestId) {
    throw new Error(`托管 Agent 缺少流请求标识：${threadId}`)
  }
  const streamStartEvent: ManagedAutoSendStreamStartEvent = {
    runId: streamRequestId,
    threadId,
    streamRequestId,
    ...(request.agentMode ? { agentMode: request.agentMode } : {})
  }
  resolvedDelivery.send(AUTO_MODE_MANAGED_STREAM_STARTED_CHANNEL, streamStartEvent)

  let handle: Awaited<ReturnType<typeof startAgentRun>>
  try {
    handle = await startAgentRun(request, resolvedDelivery)
  } catch (error) {
    const requestChannel = resolveAgentStreamRequestChannel(
      `agent:stream:${threadId}`,
      streamRequestId
    )
    resolvedDelivery.send(requestChannel, {
      type: "error",
      error: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
  void handle.completion.catch((error) => {
    console.error(`[AutoMode] Managed Agent run failed for thread ${handle.threadId}:`, error)
    emitAppAttention({
      kind: "task-error",
      threadId: handle.threadId,
      key: `managed-mode-run:${prepared.userMessageId}`
    })
  })
}

async function resolveActionTargetThreadId(
  action: AutoNextStepAction,
  context: ManagedActionExecutionContext
): Promise<string | undefined> {
  if (action.actionType === "complete") return undefined
  if (action.actionType === "continue_current_session") return context.sourceThreadId

  const workspacePath =
    action.sessionWorkspace?.trim() || getSourceWorkspacePath(context.sourceThreadId)
  const titleSource = action.nextAction.autoSend
    ? (action.nextAction.userMessage?.trim() ?? "")
    : ""
  const thread = await createThreadService({
    workspacePath,
    ...(titleSource ? { title: generateTitle(titleSource) } : {}),
    harnessFeature: {
      projectId: context.projectId,
      slug: context.featureId,
      source: HARNESS_SOURCE
    }
  })
  return thread.thread_id
}

function persistPendingAutoDraft(draft: PendingAutoDraft): void {
  const thread = mergeThreadValues(draft.targetThreadId, {
    [AUTO_MODE_PENDING_DRAFT_THREAD_VALUE_KEY]: draft
  })
  if (!thread) {
    throw new Error(`无法保存托管草稿，会话不存在：${draft.targetThreadId}`)
  }
}

export async function executeManagedActions({
  context,
  actions,
  delivery
}: ExecuteManagedActionsInput): Promise<ExecuteManagedActionsResult> {
  const results: ManagedActionResult[] = []
  const pendingDrafts: PendingAutoDraft[] = []

  for (const [actionIndex, action] of actions.entries()) {
    let targetThreadId: string | undefined
    try {
      const prepared =
        action.actionType !== "complete" && action.nextAction.autoSend
          ? await prepareHarnessMessage(context.projectId, action.nextAction)
          : undefined
      targetThreadId = await resolveActionTargetThreadId(action, context)
      if (action.actionType !== "complete" && targetThreadId) {
        if (prepared) {
          await startManagedAgentRun(targetThreadId, prepared, delivery)
        } else {
          const pendingDraft: PendingAutoDraft = {
            targetThreadId,
            ...(action.nextAction.slashSkill ? { slashSkill: action.nextAction.slashSkill } : {}),
            ...(action.nextAction.userMessage !== undefined
              ? { userMessage: action.nextAction.userMessage }
              : {})
          }
          persistPendingAutoDraft(pendingDraft)
          pendingDrafts.push(pendingDraft)
        }
      }
      results.push({
        eventId: context.eventId,
        actionIndex,
        actionType: action.actionType,
        status: "succeeded",
        ...(targetThreadId ? { targetThreadId } : {})
      })
    } catch (error) {
      results.push({
        eventId: context.eventId,
        actionIndex,
        actionType: action.actionType,
        status: "failed",
        ...(targetThreadId ? { targetThreadId } : {}),
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return { results, pendingDrafts }
}
