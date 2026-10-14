import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { createHash, randomUUID } from "node:crypto"
import type { ModsManager } from "../mods/manager"
import { BuiltinProjectAdvisor, ADVISOR_LIMITS, type AdvisorScope } from "../mods/builtins/advisor"
import { projectBuiltinRunOverview } from "../mods/builtins/overview"
import { builtinInstructionsStore } from "../mods/builtins/instructions"
import { getThreadCore } from "../db"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import type { ModIdentity } from "../../shared/mods/types"
import { readBuiltinProjectFacts } from "../mods/builtins/project-facts"

export function registerBuiltinAdvisorHandlers(
  ipc: IpcMain,
  manager: ModsManager,
  access: {
    scope(
      event: IpcMainInvokeEvent,
      threadId: string,
      expectedWorkspace: string
    ): { workspace: string; assertCurrent(): void }
  }
) {
  const advisor = new BuiltinProjectAdvisor(manager.store)
  ipc.handle(
    "mods:builtin-advisor",
    async (
      event,
      input: {
        threadId: string
        expectedWorkspace: string
        action: "view" | "enable" | "disable" | "analyze" | "cancel" | "dismiss"
      }
    ) => {
      if (
        !input ||
        typeof input.threadId !== "string" ||
        typeof input.expectedWorkspace !== "string" ||
        !input.expectedWorkspace.trim() ||
        !["view", "enable", "disable", "analyze", "cancel", "dismiss"].includes(input.action)
      )
        throw Error("ADVISOR_INVALID")
      const fence = access.scope(
        event,
        input.threadId,
        manager.workspaceKey(input.expectedWorkspace)
      )
      const row = getThreadCore(input.threadId)!
      const scope: AdvisorScope = {
        ...fence,
        threadId: input.threadId,
        incarnation: JSON.stringify(captureThreadIncarnation(row)),
        factsIdentity: () => {
          fence.assertCurrent()
          const records = manager.store.audit(
            fence.workspace,
            101,
            Number.MAX_SAFE_INTEGER,
            input.threadId,
            "devclaw-project-advisor"
          )
          const instructions = builtinInstructionsStore.read({
            threadId: input.threadId,
            workspace: fence.workspace,
            incarnationKey: JSON.stringify(captureThreadIncarnation(row))
          })
          return createHash("sha256")
            .update(
              JSON.stringify({
                runId: instructions.snapshot?.runId,
                calls: records.map((record) => [
                  record.callId,
                  record.status,
                  record.publication,
                  record.finishedAt
                ]),
                policy: manager.policy.deployment,
                project: readBuiltinProjectFacts(input.threadId, fence.workspace).identity
              })
            )
            .digest("hex")
        }
      }
      if (input.action === "view") return advisor.view(scope)
      if (input.action === "dismiss") return advisor.dismiss(scope)
      if (input.action === "enable") return advisor.enable(scope, true)
      if (input.action === "disable") {
        advisor.enable(scope, false)
        await advisor.cancel(scope)
        return advisor.view(scope)
      }
      if (input.action === "cancel") {
        await advisor.cancel(scope)
        return advisor.view(scope)
      }
      const records = manager.store.audit(
        scope.workspace,
        101,
        Number.MAX_SAFE_INTEGER,
        scope.threadId,
        "devclaw-project-advisor"
      )
      const overview = projectBuiltinRunOverview({
        threadId: scope.threadId,
        workspace: scope.workspace,
        capturedAt: Date.now(),
        instructions: builtinInstructionsStore.read({
          threadId: scope.threadId,
          workspace: scope.workspace,
          incarnationKey: scope.incarnation
        }),
        records: records.slice(0, 100),
        limited: records.length > 100,
        policy: manager.policy.deployment
      })
      overview.project = readBuiltinProjectFacts(input.threadId, scope.workspace).facts
      const controller = new AbortController()
      const abort = () => controller.abort(Error("ADVISOR_SCOPE_CHANGED"))
      const navigate = (details: { isMainFrame: boolean; isSameDocument?: boolean }) => {
        if (details.isMainFrame && !details.isSameDocument) abort()
      }
      event.sender.once("destroyed", abort)
      event.sender.on("did-start-navigation", navigate)
      try {
        return await advisor.analyze(
          scope,
          overview,
          async (facts, signal) => {
            scope.assertCurrent()
            const id = randomUUID()
            const identity: ModIdentity = {
              callId: id,
              threadId: scope.threadId,
              workspace: scope.workspace,
              turnId: id,
              agentId: "project-advisor",
              origin: "user-action",
              grantEpoch: 0,
              modId: "devclaw-project-advisor"
            }
            await manager.policy.admit(
              identity,
              "model.complete",
              { purpose: "project-advisor", facts },
              signal
            )
            scope.assertCurrent()
            const metadata =
              typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata
            const modelRef =
              manager.clawDefaultModel?.(scope.workspace, scope.threadId) ??
              (typeof metadata?.model === "string" ? metadata.model : undefined)
            manager.store.claimFunctionModel(
              identity,
              { purpose: "project-advisor" },
              { facts },
              modelRef ?? "configured-default",
              ADVISOR_LIMITS.outputTokens
            )
            try {
              const { invokeBuiltinAdvisor } = await import("../mods/builtins/advisor-model")
              scope.assertCurrent()
              signal.throwIfAborted()
              const result = await invokeBuiltinAdvisor(facts, signal, modelRef)
              scope.assertCurrent()
              signal.throwIfAborted()
              manager.store.recordFunctionModelUsage(id, result.inputTokens, result.outputTokens)
              const published = await manager.policy.publish(
                result,
                undefined,
                signal,
                (digest, rules) => manager.store.publication(id, digest, rules, "published")
              )
              scope.assertCurrent()
              signal.throwIfAborted()
              manager.store.settle(id, "succeeded")
              return published
            } catch (error) {
              manager.store.settle(id, signal.aborted ? "unknown" : "failed")
              manager.store.blockPublication(id)
              throw error
            }
          },
          controller.signal
        )
      } finally {
        event.sender.removeListener("destroyed", abort)
        event.sender.removeListener("did-start-navigation", navigate)
      }
    }
  )
}
