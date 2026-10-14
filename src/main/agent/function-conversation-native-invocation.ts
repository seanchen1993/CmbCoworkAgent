import { IterableReadableStream } from "@langchain/core/utils/stream"
import { types } from "node:util"
import { setTimeout as yieldToEventLoop } from "node:timers/promises"
import type { RunnableConfig } from "@langchain/core/runnables"
import type { FunctionNativeConversationRuntime } from "../mods/manager"
import { FUNCTION_STREAM_TERMINAL } from "../mods/v2/host-stream-lifetime"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { createFunctionConversationNativeSourceLifetime,
  type FunctionConversationNativeStreamShape, type FunctionNativeStreamDiagnostic,
  type FunctionConversationNativeSseSource } from "./function-conversation-native-lifetime"
import type { FunctionNativeProtectedDiagnostic } from "./native-sse-diagnostic"
import { encodeFunctionConversationNativeSse } from "./native-conversation-sse"
import { assertFunctionConversationNativeHostInstallation,
  readFunctionConversationNativeDerivedInstallation, readFunctionNativeSseDeferredPartial,
  readFunctionNativeSsePartialOmission, type FunctionNativeSseDeferredPartial,
  type FunctionNativeSsePartialOmission } from
  "./function-conversation-native-host"
import { readFunctionConversationNativeAgentDerivation,
  readFunctionConversationNativeStandardCancellationSignal } from "./native-agent-factory"
import { readFunctionConversationInvocationDerivation } from "./mods-conversation-invocation"

export interface FunctionConversationNativeInvocationHost {
  configure<T extends RunnableConfig>(config: T): T
  message(value: unknown): unknown | undefined
  validate(mode: string, value: unknown): void
  retainInput?(input: unknown, config: RunnableConfig): Promise<unknown>
  prepareSseDiagnostic?(token: FunctionNativeStreamDiagnostic): Promise<FunctionNativeProtectedDiagnostic>
  deferCompletedSsePartial?(token: FunctionNativeStreamDiagnostic,
    receipt?: FunctionNativeProtectedDiagnostic, projectedTuple?: readonly unknown[]):
    FunctionNativeSseDeferredPartial | undefined
  confirmSsePartialOmissions?(source: FunctionConversationNativeSseSource, finished?: boolean):
    readonly FunctionNativeSsePartialOmission[]
  closeSseDiagnosticSource?(source: FunctionConversationNativeSseSource): void
  whenDrained(): Promise<void>
}

interface Config extends RunnableConfig {
  streamMode?: string | readonly string[]
  subgraphs?: boolean
  encoding?: string
}

type Lifetime = ReturnType<typeof createFunctionConversationNativeSourceLifetime>
interface RoutedFrame {
  readonly value: unknown
  readonly diagnostic?: FunctionNativeStreamDiagnostic
}
type PreparedFrame = { readonly kind: "protected"; readonly receipt?: FunctionNativeProtectedDiagnostic }
  | { readonly kind: "deferred"; readonly token: FunctionNativeSseDeferredPartial }
const throwIfAborted = AbortSignal.prototype.throwIfAborted
const nativeSignalAny = AbortSignal.any

function fail(): never {
  throw new ModFunctionError("MODS_CONVERSATION_NATIVE_STREAM_UNAVAILABLE")
}

function frameValues(value: unknown): readonly unknown[] {
  if (!value || typeof value !== "object" || types.isProxy(value) || !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype) fail()
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>
  const length = descriptors.length
  if (!length || !("value" in length) || typeof length.value !== "number" ||
    !Number.isSafeInteger(length.value) || length.value < 0 || length.value > 1_000_000 ||
    Reflect.ownKeys(descriptors).length !== length.value + 1) fail()
  const values: unknown[] = []
  for (let index = 0; index < length.value; index++) {
    const field = descriptors[String(index)]
    if (!field || !("value" in field) || !field.enumerable) fail()
    values.push(field.value)
  }
  return values
}

