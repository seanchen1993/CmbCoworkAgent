import { createHash } from "node:crypto"
import { z } from "zod"
import type { WorkflowWorktreeLedger } from "./worktree-lease"
import type { WorkflowDeterministicActionRunner } from "./deterministic-action"
import { workflowDeadlineArgv, workflowDeadlineId, workflowDeadlinePolicy } from "./resource-deadline"

const identity = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex")
const named = { resourceId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/) }
const request = z.discriminatedUnion("op", [
  z.object({ op: z.literal("deadline-begin"), handle: z.string().uuid(),
    budgetId: workflowDeadlineId, policy: workflowDeadlinePolicy }).strict(),
  z.object({ op: z.literal("deadline-command"), handle: z.string().uuid(),
    budgetId: workflowDeadlineId, commandId: workflowDeadlineId, argv: workflowDeadlineArgv }).strict(),
  z.object({ op: z.literal("deadline-settle"), handle: z.string().uuid(),
    budgetId: workflowDeadlineId, outcome: z.enum(["succeeded", "failed"]),
    executionId: z.string().min(1).max(128).optional() }).strict(),
  z
    .object({
      op: z.literal("acquire"),
      ...named,
      workspaceRef: z
        .string()
        .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/)
        .optional()
    })
    .strict(),
  z
    .object({
      op: z.literal("inspect"),
      ...named,
      workspaceRef: z
        .string()
        .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/)
        .optional()
    })
    .strict(),
  z
    .object({
      op: z.enum(["merge-into", "reconcile-merge"]),
      handle: z.string().uuid(),
      targetHandle: z.string().uuid(),
      expectedCommit: z.string().regex(/^[a-f0-9]{40,64}$/i),
      expectedTargetCommit: z.string().regex(/^[a-f0-9]{40,64}$/i)
    })
    .strict(),
  z
    .object({
      op: z.enum(["seal", "reconcile", "merge", "discard"]),
      handle: z.string().uuid(),
      expectedCommit: z.string().regex(/^[a-f0-9]{40,64}$/i)
    })
    .strict()
])

/** Optional Git primitive: all resource facts remain in the original run/manifest. */
export function createWorkflowWorktreeResourceRunner(
  ledger: WorkflowWorktreeLedger,
  parentIdentity: string,
  assertCurrent: () => void,
  verifyDeadlineReceipt: (handle: string, budgetId: string, executionId: string) => boolean = () => false
): WorkflowDeterministicActionRunner {
  return async (raw, child, signal) => {
    signal.throwIfAborted()
    assertCurrent()
    const input = request.parse(raw)
    const sourceIdentity = identity([
      parentIdentity,
      child?.identity ?? "root",
      child?.scriptSha256 ?? null
    ])
    if (input.op === "deadline-begin" || input.op === "deadline-command" || input.op === "deadline-settle") {
      const result = await ledger.deadlineCommand(input.handle, input.budgetId, sourceIdentity,
        input.op === "deadline-begin" ? { op: "begin", policy: input.policy } :
          input.op === "deadline-command" ? { op: "command", commandId: input.commandId, argv: input.argv } :
            { op: "settle", outcome: input.outcome, executionId: input.executionId },
        assertCurrent, executionId => verifyDeadlineReceipt(input.handle, input.budgetId, executionId))
      assertCurrent()
      signal.throwIfAborted()
      return result
    }
    const result =
      input.op === "acquire" || input.op === "inspect"
        ? await ledger[input.op === "acquire" ? "acquireResource" : "inspectResource"](
            identity([child?.identity ?? "root", input.resourceId]),
            sourceIdentity,
            input.workspaceRef
          )
        : input.op === "merge-into" || input.op === "reconcile-merge"
          ? await ledger.mergeResourceInto(
              input.handle,
              input.targetHandle,
              input.expectedCommit,
              input.expectedTargetCommit,
              input.op === "reconcile-merge"
            )
          : await ledger.resourceCommand(input.handle, input.op, input.expectedCommit)
    signal.throwIfAborted()
    assertCurrent()
    return result
  }
}
