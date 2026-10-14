import { randomUUID } from "node:crypto"
import { types } from "node:util"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import type { FunctionNativeConversationRuntime } from "../mods/manager"
import { readFunctionConversationNativePolicySource, snapshotFunctionNativeDeployment }
  from "../mods/native-conversation-policy-source"
import { captureNativePartialMetadata } from "./native-message-capture"
import { createNativePolicyWorker, NATIVE_POLICY_MIRROR_VERSION } from "./native-policy-worker"
import { reserveNativePolicyProcessAdmission, releaseNativePolicyCaptureReservation,
  commitNativePolicyProcessAdmission, startNativePolicyProcessWork, cancelNativePolicyProcessWork,
  whenNativePolicyProcessWorkDrained, type NativePolicyProcessWork } from "./native-policy-process"
import { currentFunctionConversationNativeSseSource, readFunctionNativeStreamDiagnostic,
  type FunctionNativeStreamDiagnostic, type FunctionNativeStreamDiagnosticView,
  type FunctionConversationNativeSseSource } from "./function-conversation-native-lifetime"
import { readFunctionNativeCompletedPartial, type FunctionNativeCompletedPartialCandidate,
  type FunctionNativeCompletedPartialView } from "./function-conversation-native-calls"

const brand = Symbol("native-protected-stream-diagnostic")
export interface FunctionNativeProtectedDiagnostic { readonly [brand]: true }
export interface NativeSseDiagnosticData {
  readonly data: Readonly<Record<string, unknown>>
  readonly originalMessage: object
  readonly originalMetadata: object
  /** Complete data and private identity tail only; no physical/policy source callback. */
  assertDataCurrent(): void
}
const stringify = JSON.stringify
const throwIfAborted = AbortSignal.prototype.throwIfAborted
const nativeWeakGet = WeakMap.prototype.get, nativeWeakSet = WeakMap.prototype.set
const nativeSetHas = Set.prototype.has
function weakData<K extends object, V>(map: WeakMap<K, V>, key: K): V | undefined {
  return Reflect.apply(nativeWeakGet, map, [key]) as V | undefined
}
function writeWeak<K extends object, V>(map: WeakMap<K, V>, key: K, value: V): void {
  Reflect.apply(nativeWeakSet, map, [key, value])
}
const display = new Set(["name", "tags", "ls_provider", "ls_model_name", "ls_stop", "lc_agent_name"])
const keys = new Set(["tags", "name", "thread_id", "checkpoint_ns", "langgraph_step",
  "langgraph_node", "langgraph_triggers", "langgraph_path", "langgraph_checkpoint_ns",
  "ls_provider", "ls_model_type", "ls_model_name", "ls_temperature", "ls_max_tokens", "ls_stop",
  "ls_integration", "__pregel_task_id", "versions", "lc_agent_name"])
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
const uuidValue = new RegExp(`^${uuid}$`, "i")
const taskNamespace = new RegExp(`^(?:(?:model_request|tools):${uuid})(?:\\|(?:model_request|tools):${uuid})*$`, "i")
function fail(): never { throw new ModFunctionError("MODS_NATIVE_SSE_DIAGNOSTIC_INVALID") }
function own(value: unknown, key: PropertyKey): unknown {
  if (!value || typeof value !== "object" || types.isProxy(value)) fail()
  const field = Object.getOwnPropertyDescriptor(value, key)
  if (!field || !field.enumerable || !("value" in field)) fail()
  return field.value
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value)) fail()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail()
  return value as Record<string, unknown>
}
function strings(value: unknown): readonly string[] {
  if (!value || typeof value !== "object" || types.isProxy(value) || !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype) fail()
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 ||
    length > 1_000_000 || Reflect.ownKeys(value).length !== length + 1) fail()
  const result: string[] = []
  for (let index = 0; index < length; index++) {
    const item = own(value, String(index))
    if (typeof item !== "string") fail()
    result[result.length] = item
  }
  return result
}