function decode(value: unknown, shape: FunctionConversationNativeStreamShape):
  { mode: string; payload: unknown; namespace?: readonly string[] } {
  let mode: string, payload: unknown, namespace: readonly string[] | undefined
  if (shape.multiple || shape.subgraphs) {
    const frame = frameValues(value)
    const position = shape.subgraphs ? 1 : 0
    if (shape.subgraphs) {
      const parts = frameValues(frame[0])
      if (parts.some(part => typeof part !== "string")) fail()
      namespace = parts as readonly string[]
    }
    if (shape.multiple) {
      const selected = frame[position]
      if (typeof selected !== "string" || !shape.modes.includes(selected)) fail()
      mode = selected
      payload = frame[position + 1]
      if (frame.length !== position + 2) fail()
    } else {
      if (frame.length !== 2 || shape.modes.length !== 1) fail()
      mode = shape.modes[0]
      payload = frame[1]
    }
  } else {
    if (shape.modes.length !== 1) fail()
    mode = shape.modes[0]
    payload = value
  }
  if (mode === "messages") {
    const tuple = frameValues(payload)
    if (tuple.length !== 2) fail()
    payload = tuple
  }
  return { mode, payload, namespace }
}

function route(value: unknown, lifetime: Lifetime,
  host: FunctionConversationNativeInvocationHost): RoutedFrame[] {
  const requested = lifetime.shape(), actual = lifetime.actualShape()
  if (!requested || !actual) fail()
  const frame = decode(value, actual), output: RoutedFrame[] = []
  const append = (mode: string, payload: unknown, namespace = frame.namespace,
    diagnostic?: FunctionNativeStreamDiagnostic) => {
    const projected = mode === "messages" ? lifetime.run(() => host.message(payload)) : payload
    if (projected === undefined && mode === "messages") return
    host.validate(mode, projected)
    if (mode === "messages" && !lifetime.acceptMessage(projected)) return
    if (requested.subgraphs) {
      if (!namespace) fail()
      output.push({ value: requested.multiple ? [namespace, mode, projected]
        : [namespace, projected], ...(diagnostic ? { diagnostic } : {}) })
    } else output.push({ value: requested.multiple ? [mode, projected] : projected,
      ...(diagnostic ? { diagnostic } : {}) })
  }
  if (frame.mode === "updates" && requested.modes.includes("messages")) {
    // Exact accepted replacements only; history, public stamps and equal IDs cannot mint a frame.
    for (const completion of lifetime.completions(frame.payload)) {
      const tuple = [completion.message, completion.metadata]
      const token = lifetime.completionDiagnostic(completion, tuple)
      append("messages", tuple, completion.namespace, token)
    }
  }
  if (requested.modes.includes(frame.mode)) append(frame.mode, frame.payload, frame.namespace,
    lifetime.diagnostic(value))
  return output
}

