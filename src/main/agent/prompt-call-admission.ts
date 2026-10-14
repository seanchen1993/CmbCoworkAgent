import { createHash } from "node:crypto"

type Kind = "model" | "result-tool"
type State = "open" | "closing" | "sealed" | "failed"
interface Call {
  sequence: number
  kind: Kind
  requestDigest: string
  state: "running" | "settled" | "unknown"
}
declare const drainedBrand: unique symbol
export interface PromptCallDrainToken {
  readonly [drainedBrand]: true
}
export interface PromptCallDrainReceipt {
  readonly coverage: "admitted-call-drain-only"
  readonly calls: readonly Readonly<Call>[]
  readonly digest: string
}
const receipts = new WeakMap<PromptCallDrainToken, PromptCallDrainReceipt>()

/** This proves only admission/drain, never actual graph capability closure or provider identity. */
export function readPromptCallDrainReceipt(token: unknown): PromptCallDrainReceipt | undefined {
  return token !== null && typeof token === "object"
    ? receipts.get(token as PromptCallDrainToken)
    : undefined
}

export function createPromptCallAdmission(input: {
  signal: AbortSignal
  deadline: number
  maxCalls: number
  assertCurrent(): void
}) {
  if (
    !Number.isSafeInteger(input.deadline) ||
    !Number.isSafeInteger(input.maxCalls) ||
    input.maxCalls < 1 ||
    input.maxCalls > 128
  )
    throw Error("FLOW_PROMPT_ADMISSION_LIMIT")
  const controller = new AbortController()
  const calls: Call[] = []
  let state: State = "open"
  const readState = (): State => state
  let active = 0
  let sealing: Promise<PromptCallDrainToken> | undefined
  let resolveDrained: (() => void) | undefined
  let rejectStopped: ((reason: unknown) => void) | undefined
  const drained = new Promise<void>((resolve) => {
    resolveDrained = resolve
  })
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectStopped = reject
  })
  // Abort may precede seal; retain the rejection without creating an unhandled promise.
  void stopped.catch(() => undefined)
  const timer: { value?: ReturnType<typeof setTimeout> } = {}
  function onAbort() {
    fail(input.signal.reason ?? Error("FLOW_PROMPT_ABORTED"))
  }
  const cleanup = () => {
    if (timer.value !== undefined) clearTimeout(timer.value)
    input.signal.removeEventListener("abort", onAbort)
  }
  const fail = (reason: unknown) => {
    if (state === "sealed" || state === "failed") return
    state = "failed"
    controller.abort(reason)
    rejectStopped!(reason)
    cleanup()
  }
  input.signal.addEventListener("abort", onAbort, { once: true })
  const remaining = input.deadline - Date.now()
  timer.value = setTimeout(
    () => fail(Error("FLOW_PROMPT_DEADLINE")),
    Math.max(0, Math.min(remaining, 2_147_483_647))
  )
  const assertCurrent = () => {
    try {
      input.signal.throwIfAborted()
      if (Date.now() >= input.deadline) throw Error("FLOW_PROMPT_DEADLINE")
      if (state === "failed") throw Error("FLOW_PROMPT_CALL_UNKNOWN")
      input.assertCurrent()
      // An authority callback is an observable boundary, not a cached authorization.
      input.signal.throwIfAborted()
      if (Date.now() >= input.deadline || readState() === "failed")
        throw Error("FLOW_PROMPT_CALL_UNKNOWN")
    } catch (error) {
      fail(error)
      throw error
    }
  }
  if (input.signal.aborted) onAbort()
  return Object.freeze({
    signal: controller.signal,
    async run<T>(
      kind: Kind,
      requestDigest: string,
      invoke: (signal: AbortSignal) => Promise<T>
    ): Promise<T> {
      if (state !== "open") throw Error("FLOW_PROMPT_ADMISSION_CLOSED")
      assertCurrent()
      // Recheck after callbacks: reentrant seal must fence this call before invocation.
      if (state !== "open") throw Error("FLOW_PROMPT_ADMISSION_CLOSED")
      if (
        !/^[a-f0-9]{64}$/.test(requestDigest) ||
        !["model", "result-tool"].includes(kind) ||
        calls.length >= input.maxCalls
      ) {
        const error = Error("FLOW_PROMPT_ADMISSION_LIMIT")
        fail(error)
        throw error
      }
      const call: Call = { sequence: calls.length, kind, requestDigest, state: "running" }
      calls.push(call)
      active++
      try {
        const result = await invoke(controller.signal)
        assertCurrent()
        call.state = "settled"
        return result
      } catch (error) {
        call.state = "unknown"
        fail(error)
        throw error
      } finally {
        active--
        if (active === 0 && readState() === "closing") resolveDrained!()
      }
    },
    seal(): Promise<PromptCallDrainToken> {
      if (sealing) return sealing
      if (state !== "open") return Promise.reject(Error("FLOW_PROMPT_CALL_UNKNOWN"))
      state = "closing"
      if (active === 0) resolveDrained!()
      sealing = (async () => {
        try {
          await Promise.race([drained, stopped])
          assertCurrent()
          if (active !== 0 || calls.some((call) => call.state !== "settled"))
            throw Error("FLOW_PROMPT_CALL_UNKNOWN")
          const facts = calls.map((call) => Object.freeze({ ...call }))
          const token = Object.freeze({}) as PromptCallDrainToken
          receipts.set(
            token,
            Object.freeze({
              coverage: "admitted-call-drain-only",
              calls: Object.freeze(facts),
              digest: createHash("sha256").update(JSON.stringify(facts)).digest("hex")
            })
          )
          state = "sealed"
          return token
        } catch (error) {
          fail(error)
          throw error
        } finally {
          cleanup()
        }
      })()
      return sealing
    },
    dispose(): void {
      fail(Error("FLOW_PROMPT_DISPOSED"))
      cleanup()
    }
  })
}
