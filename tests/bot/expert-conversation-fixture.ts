import { setup } from "./service-conversation-fixture"
import {
  expertContextDigest,
  parseCoordination
} from "../../src/main/services/bot/expert-conversation-validation"
import { PartnerLocalFault } from "../../src/main/services/bot/partner-local-boundary"
import type { ServiceConversationStore } from "../../src/main/services/bot/service-conversation-store"
import type {
  ExpertConversationInput,
  ExpertContextMessage,
  ExpertTaskReceipt
} from "../../src/shared/bot/expert-conversation"
export function expertSetup(db: ConstructorParameters<typeof ServiceConversationStore>[0]) {
  const f = setup(db),
    roles = new Map<string, "main" | "task">(),
    inputs = new Map<string, ExpertConversationInput>(),
    receipts = new Map<string, ExpertTaskReceipt>(),
    consumed = new Map<string, ExpertTaskReceipt>(),
    messages = new Map<string, ExpertContextMessage[]>()
  const client = f.client as typeof f.client & Record<string, any>
  let lost: string | null = null
  const effect = <T>(step: string, result: T) => {
    if (lost === step) {
      lost = null
      throw new PartnerLocalFault("OUTCOME_UNKNOWN")
    }
    return structuredClone(result)
  }
  const create = client.createTask.bind(client),
    append = client.createMessage.bind(client),
    enqueue = client.enqueue.bind(client)
  client.createMessage = async (task, text, command) => {
    const value = await append(task, text, command)
    const entries = messages.get(task.id) ?? []
    if (!entries.some((m) => m.sourceId === value.message.id))
      entries.push({
        role: "user",
        text,
        sourceId: value.message.id,
        taskVersion: value.taskVersion
      })
    messages.set(task.id, entries)
    return value
  }
  const receipt = (
    id: string,
    sourceRunId: string | null = null,
    messageId: string | null = null
  ): ExpertTaskReceipt => ({
    task: structuredClone(f.tasks.get(id)!),
    role: roles.get(id)!,
    botId: "expert",
    principalId: "business",
    sourceRunId,
    messageId
  })
  client.ensureExpertConversation = async (v: any) => {
    if (receipts.has(v.commandId)) return effect("ensure", receipts.get(v.commandId))
    const previous =
      v.taskId ?? (v.role === "main" ? [...roles].find(([, role]) => role === "main")?.[0] : null)
    const task = previous ? f.tasks.get(previous)! : await create(v.groupId, v.goal, v.commandId)
    task.title = v.title
    roles.set(task.id, v.role)
    const result = receipt(task.id)
    receipts.set(v.commandId, result)
    return effect("ensure", result)
  }
  client.expertConversationSummaries = async (_group: string, _bot: string, ids: string[]) =>
    ids.map((id) => {
      const task = f.tasks.get(id)!
      return {
        taskId: id,
        taskVersion: task.version,
        status: task.status,
        role: roles.get(id) ?? "task",
        busy: [...f.runs.values()].some(
          (r) =>
            r.run.taskId === id &&
            !["succeeded", "failed", "cancelled"].includes(String(r.run.status))
        )
      }
    })
  client.freezeExpertInput = async (v: any) => {
    if (inputs.has(v.commandId)) return effect("freeze", inputs.get(v.commandId))
    const task = f.tasks.get(v.taskId)!,
      history: ExpertContextMessage[] = [
        { role: "user", sourceId: task.id, taskVersion: 1, text: task.goal },
        ...(messages.get(task.id) ?? [])
      ]
    for (const entry of f.runs.values())
      if (entry.run.taskId === task.id && entry.result?.outcome === "succeeded") {
        let text = entry.result.text
        if (roles.get(task.id) === "main") {
          try {
            const envelope = parseCoordination(text, inputs.get(String(entry.run.commandId))!)
            text = envelope.intent
              ? consumed.has(String(entry.run.id))
                ? "已交办到任务会话。"
                : "交办尚未完成。"
              : envelope.reply
          } catch {
            text = "该轮回复无法解析，未交办。"
          }
        }
        history.push({
          role: "assistant",
          sourceId: String(entry.run.id),
          taskVersion: Number(entry.run.taskVersion),
          text
        })
      }
    history.sort((a, b) => a.taskVersion - b.taskVersion || (a.role === "user" ? -1 : 1))
    const unsigned: Omit<ExpertConversationInput, "digest"> = {
      profile: roles.get(task.id) === "main" ? "expert_main_v1" : "expert_task_v1",
      taskId: task.id,
      taskVersion: v.expectedTaskVersion,
      sourceRequestId: v.sourceRequestId,
      messages: history,
      targets: v.allowedTaskIds.map((id: string) => ({
        taskId: id,
        title: f.tasks.get(id)!.title,
        status: f.tasks.get(id)!.status
      }))
    }
    const value = { ...unsigned, digest: expertContextDigest(unsigned) }
    inputs.set(v.commandId, value)
    return effect("freeze", value)
  }
  client.enqueue = async (task, bot, command, deadline) => {
    const value = await enqueue(task, bot, command, deadline),
      input = inputs.get(command)
    if (!input) return value
    Object.assign(f.runs.get(value.runId)!.run, {
      executionProfile: input.profile,
      contextDigest: input.digest
    })
    return { ...value, executionProfile: input.profile, contextDigest: input.digest }
  }
  client.coordinateExpertTask = async (command: string, runId: string) => {
    if (receipts.has(command)) return effect("coordinate", receipts.get(command))
    if (consumed.has(runId)) return effect("coordinate", consumed.get(runId))
    const run = f.runs.get(runId)!,
      input = inputs.get(String(run.run.commandId))!,
      intent = parseCoordination(run.result.text, input).intent!
    const text = input.messages.findLast((m) => m.role === "user")!.text
    let id: string,
      messageId: string | null = null
    if (intent.kind === "create_task") {
      const task = await create("group", text, command + ":create")
      task.title = intent.title
      id = task.id
      roles.set(id, "task")
    } else {
      id = intent.targetTaskRef
      const value = await client.createMessage(f.tasks.get(id)!, text, command + ":message")
      messageId = value.message.id
      roles.set(id, "task")
    }
    const result = receipt(id, runId, messageId)
    receipts.set(command, result)
    consumed.set(runId, result)
    return effect("coordinate", result)
  }
  client.expertTaskLifecycle = async (v: any) => {
    if (receipts.has(v.commandId)) return effect("lifecycle", receipts.get(v.commandId))
    const task = f.tasks.get(v.taskId)!
    if (task.version !== v.expectedVersion) throw new PartnerLocalFault("VERSION_CONFLICT")
    task.version++
    task.status = v.action === "complete" ? "completed" : "active"
    const result = receipt(task.id)
    receipts.set(v.commandId, result)
    return effect("lifecycle", result)
  }
  return {
    ...f,
    get app() {
      return f.app
    },
    inputs,
    roles,
    receipts,
    consumed,
    loss(step: string) {
      lost = step
    },
    reopen: () => f.reopen()
  }
}