/** Routing constants stay fixed. Freedom applies only to the actual protected display fields. */
function metadata(value: unknown, bounded: () => void): Readonly<Record<string, unknown>> {
  const original = object(value)
  const originalKeys = Reflect.ownKeys(original)
  for (let index = 0; index < originalKeys.length; index++) {
    const key = originalKeys[index]
    if (typeof key !== "string" || !Reflect.apply(nativeSetHas, keys, [key])) fail()
    own(original, key)
  }
  const copied = captureNativePartialMetadata(original, bounded).data
  const enumerableKeys = Object.keys(original)
  for (let index = 0; index < enumerableKeys.length; index++) {
    const key = enumerableKeys[index]
    const item = own(original, key)
    if (item === undefined) continue
    if (Reflect.apply(nativeSetHas, display, [key])) {
      if (key === "tags" || key === "ls_stop" && typeof item !== "string") strings(item)
      else if (typeof item !== "string") fail()
    } else if (key === "langgraph_step" || key === "ls_max_tokens") {
      if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0) fail()
    } else if (key === "ls_temperature") {
      if (typeof item !== "number" || !Number.isFinite(item)) fail()
    } else if (key === "langgraph_node") {
      if (item !== "model_request" && item !== "tools") fail()
    } else if (key === "langgraph_triggers") {
      const triggers = strings(item)
      for (let index = 0; index < triggers.length; index++) {
        const part = triggers[index]
        if (part !== "__start__" && part !== "model_request" && part !== "tools" &&
          part !== "branch:to:model_request" && part !== "branch:to:tools") fail()
      }
    } else if (key === "langgraph_path") {
      if (!Array.isArray(item) || types.isProxy(item)) fail()
      const data = copied[key]
      if (!Array.isArray(data)) fail()
      for (let index = 0; index < data.length; index++) {
        const part = data[index]
        if (!(typeof part === "string" && (part === "__pregel_pull" || part === "__pregel_push" ||
          part === "model_request" || part === "tools")) &&
          !(typeof part === "number" && Number.isSafeInteger(part) && part >= 0)) fail()
      }
    } else if (key === "ls_model_type") { if (item !== "chat") fail() }
    else if (key === "ls_integration") {
      if (item !== "langchain_create_agent" && item !== "langchain_chat_model") fail()
    } else if (key === "thread_id") {
      if (typeof item !== "string" || !uuidValue.test(item)) fail()
    } else if (key === "checkpoint_ns" || key === "langgraph_checkpoint_ns") {
      if (typeof item !== "string" || item !== "" && !taskNamespace.test(item)) fail()
    } else if (key === "__pregel_task_id") {
      const namespace = copied.langgraph_checkpoint_ns
      if (typeof item !== "string" || !uuidValue.test(item) || typeof namespace !== "string" ||
        !taskNamespace.test(namespace)) fail()
      const parts = namespace.split("|")
      if (parts[parts.length - 1]?.split(":")[1] !== item) fail()
    } else if (key === "versions") {
      const version = object(item), names = Reflect.ownKeys(version)
      if (names.length !== 1 || names[0] !== "@langchain/core" ||
        own(version, "@langchain/core") !== "1.1.36") fail()
    } else fail()
  }
  return copied
}
function deferred<T>() {
  const result = Promise.withResolvers<T>()
  void result.promise.catch(() => undefined)
  return result
}
interface DiagnosticRecord {
  readonly owner: Owner
  readonly token: FunctionNativeStreamDiagnostic
  readonly view: FunctionNativeStreamDiagnosticView
  readonly policy: ReturnType<FunctionNativeConversationRuntime["capturePolicy"]>
  readonly policyValue: object
  readonly policyIdentity: object
  readonly policyFacts: string
  readonly certificate: NonNullable<ReturnType<typeof readFunctionConversationNativePolicySource>>
  readonly input: Readonly<Record<string, unknown>>
  readonly rawDigest: string
  readonly result: ReturnType<typeof deferred<FunctionNativeProtectedDiagnostic>>
  readonly id: string
  readonly signal: AbortSignal
  readonly timer: ReturnType<typeof setTimeout>
  readonly controller: AbortController
  process?: NativePolicyProcessWork
  response?: unknown
  output?: Readonly<Record<string, unknown>>
  outputDigest?: string
  receipt?: FunctionNativeProtectedDiagnostic
  error?: unknown
  failed: boolean
  reading: boolean
  released: boolean
}
interface Owner {
  readonly runtime: FunctionNativeConversationRuntime
  readonly source: FunctionConversationNativeSseSource
  readonly records: WeakMap<FunctionNativeStreamDiagnostic, DiagnosticRecord | {
    capturing: true; failed: boolean }>
  readonly pending: Set<DiagnosticRecord>
  readonly processes: Set<NativePolicyProcessWork>
  readonly assertBound: (view: FunctionNativeStreamDiagnosticView) => void
  readonly assertBoundData: (view: FunctionNativeStreamDiagnosticView) => void
  closed: boolean
}
const receipts = new WeakMap<FunctionNativeProtectedDiagnostic, DiagnosticRecord>()
const safeCodes = new Set(["MODS_CANCELLED", "MODS_CALL_SCOPE_CHANGED",
  "MODS_CONVERSATION_STREAM_PROJECTION_INVALID", "MODS_NATIVE_SSE_DIAGNOSTIC_INVALID",
  "MODS_NATIVE_SSE_DIAGNOSTIC_REENTRANT", "MODS_NATIVE_CAPTURE_INVALID",
  "MODS_NATIVE_CAPTURE_PROXY", "MODS_NATIVE_CAPTURE_ACCESSOR", "MODS_NATIVE_CAPTURE_TYPE",
  "MODS_NATIVE_CAPTURE_CYCLE", "MODS_NATIVE_CAPTURE_EXPANSION", "MODS_NATIVE_POLICY_FAILURE",
  "MODS_NATIVE_POLICY_RESPONSE", "MODS_NATIVE_POLICY_TERMINATION_FAILED",
  "MODS_NATIVE_PROTECTION_TIMEOUT", "MODS_NATIVE_PROTECTION_STALE",
  "MODS_NATIVE_PROTECTION_CAPACITY", "MODS_NATIVE_PROTECTION_IDENTITY",
  "MODS_NATIVE_PROTECTION_SYNC_REQUIRED", "MODS_NATIVE_PROTECTION_DRAIN_UNKNOWN"])

