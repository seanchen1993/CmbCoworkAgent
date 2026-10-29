import { IterableReadableStream } from "@langchain/core/utils/stream"
import type { RunnableConfig } from "@langchain/core/runnables"
import { types } from "node:util"
import { measureHostRuntimeSync, measureHostRuntimeAsync } from "../services/host-runtime-timing"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { FUNCTION_STREAM_TERMINAL } from "../mods/v2/host-stream-lifetime"
import { filterModData } from "../mods/publication"
import { FUNCTION_CONVERSATION_CHANNEL } from "../checkpointer/function-conversation-delivery"
import type { FunctionConversationSharedCheckpointOpeningCurrent } from
  "../mods/v2/conversation-shared-checkpointer"
import { createFunctionConversationNativeSourceLifetimeFromInstallation,
  type FunctionConversationNativeSourceObserverInstallation,
  type FunctionConversationNativeStreamShape } from "./function-conversation-native-lifetime"
import { isSharedNativeDomainCurrent, readSharedNativeDomainCleanupView,
  type SharedNativeDomainRecord, type FunctionConversationSharedNativeDomainView } from
  "./function-conversation-shared-native-domain"

type Lifetime = ReturnType<typeof createFunctionConversationNativeSourceLifetimeFromInstallation>
type Next = IteratorResult<unknown>
interface Demand { resolve(value: Next): void; reject(reason: unknown): void }
export interface SharedNativeRoutedFrame {
  readonly value: unknown
  assertCurrent(): void
}
export interface SharedNativeStreamDriver {
  readonly stream: IterableReadableStream<unknown>
  readonly signal: AbortSignal
  readonly completion: Promise<void>
  open(): Promise<IterableReadableStream<unknown>>
  attach(domain: SharedNativeDomainRecord, opening: FunctionConversationSharedCheckpointOpeningCurrent,
    installation: FunctionConversationNativeSourceObserverInstallation, config: RunnableConfig): RunnableConfig
  consume(start: () => unknown | Promise<unknown>, route: (value: unknown,
    lifetime: Lifetime, view: FunctionConversationSharedNativeDomainView) => SharedNativeRoutedFrame[]): Promise<void>
}
const drivers = new WeakMap<SharedNativeDomainRecord, { admit(): void }>()

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  // A caller can return during opening before anyone awaits these results.
  void promise.catch(() => undefined)
  return { promise, resolve, reject }
}
function fail(): never { throw new ModFunctionError("MODS_CONVERSATION_NATIVE_STREAM_UNAVAILABLE") }

/** Notification at the end of the original successful Saver/Host/Tools admission only. */
export function notifySharedNativeStreamAdmission(domain: SharedNativeDomainRecord): void {
  drivers.get(domain)?.admit()
}

/** Only data is projected here; an event never creates a native message or tool permission. */
export function projectSharedNativeStreamEvent(value: unknown,
  view: FunctionConversationSharedNativeDomainView, lifetime: Lifetime): unknown {
  if (!value || typeof value !== "object" || types.isProxy(value)) fail()
  const event = value as Record<string, unknown>, data = event.data
  let selected = value
  if (event.event === "on_chat_model_stream" && data && typeof data === "object") {
    const chunk = Object.getOwnPropertyDescriptor(data, "chunk")
    if (chunk && "value" in chunk) {
      const projected = lifetime.run(() => view.host.message([chunk.value, event.metadata]))
      selected = { ...event, data: { ...data, chunk: projected === undefined ? null :
        Array.isArray(projected) ? projected[0] : projected } }
    }
  }
  let nodes = 30_000
  const seen = new Set<object>()
  const strip = (input: unknown, depth = 0): unknown => {
    if (--nodes < 0 || depth > 32) throw new ModFunctionError("MODS_OUTPUT_LIMIT")
    if (!input || typeof input !== "object") return input
    if (types.isProxy(input) || seen.has(input)) fail()
    if (ArrayBuffer.isView(input) || input instanceof ArrayBuffer) return input
    seen.add(input)
    try {
      if (Array.isArray(input)) return input.map(item => strip(item, depth + 1))
      const result: Record<string, unknown> = {}
      for (const key of Object.keys(input)) {
        if (key === FUNCTION_CONVERSATION_CHANNEL ||
          ["__proto__", "constructor", "prototype"].includes(key)) continue
        const field = Object.getOwnPropertyDescriptor(input, key)
        if (!field || !("value" in field)) fail()
        if (field.value !== undefined) result[key] = strip(field.value, depth + 1)
      }
      return result
    } finally { seen.delete(input) }
  }
  view.assertCurrent()
  const policy = view.runtime.capturePolicy()
  policy.assertCurrent()
  const result = filterModData(strip(selected), policy.value.protected)
  const redact = (input: typeof result): typeof result => {
    if (typeof input === "string") {
      for (const literal of policy.value.deployment.redactLiterals)
        input = input.split(literal).join("[REDACTED]")
      return input
    }
    if (Array.isArray(input)) return input.map(redact)
    if (input && typeof input === "object")
      return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, redact(item)]))
    return input
  }
  const safe = policy.value.protected ? redact(result) : result
  policy.assertCurrent()
  view.assertDataCurrent()
  return safe
}