/** Keep ReactAgent's defaults/private receiver; native output is inspected before any consumer JSON. */
export function wrapFunctionConversationNativeInvocation<T extends object>(
  graph: T, host: FunctionConversationNativeInvocationHost,
  runtime: Pick<FunctionNativeConversationRuntime, "signal" | "assertCurrent">,
  expectedNativeGraph?: object
): T {
  const derivation = readFunctionConversationInvocationDerivation(graph) ??
    readFunctionConversationNativeAgentDerivation(graph)
  const nativeGraph = derivation?.graph ?? Reflect.get(graph, "graph", graph) as unknown
  if (!nativeGraph || typeof nativeGraph !== "object" ||
    (expectedNativeGraph && nativeGraph !== expectedNativeGraph)) fail()
  const methods = new Map<PropertyKey, unknown>()
  const capture = (config: Config, streaming = false) => {
    assertFunctionConversationNativeHostInstallation(host, nativeGraph, runtime)
    const installation = derivation &&
      readFunctionConversationNativeDerivedInstallation(host, nativeGraph, runtime)
    config = derivation?.resolve(config) ?? config
    if (config.encoding !== undefined &&
      (!streaming || config.encoding !== "text/event-stream")) fail()
    // The known factory's fixed data flag cannot replace the actual Host/graph/runtime join.
    if (derivation?.hasDefaultCancellation && !installation) fail()
    let cut: AbortController, originalSignal: AbortSignal
    if (installation) {
      if (types.isProxy(runtime) || types.isProxy(config)) fail()
      const runtimeField = Object.getOwnPropertyDescriptor(runtime, "signal")
      const callField = Object.getOwnPropertyDescriptor(config, "signal")
      if (!runtimeField || !("value" in runtimeField) || callField && !("value" in callField)) fail()
      cut = new AbortController()
      const cutSignal = cut.signal
      const runtimeSignal = readFunctionConversationNativeStandardCancellationSignal(runtimeField.value)
      const callSignal = readFunctionConversationNativeStandardCancellationSignal(callField?.value)
      if (!runtimeSignal) fail()
      const check = () => {
        if (types.isProxy(runtime) || types.isProxy(config)) fail()
        const currentRuntime = Object.getOwnPropertyDescriptor(runtime, "signal")
        const currentCall = Object.getOwnPropertyDescriptor(config, "signal")
        if (!sameSignalField(currentRuntime, runtimeField) ||
          (callField ? !sameSignalField(currentCall, callField) : currentCall !== undefined)) fail()
        readFunctionConversationNativeStandardCancellationSignal(cutSignal)
        readFunctionConversationNativeStandardCancellationSignal(runtimeSignal)
        if (callSignal) readFunctionConversationNativeStandardCancellationSignal(callSignal)
        if (!readFunctionConversationNativeDerivedInstallation(host, nativeGraph, runtime)) fail()
      }
      readFunctionConversationNativeStandardCancellationSignal(cutSignal)
      runtime.assertCurrent()
      check()
      originalSignal = Reflect.apply(nativeSignalAny, AbortSignal,
        [callSignal ? [cutSignal, runtimeSignal, callSignal] : [cutSignal, runtimeSignal]]) as AbortSignal
      check()
      readFunctionConversationNativeStandardCancellationSignal(originalSignal)
    } else {
      // Generic callers retain the original combination and guard ordering.
      runtime.assertCurrent()
      cut = new AbortController()
      originalSignal = AbortSignal.any([cut.signal, runtime.signal,
        ...(config.signal ? [config.signal] : [])])
    }
    const signal = installation ? derivation!.resolveCancellation(originalSignal) : originalSignal
    const assertCurrent = () => {
      assertFunctionConversationNativeHostInstallation(host, nativeGraph, runtime)
      if (installation) Reflect.apply(throwIfAborted, signal, [])
      else signal.throwIfAborted()
      runtime.assertCurrent()
      assertFunctionConversationNativeHostInstallation(host, nativeGraph, runtime)
    }
    assertCurrent()
    const lifetime = createFunctionConversationNativeSourceLifetime(nativeGraph, assertCurrent,
      { runtime, signal })
    const configured = host.configure({ ...config, configurable: { ...config.configurable }, signal })
    if (configured.signal !== signal) fail()
    assertCurrent()
    const terminal = lifetime.whenSettled().then(() => host.whenDrained())
    void terminal.catch(() => undefined)
    return { cut, signal, assertCurrent, lifetime, configured, terminal }
  }
  return new Proxy(graph, {
    get(target, key) {
      if (key === "withConfig") {
        if (!methods.has(key)) methods.set(key, (config: RunnableConfig) => {
          const installation = readFunctionConversationNativeDerivedInstallation(host, nativeGraph, runtime)
          if (!derivation || !installation) fail()
          const operation = installation.begin()
          try {
            operation.assertCurrent()
            derivation.assertStructure()
            const derived = derivation.deriveCancellation(config)
            const child = readFunctionConversationInvocationDerivation(derived) ??
              readFunctionConversationNativeAgentDerivation(derived)
            if (!child) fail()
            child.assertStructure()
            operation.install(child.graph)
            operation.assertCurrent()
            derivation.assertStructure()
            child.assertStructure()
            const wrapped = wrapFunctionConversationNativeInvocation(derived, host, runtime, child.graph)
            operation.publish(child.graph)
            return wrapped
          } finally { operation.dispose() }
        })
        return methods.get(key)
      }
      const value = Reflect.get(target, key, target) as unknown
      if (typeof value !== "function") return value
      if (methods.has(key)) return methods.get(key)
      const call = (input: unknown, config: Config, ...rest: unknown[]): unknown =>
        Reflect.apply(value, target, [input, config, ...rest])
      if (key === "streamEvents") methods.set(key, () => fail())
      else if (key === "invoke") methods.set(key,
        async (input: unknown, config: Config = {}, ...rest: unknown[]) => {
          const captured = capture(config)
          let failure: { error: unknown } | undefined
          let output: unknown
          try {
            const result: unknown = await captured.lifetime.run(async () => {
              const prepared = host.retainInput
                ? await host.retainInput(input, captured.configured) : input
              captured.assertCurrent()
              return call(prepared, captured.configured, ...rest)
            })
            captured.assertCurrent()
            const shape = captured.lifetime.shape()
            if (!shape) fail()
            if (!shape.multiple && shape.modes[0] === "values") {
              const routed = route(result, captured.lifetime, host)
              if (routed.length !== 1) fail()
              output = routed[0].value
            } else {
              if (!Array.isArray(result)) fail()
              output = result.flatMap(item => route(item, captured.lifetime, host).map(frame => frame.value))
            }
            captured.assertCurrent()
          } catch (error) {
            failure = { error }
            captured.cut.abort(error)
          }
          captured.lifetime.finishOpening()
          if (failure) {
            try { await captured.lifetime.drain() } catch { /* Preserve the invocation error. */ }
          }
          // A routed-output error or cancellation cannot outrun the original graph/keeper.
          try { await captured.terminal }
          catch (error) { failure ??= { error } }
          if (failure) throw failure.error
          captured.assertCurrent()
          return output
        })
      else if (key === "stream") methods.set(key,
        async (input: unknown, config: Config = {}, ...rest: unknown[]) => {
          const captured = capture(config, true)
          let actual: AsyncIterable<unknown>
          try {
            const opened: unknown = await captured.lifetime.run(async () => {
              const prepared = host.retainInput
                ? await host.retainInput(input, captured.configured) : input
              captured.assertCurrent()
              return call(prepared, captured.configured, ...rest)
            })
            if (!opened || typeof (opened as AsyncIterable<unknown>)[Symbol.asyncIterator] !== "function")
              fail()
            actual = opened as AsyncIterable<unknown>
            if (!captured.lifetime.shape()) fail()
            captured.assertCurrent()
          } catch (error) {
            captured.cut.abort(error)
            captured.lifetime.finishOpening()
            try { await captured.lifetime.drain() } catch { /* Preserve the opening failure. */ }
            try { await captured.terminal } catch { /* Preserve the original opening failure. */ }
            throw error
          }
          captured.lifetime.finishOpening()
          const inner = actual[Symbol.asyncIterator]()
          let controller: ReadableStreamDefaultController<unknown> | undefined
          let closed = false, ended = false, closing: Promise<void> | undefined
          const frames: RoutedFrame[] = []
          const deferPartial = (token: FunctionNativeStreamDiagnostic,
            receipt?: FunctionNativeProtectedDiagnostic, projectedTuple?: readonly unknown[]):
            FunctionNativeSseDeferredPartial | undefined => {
            if (!host.deferCompletedSsePartial) return undefined
            const source = captured.lifetime.sseSource()
            if (!source) fail()
            return captured.lifetime.run(() => {
              const pending = host.deferCompletedSsePartial!(token, receipt, projectedTuple)
              if (pending) readFunctionNativeSseDeferredPartial(pending, source)
              return pending
            })
          }
          const confirmOmissions = (finished = false) => {
            const source = captured.lifetime.sseSource()
            if (!source || !host.confirmSsePartialOmissions) return
            captured.lifetime.run(() => {
              const omissions = host.confirmSsePartialOmissions!(source, finished)
              for (const omission of omissions) readFunctionNativeSsePartialOmission(omission, source)
            })
          }
          const prepareDiagnostic = async (frame: RoutedFrame): Promise<PreparedFrame> => {
            if (captured.lifetime.encoding() !== "text/event-stream" || !host.prepareSseDiagnostic)
              return { kind: "protected" }
            const shape = captured.lifetime.shape()
            if (!shape) fail()
            const decoded = decode(frame.value, shape)
            if (decoded.mode !== "messages") return { kind: "protected" }
            if (!frame.diagnostic) fail()
            const tuple = decoded.payload as readonly unknown[]
            const before = deferPartial(frame.diagnostic, undefined, tuple)
            if (before) return { kind: "deferred", token: before }
            const receipt = await captured.lifetime.run(() =>
              host.prepareSseDiagnostic!(frame.diagnostic!))
            // Only this explicit await boundary can select a completed candidate. A failure
            // from the strict live reader is never caught or upgraded into an omission.
            const after = deferPartial(frame.diagnostic, receipt, tuple)
            return after ? { kind: "deferred", token: after } : { kind: "protected", receipt }
          }
          const encode = (frame: RoutedFrame,
            protectedDiagnostic?: FunctionNativeProtectedDiagnostic): unknown => {
            if (captured.lifetime.encoding() !== "text/event-stream") return frame.value
            const shape = captured.lifetime.shape()
            if (!shape) fail()
            const decoded = decode(frame.value, shape), diagnostic = frame.diagnostic
            return captured.lifetime.run(() => encodeFunctionConversationNativeSse(
              decoded.mode, decoded.payload, decoded.namespace, {
                signal: captured.signal, assertCurrent: captured.assertCurrent,
                message: value => host.message(value),
                ...(diagnostic && protectedDiagnostic ? { diagnostic, protectedDiagnostic } : {})
              }))
          }
          const cleanup = (): Promise<void> => {
            if (!closing) {
              closing = (async () => {
                let failure: { error: unknown } | undefined
                const source = captured.lifetime.sseSource()
                if (source) host.closeSseDiagnosticSource?.(source)
                // The framework shell can stop calling its raw generator after signal abort.
                // Drive only this captured invocation's real generators to their actual finally.
                const draining = captured.lifetime.drain()
                void draining.catch(() => undefined)
                try {
                  if (!ended && inner.return) {
                    let item = await inner.return()
                    while (!item.done) item = await inner.next()
                  }
                } catch (error) { failure = { error } }
                try { await draining } catch (error) { failure ??= { error } }
                try { await captured.terminal }
                catch (error) { failure ??= { error } }
                if (failure) throw failure.error
              })()
              void closing.catch(() => undefined)
            }
            return closing
          }
          const cancel = (reason: unknown, closeReadable: boolean): Promise<void> => {
            if (!closed) {
              closed = true
              if (closeReadable) controller?.close()
            }
            if (!captured.cut.signal.aborted)
              captured.cut.abort(reason ?? new DOMException("Native stream cancelled", "AbortError"))
            return cleanup()
          }
          const aborted = () => {
            const report = !closed
            closed = true
            void cleanup().then(() => {
              if (report) controller?.error(captured.signal.reason)
            }, () => { if (report) controller?.error(captured.signal.reason) })
          }
          class NativeStream extends IterableReadableStream<unknown> {
            readonly signal = captured.signal
            readonly [FUNCTION_STREAM_TERMINAL] = captured.terminal
            constructor() {
              super({
                start(output) {
                  controller = output
                  captured.signal.addEventListener("abort", aborted, { once: true })
                  if (captured.signal.aborted) aborted()
                },
                async pull(output) {
                  try {
                    while (!closed) {
                      // Buffered graph frames otherwise chain fulfilled promises without an
                      // event-loop turn, starving input/cancellation while terminal guards run.
                      // A timer turn allows pending event-loop work to compete between frames.
                      // Electron input latency is also covered by the packaged regression.
                      // Yield before any frame check; every original authority/data check still
                      // runs after resumption and validation through publication stays atomic.
                      await yieldToEventLoop(0)
                      if (closed) return
                      captured.assertCurrent()
                      if (frames.length) {
                        const frame = frames.shift()
                        if (!frame) fail()
                        const shape = captured.lifetime.shape()
                        if (!shape) fail()
                        const queued = decode(frame.value, shape)
                        host.validate(queued.mode, queued.payload)
                        captured.assertCurrent()
                        const prepared = await prepareDiagnostic(frame)
                        if (prepared.kind === "deferred") continue
                        const encoded = encode(frame, prepared.receipt)
                        // The encoder's complete SQL/data tail is the last validation before
                        // publication. Do not run another physical callback after that tail.
                        Reflect.apply(throwIfAborted, captured.signal, [])
                        output.enqueue(encoded)
                        return
                      }
                      const item = await inner.next()
                      if (closed) return
                      if (item.done) {
                        ended = true
                        await captured.terminal
                        captured.assertCurrent()
                        confirmOmissions(true)
                        const source = captured.lifetime.sseSource()
                        if (source) host.closeSseDiagnosticSource?.(source)
                        if (!closed) { closed = true; output.close() }
                        return
                      }
                      const actualShape = captured.lifetime.actualShape()
                      if (!actualShape) fail()
                      const actualMode = decode(item.value, actualShape).mode
                      if (actualMode === "values" || actualMode === "updates") {
                        // Graph computation/checkpoint work and projection must not monopolize
                        // one microtask. Classify only; route re-decodes and fully validates
                        // after resumption. Raw message partials keep their immediate capture.
                        await yieldToEventLoop(0)
                        if (closed) return
                      }
                      captured.assertCurrent()
                      confirmOmissions()
                      if (captured.lifetime.encoding() === "text/event-stream") {
                        const originalDiagnostic = captured.lifetime.diagnostic(item.value)
                        if (originalDiagnostic && deferPartial(originalDiagnostic)) continue
                      }
                      const projected = route(item.value, captured.lifetime, host)
                      captured.assertCurrent()
                      const frame = projected.shift()
                      if (!frame) continue
                      frames.push(...projected)
                      // Preserve the first frame's original handoff. In particular a native
                      // partial must not acquire a timer gap after its source was inspected.
                      const prepared = await prepareDiagnostic(frame)
                      if (prepared.kind === "deferred") continue
                      const encoded = encode(frame, prepared.receipt)
                      Reflect.apply(throwIfAborted, captured.signal, [])
                      output.enqueue(encoded)
                      return
                    }
                  } catch (error) {
                    if (!captured.cut.signal.aborted) captured.cut.abort(error)
                    try { await cleanup() } catch { /* Preserve the output/source failure. */ }
                    if (!closed) { closed = true; output.error(error) }
                  }
                },
                cancel: reason => cancel(reason, false)
              }, {
                // The IPC consumer yields before expensive snapshot projection. Do not
                // start another guard/route batch until it actually requests a frame.
                highWaterMark: 0
              })
            }
            override cancel(reason?: unknown): Promise<void> { return cancel(reason, true) }
            override async return(): Promise<IteratorResult<unknown>> {
              try { await cancel(undefined, true) }
              finally { this.reader?.releaseLock() }
              return { done: true, value: undefined }
            }
            override async throw(error: unknown): Promise<IteratorResult<unknown>> {
              try { await cancel(error, true) }
              finally { this.reader?.releaseLock() }
              throw error
            }
          }
          void captured.terminal.then(() => {
            captured.signal.removeEventListener("abort", aborted)
          }, () => { captured.signal.removeEventListener("abort", aborted) })
          return new NativeStream()
        })
      else methods.set(key, value.bind(target))
      return methods.get(key)
    }
  })
}

function sameSignalField(current: PropertyDescriptor | undefined,
  original: PropertyDescriptor): boolean {
  return !!current && "value" in current && current.value === original.value &&
    current.enumerable === original.enumerable && current.configurable === original.configurable &&
    current.writable === original.writable
}
