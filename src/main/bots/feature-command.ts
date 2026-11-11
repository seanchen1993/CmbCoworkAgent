import { randomUUID } from "node:crypto"
import { withCurrentHarnessFeature } from "../harness-board/feature-catalog-lifecycle"
import { HARNESS_SOURCE } from "../../shared/harness-board-types"
import type { LocalBotHost } from "./host"
import type { FeatureOperation, FeatureOwner } from "./feature-store"
import {
  desktopFeatureCatalog,
  imFeatureBindingService
} from "../services/im/feature-binding-service"

import {
  startManagedRun,
  stopManagedRun,
  withIdleManagedFeature
} from "../harness-board/auto-mode-controller"
import {
  prepareManagedAgentRun,
  startPreparedManagedAgentRun
} from "../harness-board/auto-mode-action-executor"
import { createThreadService } from "../services/thread-service"
import { splitBotInlineReasoning } from "../../shared/bots/inline-reasoning"
import { notifyRemoteThreadChanged } from "../agent/renderer-stream-mirror"
import {
  addFeatureSession,
  checkFeatureThread,
  featureDetail,
  featureDelivery
} from "./feature-service"

export type FeatureCommand =
  | { action: "list"; projectId?: string; query?: string; offset?: number }
  | { action: "read"; followId: string; threadId?: string }
  | { action: "follow"; projectId: string; slug: string }
  | { action: "complete"; projectId: string; slug: string; expectedVersion?: number }
  | { action: "reopen"; projectId: string; slug: string; expectedVersion?: number }
  | {
      action: FeatureOperation
      projectId: string
      slug: string
      requestKey: string
      message?: string
      threadId?: string
      runId?: string
    }