/** One Scope callback drives this iterator until its original finally has settled. */
export function createSharedNativeStreamDriver(mode: "stream" | "events",
  run: (driver: SharedNativeStreamDriver) => Promise<void>): SharedNativeStreamDriver {
  const cut = new AbortController(), opened = deferred<IterableReadableStream<unknown>>()
  const completed = deferred<void>(), ready = deferred<void>()
  let changed = deferred<void>(), started = false, stopped = false, returned = false
  let terminal = false, readableClosed = false, demand: Demand | undefined
  let controller: ReadableStreamDefaultController<unknown> | undefined
  let lifetime: Lifetime | undefined, opening: FunctionConversationSharedCheckpointOpeningCurrent | undefined
  let domain: SharedNativeDomainRecord | undefined, view: FunctionConversationSharedNativeDomainView | undefined
  let signal = cut.signal, failed = false, failure: unknown
  const frames: SharedNativeRoutedFrame[] = []
  const wake = () => { const previous = changed; changed = deferred<void>(); previous.resolve() }
  const guard = () => measureHostRuntimeSync("streamGuard", () => {
    if (!opening || !domain) fail()
    signal.throwIfAborted()
    if (stopped) fail()
    opening.assertCurrent()
    if (!isSharedNativeDomainCurrent(domain)) fail()
    if (view) { view.assertCurrent(); view.assertDataCurrent() }
  })
  const stop = (reason: unknown, isReturn: boolean) => {
    returned ||= isReturn
    stopped = true
    if (!cut.signal.aborted) cut.abort(reason ?? new DOMException("Shared stream closed", "AbortError"))
    ready.resolve()
    wake()
    if (!started) {
      terminal = true
      opened.reject(cut.signal.reason)
      completed.resolve()
      readableClosed = true
      controller?.close()
    }
  }
  const onAbort = () => {
    stop(signal.reason, false)
  }
  const finish = (error?: { reason: unknown }) => {
    if (terminal) return
    terminal = true
    if (error) {
      failed = true; failure = error.reason
      opened.reject(error.reason)
      demand?.reject(error.reason)
      completed.reject(error.reason)
      if (!readableClosed) { readableClosed = true; controller?.error(error.reason) }
    } else {
      demand?.resolve({ done: true, value: undefined })
      completed.resolve()
      if (!readableClosed) { readableClosed = true; controller?.close() }
    }
    demand = undefined
    signal.removeEventListener("abort", onAbort)
    if (domain) drivers.delete(domain)
    wake()
  }
  const open = () => {
    if (!started && !stopped) {
      started = true
      void Promise.resolve().then(() => run(driver)).then(() => finish(), reason => finish({ reason }))
    }
    return opened.promise
  }
  class SharedStream extends IterableReadableStream<unknown> {
    readonly [FUNCTION_STREAM_TERMINAL] = completed.promise
    constructor() {
      super({ start(output) { controller = output },
        async pull(output) {
          if (terminal) { if (failed) throw failure; return }
          const next = deferred<Next>()
          demand = next
          wake()
          void open().catch(() => undefined)
          const result = await next.promise
          if (!result.done && !stopped) output.enqueue(result.value)
        },
        async cancel(reason) { readableClosed = true; stop(reason, true); await completed.promise }
      }, { highWaterMark: 0 })
    }
    override async cancel(reason?: unknown): Promise<void> {
      stop(reason, true)
      await completed.promise
      if (!terminal) controller?.close()
    }
    override async return(): Promise<Next> {
      stop(undefined, true)
      try { await completed.promise }
      finally { this.reader?.releaseLock() }
      return { done: true, value: undefined }
    }
    override async throw(reason: unknown): Promise<Next> {
      stop(reason, true)
      try { await completed.promise }
      finally { this.reader?.releaseLock() }
      throw reason
    }
  }
  const stream = new SharedStream()
  const driver: SharedNativeStreamDriver = {
    stream, signal: cut.signal, completion: completed.promise, open,
    attach(actual, current, installation, config) {
      if (domain || stopped) fail()
      domain = actual; opening = current
      signal = AbortSignal.any([cut.signal, current.signal, current.controllerSignal,
        ...(config.signal ? [config.signal] : [])])
      signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) onAbort()
      guard()
      lifetime = createFunctionConversationNativeSourceLifetimeFromInstallation(installation, guard)
      drivers.set(actual, { admit() {
        if (view || stopped || !isSharedNativeDomainCurrent(actual) || actual.phase !== "ready") fail()
        const admitted = readSharedNativeDomainCleanupView(actual)
        if (!admitted) fail()
        admitted.assertDataCurrent()
        view = admitted
        ready.resolve()
        wake()
      } })
      let configurable = config.configurable
      const inherited = configurable && Object.getOwnPropertyDescriptor(configurable,
        "__pregel_abort_signals")
      if (inherited) {
        if (!("value" in inherited)) fail()
        const marker: unknown = inherited.value
        if (marker !== undefined && marker !== null) {
          if (typeof marker !== "object" || types.isProxy(marker) ||
            ![Object.prototype, null].includes(Object.getPrototypeOf(marker))) fail()
          const fields = Object.getOwnPropertyDescriptors(marker)
          for (const field of Object.values(fields)) if (!("value" in field)) fail()
          const external = fields.externalAbortSignal
          const parent: unknown = external?.value
          if (parent !== undefined && (types.isProxy(parent) || !(parent instanceof AbortSignal))) fail()
          // Pregel prefers this inherited marker over the top-level signal when it
          // creates node signals. Keep the parent marker intact and include this call's cut.
          fields.externalAbortSignal = { ...(external ?? { enumerable: true,
            writable: true, configurable: true }),
            value: parent ? AbortSignal.any([parent as AbortSignal, signal]) : signal }
          const copied = Object.create(Object.getPrototypeOf(marker), fields) as object
          configurable = { ...configurable, __pregel_abort_signals: copied }
        }
      }
      return { ...config, configurable, signal }
    },
    async consume(start, route) {
      if (!lifetime || !opening || !domain) fail()
      const source = lifetime
      let iterator: AsyncIterator<unknown> | undefined, ended = false, next: Promise<Next> | undefined
      let caught: { reason: unknown } | undefined
      let preludeBytes = 0
      const prelude: unknown[] = []
      const requestedCancellation = (reason: unknown): boolean => {
        if (!returned || !cut.signal.aborted || reason === undefined) return false
        const seen = new Set<object>()
        while (true) {
          if (reason === cut.signal.reason) return true
          if (!reason || typeof reason !== "object" || types.isProxy(reason) || seen.has(reason)) return false
          seen.add(reason)
          const cause = Object.getOwnPropertyDescriptor(reason, "cause")
          if (!cause || !("value" in cause)) return false
          reason = cause.value
        }
      }
      try {
        guard()
        const actual: unknown = await source.run(start)
        if (!actual || typeof (actual as AsyncIterable<unknown>)[Symbol.asyncIterator] !== "function") fail()
        iterator = (actual as AsyncIterable<unknown>)[Symbol.asyncIterator]()
        opened.resolve(stream)
        if (mode === "stream") source.finishOpening()
        while (!stopped) {
          if (view && prelude.length) {
            guard()
            const buffered = prelude.splice(0)
            for (const frame of buffered) frames.push(...route(frame, source, view))
            source.finishOpening()
          }
          if (view && demand && frames.length) {
            guard()
            const frame = frames.shift()
            if (!frame) fail()
            measureHostRuntimeSync("streamFrame", () => frame.assertCurrent())
            const waiting = demand
            demand = undefined
            waiting.resolve({ done: false, value: frame.value })
            continue
          }
          if (view && !demand) { await changed.promise; continue }
          if (!next) {
            next = measureHostRuntimeAsync("streamPull", () =>
              Promise.resolve(source.run(() => iterator!.next())))
            void next.catch(() => undefined)
          }
          const selected = mode === "events" && !view
            ? await Promise.race([next.then(item => ({ item })), ready.promise.then(() => ({ ready: true }))])
            : { item: await next }
          if ("ready" in selected) continue
          next = undefined
          if (stopped) break
          const item = selected.item
          if (item.done) {
            ended = true
            if (!view) fail()
            guard()
            break
          }
          if (mode === "events" && !view) {
            // Continue consuming prelude callback writes so they cannot prevent admission.
            const size = Buffer.byteLength(JSON.stringify(filterModData(item.value, false)), "utf8")
            if (prelude.length >= 256 || (preludeBytes += size) > 1024 * 1024)
              throw new ModFunctionError("MODS_OUTPUT_LIMIT")
            prelude.push(item.value)
            continue
          }
          guard()
          if (!view) fail()
          if (mode === "events") {
            source.finishOpening()
            frames.push(...route(item.value, source, view))
          } else frames.push(...route(item.value, source, view))
        }
      } catch (reason) {
        if (!requestedCancellation(reason)) caught = { reason }
        if (!cut.signal.aborted) cut.abort(reason)
      } finally {
        source.finishOpening()
        try {
          if (iterator && !ended) {
            if (next) {
              try { ended = (await next).done === true }
              catch (reason) {
                ended = true
                if (!requestedCancellation(reason)) caught ??= { reason }
              }
            }
            if (!ended && mode === "events") {
              // Keep draining the event writer until SDK finally awaits its actual background run.
              while (!(await source.run(() => iterator!.next())).done) { /* Cleanup only. */ }
            } else if (!ended && iterator.return) {
              let item = await source.run(() => iterator!.return!())
              while (!item.done) item = await source.run(() => iterator!.next())
            }
          }
        } catch (reason) { if (!requestedCancellation(reason)) caught ??= { reason } }
        const cleanup = await Promise.allSettled([source.drain(), source.whenSettled()])
        // Observe both actual terminal paths even when the first cleanup rejects.
        for (const result of cleanup) if (result.status === "rejected")
          caught ??= { reason: result.reason }
      }
      if (caught) throw caught.reason
      if (!returned) {
        guard()
        if (frames.length) {
          // Flush accepted frames before resolving the whole Scope callback.
          while (frames.length && !stopped) {
            if (!demand) { await changed.promise; continue }
            guard()
            const frame = frames.shift()
            if (!frame) fail()
            measureHostRuntimeSync("streamFrame", () => frame.assertCurrent())
            const waiting = demand; demand = undefined
            waiting.resolve({ done: false, value: frame.value })
          }
        }
      }
    }
  }
  return driver
}

