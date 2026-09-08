import { v4 as uuid } from "uuid"
import { getThread, upsertThreadMessages } from "../db"
import { startAgentRun, type AgentRunDelivery } from "../agent/agent-run-service"
import { emitAppAttention } from "../app-attention-events"
import { listAllSkills, listPluginSkills } from "../ipc/skills"
import { normalizeSkillId } from "../skills/ids"
import { createThreadService } from "../services/thread-service"
import { generateTitle } from "../services/title-generator"
import { getDisabledSkills } from "../storage"
import type { AgentInvokeParams, SkillMetadata, Thread } from "../types"
import { getHarnessProjectAdapterSnapshot } from "./service"
import { resolveAgentStreamRequestChannel } from "../../shared/agent-stream-channel"
import { formatSkillUseBlock } from "../../shared/skill-use-block"
import {
  AUTO_MODE_MANAGED_STREAM_STARTED_CHANNEL,
  HARNESS_SOURCE,
  type HarnessAdapterSnapshot,
  type ManagedAutoSendStreamStartEvent,
  type ManagedRunSessionAction
} from "../../shared/harness-board-types"

interface PreparedHarnessMessage {
  modelMessage: string
  displayMessage: string
  userMessageId: string
}

export class ManagedActionValidationError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string
  ) {
    super(message)
    this.name = "ManagedActionValidationError"
  }
}

export interface CreateManagedHarnessSessionInput {
  projectId: string
  featureId: string
  runId: string
  nodeId: string
  nextAction: ManagedRunSessionAction
  workspacePath: string
  delivery: AgentRunDelivery
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
  const preferredPlugin = await getHarnessProjectAdapterSnapshot(projectId)
  const matches = [...localSkills, ...pluginSkills].filter((skill) => {
    if (normalizeSkillId(skill.name) !== normalizedSlashSkill) return false
    if (isLocalSkillDisabled(skill, disabledSkillIds)) return false
    return !isPluginSkill(skill) || isPreferredPluginSkill(skill, preferredPlugin)
  })
  return (
    matches.find((skill) => isPreferredPluginSkill(skill, preferredPlugin)) ?? matches[0] ?? null
  )
}

async function prepareHarnessMessage(
  projectId: string,
  nextAction: ManagedRunSessionAction
): Promise<PreparedHarnessMessage> {
  const userMessage = nextAction.userMessage.trim()
  const slashSkill = nextAction.slashSkill.trim()
  if (!slashSkill) {
    throw new ManagedActionValidationError(
      "next_action_missing_slash_skill",
      "当前节点的 nextAction 缺少 slashSkill"
    )
  }
  if (!userMessage) {
    throw new ManagedActionValidationError(
      "next_action_missing_user_message",
      "当前节点的 nextAction 缺少 userMessage"
    )
  }
  let skillBlock = ""
  const skill = await resolveHarnessSkill(projectId, slashSkill)
  if (!skill) {
    throw new ManagedActionValidationError(
      "next_action_skill_unavailable",
      `未找到当前 Harness 插件或本地可用的 Skill：${slashSkill}`
    )
  }
  skillBlock = formatSkillUseBlock({
    name: skill.name,
    path: skill.path,
    description: skill.description,
    metadata: skill.metadata,
    allowedTools: skill.allowedTools
  })
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
    managedExecution: true,
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

export async function sendManagedProviderRetry(
  threadId: string,
  delivery: AgentRunDelivery
): Promise<void> {
  await startManagedAgentRun(
    threadId,
    {
      modelMessage: "继续当前任务",
      displayMessage: "继续当前任务（ManagedRun 模型服务重试）",
      userMessageId: uuid()
    },
    delivery
  )
}

export async function sendManagedBizRetryReuseThread(
  threadId: string,
  delivery: AgentRunDelivery
): Promise<void> {
  await startManagedAgentRun(
    threadId,
    {
      modelMessage: "继续当前任务",
      displayMessage: "继续当前任务（ManagedRun 业务重试）",
      userMessageId: uuid()
    },
    delivery
  )
}

export async function createAndStartManagedHarnessSession(
  input: CreateManagedHarnessSessionInput
): Promise<{ threadId: string; thread: Thread }> {
  const prepared = await prepareHarnessMessage(input.projectId, input.nextAction)
  const thread = await createManagedHarnessSession(input)
  try {
    await startManagedAgentRun(thread.threadId, prepared, input.delivery)
  } catch (error) {
    throw new Error(
      `无法启动 ManagedRun 会话 ${thread.threadId}：${error instanceof Error ? error.message : String(error)}`
    )
  }
  return thread
}

export async function createManagedHarnessSession(
  input: CreateManagedHarnessSessionInput
): Promise<{ threadId: string; thread: Thread }> {
  const titleSource = input.nextAction.userMessage?.trim() ?? ""
  const thread = await createThreadService({
    workspacePath: input.workspacePath,
    ...(titleSource ? { title: generateTitle(titleSource) } : {}),
    harnessFeature: {
      projectId: input.projectId,
      slug: input.featureId,
      source: HARNESS_SOURCE,
      runId: input.runId,
      nodeId: input.nodeId
    }
  })
  return { threadId: thread.thread_id, thread }
}
