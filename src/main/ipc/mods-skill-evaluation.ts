import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { types } from "node:util"
import { z } from "zod"
import type { SkillEvaluationBridge } from "../mods/evaluation/skill-bridge"
import type { EvaluationScope } from "../mods/evaluation/runner"

const text = z.string().min(1).max(200)
const sha = z.string().regex(/^[0-9a-f]{64}$/)
const scopeFields = { threadId: text, expectedWorkspace: z.string().min(1).max(4096) }
const selection = z
  .object({ id: text, revision: z.number().int().positive(), digest: sha })
  .strict()
const prepareSchema = z
  .object({ ...scopeFields, candidateId: text, fixture: selection, agentStepId: text })
  .strict()
const startSchema = z
  .object({
    ...scopeFields,
    id: z.string().uuid(),
    expectedDigest: sha,
    tasks: z
      .array(
        z
          .object({
            id: z.string().regex(/^[A-Za-z0-9_-]{1,60}$/),
            goal: z.string().min(1).max(4000)
          })
          .strict()
      )
      .min(1)
      .max(5),
    budget: z
      .object({
        timeoutMs: z.number().int().min(1000).max(3_600_000),
        maxExecutions: z.number().int().min(1).max(200)
      })
      .strict()
  })
  .strict()
const changeSchema = z
  .object({
    ...scopeFields,
    id: z.string().uuid(),
    expectedDigest: sha,
    action: z.enum(["adopt", "rollback", "cancel", "discard", "forget-history"]),
    acknowledgeRecoveryLoss: z.literal(true).optional()
  })
  .strict()
  .refine((value) => value.action !== "forget-history" || value.acknowledgeRecoveryLoss === true)
interface Access {
  trusted(event: IpcMainInvokeEvent): void
  threadScope(threadId: string): string
  captureThreadFence(threadId: string): () => void
}
export function registerSkillEvaluationHandlers(
  ipc: IpcMain,
  bridge: SkillEvaluationBridge,
  access: Access
) {
  const scoped = (event: IpcMainInvokeEvent, threadId: string, workspace: string) => {
    const controller = new AbortController(),
      sender = event.sender,
      frame = sender.mainFrame
    const fence = access.captureThreadFence(threadId)
    const scope: EvaluationScope = {
      workspace,
      threadId,
      signal: controller.signal,
      assertCurrent() {
        controller.signal.throwIfAborted()
        access.trusted(event)
        fence()
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
    action: (event: IpcMainInvokeEvent, value: unknown) => Promise<unknown>
  ) =>
    ipc.handle("mods:skill-evaluation:" + name, async (event, value) => {
      try {
        access.trusted(event)
        if (
          value &&
          typeof value === "object" &&
          (types.isProxy(value) ||
            Object.values(Object.getOwnPropertyDescriptors(value)).some((row) => !("value" in row)))
        )
          throw Error("INVALID")
        return { ok: true, value: await action(event, value) }
      } catch (error) {
        const message = error instanceof Error ? error.message : ""
        const code =
          error instanceof z.ZodError || /UNSUPPORTED|INVALID/.test(message)
            ? "INVALID"
            : error instanceof Error && error.name === "AbortError"
              ? "CANCELLED"
              : ((["BUSY", "STALE", "LIMIT", "CANCELLED"] as const).find(
                  (code) => message === code || message.endsWith("_" + code)
                ) ?? "FAILED")
        return { ok: false, code }
      }
    })
  handle("list", async (event, value) => {
    const threadId = text.parse(value),
      workspace = access.threadScope(threadId)
    return bridge.list(scoped(event, threadId, workspace).scope)
  })
  for (const operation of ["prepare", "start", "change"] as const)
    handle(operation, async (event, value) => {
      const request =
        operation === "prepare"
          ? prepareSchema.parse(value)
          : operation === "start"
            ? startSchema.parse(value)
            : changeSchema.parse(value)
      const { scope, controller } = scoped(event, request.threadId, request.expectedWorkspace)
      scope.assertCurrent()
      const abort = () => controller.abort()
      const navigate = (details: { isMainFrame: boolean; isSameDocument?: boolean }) => {
        if (details.isMainFrame && !details.isSameDocument) abort()
      }
      const timer = setTimeout(
        abort,
        operation === "start"
          ? (request as z.infer<typeof startSchema>).budget.timeoutMs + 5000
          : 20000
      )
      const cleanup = () => {
        clearTimeout(timer)
        event.sender.removeListener("destroyed", abort)
        event.sender.removeListener("did-start-navigation", navigate)
      }
      event.sender.once("destroyed", abort)
      event.sender.on("did-start-navigation", navigate)
      let started: string | undefined
      try {
        const result =
          operation === "prepare"
            ? bridge.prepare(request as z.infer<typeof prepareSchema>, scope)
            : operation === "start"
              ? await bridge.start(request as z.infer<typeof startSchema>, scope)
              : await bridge.change(request as z.infer<typeof changeSchema>, scope)
        if (operation === "start") started = result.id
        scope.assertCurrent()
        if (started)
          void bridge
            .wait(scope, started)
            .finally(cleanup)
            .catch(() => undefined)
        else cleanup()
        return result
      } catch (error) {
        controller.abort()
        // Start may persist an evaluation before a reply/fence failure. Its owned cleanup still drains.
        if (operation === "start")
          await bridge
            .wait(scope, (request as z.infer<typeof startSchema>).id)
            .catch(() => undefined)
        cleanup()
        throw error
      }
    })
}
