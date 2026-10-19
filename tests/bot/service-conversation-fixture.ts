import { textDigest } from "../../src/main/services/bot/text-delivery-validation"
import type {
  TextDeliverySummary,
  TextDeliveryVersion,
  TextDeliveryDecision
} from "../../src/shared/bot/text-delivery"
import assert from "node:assert/strict"
import {
  ServiceConversationStore,
  type ServiceScope
} from "../../src/main/services/bot/service-conversation-store"
import { ServiceConversationService } from "../../src/main/services/bot/service-conversation"
import {
  PartnerLocalFault,
  type PartnerLocalClient
} from "../../src/main/services/bot/partner-local-client"
import type { Task } from "../../src/shared/bot/contracts.generated"
import { inputFixture, runFixture } from "./requirement-execution-fixture"
export const model = { ref: "custom:fixture", name: "Fixture", hash: "a".repeat(64) }
export function setup(db: ConstructorParameters<typeof ServiceConversationStore>[0]) {
  const journal = new ServiceConversationStore(db),
    input = inputFixture()
  let scope: ServiceScope = {
    url: "http://127.0.0.1:12345",
    spaceId: "A",
    businessPrincipalId: "business",
    ownerPrincipalId: "owner",
    nodeId: "node",
    workspaceRef: "workspace",
    groupId: "group",
    botId: "expert"
  }
  const tasks = new Map<string, Task>(),
    commands = new Map<string, unknown>(),
    runs = new Map<string, { run: Record<string, unknown>; result: any }>()
  const heads = new Map<string, NonNullable<TextDeliverySummary["head"]>>(),
    versions = new Map<string, TextDeliveryVersion>(),
    decisions = new Map<string, TextDeliveryDecision>()
  const deliveryStats = { publishes: 0, decisions: 0 }
  let deliveryLoss: "publish" | "review" | null = null,
    deliveryLossCode = "OUTCOME_UNKNOWN",
    unavailable = false
  const summary = (id: string): TextDeliverySummary => {
    const task = tasks.get(id)!
    return structuredClone({
      taskId: id,
      taskVersion: task.version,
      taskStatus: task.status as TextDeliverySummary["taskStatus"],
      head: heads.get(id) ?? null,
      canReview: heads.get(id)?.status === "pending"
    })
  }
  const stats = { creates: 0, messages: 0, enqueues: 0, inspects: 0, cancels: 0, executions: 0 }
  let lossCode = "DEPENDENCY_UNAVAILABLE",
    lost: "create" | "message" | "enqueue" | null = null,
    deny = false,
    currentModel = { ...model },
    early: ((id: string) => Promise<void>) | null = null
  function replay<T>(command: string, action: () => T): T {
    if (commands.has(command)) return structuredClone(commands.get(command)) as T
    const result = action()
    commands.set(command, structuredClone(result))
    return result
  }
  const client = {
    async deliverySummaries(ids: string[]) {
      if (unavailable) throw new PartnerLocalFault("DEPENDENCY_UNAVAILABLE")
      return ids.map(summary)
    },
    async deliveryVersions(task: string, before = Number.MAX_SAFE_INTEGER) {
      const list = [...versions.values()]
        .filter((v) => v.taskId === task && v.number < before)
        .sort((a, b) => b.number - a.number)
      return {
        items: list.slice(0, 40).map(({ text, ...v }) => v),
        nextBefore: list.length > 40 ? list[39].number : null
      }
    },
    async deliveryVersion(task: string, version: string) {
      const v = versions.get(version)!
      assert.equal(v.taskId, task)
      return structuredClone({
        summary: summary(task),
        version: v,
        decision: decisions.get(version) ?? null
      })
    },
    async publishTextDelivery(v: Parameters<PartnerLocalClient["publishTextDelivery"]>[0]) {
      if (unavailable) throw new PartnerLocalFault("DEPENDENCY_UNAVAILABLE")
      const result = replay(v.commandId, () => {
        const task = tasks.get(v.taskId)!,
          source = runs.get(v.runId)!,
          head = heads.get(task.id)
        if (
          task.version !== v.expectedTaskVersion ||
          (head?.revision ?? 0) !== v.expectedReviewVersion ||
          source.run.taskVersion !== task.version ||
          source.run.status !== "succeeded" ||
          task.status !== "active"
        )
          throw new PartnerLocalFault("INPUT_CHANGED")
        deliveryStats.publishes++
        const version = {
          id: "version-" + deliveryStats.publishes,
          spaceId: "A",
          groupId: task.groupId,
          taskId: task.id,
          botId: "expert",
          number: (head?.number ?? 0) + 1,
          sourceRunId: v.runId,
          sourceAttemptId: String(source.run.attemptId),
          inputTaskVersion: task.version,
          text: source.result.text,
          digest: textDigest(source.result.text),
          sizeBytes: Buffer.byteLength(source.result.text),
          createdAt: new Date().toISOString(),
          createdBy: "business",
          baseVersionId: head?.versionId ?? null,
          feedbackMessageId: head?.feedbackMessageId ?? null
        }
        versions.set(version.id, version)
        heads.set(task.id, {
          spaceId: "A",
          groupId: task.groupId,
          taskId: task.id,
          botId: "expert",
          revision: (head?.revision ?? 0) + 1,
          versionId: version.id,
          number: version.number,
          status: "pending",
          reviewerPrincipalId: "business",
          feedbackMessageId: null,
          updatedAt: version.createdAt
        })
        task.version++
        task.status = "awaiting_business"
        return { versionId: version.id, summary: summary(task.id), decision: null }
      })
      if (deliveryLoss === "publish") {
        deliveryLoss = null
        throw new PartnerLocalFault(deliveryLossCode)
      }
      return result
    },
    async decideTextDelivery(v: Parameters<PartnerLocalClient["decideTextDelivery"]>[0]) {
      if (unavailable) throw new PartnerLocalFault("DEPENDENCY_UNAVAILABLE")
      const result = replay(v.commandId, () => {
        const task = tasks.get(v.taskId)!,
          head = heads.get(task.id)!
        if (
          task.version !== v.expectedTaskVersion ||
          head.revision !== v.expectedReviewVersion ||
          head.versionId !== v.versionId ||
          head.status !== "pending"
        )
          throw new PartnerLocalFault("INPUT_CHANGED")
        deliveryStats.decisions++
        task.version++
        head.revision++
        const decision: TextDeliveryDecision = {
          id: "decision-" + deliveryStats.decisions,
          spaceId: "A",
          taskId: task.id,
          versionId: v.versionId,
          principalId: "business",
          decision: v.decision,
          comment: v.comment,
          createdAt: new Date().toISOString(),
          feedbackMessageId: v.decision === "reject" ? "feedback-" + deliveryStats.decisions : null,
          taskVersion: task.version
        }
        decisions.set(v.versionId, decision)
        head.feedbackMessageId = decision.feedbackMessageId
        head.status = v.decision === "approve" ? "completed" : "changes_requested"
        task.status = v.decision === "approve" ? "completed" : "active"
        if (v.decision === "reject") stats.messages++
        return { versionId: v.versionId, summary: summary(task.id), decision }
      })
      if (deliveryLoss === "review") {
        deliveryLoss = null
        throw new PartnerLocalFault(deliveryLossCode)
      }
      return result
    },
    async createTask(group: string, text: string, command: string) {
      const result = replay(command, () => {
        stats.creates++
        const task = {
          ...input.task,
          id: "task-" + stats.creates,
          taskNumber: "TASK-" + stats.creates,
          title: text.slice(0, 80),
          goal: text,
          groupId: group
        }
        tasks.set(task.id, task)
        return task
      })
      if (lost === "create") {
        lost = null
        throw new PartnerLocalFault(lossCode)
      }
      return result
    },
    async lookupTask(_group: string, number: string) {
      return structuredClone([...tasks.values()].find((t) => t.taskNumber === number)!)
    },
    async createMessage(task: Task, text: string, command: string) {
      const result = replay(command, () => {
        const current = tasks.get(task.id)!
        if (current.version !== task.version) throw new PartnerLocalFault("VERSION_CONFLICT")
        if (current.status === "completed") throw new PartnerLocalFault("INPUT_CHANGED")
        current.version++
        const head = heads.get(task.id)
        if (head) {
          head.revision++
          head.status = "invalidated"
          current.status = "active"
        }
        stats.messages++
        return {
          taskVersion: current.version,
          message: {
            id: "message-" + stats.messages,
            spaceId: "A",
            taskId: task.id,
            text,
            authorPrincipalId: "business",
            createdAt: new Date().toISOString(),
            artifactVersions: []
          }
        }
      })
      if (lost === "message") {
        lost = null
        throw new PartnerLocalFault(lossCode)
      }
      return result
    },
    async enqueue(task: Task, _bot: string, command: string, deadline: string) {
      const result = replay(command, () => {
        if (tasks.get(task.id)!.status !== "active" || tasks.get(task.id)!.version !== task.version)
          throw new PartnerLocalFault("INPUT_CHANGED")
        stats.enqueues++
        const id = "run-" + stats.enqueues
        runs.set(id, {
          run: {
            ...runFixture(),
            id,
            taskId: task.id,
            taskVersion: task.version,
            commandId: command,
            requesterPrincipalId: "business",
            status: "queued",
            version: 1,
            deadline
          },
          result: null
        })
        return { runId: id, status: "queued" }
      })
      if (early) await early(result.runId)
      if (lost === "enqueue") {
        lost = null
        throw new PartnerLocalFault(lossCode)
      }
      return result
    },
    async inspect(id: string) {
      stats.inspects++
      if (deny) throw new PartnerLocalFault("FORBIDDEN")
      return structuredClone(runs.get(id)!)
    },
    async cancelPending(id: string, version: number) {
      const entry = runs.get(id)!
      assert.equal(entry.run.version, version)
      if (entry.run.status !== "queued") throw new PartnerLocalFault("OUTCOME_UNKNOWN")
      stats.cancels++
      entry.run.status = "cancelled"
      entry.run.version = Number(entry.run.version) + 1
    }
  }
  const context = async () => {
    if (deny) throw new PartnerLocalFault("FORBIDDEN")
    return {
      scope,
      client: client as unknown as PartnerLocalClient,
      group: input.group,
      botVersionId: "expert-v1",
      expertName: "服务专家",
      nodeEnabled: true
    }
  }
  const deps = {
    store: journal,
    context,
    overview: async () => ({ connected: true, nodeEnabled: true, expertName: "服务专家" }),
    models: async () => [{ ref: model.ref, name: model.name }],
    model: async (ref: string) => {
      assert.equal(ref, model.ref)
      return currentModel
    },
    cancelOwned: (_runId: string) => true,
    cadenceMs: 100000
  }
  let app = new ServiceConversationService(deps)
  function settle(id: string, text = "分析结果") {
    const entry = runs.get(id)!
    entry.run.status = "succeeded"
    entry.run.version = Number(entry.run.version) + 1
    entry.result = {
      runId: id,
      attemptId: entry.run.attemptId,
      outcome: "succeeded",
      text,
      settledAt: new Date().toISOString()
    }
  }
  return {
    journal,
    deliveryStats,
    heads,
    versions,
    decisions,
    setDeliveryLoss(step: typeof deliveryLoss, code = "OUTCOME_UNKNOWN") {
      deliveryLoss = step
      deliveryLossCode = code
    },
    setUnavailable(value: boolean) {
      unavailable = value
    },
    stats,
    tasks,
    runs,
    commands,
    client,
    deps,
    context,
    settle,
    get app() {
      return app
    },
    async reopen() {
      await app.stop()
      app = new ServiceConversationService(deps)
    },
    setLost(v: typeof lost, code = "DEPENDENCY_UNAVAILABLE") {
      lost = v
      lossCode = code
    },
    setDeny(v: boolean) {
      deny = v
    },
    drift() {
      currentModel = { ...model, hash: "b".repeat(64) }
    },
    setEarly(v: typeof early) {
      early = v
    },
    switchScope() {
      scope = { ...scope, url: "http://127.0.0.1:12346" }
    },
    get scope() {
      return scope
    }
  }
}
export async function initialize(f: ReturnType<typeof setup>) {
  const opened = await f.app.open()
  await f.app.selectModel({ conversationId: opened.conversationId, modelRef: model.ref })
  return opened.conversationId!
}
export const send = (
  f: ReturnType<typeof setup>,
  conversationId: string,
  requestId: string,
  taskRef: string | null = null,
  text = "整理需求说明"
) => f.app.send({ conversationId, requestId, taskRef, text })