/** Public diagnostic errors carry only a fixed code, never an original error object or text. */
export function nativeSseDiagnosticFailure(reason: unknown): ModFunctionError {
  if (reason && typeof reason === "object" && !types.isProxy(reason)) {
    const code = Object.getOwnPropertyDescriptor(reason, "code")
    if (code && "value" in code && typeof code.value === "string" && Reflect.apply(nativeSetHas, safeCodes, [code.value]))
      return new ModFunctionError(code.value)
  }
  return new ModFunctionError("MODS_NATIVE_SSE_DIAGNOSTIC_INVALID")
}
function firstFailure(record: DiagnosticRecord, reason: unknown): void {
  if (record.failed) return
  record.failed = true
  record.error = reason
}
function facts(policy: DiagnosticRecord["policy"]): string {
  const value = own(policy, "value")
  return stringify({ epoch: own(value, "epoch"), digest: own(value, "digest"),
    protected: own(value, "protected"), deployment: snapshotFunctionNativeDeployment(
      own(value, "deployment")) })
}
function bounded(record: DiagnosticRecord): void {
  Reflect.apply(throwIfAborted, record.signal, [])
  if (record.owner.closed || process.hrtime.bigint() >= record.view.expiresAtNs) fail()
}
function tail(record: DiagnosticRecord, completed?: FunctionNativeCompletedPartialView): void {
  bounded(record)
  const { owner, view } = record
  if (record.failed || weakData(owner.records, record.token) !== record ||
    currentFunctionConversationNativeSseSource() !== owner.source ||
    view.runtime !== owner.runtime || view.source !== owner.source ||
    own(record.policy, "value") !== record.policyValue ||
    own(record.policyValue, "identity") !== record.policyIdentity ||
    facts(record.policy) !== record.policyFacts ||
    captureNativePartialMetadata(view.metadata, () => bounded(record)).digest !== record.rawDigest)
    fail()
  view.assertDataCurrent()
  if (completed) {
    if (completed.runtime !== owner.runtime || completed.source !== owner.source ||
      completed.chunk !== view.message ||
      own(own(completed.policy, "value"), "identity") !== record.policyIdentity ||
      facts(completed.policy) !== record.policyFacts) fail()
    completed.assertDataCurrent()
  } else owner.assertBoundData(view)
  record.certificate.assertTail()
  if (record.output && captureNativePartialMetadata(record.output, () => bounded(record)).digest !==
    record.outputDigest) fail()
  bounded(record)
}
function current(record: DiagnosticRecord): void {
  if (record.reading) {
    firstFailure(record, new ModFunctionError("MODS_NATIVE_SSE_DIAGNOSTIC_REENTRANT"))
    fail()
  }
  record.reading = true
  try {
    tail(record)
    record.view.assertCurrent()
    record.owner.assertBound(record.view)
    record.certificate.assertCurrent()
    tail(record)
  } catch (error) { firstFailure(record, error); throw nativeSseDiagnosticFailure(error) }
  finally { record.reading = false }
}

