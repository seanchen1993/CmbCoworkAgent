import {
  assertCreatorModelAccounting,
  type CreatorModelAccounting
} from "../mods/devtools/creator-model-accounting"

type HookOwner = { workspacePath?: string; sessionId?: string; signal?: AbortSignal }
export interface HookModelAccounting {
  readonly receipt: CreatorModelAccounting
  readonly signal?: AbortSignal
  assertCurrent(): void
}
export type HookAccountingBinder = <T extends HookOwner>(context: T) => T

// Main-only side channel. Neither Hook JSON/env nor guest/renderer input can carry a receipt.
const contexts = new WeakMap<object, HookModelAccounting>()

export function createHookAccountingBinder(
  receipt: CreatorModelAccounting | undefined,
  owner: { workspace: string; threadId: string },
  signal?: AbortSignal,
  assertCurrent: () => void = () => signal?.throwIfAborted()
): HookAccountingBinder {
  if (receipt) assertCreatorModelAccounting(receipt, owner)
  return (context) => {
    if (!receipt) return context
    if (context.workspacePath !== owner.workspace || context.sessionId !== owner.threadId)
      throw Error("DEVELOPMENT_MODEL_ACCOUNTING_SCOPE")
    const signals = [signal, context.signal].filter((item): item is AbortSignal => !!item)
    const combined = signals.length ? AbortSignal.any(signals) : undefined
    contexts.set(
      context,
      Object.freeze({
        receipt,
        signal: combined,
        assertCurrent: () => {
          if (context.workspacePath !== owner.workspace || context.sessionId !== owner.threadId)
            throw Error("DEVELOPMENT_MODEL_ACCOUNTING_SCOPE")
          assertCreatorModelAccounting(receipt, owner)
          combined?.throwIfAborted()
          assertCurrent()
        }
      })
    )
    return context
  }
}

/** Capture before the runner clones/merges context; subsequent routing uses this exact value. */
export function readHookModelAccounting(context: HookOwner): HookModelAccounting | undefined {
  return contexts.get(context)
}
