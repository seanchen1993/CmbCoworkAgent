import { z } from "zod"
import { BotDomainError } from "../../shared/bot-types"
import {
  buildSubagentStartHookContext,
  buildSubagentStopHookContext
} from "../hooks/subagent-context"
import type { BotRuntimeRequest } from "./host"
import type { BotSkillHooks } from "./skill-hooks"
import type { BotStore } from "./store"
import { readSkillHookReceipt, skillCompletionReceipt } from "./skill-hook-state"

const startKey = "lifecycle:subagent-start"
const stopKey = "lifecycle:subagent-stop"
const completion = skillCompletionReceipt.extend({ failed: z.boolean() }).strict()

function assertResult(saved: z.infer<typeof completion>): void {
  if (saved.result?.continue === false)
    throw new BotDomainError(
      "subagent_hook_halted",
      saved.result.stopReason || saved.result.reason || "子任务结束检查要求停止任务"
    )
}

/** Hooks belong to the child's lease and isolated workspace. Parallel children
 * must never compete for a single parent approval or borrow its tool authority. */
export class BotSubagentLifecycle {
  constructor(
    private readonly request: BotRuntimeRequest,
    private readonly hooks: Pick<BotSkillHooks, "run">
  ) {}

  started(): boolean {
    const { store, run } = this.request
    const value = readSkillHookReceipt(store, run.id, startKey)
    return value === undefined ? false : z.literal(true).parse(value)
  }

  async start(): Promise<void> {
    const { store, run, lease, signal } = this.request
    const child = store.workflowChildren.metadata(run.id)
    if (!child) return
    signal.throwIfAborted()
    store.assertDispatch(lease)
    const prior = readSkillHookReceipt(store, run.id, startKey)
    if (prior !== undefined) {
      z.literal(true).parse(prior)
      return
    }
    await this.hooks.run(
      "SubagentStart",
      buildSubagentStartHookContext({
        threadId: run.id,
        toolCallId: run.id,
        subagentType: child.input.agentType,
        taskDescription: child.input.prompt
      }),
      startKey
    )
    signal.throwIfAborted()
    store.assertDispatch(lease)
    store.toolOnce(lease, startKey, { event: "SubagentStart" }, () => true)
  }

  async finish(failed: boolean): Promise<void> {
    const { store, run, lease, signal } = this.request
    const child = store.workflowChildren.metadata(run.id)
    if (!child) return
    signal.throwIfAborted()
    store.assertDispatch(lease)
    if (!this.started()) return
    const prior = readSkillHookReceipt(store, run.id, stopKey)
    if (prior !== undefined) {
      const saved = completion.parse(prior)
      if (saved.failed !== failed)
        throw new BotDomainError("subagent_hook_outcome", "子任务结束状态与已保存检查不一致")
      assertResult(saved)
      return
    }
    // A cancelled or revoked task cannot dispatch new cleanup operations. Its
    // existing in-flight effects are handled by the ordinary recovery path.
    const context = buildSubagentStopHookContext({
      threadId: run.id,
      toolCallId: run.id,
      failed
    })
    const result = await this.hooks.run(
      "SubagentStop",
      { ...context, subagent: { ...context.subagent!, name: child.input.agentType } },
      stopKey
    )
    signal.throwIfAborted()
    store.assertDispatch(lease)
    const saved = completion.parse(
      store.toolOnce(lease, stopKey, { event: "SubagentStop", failed }, () => ({
        invocation: stopKey,
        failed,
        result
      }))
    )
    // Persist the halt before throwing, so recovery and the parent see it even
    // when workflow JavaScript catches an individual agent failure.
    assertResult(saved)
  }
}

export function assertBotChildLifecycle(store: BotStore, parentRunId: string): void {
  const rows = store.db.exec(
    `SELECT p.response FROM bot_runs r
     JOIN bot_workflow_children c ON c.run_id=r.id
     JOIN bot_receipts p ON p.nonce='tool:' || r.id || ':' || ?
     WHERE r.parent_run_id=? AND json_extract(p.response,'$.result.continue')=0 LIMIT 1`,
    [stopKey, parentRunId]
  )[0]?.values
  for (const row of rows ?? []) assertResult(completion.parse(JSON.parse(z.string().parse(row[0]))))
}