/** Only the genuine Host's fixed validator selects its actual installed graph and message owner. */
export function createNativeSseDiagnosticOwner(input: {
  readonly runtime: FunctionNativeConversationRuntime
  readonly source: FunctionConversationNativeSseSource
  assertBound(view: FunctionNativeStreamDiagnosticView): void
  assertBoundData(view: FunctionNativeStreamDiagnosticView): void
}) {
  const owner: Owner = { runtime: input.runtime, source: input.source, records: new WeakMap(),
    pending: new Set(), processes: new Set(), assertBound: input.assertBound.bind(input),
    assertBoundData: input.assertBoundData.bind(input), closed: false }
  return Object.freeze({
    prepare(token: FunctionNativeStreamDiagnostic): Promise<FunctionNativeProtectedDiagnostic> {
      if (owner.closed) fail()
      const previous = weakData(owner.records, token)
      if (previous) {
        if ("capturing" in previous) { previous.failed = true; fail() }
        return previous.result.promise
      }
      // The same shared 256 reservation and sticky latch precede the first source callback.
      const reservation = reserveNativePolicyProcessAdmission(owner)
      const latch = { capturing: true as const, failed: false }
      writeWeak(owner.records, token, latch)
      let record: DiagnosticRecord | undefined
      try {
        const view = readFunctionNativeStreamDiagnostic(token, owner.source)
        if (view.runtime !== owner.runtime) fail()
        owner.assertBound(view)
        const policy = owner.runtime.capturePolicy()
        const certificate = readFunctionConversationNativePolicySource(policy, owner.runtime)
        if (!certificate) fail()
        const policyValue = object(own(policy, "value")), policyIdentity = own(policyValue, "identity")
        if (!policyIdentity || typeof policyIdentity !== "object" || types.isProxy(policyIdentity) ||
          typeof own(policyValue, "protected") !== "boolean") fail()
        const controller = new AbortController()
        const signal = AbortSignal.any([controller.signal, view.signal, owner.runtime.signal,
          owner.runtime.target.signal])
        const check = () => {
          Reflect.apply(throwIfAborted, signal, [])
          if (process.hrtime.bigint() >= view.expiresAtNs) fail()
        }
        const raw = metadata(view.metadata, check)
        if (raw.thread_id !== undefined && raw.thread_id !== owner.runtime.binding.checkpointThreadId)
          fail()
        if (latch.failed || owner.closed || weakData(owner.records, token) !== latch) fail()
        const result = deferred<FunctionNativeProtectedDiagnostic>()
        const timer = setTimeout(() => controller.abort(new ModFunctionError(
          "MODS_NATIVE_PROTECTION_TIMEOUT")), Math.max(0,
          Number((view.expiresAtNs - process.hrtime.bigint()) / 1_000_000n)))
        record = { owner, token, view, policy, policyValue, policyIdentity, certificate,
          policyFacts: facts(policy), input: raw,
          rawDigest: captureNativePartialMetadata(view.metadata, check).digest,
          id: randomUUID(), signal, timer, controller, result, failed: false,
          reading: false, released: false }
        const actual = record
        writeWeak(owner.records, token, actual)
        owner.pending.add(actual)
        const run = <T>(work: () => T): T => view.run(work)
        const abort = () => {
          const error = new ModFunctionError("MODS_CANCELLED")
          firstFailure(actual, error)
          if (actual.process) cancelNativePolicyProcessWork(actual.process, error)
          else actual.result.reject(nativeSseDiagnosticFailure(actual.error))
        }
        actual.process = commitNativePolicyProcessAdmission(reservation, {
          assertCurrent: () => run(() => current(actual)),
          onStarting: () => undefined,
          createWorker: createNativePolicyWorker,
          onWorker: () => undefined,
          createPacket: () => run(() => {
            const value: Record<string, unknown> = {}
            for (const key of Object.keys(raw)) if (Reflect.apply(nativeSetHas, display, [key]) && raw[key] !== undefined)
              value[key] = raw[key]
            return { id: actual.id, version: NATIVE_POLICY_MIRROR_VERSION, value,
              literals: snapshotFunctionNativeDeployment(own(policyValue, "deployment")).redactLiterals }
          }),
          onResponse: response => { actual.response = response },
          onCancel: error => { firstFailure(actual, error)
            actual.result.reject(nativeSseDiagnosticFailure(actual.error)) },
          onQuarantine: () => {
            firstFailure(actual, new ModFunctionError("MODS_NATIVE_PROTECTION_DRAIN_UNKNOWN"))
            actual.result.reject(nativeSseDiagnosticFailure(actual.error))
          },
          onFinish: exitCode => run(() => {
            try {
              if (actual.failed) throw actual.error
              current(actual)
              const output: Record<string, unknown> = {}
              let protectedDisplay: Record<string, unknown> = {}
              if (own(policyValue, "protected") === true) {
                const response = object(actual.response)
                if (exitCode !== 0 || own(response, "ok") !== true || own(response, "id") !== actual.id ||
                  own(response, "version") !== NATIVE_POLICY_MIRROR_VERSION) fail()
                const rules = strings(own(response, "ruleIds"))
                if (rules[0] !== "baseline-v1" || rules.some(rule => !["baseline-v1",
                  "credential-field", "credential-token", "bearer", "deployment-literal"].includes(rule)))
                  fail()
                protectedDisplay = object(captureNativePartialMetadata(
                  object(own(response, "value")), () => bounded(actual)).data)
                const expected = Object.keys(raw).filter(key => Reflect.apply(nativeSetHas, display, [key]) && raw[key] !== undefined)
                if (Object.keys(protectedDisplay).length !== expected.length ||
                  expected.some(key => !Object.hasOwn(protectedDisplay, key))) fail()
              }
              for (const key of Object.keys(raw)) Object.defineProperty(output, key, {
                value: own(policyValue, "protected") === true && Reflect.apply(nativeSetHas, display, [key]) && raw[key] !== undefined
                  ? protectedDisplay[key] : raw[key], enumerable: true, configurable: false, writable: false })
              actual.output = Object.freeze(output)
              actual.outputDigest = captureNativePartialMetadata(output, () => bounded(actual)).digest
              current(actual)
              const receipt: FunctionNativeProtectedDiagnostic = Object.freeze({ [brand]: true as const })
              actual.receipt = receipt
              tail(actual)
              writeWeak(receipts, receipt, actual)
            } catch (error) { firstFailure(actual, error) }
            // This owner's retained work is removed once, after genuine driver exit/never-started.
            if (actual.released) fail()
            actual.released = true
            clearTimeout(timer)
            signal.removeEventListener("abort", abort)
            owner.pending.delete(actual)
            if (actual.failed) actual.result.reject(nativeSseDiagnosticFailure(actual.error))
            else if (!actual.receipt) actual.result.reject(
              new ModFunctionError("MODS_NATIVE_SSE_DIAGNOSTIC_INVALID"))
            else actual.result.resolve(actual.receipt)
            return "released" as const
          })
        })
        owner.processes.add(actual.process)
        void whenNativePolicyProcessWorkDrained(actual.process).then(() => {
          if (actual.process) owner.processes.delete(actual.process)
        }, () => { /* An unknown terminal remains recorded and observable. */ })
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) abort()
        startNativePolicyProcessWork(actual.process, own(policyValue, "protected") === true)
        return result.promise
      } catch (error) {
        if (record) firstFailure(record, error)
        if (record?.process) cancelNativePolicyProcessWork(record.process, error)
        else {
          if (record) { clearTimeout(record.timer); owner.pending.delete(record) }
          releaseNativePolicyCaptureReservation(reservation)
        }
        throw nativeSseDiagnosticFailure(error)
      }
    },
    close() {
      if (owner.closed) return
      owner.closed = true
      for (const record of owner.pending) record.controller.abort(new ModFunctionError("MODS_CANCELLED"))
    },
    async whenDrained() {
      try {
        while (owner.processes.size || owner.pending.size) {
          const results = await Promise.allSettled([...owner.processes].map(process =>
            whenNativePolicyProcessWorkDrained(process)))
          for (const result of results) if (result.status === "rejected") throw result.reason
          if (!owner.processes.size && owner.pending.size) fail()
        }
      } catch (error) { throw nativeSseDiagnosticFailure(error) }
    }
  })
}