export async function runBotFeatureCommand(
  host: LocalBotHost,
  taskId: string,
  input: FeatureCommand
) {
  const authorize = () => host.featureToolTask(taskId)
  const task = authorize()
  const store = host.featureStore
  const scope = { botId: task.botId, audience: task.mockSource?.audienceKey ?? "desktop" }
  const catalog = task.mockSource ? imFeatureBindingService : desktopFeatureCatalog
  const readDetail = async (owner: FeatureOwner) => {
    const detail = await featureDetail(host, owner)
    authorize()
    return detail
  }
  if (input.action === "list") {
    const items = input.projectId
      ? await catalog.listRemoteFeatures(input.projectId)
      : host.featureTasks(scope).map((row) => row.task)
    authorize()
    const query = input.query?.trim().toLowerCase()
    const filtered = query
      ? items.filter((item) => (item.title + " " + item.slug).toLowerCase().includes(query))
      : items
    const offset = input.offset ?? 0
    return {
      items: filtered.slice(offset, offset + 30),
      nextOffset: offset + 30 < filtered.length ? offset + 30 : undefined
    }
  }
  if (input.action === "read") {
    const owner = store.owner(input.followId, scope)
    if (task.mockSource) {
      const access = await catalog.featureAccess(owner.projectId, owner.slug)
      authorize()
      if (!access.valid) throw new Error(access.message)
    }
    const { resolveHarnessFeatureCurrentStage } = await import("../harness-board/service")
    const stage = await resolveHarnessFeatureCurrentStage(owner.projectId, owner.slug)
    authorize()
    const detail = await readDetail(owner)
    if (!input.threadId) return { ...detail, stage }
    const { getThreadMessagesPage } = await import("../db")
    authorize()
    checkFeatureThread(host, owner, input.threadId)
    const { messages } = getThreadMessagesPage(input.threadId, { limit: 20, byteBudget: 24000 })
    const history = messages.flatMap((m) => {
      if (m.role !== "user" && m.role !== "assistant") return []
      const text =
        typeof m.content === "string"
          ? m.content
          : m.content
              .filter((b) => b.type === "text")
              .map((b) => b.text)
              .join("\n")
      const visible = m.role === "assistant" ? splitBotInlineReasoning(text).body.trim() : text
      return visible ? [{ role: m.role, text: visible.slice(0, 2000) }] : []
    })
    return { detail, stage, history }
  }
  if (input.action === "complete" || input.action === "reopen") {
    const item = store.find(scope, input.projectId, input.slug)
    if (!item || !Number.isSafeInteger(input.expectedVersion))
      throw new Error("请先查询当前任务及版本")
    host.changeFeatureState(scope, item.id, input.action, input.expectedVersion!)
    return readDetail(store.owner(item.id, scope))
  }
  // Stopping an owned run must still work after the project is archived or its directory moves.
  const stopping = input.action === "stop" || input.action === "interrupt"
  let owner: FeatureOwner,
    workspace = ""
  if (stopping) {
    const followed = store
      .list(scope)
      .find((x) => x.projectId === input.projectId && x.slug === input.slug)
    if (!followed) throw new Error("当前对话未跟进此 Feature")
    owner = store.owner(followed.id, scope)
  } else {
    owner = await withCurrentHarnessFeature(
      input.projectId,
      input.slug,
      () =>
        input.action === "follow"
          ? catalog.featureAccess(input.projectId, input.slug)
          : catalog.validateFeature(input.projectId, input.slug),
      (feature) => {
        authorize()
        if (!feature.valid) throw new Error(feature.message)
        if ("workspacePath" in feature) workspace = String(feature.workspacePath)
        const follow = store.follow(scope, {
          projectId: input.projectId,
          slug: input.slug,
          projectName: feature.project.name,
          title: feature.feature.title
        })
        host.featureChanged(scope, follow)
        return follow
      }
    )
  }
  if (input.action === "follow") return readDetail(owner)
  const selected = input.threadId ? checkFeatureThread(host, owner, input.threadId) : undefined
  const verifySelected = () => {
    store.owner(owner.id, scope)
    if (
      input.threadId &&
      checkFeatureThread(host, owner, input.threadId).incarnation !== selected?.incarnation
    )
      throw new Error("原项目会话已被替换")
  }
  const { fresh, receipt } = store.begin(owner, taskId, input.requestKey, input.action, [
    input.threadId ?? null,
    input.message ?? null,
    input.runId ?? null
  ])
  if (!fresh) {
    if (receipt.error) throw new Error(receipt.error)
    return { operation: receipt, feature: await readDetail(owner) }
  }
  const { projectId, slug: featureId } = owner
  try {
    if (input.action === "manage") {
      const run = await startManagedRun(
        {
          projectId,
          featureId,
          workspacePath: workspace,
          initialUserMessage: input.message,
          existingThreadId: input.threadId,
          delivery: featureDelivery()
        },
        {
          operationId: receipt.id,
          authorize: () => {
            authorize()
            verifySelected()
          },
          created: (run) => {
            if (input.threadId) addFeatureSession(host, owner, input.threadId)
            store.active(receipt.id, undefined, run.runId)
          }
        }
      )
      if (run.status === "failed" || run.status === "corrupt")
        throw new Error(run.failureReason || "托管启动失败")
    } else if (input.action === "stop") {
      if (!input.runId || store.latestRun(owner.id) !== input.runId)
        throw new Error("请指定本对话跟进的托管运行")
      if (!(await stopManagedRun({ projectId, featureId, runId: input.runId })))
        throw new Error("该次托管已结束")
      store.finish(receipt.id)
    } else if (input.action === "interrupt") {
      if (!input.threadId || !host.featureTurns.interrupt(owner.id, input.threadId))
        throw new Error("所选会话没有由此对话交办的执行轮次")
      store.finish(receipt.id)
    } else {
      const message = input.message?.trim()
      if (!message) throw new Error("请提供要交给项目会话的内容")
      if (input.action === "continue" && !input.threadId) throw new Error("请选择要继续的项目会话")
      await withIdleManagedFeature(projectId, featureId, async () => {
        authorize()
        verifySelected()
        const delivery = featureDelivery()
        let threadId = input.threadId
        if (input.action === "session") {
          if (threadId) throw new Error("新建会话无需指定已有会话")
          const thread = await createThreadService({
            harnessFeature: { projectId, slug: featureId, source: HARNESS_SOURCE },
            botFeatureFollowId: owner.id,
            title: message.split("\n")[0].slice(0, 80)
          })
          threadId = thread.thread_id
          addFeatureSession(host, owner, threadId)
          notifyRemoteThreadChanged()
        }
        if (!threadId) throw new Error("请选择项目会话")
        authorize()
        verifySelected()
        const prepared = prepareManagedAgentRun(
          threadId,
          { modelMessage: message, displayMessage: message, userMessageId: randomUUID() },
          delivery
        )
        store.active(receipt.id, threadId)
        prepared.request.managedExecution = false
        await startPreparedManagedAgentRun(prepared, undefined, receipt.id)
      })
    }
    host.featureChanged(owner)
    return { operation: store.receipt(receipt.id), feature: await readDetail(owner) }
  } catch (error) {
    store.finish(receipt.id, error instanceof Error ? error.message : "Feature 操作失败")
    host.featureChanged(owner)
    throw error
  }
}
