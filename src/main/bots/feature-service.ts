import { createHash } from "node:crypto"
import { join } from "node:path"
import type { ManagedRunSummary, ManagedRunIdentity } from "../../shared/harness-board-types"
import { MANAGED_RUN_STATUS_LABELS } from "../../shared/harness-board-types"
import type { BotFeatureDetail, BotFeatureSession } from "../../shared/bots/feature"
import type { BotTask } from "../../shared/bots/contracts"
import type { LocalBotHost } from "./host"
import type { FeatureOwner, FeatureReceipt } from "./feature-store"
import { getLocalBotHost } from "./local-service"
import { getThreadCore, upsertThreadMessages } from "../db"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { managedRunStore } from "../harness-board/managed-run-store"
import { readHarnessFeatureMetadata } from "../harness-board/service"
import { hasPendingHumanGateForThread } from "../harness-board/human-gate-service"
import { harnessNotifications } from "../harness-board/notifications"
import { projectHarnessNotification } from "../../shared/harness-notifications"
import { isNotificationPendingForTarget } from "../../shared/app-notifications"
import { onNotificationChanged } from "../services/notification-service"
import {
  summarizePendingUserInputForRuntimeThread,
  subscribePendingUserInput,
  subscribeRemovedUserInput
} from "../services/user-input"
import { approvalDecisionBroker } from "../agent/approval-decision-broker"
import { hasPendingApprovalForRuntimeThread } from "../agent/runtime"
import {
  startAgentRun,
  hasActiveTopLevelAgentRun,
  type AgentRunDelivery,
  type AgentRunExecutionContext,
  type AgentRunRequest,
  type AgentRunTerminal
} from "../agent/agent-run-service"
import { botInteractionRoutes } from "../services/im/bot-interaction-route"
import { imRemoteAccessService } from "../services/im/remote-access-service"
import { notifyRemoteThreadChanged } from "../agent/renderer-stream-mirror"
import { createBotDeliveryTools } from "./tools"
import { splitBotInlineReasoning } from "../../shared/bots/inline-reasoning"
import { botImReplyText } from "../services/im/bot-reply-text"
import { botDirectory } from "./paths"
import { getCmbCoworkAgentDataRoot } from "../app-data-root"
import {
  desktopFeatureCatalog,
  imFeatureBindingService
} from "../services/im/feature-binding-service"
export { featureDelivery } from "./feature-window"

