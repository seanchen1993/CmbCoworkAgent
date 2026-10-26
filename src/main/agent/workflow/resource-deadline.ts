import { AsyncLocalStorage } from "node:async_hooks"
import { z } from "zod"
import type { WorkflowResourceDeadline } from "./types"

const timestamp = z.number().int().nonnegative().safe()
export const workflowDeadlinePolicy = z
  .object({
    firstExecutionMs: z.number().int().positive().max(86_400_000),
    totalMs: z.number().int().positive().max(86_400_000),
    commandMs: z.number().int().positive().max(600_000)
  })
  .strict()
export const workflowDeadlineId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/)
export const workflowDeadlineArgv = z.array(z.string().min(1).max(1024)).min(1).max(64)
export const workflowDeadlineRecord = z
  .object({
    budgetId: workflowDeadlineId,
    generation: z.number().int().positive().safe(),
    policy: workflowDeadlinePolicy,
    startedAt: timestamp,
    firstDeadlineAt: timestamp,
    deadlineAt: timestamp,
    firstCommandAt: timestamp.optional(),
    settledAt: timestamp.optional(),
    status: z.enum(["active", "succeeded", "failed"]),
    executionId: z.string().min(1).max(128).optional(),
    commands: z
      .array(
        z
          .object({
            commandId: workflowDeadlineId,
            argv: workflowDeadlineArgv,
            executionId: z.string().min(1).max(128).optional(),
            intentAt: timestamp.optional(),
            startedAt: timestamp.optional(),
            finishedAt: timestamp.optional(),
            exitCode: z.number().int().optional(),
            status: z.enum(["prepared", "unknown", "finished"])
          })
          .strict()
      )
      .max(64)
  })
  .strict()
  .superRefine((value, context) => {
    const starts = value.commands.flatMap((command) =>
      command.startedAt === undefined ? [] : [command.startedAt]
    )
    const invalidCommand = value.commands.some(
      (command) =>
        (command.status === "prepared" &&
          (command.executionId !== undefined ||
            command.intentAt !== undefined ||
            command.startedAt !== undefined ||
            command.finishedAt !== undefined ||
            command.exitCode !== undefined)) ||
        (command.status !== "prepared" &&
          (!command.executionId || command.intentAt === undefined)) ||
        (command.startedAt !== undefined &&
          (command.intentAt === undefined || command.startedAt < command.intentAt)) ||
        (command.intentAt !== undefined && command.intentAt < value.startedAt) ||
        (command.status === "finished" &&
          (command.startedAt === undefined ||
            command.finishedAt === undefined ||
            command.exitCode === undefined ||
            command.finishedAt < command.startedAt)) ||
        (command.status === "unknown" &&
          (command.finishedAt !== undefined || command.exitCode !== undefined))
    )
    if (
      invalidCommand ||
      (starts.length
        ? value.firstCommandAt !== Math.min(...starts)
        : value.firstCommandAt !== undefined) ||
      (value.settledAt !== undefined && value.settledAt < value.startedAt) ||
      (value.status === "succeeded" &&
        (!value.executionId ||
          value.firstCommandAt === undefined ||
          value.firstCommandAt >= value.firstDeadlineAt ||
          value.settledAt! >= value.deadlineAt ||
          value.commands.some((command) => command.status !== "finished") ||
          !value.commands.some(
            (command) => command.executionId === value.executionId && command.exitCode === 0
          ))) ||
      value.firstDeadlineAt !== value.startedAt + value.policy.firstExecutionMs ||
      value.deadlineAt !== value.startedAt + value.policy.totalMs ||
      new Set(value.commands.map((command) => command.commandId)).size !== value.commands.length ||
      (value.status === "active") !== (value.settledAt === undefined)
    )
      context.addIssue({ code: "custom", message: "WORKTREE_DEADLINE_FACTS_INVALID" })
  })
export function validWorkflowDeadlines(value: unknown): boolean {
  if (value === undefined) return true
  const parsed = z.array(workflowDeadlineRecord).max(32).safeParse(value)
  return (
    parsed.success &&
    new Set(parsed.data.map((item) => item.budgetId)).size === parsed.data.length &&
    parsed.data.filter((item) => item.status === "active").length <= 1
  )
}

/** Original-manifest CAS: a stale owner cannot erase history, ACKs or closed keys. */
export function assertWorkflowDeadlineHistoryTransition(
  previous: WorkflowResourceDeadline[] | undefined,
  next: WorkflowResourceDeadline[] | undefined
): void {
  for (const old of previous ?? []) {
    const current = next?.find((item) => item.budgetId === old.budgetId)
    if (
      !current ||
      JSON.stringify([
        old.policy,
        old.generation,
        old.startedAt,
        old.firstDeadlineAt,
        old.deadlineAt
      ]) !==
        JSON.stringify([
          current.policy,
          current.generation,
          current.startedAt,
          current.firstDeadlineAt,
          current.deadlineAt
        ]) ||
      (old.firstCommandAt !== undefined && old.firstCommandAt !== current.firstCommandAt) ||
      (old.status !== "active" && JSON.stringify(old) !== JSON.stringify(current))
    )
      fail("HISTORY_CHANGED")
    for (const command of old.commands) {
      const updated = current.commands.find((item) => item.commandId === command.commandId)
      if (
        !updated ||
        JSON.stringify(command.argv) !== JSON.stringify(updated.argv) ||
        (command.status !== "prepared" && updated.status === "prepared") ||
        (command.status === "finished" && JSON.stringify(command) !== JSON.stringify(updated)) ||
        (["executionId", "intentAt", "startedAt"] as const).some(
          (key) => command[key] !== undefined && command[key] !== updated[key]
        )
      )
        fail("HISTORY_CHANGED")
    }
  }
}