export function readNativeSseProtectedDiagnostic(receipt: FunctionNativeProtectedDiagnostic,
  token: FunctionNativeStreamDiagnostic, expectedSource: FunctionConversationNativeSseSource):
  NativeSseDiagnosticData {
  const record = weakData(receipts, receipt)
  if (!record || record.token !== token || record.owner.source !== expectedSource ||
    record.receipt !== receipt || !record.output || !record.released) fail()
  current(record)
  const data = record.output
  return Object.freeze({ data, originalMessage: record.view.message,
    originalMetadata: record.view.metadata, assertDataCurrent() {
    try {
      tail(record)
      if (weakData(receipts, receipt) !== record || record.receipt !== receipt || record.output !== data ||
        !record.released || record.reading) fail()
    } catch (error) { firstFailure(record, error); throw nativeSseDiagnosticFailure(error) }
  } })
}

/** No DTO is returned. A genuine released diagnostic may only help prove this partial's omit. */
export function readNativeSseCompletedDiagnostic(receipt: FunctionNativeProtectedDiagnostic,
  token: FunctionNativeStreamDiagnostic, candidate: FunctionNativeCompletedPartialCandidate,
  expectedSource: FunctionConversationNativeSseSource): Readonly<{ assertDataCurrent(): void }> {
  const record = weakData(receipts, receipt)
  if (!record || record.token !== token || record.owner.source !== expectedSource ||
    record.receipt !== receipt || !record.output || !record.released || record.failed) fail()
  if (record.reading) {
    firstFailure(record, new ModFunctionError("MODS_NATIVE_SSE_DIAGNOSTIC_REENTRANT"))
    fail()
  }
  record.reading = true
  let completed: FunctionNativeCompletedPartialView
  try {
    completed = readFunctionNativeCompletedPartial(candidate, record.owner.runtime, expectedSource)
    tail(record, completed)
    record.view.assertCurrent()
    record.certificate.assertCurrent()
    completed.assertCurrent()
    tail(record, completed)
  } catch (error) { firstFailure(record, error); throw nativeSseDiagnosticFailure(error) }
  finally { record.reading = false }
  const assertDataCurrent = () => {
    try {
      tail(record, completed)
      if (weakData(receipts, receipt) !== record || record.receipt !== receipt ||
        !record.released || record.reading) fail()
    } catch (error) { firstFailure(record, error); throw nativeSseDiagnosticFailure(error) }
  }
  assertDataCurrent()
  return Object.freeze({ assertDataCurrent })
}
