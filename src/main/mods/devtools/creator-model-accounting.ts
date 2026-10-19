import type { TraceTokenUsage } from "../../agent/trace/types"
import { types } from "node:util"

/** Main-only accounting receipt. This grants no tool, source, lease or execution authority. */
export interface CreatorModelAccounting {
  forTrace(traceId: string | undefined, signal?: AbortSignal): CreatorModelAccounting
  forChild(
    parentThreadId: string,
    childThreadId: string,
    workspace: string,
    traceId?: string,
    signal?: AbortSignal
  ): CreatorModelAccounting
  claim(): { settle(usage?: Pick<TraceTokenUsage, "inputTokens" | "outputTokens">): void }
  recordTrace(usage: CreatorTraceUsage): void
}
/** Projection of original Collector scalars, never reconstructed from transport attempt receipts. */
export interface CreatorTraceUsage {
  traceId: string
  modelCalls: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
  usageReportedCalls: number
}

const receipts = new WeakSet<CreatorModelAccounting>()
const owners = new WeakMap<CreatorModelAccounting, { workspace: string; threadId: string }>()
const runtimeReceipts = new WeakMap<object, CreatorModelAccounting>()

/** The key is the existing main-only runtime authority, not a renderer/model run ID. */
export function bindCreatorModelAccounting(
  authority: object,
  receipt: CreatorModelAccounting
): void {
  assertCreatorModelAccounting(receipt)
  runtimeReceipts.set(authority, receipt)
}
export function readCreatorModelAccounting(
  authority: object | undefined
): CreatorModelAccounting | undefined {
  return authority ? runtimeReceipts.get(authority) : undefined
}

export function assertCreatorModelAccounting(
  value: CreatorModelAccounting,
  owner?: { workspace: string; threadId: string }
): void {
  if (!receipts.has(value)) throw Error("DEVELOPMENT_MODEL_ACCOUNTING_SCOPE")
  const actual = owners.get(value)
  if (
    owner &&
    (!actual || actual.workspace !== owner.workspace || actual.threadId !== owner.threadId)
  )
    throw Error("DEVELOPMENT_MODEL_ACCOUNTING_SCOPE")
}

export function issueCreatorModelAccounting(
  input: {
    assertCurrent(): void
    claim(traceId?: string): ReturnType<CreatorModelAccounting["claim"]>
    recordTrace?(usage: CreatorTraceUsage): void
  },
  traceId?: string,
  signal?: AbortSignal,
  owner?: { workspace: string; threadId: string }
): CreatorModelAccounting {
  const receipt: CreatorModelAccounting = Object.freeze({
    forTrace(id: string | undefined, childSignal?: AbortSignal) {
      input.assertCurrent()
      childSignal?.throwIfAborted()
      if (id !== undefined && (!id || id.length > 256))
        throw Error("DEVELOPMENT_MODEL_ACCOUNTING_SCOPE")
      // A child has its own physical lifetime; the receipt is only its immutable billing parent.
      return issueCreatorModelAccounting(input, id, childSignal, owner)
    },
    forChild(parentThreadId: string, childThreadId: string, workspace: string, id?: string, childSignal?: AbortSignal) {
      if (
        !owner ||
        owner.threadId !== parentThreadId ||
        owner.workspace !== workspace ||
        !childThreadId
      )
        throw Error("DEVELOPMENT_MODEL_ACCOUNTING_SCOPE")
      input.assertCurrent()
      childSignal?.throwIfAborted()
      return issueCreatorModelAccounting(input, id, childSignal, {
        workspace,
        threadId: childThreadId
      })
    },
    claim() {
      input.assertCurrent()
      signal?.throwIfAborted()
      return input.claim(traceId)
    },
    recordTrace(usage: CreatorTraceUsage) {
      if (usage.traceId !== traceId) throw Error("DEVELOPMENT_MODEL_ACCOUNTING_SCOPE")
      input.recordTrace?.(usage)
    }
  })
  receipts.add(receipt)
  if (owner) owners.set(receipt, owner)
  return receipt
}

const budgetErrorCodes = new Set([
  "DEVELOPMENT_MODEL_ACCOUNTING_SCOPE",
  "DEVELOPMENT_MODEL_COST_UNSUPPORTED",
  "DEVELOPMENT_MODEL_ATTEMPT_BUDGET",
  "DEVELOPMENT_MODEL_HISTORY_UNCONFIRMED",
  "DEVELOPMENT_BUDGET_UNCONFIRMED",
  "DEVELOPMENT_TURN_BUDGET",
  "DEVELOPMENT_SCOPE_CHANGED",
  "DEVELOPMENT_CREATOR_MODE_REQUIRED",
  "DEVELOPMENT_DISABLED",
  "DEVELOPMENT_MODS_DISABLED"
])

/** SDK/provider wrappers can preserve the original Error as a cause. No message substring matching. */
export function readCreatorBudgetErrorCode(error: unknown): string | undefined {
  const seen = new Set<object>()
  for (let current = error; current && typeof current === "object" && !seen.has(current); ) {
    seen.add(current)
    const own = (key: string) => Object.getOwnPropertyDescriptor(current, key)?.value
    const status = own("status") ?? own("statusCode")
    const remote = typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
    const message = own("message")
    if (types.isNativeError(current) && !remote && typeof message === "string" && budgetErrorCodes.has(message))
      return message
    current = own("cause")
  }
  return undefined
}

export function isCreatorBudgetError(error: unknown): boolean {
  return readCreatorBudgetErrorCode(error) !== undefined
}