interface DeadlineScope {
  identity: string
  read(): WorkflowResourceDeadline
  save(value: WorkflowResourceDeadline): Promise<void>
  assertCurrent(): void
  active: boolean
  controller: AbortController
  timer?: ReturnType<typeof setTimeout>
  pending: Promise<void>
}
const scopes = new AsyncLocalStorage<DeadlineScope>()
const actions = new AsyncLocalStorage<{ stepId: string; executionId: string }>()
function fail(code: string): never {
  throw Error(`WORKTREE_DEADLINE_${code}`)
}
const cutoff = (budget: WorkflowResourceDeadline) =>
  Math.min(
    budget.deadlineAt,
    budget.firstCommandAt === undefined ? budget.firstDeadlineAt : Infinity
  )

function arm(scope: DeadlineScope): void {
  clearTimeout(scope.timer)
  try {
    const remaining = cutoff(scope.read()) - Date.now()
    if (remaining <= 0) scope.controller.abort(Error("WORKTREE_DEADLINE_EXPIRED"))
    else scope.timer = setTimeout(() => arm(scope), Math.min(remaining, 2_147_483_647))
  } catch (error) {
    scope.controller.abort(error)
  }
}

/** Admission is separate from authority: expiry must not prevent native settlement or cleanup. */
export function assertWorkflowResourceAdmission(): void {
  const scope = scopes.getStore()
  if (!scope) return
  if (!scope.active) fail("SCOPE_CLOSED")
  scope.assertCurrent()
  const budget = scope.read()
  if (budget.status !== "active") fail("SETTLED")
  if (Date.now() >= cutoff(budget)) {
    scope.controller.abort(Error("WORKTREE_DEADLINE_EXPIRED"))
    fail("EXPIRED")
  }
  scope.controller.signal.throwIfAborted()
}

export function captureWorkflowResourceAdmission(): () => void {
  const scope = scopes.getStore()
  return scope ? () => scopes.run(scope, assertWorkflowResourceAdmission) : () => {}
}

export function workflowResourceCommandTimeout(requestedMs: number): number {
  assertWorkflowResourceAdmission()
  const scope = scopes.getStore()
  return scope
    ? Math.min(requestedMs, scope.read().policy.commandMs, cutoff(scope.read()) - Date.now())
    : requestedMs
}

export function workflowResourceDeadlineSignal(): AbortSignal | undefined {
  return scopes.getStore()?.controller.signal
}

export function workflowResourceDeadlineIdentity(): string | undefined {
  return scopes.getStore()?.identity
}

export function withWorkflowDeadlineAction<T>(
  stepId: string,
  executionId: string,
  work: () => Promise<T>
): Promise<T> {
  return actions.run({ stepId, executionId }, work)
}

export async function withWorkflowResourceDeadline<T>(
  input: Pick<DeadlineScope, "identity" | "read" | "save" | "assertCurrent">,
  work: () => Promise<T>
): Promise<T> {
  const scope: DeadlineScope = {
    ...input,
    active: true,
    controller: new AbortController(),
    pending: Promise.resolve()
  }
  return scopes.run(scope, async () => {
    try {
      assertWorkflowResourceAdmission()
      if (scope.read().commands.some((command) => command.status === "unknown"))
        fail("COMMAND_UNKNOWN")
      arm(scope)
      const value = await work()
      assertWorkflowResourceAdmission()
      return value
    } finally {
      scope.active = false
      clearTimeout(scope.timer)
      await scope.pending
    }
  })
}

/** Serializes facts in the original resource, not a second process/action ledger. */
async function update(scope: DeadlineScope, change: (budget: WorkflowResourceDeadline) => void) {
  const pending = scope.pending.then(async () => {
    const next = structuredClone(scope.read())
    change(next)
    await scope.save(next)
  })
  scope.pending = pending.catch(() => {})
  await pending
}

export async function prepareWorkflowDeadlineProcess(argv: readonly string[]) {
  const scope = scopes.getStore()
  if (!scope) return undefined
  assertWorkflowResourceAdmission()
  const action = actions.getStore()
  const command =
    action &&
    scope
      .read()
      .commands.find(
        (item) =>
          item.commandId === action.stepId && JSON.stringify(item.argv) === JSON.stringify(argv)
      )
  if (command) {
    await update(scope, (budget) => {
      assertWorkflowResourceAdmission()
      const original = budget.commands.find((item) => item.commandId === command.commandId)!
      if (original.status !== "prepared") fail("COMMAND_UNKNOWN")
      original.status = "unknown"
      original.executionId = action!.executionId
      original.intentAt = Date.now()
    })
    assertWorkflowResourceAdmission()
  }
  return {
    timeoutMs: Math.min(scope.read().policy.commandMs, scope.read().deadlineAt - Date.now()),
    started: async () => {
      if (!command) return
      await update(scope, (budget) => {
        const original = budget.commands.find((item) => item.commandId === command.commandId)!
        original.startedAt = Date.now()
        budget.firstCommandAt ??= original.startedAt
        // A late ACK is evidence, never permission to extend an already expired budget.
        if (
          original.startedAt >= budget.firstDeadlineAt &&
          budget.firstCommandAt === original.startedAt
        )
          scope.controller.abort(Error("WORKTREE_DEADLINE_EXPIRED"))
      })
      arm(scope)
      assertWorkflowResourceAdmission()
    },
    finished: async (exitCode: number) => {
      if (!command) return
      await update(scope, (budget) => {
        const original = budget.commands.find((item) => item.commandId === command.commandId)!
        original.finishedAt = Date.now()
        original.exitCode = exitCode
        original.status = "finished"
      })
    }
  }
}