/** The same native frame shape/routing used by the existing Main invocation. */
export function routeSharedNativeStreamFrame(value: unknown, lifetime: Lifetime,
  view: FunctionConversationSharedNativeDomainView,
  copy: (mode: string, payload: unknown) => unknown): SharedNativeRoutedFrame[] {
  const requested = lifetime.shape(), actual = lifetime.actualShape()
  if (!requested || !actual) fail()
  const array = (input: unknown): readonly unknown[] => {
    if (!Array.isArray(input) || types.isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype) fail()
    const length = Object.getOwnPropertyDescriptor(input, "length")
    if (!length || !("value" in length) || !Number.isSafeInteger(length.value) ||
      length.value < 0 || length.value > 1_000_000 || Reflect.ownKeys(input).length !== length.value + 1) fail()
    const result: unknown[] = []
    for (let index = 0; index < length.value; index++) {
      const field = Object.getOwnPropertyDescriptor(input, String(index))
      if (!field || !("value" in field) || !field.enumerable) fail()
      result.push(field.value)
    }
    return result
  }
  const decode = (frame: unknown, shape: FunctionConversationNativeStreamShape) => {
    let payload = frame, namespace: unknown, mode = shape.modes[0]
    if (shape.multiple || shape.subgraphs) {
      const values = array(frame)
      const position = shape.subgraphs ? 1 : 0
      if (shape.subgraphs) {
        const parts = array(values[0])
        if (parts.some(part => typeof part !== "string")) fail()
        namespace = parts
      }
      if (shape.multiple) {
        const selected = values[position]
        if (typeof selected !== "string" || !shape.modes.includes(selected)) fail()
        mode = selected
        payload = values[position + 1]
        if (values.length !== position + 2) fail()
      } else {
        if (values.length !== 2 || shape.modes.length !== 1) fail()
        payload = values[1]
      }
    }
    if (typeof mode !== "string" || !shape.modes.includes(mode)) fail()
    if (mode === "messages") {
      const tuple = array(payload)
      if (tuple.length !== 2) fail()
      payload = tuple
    }
    return { mode, payload, namespace }
  }
  const frame = decode(value, actual), output: SharedNativeRoutedFrame[] = []
  const append = (mode: string, payload: unknown, namespace = frame.namespace) => {
    const projected = mode === "messages" ? lifetime.run(() => view.host.message(payload)) : copy(mode, payload)
    if (mode === "messages" && projected === undefined) return
    view.host.validate(mode, mode === "messages" ? projected : payload)
    if (mode === "messages" && !lifetime.acceptMessage(projected)) return
    const validate = () => {
      view.host.validate(mode, mode === "messages" ? projected : payload)
      view.assertDataCurrent()
    }
    output.push({ value: requested.subgraphs ? requested.multiple ? [namespace, mode, projected] : [namespace, projected]
      : requested.multiple ? [mode, projected] : projected, assertCurrent: validate })
  }
  if (frame.mode === "updates" && requested.modes.includes("messages"))
    for (const completion of lifetime.completions(frame.payload))
      append("messages", [completion.message, completion.metadata], completion.namespace)
  if (requested.modes.includes(frame.mode)) append(frame.mode, frame.payload)
  return output
}
