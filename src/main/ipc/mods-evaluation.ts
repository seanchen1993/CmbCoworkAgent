import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { types } from "node:util"
import type { EvaluationStartInput, EvaluationResult } from "../../shared/mods/evaluation-api"
import type { EvaluationRunner, EvaluationScope } from "../mods/evaluation/runner"

interface Access {
  trusted(event: IpcMainInvokeEvent): void
  threadScope(threadId: string): string
  captureThreadFence(threadId: string): () => void
}
function plain(input: unknown, keys: string[]): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw Error("INVALID")
  const descriptors = Object.getOwnPropertyDescriptors(input)
  if (
    Reflect.ownKeys(input).length !== keys.length ||
    keys.some(
      (key) => !descriptors[key] || !("value" in descriptors[key]) || !descriptors[key].enumerable
    )
  )
    throw Error("INVALID")
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]))
}
function text(value: unknown, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
    throw Error("INVALID")
  return value
}
function integer(value: unknown, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max)
    throw Error("INVALID")
  return Number(value)
}
function startInput(input: unknown): EvaluationStartInput {
  const row = plain(input, [
    "threadId",
    "expectedWorkspace",
    "baseline",
    "candidate",
    "tasks",
    "budget"
  ])
  const selection = (input: unknown) => {
    const value = plain(input, ["id", "revision", "digest"])
    const digest = text(value.digest, 64)
    if (!/^[a-f0-9]{64}$/.test(digest)) throw Error("INVALID")
    return { id: text(value.id, 128), revision: integer(value.revision, 1_000_000), digest }
  }
  if (
    !Array.isArray(row.tasks) ||
    types.isProxy(row.tasks) ||
    row.tasks.length < 1 ||
    row.tasks.length > 5
  )
    throw Error("INVALID")
  const tasks = row.tasks.map((input) => {
    const task = plain(input, ["id", "goal"])
    return { id: text(task.id, 60), goal: text(task.goal, 4000) }
  })
  const budget = plain(row.budget, ["timeoutMs", "maxExecutions"])
  return {
    threadId: text(row.threadId),
    expectedWorkspace: text(row.expectedWorkspace, 4096),
    baseline: selection(row.baseline),
    candidate: selection(row.candidate),
    tasks,
    budget: {
      timeoutMs: integer(budget.timeoutMs, 3_600_000),
      maxExecutions: integer(budget.maxExecutions, 200)
    }
  }
}
function publicCode(
  error: unknown
): "INVALID" | "BUSY" | "STALE" | "LIMIT" | "CANCELLED" | "FAILED" {
  const message = error instanceof Error ? error.message : ""
  for (const code of ["INVALID", "BUSY", "STALE", "LIMIT", "CANCELLED"] as const)
    if (message === code || message.endsWith("_" + code)) return code
  return error instanceof Error && error.name === "AbortError" ? "CANCELLED" : "FAILED"
}
export function registerEvaluationHandlers(ipc: IpcMain, runner: EvaluationRunner, access: Access) {
  const createScope = (event: IpcMainInvokeEvent, threadId: string, workspace: string) => {
    const controller = new AbortController(),
      sender = event.sender,
      frame = sender.mainFrame
    const assertThread = access.captureThreadFence(threadId)
    const scope: EvaluationScope = {
      workspace,
      threadId,
      signal: controller.signal,
      assertCurrent: () => {
        controller.signal.throwIfAborted()
        access.trusted(event)
        assertThread()
        if (
          sender.isDestroyed() ||
          sender.mainFrame !== frame ||
          event.senderFrame !== frame ||
          access.threadScope(threadId) !== workspace
        )
          throw Error("STALE")
        controller.signal.throwIfAborted()
      }
    }
    return { scope, controller }
  }
  const handle = (
    name: string,
    action: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>
  ) =>
    ipc.handle(
      "mods:evaluation:" + name,
      async (event, input): Promise<EvaluationResult<unknown>> => {
        try {
          access.trusted(event)
          return { ok: true, value: await action(event, input) }
        } catch (error) {
          return { ok: false, code: publicCode(error) }
        }
      }
    )
  handle("list", async (event, input) => {
    const threadId = text(input),
      workspace = text(access.threadScope(threadId), 4096)
    const { scope } = createScope(event, threadId, workspace)
    scope.assertCurrent()
    const evaluations = runner.list(scope)
    scope.assertCurrent()
    return { workspace, evaluations }
  })
  handle("start", async (event, input) => {
    const request = startInput(input)
    const { scope, controller } = createScope(event, request.threadId, request.expectedWorkspace)
    scope.assertCurrent()
    const abort = () => controller.abort()
    const navigate = (details: { isMainFrame: boolean; isSameDocument?: boolean }) => {
      if (details.isMainFrame && !details.isSameDocument) abort()
    }
    const cleanup = () => {
      event.sender.removeListener("destroyed", abort)
      event.sender.removeListener("did-start-navigation", navigate)
    }
    event.sender.once("destroyed", abort)
    event.sender.on("did-start-navigation", navigate)
    let result: Awaited<ReturnType<EvaluationRunner["start"]>> | undefined
    try {
      result = await runner.start(request, scope)
      scope.assertCurrent()
      void runner
        .wait(scope.workspace, scope.threadId, result.id)
        .finally(cleanup)
        .catch(() => undefined)
      return result
    } catch (error) {
      controller.abort()
      if (result) await runner.wait(scope.workspace, scope.threadId, result.id)
      cleanup()
      throw error
    }
  })
  handle("discard", async (event, input) => {
    const row = plain(input, ["threadId", "expectedWorkspace", "evaluationId", "expectedDigest"])
    const { scope } = createScope(event, text(row.threadId), text(row.expectedWorkspace, 4096))
    const id = text(row.evaluationId, 36), digest = text(row.expectedDigest, 64)
    if (!/^[a-f0-9]{64}$/.test(digest)) throw Error("INVALID")
    scope.assertCurrent()
    runner.discard(scope, id, digest)
    scope.assertCurrent()
  })
  handle("cancel", async (event, input) => {
    const row = plain(input, ["threadId", "expectedWorkspace", "evaluationId"])
    const { scope } = createScope(event, text(row.threadId), text(row.expectedWorkspace, 4096))
    const id = text(row.evaluationId, 36)
    scope.assertCurrent()
    await runner.cancel(scope, id)
    scope.assertCurrent()
  })
}
