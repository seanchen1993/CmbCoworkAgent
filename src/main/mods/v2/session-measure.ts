import { AsyncLocalStorage } from "node:async_hooks"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"

/** Private native measurements, never snapshots returned by a mutable SDK operation. */
export function measurementSnapshot(value: ModJson): ModObject {
  if (!isModObject(value) || !isModObject(value.context) || !Array.isArray(value.rateLimits))
    throw new ModFunctionError("MODS_MEASUREMENT_UNAVAILABLE")
  const { window, tokens, percent } = value.context
  if (
    !Number.isSafeInteger(window) ||
    Number(window) <= 0 ||
    (tokens !== undefined && (!Number.isSafeInteger(tokens) || Number(tokens) < 0)) ||
    (percent !== undefined &&
      (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100))
  )
    throw new ModFunctionError("MODS_MEASUREMENT_UNAVAILABLE")
  const rateLimits = value.rateLimits.map((row) => {
    if (
      !isModObject(row) ||
      typeof row.kind !== "string" ||
      typeof row.percentUsed !== "number" ||
      !Number.isFinite(row.percentUsed) ||
      row.percentUsed < 0 ||
      (row.resetsAt !== undefined && typeof row.resetsAt !== "string")
    )
      throw new ModFunctionError("MODS_MEASUREMENT_UNAVAILABLE")
    return {
      kind: row.kind,
      percentUsed: row.percentUsed,
      ...(row.resetsAt === undefined ? {} : { resetsAt: row.resetsAt })
    }
  })
  if (
    value.cost !== undefined &&
    (!isModObject(value.cost) ||
      typeof value.cost.usd !== "number" ||
      !Number.isFinite(value.cost.usd) ||
      value.cost.usd < 0)
  )
    throw new ModFunctionError("MODS_MEASUREMENT_UNAVAILABLE")
  return parseModJson(
    encodeModJson({
      context: {
        window,
        ...(tokens === undefined ? {} : { tokens }),
        ...(percent === undefined ? {} : { percent })
      },
      rateLimits,
      ...(value.cost === undefined ? {} : { cost: { usd: (value.cost as ModObject).usd } })
    })
  ) as ModObject
}

function changes(current: ModObject, previous?: ModObject): string[] {
  const changed: string[] = []
  if (!previous || encodeModJson(current.context) !== encodeModJson(previous.context))
    changed.push("context")
  const quota = (value: ModJson) =>
    (value as ModObject[])
      .map((row) => ({
        kind: row.kind,
        percentUsed: Math.trunc(Number(row.percentUsed)),
        resetsAt: row.resetsAt ?? null
      }))
      .sort((a, b) => String(a.kind).localeCompare(String(b.kind)))
  if (
    (!previous && (current.rateLimits as ModJson[]).length) ||
    (previous &&
      encodeModJson(quota(current.rateLimits)) !== encodeModJson(quota(previous.rateLimits)))
  )
    changed.push("rateLimits")
  if (
    isModObject(current.cost) &&
    (!previous ||
      !isModObject(previous.cost) ||
      Number(current.cost.usd) > Number(previous.cost.usd))
  )
    changed.push("cost")
  return changed
}

/** One active notification and one latest pending request, each retaining its original ALS. */
export class FunctionSessionMeasurements {
  private baseline?: ModObject
  private pending?: () => Promise<void>
  private running?: Promise<void>
  private closed = false
  private readonly entered = new AsyncLocalStorage<boolean>()

  enqueue(
    run: (
      prepare: (snapshot: ModObject) =>
        | {
            input: ModObject
            commit(): void
          }
        | undefined
    ) => Promise<void>
  ): Promise<void> {
    if (this.closed) return Promise.resolve()
    const resume = AsyncLocalStorage.snapshot()
    this.pending = () =>
      resume(() =>
        this.entered.run(true, () =>
          run((snapshot) => {
            const changed = changes(snapshot, this.baseline)
            if (!changed.length) return undefined
            let committed = false
            return {
              input: { ...snapshot, changed },
              commit: () => {
                if (!committed && !this.closed) {
                  committed = true
                  this.baseline = snapshot
                }
              }
            }
          })
        )
      )
    // A native reentry must not await the notification that called it.
    if (this.running) return this.entered.getStore() ? Promise.resolve() : this.running
    const running = Promise.resolve().then(async () => {
      try {
        while (!this.closed && this.pending) {
          const next = this.pending
          this.pending = undefined
          await next()
        }
      } finally {
        // Clear in this same continuation, not a later .finally microtask: no lost enqueue.
        if (this.running === running) this.running = undefined
      }
    })
    this.running = running
    return running
  }

  close(): void {
    this.closed = true
    this.pending = undefined
    this.baseline = undefined
  }
}

/** Bounds even a native reader that neglects cancellation; late code still sees an aborted scope. */
export async function withinMeasurementBudget(
  parent: AbortSignal,
  run: (signal: AbortSignal) => Promise<void>,
  milliseconds = 5000
): Promise<void> {
  const deadline = new AbortController()
  const signal = AbortSignal.any([parent, deadline.signal])
  const timer = setTimeout(
    () => deadline.abort(new ModFunctionError("MODS_MEASUREMENT_TIMEOUT")),
    milliseconds
  )
  timer.unref()
  let detach: () => void = () => undefined
  const cancelled = new Promise<never>((_, reject) => {
    const abort = () => reject(signal.reason)
    detach = () => signal.removeEventListener("abort", abort)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  })
  try {
    signal.throwIfAborted()
    await Promise.race([run(signal), cancelled])
  } catch (error) {
    deadline.abort(error)
    // This observer is fail-open. Its original task handles task cancellation separately.
  } finally {
    // Even successful notifications cannot leave processes or timers with an unbounded lifetime.
    deadline.abort(new ModFunctionError("MODS_MEASUREMENT_ENDED"))
    clearTimeout(timer)
    detach()
  }
}
