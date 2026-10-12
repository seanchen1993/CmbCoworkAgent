import { serializeBotFailure } from "./error-diagnostic"
import { BotDomainError } from "../../shared/bot-types"
import type { BotRuntimeRequest } from "./host"
import type { BotWorkflowStore } from "./workflow-store"
import { workflowAgentRequest, type workflowAgentResult } from "./workflow-contract"
import type { WorkflowSubagentRunner } from "../agent/workflow/types"
import type { z } from "zod"

/** The parent waits for this executor's cleanup and receipt commit before its
 * worker slot is released. No fresh thread or retry can bypass an old effect. */
export function botWorkflowChildRunner(
  parent: BotRuntimeRequest,
  workflow: BotWorkflowStore,
  execute: (request: BotRuntimeRequest) => Promise<string>,
  finishChild?: (request: BotRuntimeRequest) => Promise<void>,
  nativeTask?: {
    start(request: BotRuntimeRequest): Promise<void>
    settle(request: BotRuntimeRequest): Promise<void>
  }
): WorkflowSubagentRunner {
  return async ({ signal, ...raw }) => {
    signal.throwIfAborted()
    const input = workflowAgentRequest.parse(raw)
    const { store } = parent
    const claim = store.workflowChildren.claim(workflow, parent.lease, input)
    if (claim.result) return claim.result
    const lease = claim.lease!
    const controller = new AbortController()
    const stop = (reason: unknown) => {
      try {
        // A late callback from a replaced executor must not cancel the new
        // lease, or keep itself alive on that executor's in-flight receipt.
        store.assertLease(lease, true, true)
        if (store.workflowChildren.isCollectingReceipt(claim.run.id)) return
        store.cancel(claim.run.id)
      } catch {
        /* stale/review state remains authoritative */
      }
      controller.abort(reason)
    }
    const onAbort = () => stop(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
    const timer = setInterval(() => {
      try {
        if (store.getRun(claim.run.id).status === "cancelling") throw new Error("子任务已停止")
        workflow.assertOwner(parent.lease)
        store.workflowChildren.renew(lease)
      } catch (error) {
        stop(error)
      }
    }, 250)
    timer.unref()
    let childRequest: BotRuntimeRequest | undefined
    let nativeSettlementAttempted = false
    const settleNative = async () => {
      if (!input.desktopAccess || !childRequest || nativeSettlementAttempted) return
      nativeSettlementAttempted = true
      try {
        if (!nativeTask)
          throw new BotDomainError("workflow_desktop_scope", "工作应用子任务缺少后台执行端口")
        await nativeTask.settle(childRequest)
      } catch (error) {
        // Do not make the original reservation available after an unconfirmed
        // physical observation fence, or retry that transition on this executor.
        store.interruptOwnedRun(lease, "应用子任务观察收束未确认，请核对后恢复")
        throw error
      }
    }
    try {
      childRequest = {
        store,
        run: claim.run,
        lease,
        signal: controller.signal,
        bot: store.getBot(claim.run.botId),
        messages: [],
        assertOwnership: parent.assertOwnership,
        onRunFailure: parent.onRunFailure
      }
      if (input.desktopAccess) {
        if (!nativeTask)
          throw new BotDomainError("workflow_desktop_scope", "工作应用子任务缺少后台执行端口")
        try {
          await nativeTask.start(childRequest)
        } catch (error) {
          store.interruptOwnedRun(lease, "应用子任务观察准备未确认，请核对后恢复")
          throw error
        }
      }
      const text = await execute(childRequest)
      controller.signal.throwIfAborted()
      const result: z.infer<typeof workflowAgentResult> = {
        text: text.slice(0, 64_000),
        structured: input.schema ? store.workflowChildren.readStructured(claim.run.id) : undefined,
        outputTokens: store.workflowChildren.outputTokens(claim.run.id)
      }
      await settleNative()
      const settled = store.workflowChildren.settle(lease, "succeeded", result)
      if (settled.status !== "succeeded")
        throw new BotDomainError("workflow_child_review", settled.error ?? "子任务尚未结算")
      return result
    } catch (error) {
      const current = store.getRun(claim.run.id)
      if (
        current.leaseOwner === lease.owner &&
        current.fence === lease.fence &&
        ["running", "waiting_input", "cancelling"].includes(current.status)
      ) {
        try {
          await settleNative()
        } catch {
          /* original fence record remains needs_review */
        }
        const failure = serializeBotFailure(error)
        const afterFence = store.getRun(claim.run.id)
        if (afterFence.leaseOwner !== lease.owner || afterFence.fence !== lease.fence) throw error
        const settled = store.workflowChildren.settle(
          lease,
          controller.signal.aborted ? "cancelled" : "failed",
          failure.message,
          failure.diagnostic
        )
        if (settled.status === "failed") parent.onRunFailure?.(settled, failure)
      }
      throw error
    } finally {
      clearInterval(timer)
      signal.removeEventListener("abort", onAbort)
      // Cleanup uses only this child owner and never launches a fresh surface.
      if (input.browserAccess === "page" && childRequest) {
        // A retirement failure must not turn an already committed child result
        // into a failed task. Unreleased resources remain bounded and owned.
        await finishChild?.(childRequest).catch(() => {
          console.warn("[BotBrowser] 任务页面尚未释放，保留原执行记录")
        })
      }
    }
  }
}
