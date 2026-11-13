import assert from "node:assert/strict"
import type { ElectronApplication } from "playwright"

export const DISPLAY_CANCEL_SLEEP_MS = 27123

export interface DisplayCancelObservation {
  active: number
  peak: number
  reads: Array<{
    id: string
    threadId: string
    component: string
    text: string
    started: number
    ended?: number
    error?: string
  }>
  cancels: Array<{ id: string; at: number }>
  nativeClockTimers: Array<{ started: number; cancelled?: number; fired?: number }>
}

/** Observe Main physical promises and native SDK clocks; preserve every result/handle. */
export async function observeDisplayCancellation(app: ElectronApplication): Promise<void> {
  await app.evaluate("globalThis.__name = value => value\nvoid 0")
  await app.evaluate(({ ipcMain }, sleepMs) => {
    const state: DisplayCancelObservation = {
      active: 0,
      peak: 0,
      reads: [],
      cancels: [],
      nativeClockTimers: []
    }
    const globals = globalThis as unknown as {
      displayCancelObservation: DisplayCancelObservation
    }
    globals.displayCancelObservation = state
    const handlers = (
      ipcMain as unknown as {
        _invokeHandlers: Map<string, (...args: unknown[]) => unknown>
      }
    )._invokeHandlers
    for (const channel of ["mods:function-site-read", "mods:function-site-render"]) {
      const handler = handlers.get(channel)
      if (!handler) throw Error(`MISSING_REAL_HANDLER:${channel}`)
      handlers.set(channel, async (...args) => {
        const input = args[1] as {
          readId: string
          threadId: string
          component?: string
          props?: { text?: unknown }
        }
        const entry: DisplayCancelObservation["reads"][number] = {
          id: input.readId,
          threadId: input.threadId,
          component: input.component ?? "render",
          text: String(input.props?.text ?? ""),
          started: performance.now()
        }
        state.reads.push(entry)
        state.active++
        state.peak = Math.max(state.peak, state.active)
        try {
          return await handler(...args)
        } catch (error) {
          entry.error = String(error)
          throw error
        } finally {
          entry.ended = performance.now()
          state.active--
        }
      })
    }
    const cancel = handlers.get("mods:function-site-read-cancel")
    if (!cancel) throw Error("MISSING_REAL_CANCEL_HANDLER")
    handlers.set("mods:function-site-read-cancel", (...args) => {
      state.cancels.push({ id: (args[1] as { readId: string }).readId, at: performance.now() })
      return cancel(...args)
    })
    const nativeSetTimeout = globalThis.setTimeout
    const nativeClearTimeout = globalThis.clearTimeout
    const timers = new Map<
      ReturnType<typeof setTimeout>,
      DisplayCancelObservation["nativeClockTimers"][number]
    >()
    globalThis.setTimeout = new Proxy(nativeSetTimeout, {
      apply(target, receiver, values) {
        const [callback, delay, ...args] = values
        if (delay !== sleepMs) return Reflect.apply(target, receiver, values)
        const entry: DisplayCancelObservation["nativeClockTimers"][number] = {
          started: performance.now()
        }
        state.nativeClockTimers.push(entry)
        const timer = Reflect.apply(target, receiver, [
          function (this: unknown, ...values: unknown[]) {
            entry.fired = performance.now()
            timers.delete(timer)
            return Reflect.apply(callback, this, values)
          },
          delay,
          ...args
        ]) as ReturnType<typeof setTimeout>
        timers.set(timer, entry)
        return timer
      }
    })
    globalThis.clearTimeout = new Proxy(nativeClearTimeout, {
      apply(target, receiver, values) {
        const [timer] = values
        const entry = timers.get(timer)
        if (entry) {
          entry.cancelled = performance.now()
          timers.delete(timer)
        }
        return Reflect.apply(target, receiver, values)
      }
    })
  }, DISPLAY_CANCEL_SLEEP_MS)
}

export function readDisplayCancellation(
  app: ElectronApplication
): Promise<DisplayCancelObservation> {
  return app.evaluate(
    () =>
      (
        globalThis as unknown as {
          displayCancelObservation: DisplayCancelObservation
        }
      ).displayCancelObservation
  )
}

export function assertOldDisplayReadsCancelled(state: DisplayCancelObservation, threadId: string) {
  const old = state.reads.filter(
    (row) => row.threadId === threadId && /^DISPLAY_CANCEL_A_[0-3]$/.test(row.text)
  )
  assert.equal(old.length, 4, "Exactly four original visible body reads must be held")
  assert.equal(state.nativeClockTimers.length, 4, "Four actual native SDK clock timers must exist")
  for (const row of old) {
    assert(
      row.id && state.cancels.some((cancel) => cancel.id === row.id),
      "Preload must cancel each old ID"
    )
    assert(
      row.ended !== undefined && /CANCELLED|cancel/i.test(row.error ?? ""),
      `Old physical IPC must reject after cancellation: ${JSON.stringify(row)}`
    )
  }
  for (const timer of state.nativeClockTimers)
    assert(
      timer.cancelled !== undefined && timer.fired === undefined,
      "The real native timer must be cleared rather than left behind a raced promise"
    )
  assert(state.peak <= 4, `The original physical UI budget must remain four: ${state.peak}`)
}