function projectThread(owner: FeatureOwner, threadId: string) {
  const row = getThreadCore(threadId)
  if (!row) throw new Error("原项目会话已删除")
  const meta = JSON.parse(row.metadata || "{}")
  const feature = readHarnessFeatureMetadata(meta)
  if (
    feature?.projectId !== owner.projectId ||
    feature.slug !== owner.slug ||
    meta.botId ||
    meta.botHostId ||
    !meta.workspacePath
  )
    throw new Error("所选会话不属于此 Feature")
  return {
    row,
    feature,
    workspace: String(meta.workspacePath),
    incarnation: JSON.stringify(captureThreadIncarnation(row))
  }
}
export function checkFeatureThread(
  host: LocalBotHost,
  owner: FeatureOwner,
  threadId: string,
  expected = host.featureStore.session(owner.id, threadId)
) {
  const thread = projectThread(owner, threadId)
  if (expected !== thread.incarnation) throw new Error("原项目会话已被替换")
  if (imRemoteAccessService.getThreadGrant(threadId)?.state === "active")
    throw new Error("该项目会话已授权给其他招乎渠道")
  return thread
}
export function addFeatureSession(
  host: LocalBotHost,
  owner: FeatureOwner,
  threadId: string,
  nodeId?: string
) {
  host.featureStore.addSession(owner, threadId, projectThread(owner, threadId).incarnation, nodeId)
  host.featureChanged(owner)
}
export async function linkExistingFeatureSession(
  host: LocalBotHost,
  owner: FeatureOwner,
  threadId: string
) {
  const group = owner.audience !== "desktop"
  const bot = host.getBot(owner.botId)
  if (
    bot.archived ||
    bot.deleting ||
    (group && host.imGateway.binding(owner.audience.slice(3))?.binding.state !== "active")
  )
    throw new Error("Bot 或群绑定当前不可用")
  const catalog = group ? imFeatureBindingService : desktopFeatureCatalog
  const entry = await catalog.validateFeature(owner.projectId, owner.slug)
  if (!entry.valid) throw new Error(entry.message)
  const current = host.getBot(owner.botId)
  if (
    current.archived ||
    current.deleting ||
    (group && host.imGateway.binding(owner.audience.slice(3))?.binding.state !== "active")
  )
    throw new Error("交办来源已失效")
  const thread = projectThread(owner, threadId)
  if (
    hasActiveTopLevelAgentRun(threadId) ||
    thread.feature.runId ||
    imRemoteAccessService.getThreadGrant(threadId)?.state === "active"
  )
    throw new Error("请选择空闲且未绑定其他托管或招乎渠道的项目会话")
  addFeatureSession(host, owner, threadId)
}
function sessionStatus(
  host: LocalBotHost,
  owner: FeatureOwner,
  threadId: string,
  incarnation: string,
  nodeId?: string
): BotFeatureSession {
  let thread: ReturnType<typeof projectThread>
  try {
    thread = checkFeatureThread(host, owner, threadId, incarnation)
  } catch {
    return { threadId, title: "会话不可用", phase: "unavailable", nodeId }
  }
  const questions = summarizePendingUserInputForRuntimeThread(threadId)
  const live = host.featureTurns.phase(threadId)
  const phase =
    questions.count || live === "question"
      ? "question"
      : live === "approval" ||
          hasPendingApprovalForRuntimeThread(threadId) ||
          hasPendingHumanGateForThread(threadId)
        ? "approval"
        : live === "running" || hasActiveTopLevelAgentRun(threadId)
          ? "running"
          : thread.row.status === "error"
            ? "failed"
            : thread.row.status === "interrupted"
              ? "interrupted"
              : "idle"
  return {
    threadId,
    title: thread.row.title || "项目会话",
    phase,
    nodeId,
    ...(questions.count ? { questions: questions.questions } : {})
  }
}
export function featureDetail(host: LocalBotHost, owner: FeatureOwner): BotFeatureDetail {
  const { id, projectId, slug } = owner
  const runId = host.featureStore.latestRun(id)
  const run = runId ? nativeRun(owner, runId) : null
  const decisionId =
    run?.status === "running" && runId
      ? host.featureStore.operationForRun(runId)?.decisionId
      : undefined
  const decision = decisionId ? harnessNotifications.get(decisionId) : undefined
  const pending =
    decision?.status === "pending" &&
    decision.runId === runId &&
    decision.projectId === projectId &&
    decision.featureId === slug
      ? decision
      : undefined
  const sessions = host.featureStore
    .sessions(id)
    .map((s) => sessionStatus(host, owner, s.threadId, s.incarnation, s.nodeId))
  return {
    ...host.featureTasks(owner, { followId: id })[0].task,
    sessions,
    ...(runId
      ? {
          run: {
            runId,
            status: run?.status ?? "corrupt",
            nodeId: run?.decisionBaseline?.nodeId,
            currentThreadId: sessions.find((s) => s.threadId === run?.currentSession?.threadId)
              ?.threadId,
            decision: run?.failureReason || run?.lastDecision?.summary,
            retryAt: run?.nextRetryAt,
            ...(pending ? { waitingForDecision: pending.message } : {})
          }
        }
      : {})
  }
}
function nativeRun(owner: FeatureOwner, runId: string) {
  try {
    return managedRunStore.getRun({ projectId: owner.projectId, featureId: owner.slug, runId })
      .snapshot
  } catch {
    return null
  }
}
function executionOwner(host: LocalBotHost, op: FeatureReceipt) {
  const owner = host.featureStore.owner(op.followId)
  const task = host.featureTask(op.taskId)
  const bot = host.getBot(owner.botId)
  if (
    bot.archived ||
    bot.deleting ||
    task.botId !== owner.botId ||
    (task.mockSource?.audienceKey ?? "desktop") !== owner.audience
  )
    throw new Error("原交办会话已失效")
  if (task.mockSource) {
    if (task.mockSource.transport !== "im") throw new Error("无效的渠道来源")
    host.imChannel.validateSource(task.mockSource, owner.botId)
    if (host.imGateway.binding(task.mockSource.bindingId)?.binding.state !== "active")
      throw new Error("原招乎绑定已解除")
  } else if (task.threadId !== bot.threadId) throw new Error("原交办不属于此 Bot 主对话")
  return { owner, task }
}
export function bindManagedFeatureSession(
  input: ManagedRunIdentity & { nodeId: string },
  threadId: string,
  operationId: string
) {
  const host = getLocalBotHost(),
    op = host.featureStore.receipt(operationId)
  const { owner } = executionOwner(host, op)
  if (
    op.action !== "manage" ||
    op.state !== "active" ||
    op.runId !== input.runId ||
    owner.projectId !== input.projectId ||
    owner.slug !== input.featureId
  )
    throw new Error("此托管运行不属于原 Feature 交办")
  const thread = projectThread(owner, threadId)
  if (thread.feature.runId !== input.runId) checkFeatureThread(host, owner, threadId)
  addFeatureSession(host, owner, threadId, input.nodeId)
}
function notice(
  host: LocalBotHost,
  owner: FeatureOwner,
  task: BotTask,
  key: string,
  text: string,
  workspace?: string
) {
  const id = createHash("sha256")
    .update(JSON.stringify([owner.id, key]))
    .digest("hex")
  const body = `【${owner.title}】${text}`.slice(0, 30000)
  const publicText = botImReplyText(body, [], workspace ? [workspace] : [])
  host.imChannel.featureNotice(task, id, publicText)
  if (getThreadCore(task.threadId))
    upsertThreadMessages(task.threadId, [
      {
        id: `feature-${id}`,
        role: "assistant",
        content: task.mockSource && !task.mockSource.personal ? publicText : body,
        created_at: new Date()
      }
    ])
  host.featureChanged(owner)
  notifyRemoteThreadChanged()
}
export function publishFeatureRun(run: ManagedRunSummary) {
  if (!run.botOperationId) return
  const host = getLocalBotHost(),
    op = host.featureStore.receipt(run.botOperationId)
  if (op.runId !== run.runId || op.state !== "active") return
  let source: ReturnType<typeof executionOwner>
  try {
    source = executionOwner(host, op)
  } catch (error) {
    host.featureStore.finish(op.id, error instanceof Error ? error.message : "来源已失效")
    return
  }
  const { owner, task } = source
  if (owner.projectId !== run.projectId || owner.slug !== run.featureId) return
  if (run.status === "running") {
    host.featureChanged(owner)
    return
  }
  const message =
    MANAGED_RUN_STATUS_LABELS[run.status] + (run.failureReason ? "。" + run.failureReason : "")
  notice(host, owner, task, [run.runId, run.status].join("/"), message, run.workspacePath)
  host.featureStore.finish(
    op.id,
    run.status === "failed" || run.status === "corrupt" ? message : undefined,
    run.status === "cancelled" ? "stopped" : undefined
  )
}
let observingDecisions = false
function observeDecisions() {
  if (observingDecisions) return
  observingDecisions = true
  onNotificationChanged((value, change) => {
    if (change !== "created" && change !== "ended") return
    const note = projectHarnessNotification(value)
    if (!note) return
    const host = getLocalBotHost()
    const active = host.featureTurns.operation(note.sourceThreadId)
    const op = note.runId
      ? host.featureStore.operationForRun(note.runId)
      : active
        ? host.featureStore.receipt(active)
        : undefined
    if (!op || op.state !== "active") return
    const { owner, task } = executionOwner(host, op)
    if (owner.projectId !== note.projectId || owner.slug !== note.featureId) return
    const thread = checkFeatureThread(host, owner, note.sourceThreadId)
    const pending = change === "created" && note.status === "pending"
    host.featureStore.setDecision(op, note.notificationId, note.sourceThreadId, pending)
    if (pending && (!task.mockSource || isNotificationPendingForTarget(note, "im")))
      notice(
        host,
        owner,
        task,
        note.notificationId,
        `${note.type === "human_gate" ? "项目阶段等待确认" : "托管遇到问题，等待选择下一步"}。${note.message}\n请在 App 的项目模式中处理。`,
        thread.workspace
      )
    else host.featureChanged(owner)
  })
}
export function recoverFeatureOperations(host: LocalBotHost, operations: FeatureReceipt[]) {
  for (const op of operations) {
    try {
      if (op.runId) {
        const { owner } = executionOwner(host, op)
        const run = nativeRun(owner, op.runId)
        if (run?.botOperationId === op.id) {
          observeDecisions()
          if (run.status !== "running") publishFeatureRun(run)
          else if (op.decisionId && harnessNotifications.get(op.decisionId)?.status !== "pending")
            host.featureStore.setDecision(op, op.decisionId, "", false)
          continue
        }
      }
      const { owner, task } = executionOwner(host, op)
      const reason = "应用已重启，本轮项目交办已中断。请核对项目会话后继续。"
      notice(host, owner, task, op.id + "/interrupted", reason)
      host.featureStore.finish(op.id, reason)
    } catch (error) {
      host.featureStore.finish(op.id, error instanceof Error ? error.message : "来源已失效")
    }
  }
}
/** Applies only to a turn explicitly submitted on behalf of this follow. Later desktop turns stay local. */
export async function startFeatureTurn(
  operationId: string,
  request: AgentRunRequest,
  delivery: AgentRunDelivery,
  base?: AgentRunExecutionContext,
  startStream?: () => void
) {
  const host = getLocalBotHost(),
    store = host.featureStore,
    op = store.receipt(operationId)
  if (op.state !== "active") throw new Error("原 Feature 操作已结束")
  const { owner, task } = executionOwner(host, op)
  observeDecisions()
  const threadId = request.threadId
  const thread = checkFeatureThread(host, owner, threadId)
  if (op.runId ? thread.feature.runId !== op.runId : op.threadId !== threadId)
    throw new Error("Feature 会话执行归属已变化")
  const valid = await (
    task.mockSource ? imFeatureBindingService : desktopFeatureCatalog
  ).validateFeature(owner.projectId, owner.slug, thread.workspace)
  if (!valid.valid) throw new Error(valid.message)
  const verify = () => {
    executionOwner(host, op)
    const current = checkFeatureThread(host, owner, threadId)
    if (op.runId && current.feature.runId !== op.runId) throw new Error("托管会话归属已变化")
  }
  verify()
  if (store.receipt(op.id).state !== "active") throw new Error("原 Feature 操作已结束")
  const registered = task.mockSource
    ? host.imGateway.binding(task.mockSource.bindingId)
    : host.imGateway.personalBinding(owner.botId, task.createdAt)
  const source = task.mockSource
  const event = source ? host.imGateway.event(source.eventId) : undefined
  const root = botDirectory(
    join(getCmbCoworkAgentDataRoot(), "bots"),
    "workspaces",
    source && !source.personal ? `mock-${source.bindingId}` : owner.botId
  )
  const turn = host.featureTurns.begin(owner, threadId, op.id, source?.bindingId)
  const signal = base?.signal ? AbortSignal.any([turn.signal, base.signal]) : turn.signal
  const routeIsCurrent = () => {
    if (signal.aborted || !registered) return false
    const current = host.imGateway.binding(registered.id)
    if (
      current?.binding.state !== "active" ||
      current.binding.version !== registered.binding.version
    )
      return false
    verify()
    return true
  }
  const questionDesktopNotice = (requestId: string) => {
    if (registered?.binding.kind !== "group" || !routeIsCurrent()) return
    notice(
      host,
      owner,
      task,
      "question/" + requestId,
      "项目会话正在等你回答。请在 App 中打开这项任务继续。"
    )
  }
  const release = registered?.binding.conversationKey
    ? botInteractionRoutes.register({
        threadId,
        realm: registered.realm,
        principalId: registered.principal,
        kind: registered.binding.kind,
        conversationKey: registered.binding.conversationKey,
        prefix: `【${owner.title}】`,
        botEventId: event?.payload.event.eventId,
        senderId: event?.payload.route.senderId,
        onQuestionUndeliverable: questionDesktopNotice,
        isCurrent: routeIsCurrent
      })
    : undefined
  const questions = new Set<string>()
  const approvals = new Set<string>()
  const owns = (id: string) =>
    !signal.aborted && (id === threadId || id.startsWith(threadId + "__"))
  const updatePhase = () => {
    host.featureTurns.setPhase(
      threadId,
      op.id,
      questions.size ? "question" : approvals.size ? "approval" : "running"
    )
    host.featureChanged(owner)
  }
  const subscriptions = [
    subscribePendingUserInput((input) => {
      if (!owns(input.threadId)) return
      questions.add(input.requestId)
      updatePhase()
      if (!botInteractionRoutes.get(input.threadId)) questionDesktopNotice(input.requestId)
    }),
    subscribeRemovedUserInput((id) => {
      if (questions.delete(id)) updatePhase()
    }),
    approvalDecisionBroker.subscribePending(({ runtimeThreadId, request: approval }) => {
      if (!owns(runtimeThreadId)) return
      approvals.add(approval.id)
      updatePhase()
      if (registered?.binding.kind === "group") {
        verify()
        notice(
          host,
          owner,
          task,
          "approval/" + approval.id,
          "项目会话正在等待本机操作审批。请在 App 的群内任务中打开对应的项目会话，确认后会继续执行。"
        )
      }
    }),
    approvalDecisionBroker.subscribeRemoved((id) => {
      if (approvals.delete(id)) updatePhase()
    })
  ]
  const cleanup = () => {
    for (const unsubscribe of subscriptions) unsubscribe()
    turn.release()
    release?.()
  }
  let terminal: AgentRunTerminal | undefined,
    finalText = "",
    cancelled = false
  let handle: Awaited<ReturnType<typeof startAgentRun>>
  try {
    startStream?.()
    handle = await startAgentRun(request, delivery, {
      ...base,
      source: "desktop",
      signal,
      ...(registered ? { allowDeferredUserInputRenderer: true } : {}),
      ...(source && !source.personal
        ? {
            remotePolicy: {
              ...base?.remotePolicy,
              sharedTaskContext: true,
              disableMessageControls: true
            }
          }
        : {}),
      verifyResolvedThread: (resolved) => {
        try {
          verify()
          if (resolved.workspacePath !== thread.workspace) return "Feature 会话工作区已变化"
          return base?.verifyResolvedThread?.(resolved) ?? null
        } catch (error) {
          return error instanceof Error ? error.message : "Feature 授权已失效"
        }
      },
      additionalTools: [
        ...(base?.additionalTools ?? []),
        ...createBotDeliveryTools(
          thread.workspace,
          signal,
          (files, callId) => {
            verify()
            const copies = files.map((file) => ({ ...file, filePath: file.attachmentPath! }))
            const key = createHash("sha256")
              .update(JSON.stringify([op.id, threadId, callId]))
              .digest("hex")
            host.imChannel.publishFiles(task, key, copies)
            const created_at = new Date()
            upsertThreadMessages(task.threadId, [
              {
                id: `feature-files-${key}`,
                role: "assistant",
                content: "",
                created_at,
                tool_calls: [
                  { id: key, name: "bot_deliver_files", args: { files: copies.map((f) => f.name) } }
                ]
              },
              {
                id: `feature-receipt-${key}`,
                role: "tool",
                name: "bot_deliver_files",
                tool_call_id: key,
                content: JSON.stringify({ kind: "bot-file-delivery", files: copies }),
                created_at
              }
            ])
            host.featureChanged(owner)
            notifyRemoteThreadChanged()
          },
          undefined,
          false,
          root
        )
      ],
      onFinalAssistant: async (output) => {
        finalText = splitBotInlineReasoning(output.finalText).body.trim()
        await base?.onFinalAssistant?.(output)
      },
      onRunTerminated: (t) => {
        terminal = t
        base?.onRunTerminated?.(t)
      },
      onRunCancelled: () => {
        cancelled = true
        base?.onRunCancelled?.()
      }
    })
  } catch (error) {
    cleanup()
    throw error
  }
  const settle = (failure?: unknown) => {
    try {
      verify()
      const error = cancelled
        ? "本轮会话已停止"
        : failure instanceof Error
          ? failure.message
          : terminal?.outcome !== "success"
            ? terminal?.message || "本轮未正常结束"
            : undefined
      notice(
        host,
        owner,
        task,
        `${op.id}/${request.userMessageId}/result`,
        error || finalText || "本轮会话已结束。",
        thread.workspace
      )
      if (!op.runId) store.finish(op.id, error, cancelled ? "stopped" : undefined)
    } catch (error) {
      if (!op.runId) store.finish(op.id, error instanceof Error ? error.message : "来源已失效")
    } finally {
      cleanup()
      host.featureChanged(owner)
    }
  }
  void handle.completion.then(() => settle(), settle)
  return handle
}
