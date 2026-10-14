import { randomUUID } from "node:crypto"
import { types } from "node:util"
import { Worker } from "node:worker_threads"
import type { BaseMessage } from "@langchain/core/messages"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import type { ManagedModDeployment } from "../mods/policy"
import {
  captureNativeMessage,
  constructCapturedNativeMessage,
  type CapturedNativeMessage
} from "./native-message-capture"
import {
  createNativePolicyWorker,
  NATIVE_POLICY_MIRROR_VERSION
} from "./native-policy-worker"
import { reserveNativePolicyProcessAdmission, commitNativePolicyProcessAdmission,
  releaseNativePolicyCaptureReservation, quarantineNativePolicyCaptureReservation,
  startNativePolicyProcessWork, cancelNativePolicyProcessWork,
  whenNativePolicyProcessWorkDrained,
  type NativePolicyProcessReservation, type NativePolicyProcessWork } from "./native-policy-process"

export interface FunctionNativeProtectionPolicy {
  readonly identity: object
  readonly protected: boolean
  readonly digest: string
  readonly epoch: number
  readonly deployment: Readonly<Omit<ManagedModDeployment, "redactLiterals" | "denyTools">> & {
    readonly redactLiterals: readonly string[]
    readonly denyTools: readonly string[]
  }
}

/** Actual producer factory input. This interface is never accepted over IPC or SDK JSON. */
export interface FunctionNativeProtectionAdmission {
  readonly message: BaseMessage
  readonly producer: object
  readonly policy: FunctionNativeProtectionPolicy
  readonly signal: AbortSignal
  readonly expiresAtNs?: bigint
  assertCurrent(): void
  retainActualWork(): () => void
  /** Native structured execution facts are checked by the actual producer adapter. */
  assertExecutionFacts(original: BaseMessage, safe: BaseMessage): void
  /** Explicitly transfers the private public-is_error presentation binding to a new instance. */
  inheritPresentation(original: BaseMessage, safe: BaseMessage): void
}

const captureBrand = Symbol("native-message-capture")
const protectedBrand = Symbol("native-message-protected")
export interface FunctionNativeProtectionCapture { readonly [captureBrand]: true }
export interface FunctionNativeProtectionReceipt { readonly [protectedBrand]: true }
export interface FunctionProtectedNativeMessage {
  readonly message: BaseMessage
  readonly receipt: FunctionNativeProtectionReceipt
  readonly policyDigest: string
  readonly ruleIds: readonly string[]
  readonly protected: boolean
}

export interface FunctionNativeProtectorOptions {
  /** Host-only injectable actual Worker factory; no executable source comes from an admission. */
  readonly createWorker?: () => Worker
}

function fail(code: string): never { throw new ModFunctionError(code) }
function failure(code: string): ModFunctionError { return new ModFunctionError(code) }
const safeCodes = new Set([
  "MODS_CANCELLED", "MODS_ENTRY_EXPIRED", "MODS_NATIVE_CAPTURE_INVALID",
  "MODS_NATIVE_CAPTURE_PROXY", "MODS_NATIVE_CAPTURE_ACCESSOR", "MODS_NATIVE_CAPTURE_TYPE",
  "MODS_NATIVE_CAPTURE_CYCLE", "MODS_NATIVE_CAPTURE_EXPANSION", "MODS_NATIVE_CAPTURE_REENTRANT",
  "MODS_NATIVE_POLICY_IDENTITY",
  "MODS_NATIVE_POLICY_UNSUPPORTED", "MODS_NATIVE_POLICY_RESPONSE", "MODS_NATIVE_POLICY_FAILURE",
  "MODS_NATIVE_POLICY_EXIT", "MODS_NATIVE_POLICY_TERMINATION_FAILED",
  "MODS_NATIVE_EXECUTION_REDACTION_REQUIRED", "MODS_NATIVE_MESSAGE_CHANGED",
  "MODS_NATIVE_PROTECTION_INIT", "MODS_NATIVE_PROTECTION_TIMEOUT", "MODS_NATIVE_PROTECTION_STALE",
  "MODS_NATIVE_PROTECTION_CAPACITY", "MODS_NATIVE_PROTECTION_IDENTITY", "MODS_NATIVE_PROTECTION_RETAIN",
  "MODS_NATIVE_PROTECTION_SYNC_REQUIRED", "MODS_NATIVE_PROTECTION_DRAIN_UNKNOWN",
  "MODS_NATIVE_PROTECTOR_CLOSED"
])
const nativeThen = Promise.prototype.then
const nativeWeakGet = WeakMap.prototype.get
function safeFailure(error: unknown, fallback: string): ModFunctionError {
  if (error && typeof error === "object" && !types.isProxy(error)) {
    const code = Object.getOwnPropertyDescriptor(error, "code")
    if (code && "value" in code && typeof code.value === "string" &&
      safeCodes.has(code.value)) return failure(code.value)
  }
  return failure(fallback)
}
function assertSync(value: unknown): void {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return
  if (types.isProxy(value)) fail("MODS_NATIVE_PROTECTION_SYNC_REQUIRED")
  if (types.isPromise(value)) {
    // Only the actual native Promise is observed, never a caller's ordinary then function/getter.
    const constructor = Object.getOwnPropertyDescriptor(value, "constructor")
    if (Object.getPrototypeOf(value) === Promise.prototype &&
      (!constructor || ("value" in constructor && constructor.value === Promise)))
      void nativeThen.call(value, undefined, () => undefined)
    fail("MODS_NATIVE_PROTECTION_SYNC_REQUIRED")
  }
  let current: object | null = value
  while (current) {
    if (types.isProxy(current)) fail("MODS_NATIVE_PROTECTION_SYNC_REQUIRED")
    const then = Object.getOwnPropertyDescriptor(current, "then")
    if (then && (!("value" in then) || typeof then.value === "function"))
      fail("MODS_NATIVE_PROTECTION_SYNC_REQUIRED")
    current = Object.getPrototypeOf(current)
  }
}
function deferred<T>() {
  let resolve: (value: T) => void = () => fail("MODS_NATIVE_PROTECTION_INIT")
  let reject: (error: unknown) => void = () => fail("MODS_NATIVE_PROTECTION_INIT")
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  // Capture can be cancelled before its first consumer attaches. The caller still receives rejection.
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

function equal(left: unknown, right: unknown): boolean {
  const pairs: Array<readonly [unknown, unknown]> = [[left, right]]
  while (pairs.length) {
    const pair = pairs.pop()
    if (!pair) return false
    const [a, b] = pair
    if (Object.is(a, b)) continue
    if (!a || !b || typeof a !== "object" || typeof b !== "object" ||
      Array.isArray(a) !== Array.isArray(b)) return false
    const keys = Object.keys(a).filter(key =>
      Object.getOwnPropertyDescriptor(a, key)?.value !== undefined)
    const other = Object.keys(b).filter(key =>
      Object.getOwnPropertyDescriptor(b, key)?.value !== undefined)
    if (keys.length !== other.length) return false
    for (const key of keys) {
      if (!Object.hasOwn(b, key)) return false
      pairs.push([Object.getOwnPropertyDescriptor(a, key)?.value,
        Object.getOwnPropertyDescriptor(b, key)?.value])
    }
  }
  return true
}

function policyCopy(input: FunctionNativeProtectionPolicy): FunctionNativeProtectionPolicy {
  function data(object: object, key: string): unknown {
    if (types.isProxy(object)) fail("MODS_NATIVE_POLICY_IDENTITY")
    const property = Object.getOwnPropertyDescriptor(object, key)
    if (!property || !("value" in property)) fail("MODS_NATIVE_POLICY_IDENTITY")
    return property.value
  }
  const identity = data(input, "identity"), protectedOutput = data(input, "protected")
  const digest = data(input, "digest"), epoch = data(input, "epoch")
  if (!identity || typeof identity !== "object" || types.isProxy(identity) ||
    typeof protectedOutput !== "boolean" || typeof digest !== "string" || !digest ||
    typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0)
    fail("MODS_NATIVE_POLICY_IDENTITY")
  const deployment = data(input, "deployment")
  if (!deployment || typeof deployment !== "object" || types.isProxy(deployment) ||
    data(deployment, "version") !== 1 || data(deployment, "id") !== "cmb.baseline/v1" ||
    typeof data(deployment, "required") !== "boolean")
    fail("MODS_NATIVE_POLICY_UNSUPPORTED")
  const required = data(deployment, "required")
  if (typeof required !== "boolean") fail("MODS_NATIVE_POLICY_UNSUPPORTED")
  const fields: Record<"redactLiterals" | "denyTools", string[]> = { redactLiterals: [], denyTools: [] }
  for (const key of ["redactLiterals", "denyTools"] as const) {
    const values = data(deployment, key), max = key === "redactLiterals" ? 256 : 160
    if (!values || typeof values !== "object" || types.isProxy(values) || !Array.isArray(values) ||
      values.length > 64 || Object.getPrototypeOf(values) !== Array.prototype)
      fail("MODS_NATIVE_POLICY_UNSUPPORTED")
    const copied: string[] = []
    for (let index = 0; index < values.length; index++) {
      const value = data(values, String(index))
      if (typeof value !== "string" || !value.length || value.length > max)
        fail("MODS_NATIVE_POLICY_UNSUPPORTED")
      copied.push(value)
    }
    fields[key] = [...new Set(copied)]
  }
  return Object.freeze({ identity, protected: protectedOutput, digest, epoch, deployment: Object.freeze({
    version: 1, id: "cmb.baseline/v1", required,
    redactLiterals: Object.freeze(fields.redactLiterals),
    denyTools: Object.freeze(fields.denyTools)
  }) })
}

function samePolicy(a: FunctionNativeProtectionPolicy, b: FunctionNativeProtectionPolicy): boolean {
  return a.identity === b.identity && a.protected === b.protected && a.digest === b.digest &&
    a.epoch === b.epoch && a.deployment.version === b.deployment.version &&
    a.deployment.id === b.deployment.id && a.deployment.required === b.deployment.required &&
    a.deployment.redactLiterals.length === b.deployment.redactLiterals.length &&
    a.deployment.redactLiterals.every((value, index) => value === b.deployment.redactLiterals[index]) &&
    a.deployment.denyTools.length === b.deployment.denyTools.length &&
    a.deployment.denyTools.every((value, index) => value === b.deployment.denyTools[index])
}

type WorkState = "captured" | "queued" | "starting" | "running" | "finishing" | "finished" | "quarantined"
interface Work {
  readonly admissionId: string
  readonly owner: FunctionNativeMessageProtector
  readonly token: FunctionNativeProtectionCapture
  readonly admission: FunctionNativeProtectionAdmission
  readonly originalSourceCurrent: FunctionNativeProtectionAdmission["assertCurrent"]
  readonly snapshot: CapturedNativeMessage
  readonly policy: FunctionNativeProtectionPolicy
  readonly controller: AbortController
  readonly signal: AbortSignal
  readonly expiresAtNs: bigint
  readonly result: ReturnType<typeof deferred<FunctionProtectedNativeMessage>>
  readonly terminal: ReturnType<typeof deferred<void>>
  readonly release: () => void
  readonly createWorker: () => Worker
  readonly abort: () => void
  readonly timer: ReturnType<typeof setTimeout>
  state: WorkState
  worker?: Worker
  response?: unknown
  error?: unknown
  process?: NativePolicyProcessWork
}
interface CaptureLatch {
  readonly owner: FunctionNativeMessageProtector
  readonly reservation: NativePolicyProcessReservation
  state: "capturing" | "admitted" | "failed"
  token?: FunctionNativeProtectionCapture
  error?: ModFunctionError
}

// Initial captures remain owner-local lifecycle facts; capacity is the shared process driver.
const captureReservations = new Set<CaptureLatch>()
const LIMITS = Object.freeze({ wallMs: 30_000 })
function fixedKeys(type: CapturedNativeMessage["type"]): readonly string[] {
  return type === "tool" ? ["id", "name", "tool_call_id", "status"] : ["id", "name"]
}
const strictStructured = ["tool_calls", "invalid_tool_calls", "usage_metadata"] as const

function assertClock(work: Work, ownDeadline = true): void {
  if (work.signal.aborted) throw safeFailure(work.signal.reason, "MODS_CANCELLED")
  const expiry = ownDeadline ? work.expiresAtNs : work.admission.expiresAtNs
  if (expiry !== undefined && process.hrtime.bigint() >= expiry)
    fail("MODS_NATIVE_PROTECTION_TIMEOUT")
}

function assertWork(work: Work, ownDeadline = true): void {
  assertClock(work, ownDeadline)
  try { assertSync(work.admission.assertCurrent()) }
  catch (error) { throw safeFailure(error, "MODS_NATIVE_PROTECTION_STALE") }
  if (captureNativeMessage(work.admission.message, () => assertClock(work, ownDeadline)).digest
    !== work.snapshot.digest)
    fail("MODS_NATIVE_MESSAGE_CHANGED")
}

function responseData(work: Work): { value: Record<string, unknown>; rules: readonly string[] } {
  const response = work.response
  if (!response || typeof response !== "object" || types.isProxy(response) || Array.isArray(response))
    fail("MODS_NATIVE_POLICY_RESPONSE")
  const record = response as Record<string, unknown>
  if (record.id === work.admissionId && record.version === NATIVE_POLICY_MIRROR_VERSION &&
    record.ok === false && record.code === "MODS_NATIVE_CAPTURE_EXPANSION")
    fail("MODS_NATIVE_CAPTURE_EXPANSION")
  if (record.id !== work.admissionId || record.version !== NATIVE_POLICY_MIRROR_VERSION ||
    record.ok !== true || !record.value || typeof record.value !== "object" ||
    Array.isArray(record.value) || !Array.isArray(record.ruleIds) ||
    record.ruleIds.length > 8 || record.ruleIds[0] !== "baseline-v1" ||
    record.ruleIds.some(rule => typeof rule !== "string" ||
      !["baseline-v1", "credential-token", "bearer", "deployment-literal", "credential-field"].includes(rule)))
    fail("MODS_NATIVE_POLICY_RESPONSE")
  return { value: record.value as Record<string, unknown>, rules: Object.freeze([...record.ruleIds]) }
}

function finish(work: Work, exitCode?: number): "released" | "quarantined" {
  if (work.state === "finished") return "released"
  if (work.state === "quarantined") return "quarantined"
  if (work.state === "finishing") fail("MODS_NATIVE_PROTECTION_DRAIN_UNKNOWN")
  // Native callbacks may synchronously close/cancel the owner. Fence this actual finally before
  // entering any of them; cancellation still rejects the result and is checked before adoption.
  work.state = "finishing"
  let output: FunctionProtectedNativeMessage | undefined
  let error: unknown = work.error
  if (!error) try {
    assertWork(work)
    if (work.error) throw work.error
    if (work.policy.protected) {
      if (exitCode !== 0) fail("MODS_NATIVE_POLICY_EXIT")
      const response = responseData(work)
      if (work.snapshot.executionSuppressed) fail("MODS_NATIVE_EXECUTION_REDACTION_REQUIRED")
      if (work.snapshot.type === "ai") for (const key of strictStructured)
        if (!equal(work.snapshot.data[key], response.value[key]))
          fail("MODS_NATIVE_EXECUTION_REDACTION_REQUIRED")
      const data: Record<string, unknown> = Object.create(null)
      const fixed = new Set(fixedKeys(work.snapshot.type))
      // Fixed fields were removed from the Worker packet, but their original insertion order is
      // part of the exact native codec. Never append an original id to the end of restored kwargs.
      for (const key of Object.keys(work.snapshot.data)) {
        if (fixed.has(key)) data[key] = work.snapshot.data[key]
        else if (Object.hasOwn(response.value, key)) data[key] = response.value[key]
      }
      if (Object.keys(response.value).some(key => !Object.hasOwn(work.snapshot.data, key)))
        fail("MODS_NATIVE_POLICY_RESPONSE")
      const message = constructCapturedNativeMessage(work.snapshot.type, data)
      assertSync(work.admission.assertExecutionFacts(work.admission.message, message))
      assertWork(work)
      if (work.error) throw work.error
      assertSync(work.admission.inheritPresentation(work.admission.message, message))
      assertWork(work)
      if (work.error) throw work.error
      output = work.owner.adoptResult(work, message, response.rules)
    } else output = work.owner.adoptResult(work, work.admission.message, [])
  } catch (caught) { error = safeFailure(caught, "MODS_NATIVE_POLICY_FAILURE") }
  clearTimeout(work.timer)
  // This release is the real host finally. A failed/uncertain release is never retried or borrowed.
  try { assertSync(work.release()) }
  catch {
    work.state = "quarantined"
    work.signal.removeEventListener("abort", work.abort)
    const unknown = failure("MODS_NATIVE_PROTECTION_DRAIN_UNKNOWN")
    work.result.reject(work.error ?? error ?? unknown)
    work.terminal.reject(unknown)
    return "quarantined"
  }
  // In particular a release that closes the owner must not resolve an output saved before that
  // callback. Its successful synchronous return proves the release, not a fresh source grant.
  error = work.error ?? error
  if (!error) try { assertWork(work) }
  catch (caught) { error = safeFailure(caught, "MODS_NATIVE_POLICY_FAILURE") }
  work.state = "finished"
  work.signal.removeEventListener("abort", work.abort)
  work.owner.releaseWork(work)
  if (error) work.result.reject(error)
  else if (output) work.result.resolve(output)
  else work.result.reject(failure("MODS_NATIVE_POLICY_RESPONSE"))
  work.terminal.resolve()
  return "released"
}

function cancel(work: Work, error: unknown): void {
  if (work.state === "finished" || work.state === "quarantined") return
  work.error ??= safeFailure(error, "MODS_CANCELLED")
  work.result.reject(work.error)
  if (!work.process) fail("MODS_NATIVE_PROTECTION_DRAIN_UNKNOWN")
  cancelNativePolicyProcessWork(work.process, work.error)
}

function quarantineFactory(work: Work, error: unknown): void {
  work.error ??= safeFailure(error, "MODS_NATIVE_POLICY_FAILURE")
  work.state = "quarantined"
  clearTimeout(work.timer)
  work.signal.removeEventListener("abort", work.abort)
  work.result.reject(work.error)
  work.terminal.reject(failure("MODS_NATIVE_PROTECTION_DRAIN_UNKNOWN"))
  work.owner.quarantineWork(work)
  // A throwing/invalid factory may already have started physical work. No exit receipt exists,
  // so both this Worker slot and its actual host admission remain occupied, without retry.
}

interface ReceiptRecord {
  readonly work: Work
  readonly output: FunctionProtectedNativeMessage
  readonly outputDigest: string
}

/** New foundation only; actual producer seal/adopter/keeper doors are separate required wiring. */
export class FunctionNativeMessageProtector {
  private closed = false
  private readonly admissions = new WeakMap<FunctionNativeProtectionAdmission, CaptureLatch>()
  private readonly captures = new WeakMap<FunctionNativeProtectionCapture, Work>()
  private readonly receipts = new WeakMap<FunctionNativeProtectionReceipt, ReceiptRecord>()
  private readonly pending = new Set<Work>()
  private readonly quarantinedCaptures = new Set<CaptureLatch>()
  private readonly createWorker: () => Worker

  constructor(options: FunctionNativeProtectorOptions = {}) {
    this.createWorker = options.createWorker ?? createNativePolicyWorker
  }

  capture(admission: FunctionNativeProtectionAdmission): FunctionNativeProtectionCapture {
    if (this.closed) fail("MODS_NATIVE_PROTECTOR_CLOSED")
    if (!admission || typeof admission !== "object" || types.isProxy(admission))
      fail("MODS_NATIVE_PROTECTION_IDENTITY")
    const previous = this.admissions.get(admission)
    if (previous) {
      if (previous.state === "admitted" && previous.token) return previous.token
      previous.error ??= failure("MODS_NATIVE_CAPTURE_REENTRANT")
      throw previous.error
    }
    const reservation = reserveNativePolicyProcessAdmission(this)
    const latch: CaptureLatch = { owner: this, reservation, state: "capturing" }
    this.admissions.set(admission, latch)
    captureReservations.add(latch)
    let release: (() => void) | undefined, retained = false, capturedWork: Work | undefined
    const assertLatch = () => {
      if (latch.error) throw latch.error
      if (this.closed) fail("MODS_NATIVE_PROTECTOR_CLOSED")
    }
    try {
      if (!admission.producer || typeof admission.producer !== "object" ||
        types.isProxy(admission.producer)) fail("MODS_NATIVE_PROTECTION_IDENTITY")
      if (admission.signal.aborted) throw safeFailure(admission.signal.reason, "MODS_CANCELLED")
      const now = process.hrtime.bigint(), ownExpiry = now + BigInt(LIMITS.wallMs) * 1_000_000n
      if (admission.expiresAtNs !== undefined && typeof admission.expiresAtNs !== "bigint")
        fail("MODS_NATIVE_PROTECTION_IDENTITY")
      const expiresAtNs = admission.expiresAtNs === undefined ? ownExpiry
        : admission.expiresAtNs < ownExpiry ? admission.expiresAtNs : ownExpiry
      const assertBoundedWork = () => {
        assertLatch()
        if (admission.signal.aborted) throw safeFailure(admission.signal.reason, "MODS_CANCELLED")
        if (process.hrtime.bigint() >= expiresAtNs) fail("MODS_NATIVE_PROTECTION_TIMEOUT")
      }
      try { assertSync(admission.assertCurrent()); assertLatch() }
      catch (error) { throw safeFailure(error, "MODS_NATIVE_PROTECTION_STALE") }
      // No async boundary or guest code runs in typed capture. Reject malformed raw data before
      // admitting actual retained work, so a capture failure cannot lose an uncertain release.
      const snapshot = captureNativeMessage(admission.message, assertBoundedWork)
      const policy = policyCopy(admission.policy)
      const token: FunctionNativeProtectionCapture = Object.freeze({ [captureBrand]: true as const })
      const ownController = new AbortController()
      const signal = AbortSignal.any([admission.signal, ownController.signal])
      const originalSourceCurrent = admission.assertCurrent
      const frozen = Object.freeze({ ...admission, policy,
        assertCurrent: originalSourceCurrent.bind(admission),
        retainActualWork: admission.retainActualWork.bind(admission),
        assertExecutionFacts: admission.assertExecutionFacts.bind(admission),
        inheritPresentation: admission.inheritPresentation.bind(admission) })
      try { assertSync(admission.assertCurrent()); assertLatch() }
      catch (error) { throw safeFailure(error, "MODS_NATIVE_PROTECTION_STALE") }
      if (signal.aborted) throw safeFailure(signal.reason, "MODS_CANCELLED")
      // A throwing/async retain can have admitted real work before returning. It is uncertain,
      // never an excuse to return capacity or retry this native admission.
      retained = true
      const actualRelease: unknown = admission.retainActualWork()
      assertSync(actualRelease)
      if (typeof actualRelease !== "function") fail("MODS_NATIVE_PROTECTION_RETAIN")
      release = actualRelease as () => void
      assertLatch()
      const abort = () => cancel(work, signal.reason ?? failure("MODS_CANCELLED"))
      const remaining = Math.max(0, Number((expiresAtNs - process.hrtime.bigint()) / 1_000_000n))
      const timer = setTimeout(() => ownController.abort(failure("MODS_NATIVE_PROTECTION_TIMEOUT")), remaining)
      const work: Work = { owner: this, token, admission: frozen, originalSourceCurrent, snapshot, policy,
        controller: ownController, signal, expiresAtNs, result: deferred(), terminal: deferred(),
        release, createWorker: this.createWorker, abort, timer, state: "captured",
        admissionId: randomUUID() }
      capturedWork = work
      work.process = commitNativePolicyProcessAdmission(reservation, {
        assertCurrent: () => assertWork(work),
        onStarting: () => { work.state = "starting" },
        createWorker: () => work.createWorker(),
        onWorker: worker => { work.worker = worker; work.state = "running" },
        createPacket: () => {
          const value = { ...work.snapshot.data }
          for (const key of fixedKeys(work.snapshot.type)) delete value[key]
          return { id: work.admissionId, version: NATIVE_POLICY_MIRROR_VERSION,
            value, literals: work.policy.deployment.redactLiterals }
        },
        onResponse: response => { work.response = response },
        onCancel: error => {
          work.error ??= safeFailure(error, "MODS_CANCELLED")
          work.result.reject(work.error)
        },
        onFinish: exitCode => finish(work, exitCode),
        onQuarantine: error => quarantineFactory(work, error)
      })
      this.pending.add(work)
      this.captures.set(token, work)
      latch.state = "admitted"
      latch.token = token
      captureReservations.delete(latch)
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
      return token
    } catch (error) {
      latch.state = "failed"
      latch.error ??= safeFailure(error, "MODS_NATIVE_PROTECTION_RETAIN")
      if (capturedWork) {
        clearTimeout(capturedWork.timer)
        if (capturedWork.process) {
          // Once committed, the one process job owns actual release; capture cannot return its
          // reservation or retry that release in a second finally.
          cancel(capturedWork, latch.error)
          captureReservations.delete(latch)
          throw latch.error
        }
      }
      if (retained && release) {
        try { assertSync(release()); retained = false }
        catch { /* Uncertain actual finally keeps this reservation quarantined. */ }
      }
      if (retained) {
        this.quarantinedCaptures.add(latch)
        quarantineNativePolicyCaptureReservation(reservation)
      } else {
        captureReservations.delete(latch)
        releaseNativePolicyCaptureReservation(reservation)
      }
      throw latch.error
    }
  }

  protect(capture: FunctionNativeProtectionCapture): Promise<FunctionProtectedNativeMessage> {
    if (this.closed) fail("MODS_NATIVE_PROTECTOR_CLOSED")
    const work = this.captures.get(capture)
    if (!work) fail("MODS_NATIVE_PROTECTION_IDENTITY")
    if (work.state === "captured") {
      if (!work.process) fail("MODS_NATIVE_PROTECTION_IDENTITY")
      if (work.policy.protected) work.state = "queued"
      startNativePolicyProcessWork(work.process, work.policy.protected)
    }
    return work.result.promise
  }

  /** Host-only internal result adoption; never exposed to SDK/wire. */
  adoptResult(work: Work, message: BaseMessage, rules: readonly string[]): FunctionProtectedNativeMessage {
    if (!this.pending.has(work) || this.captures.get(work.token) !== work)
      fail("MODS_NATIVE_PROTECTION_IDENTITY")
    const receipt: FunctionNativeProtectionReceipt = Object.freeze({ [protectedBrand]: true as const })
    const output = Object.freeze({ message, receipt, policyDigest: work.policy.digest,
      ruleIds: Object.freeze([...rules]), protected: work.policy.protected })
    this.receipts.set(receipt, { work, output,
      outputDigest: captureNativeMessage(message, () => assertClock(work)).digest })
    return output
  }

  releaseWork(work: Work): void { this.pending.delete(work) }
  quarantineWork(work: Work): void { this.pending.add(work) }

  /** Private receipt relations only; this does not check or cache current permission. */
  matchesResultSource(receipt: FunctionNativeProtectionReceipt, message: BaseMessage,
    producer: object, sourceCurrent: FunctionNativeProtectionAdmission["assertCurrent"],
    signal: AbortSignal): boolean {
    const record = Reflect.apply(nativeWeakGet, this.receipts, [receipt]) as ReceiptRecord | undefined
    return !!record && record.work.owner === this && record.output.message === message &&
      record.work.admission.producer === producer &&
      record.work.originalSourceCurrent === sourceCurrent && record.work.admission.signal === signal
  }

  /** Complete receipt data after the same original source's full synchronous check. */
  assertResultData(receipt: FunctionNativeProtectionReceipt, message: BaseMessage,
    producer: object, sourceCurrent: FunctionNativeProtectionAdmission["assertCurrent"],
    signal: AbortSignal): void {
    const record = Reflect.apply(nativeWeakGet, this.receipts, [receipt]) as ReceiptRecord | undefined
    if (!record || record.work.owner !== this || record.output.message !== message ||
      record.work.admission.producer !== producer ||
      record.work.originalSourceCurrent !== sourceCurrent || record.work.admission.signal !== signal ||
      this.closed) fail("MODS_NATIVE_PROTECTION_IDENTITY")
    assertClock(record.work, false)
    if (captureNativeMessage(message, () => assertClock(record.work, false)).digest !== record.outputDigest)
      fail("MODS_NATIVE_PROTECTION_IDENTITY")
    if (captureNativeMessage(record.work.admission.message,
      () => assertClock(record.work, false)).digest !== record.work.snapshot.digest)
      fail("MODS_NATIVE_MESSAGE_CHANGED")
    if (this.closed) fail("MODS_NATIVE_PROTECTION_IDENTITY")
    assertClock(record.work, false)
  }

  /** Exact result provenance, including an explicitly inactive policy; this is not a redaction claim. */
  assertResult(receipt: FunctionNativeProtectionReceipt, message: BaseMessage, producer: object): void {
    const record = this.receipts.get(receipt)
    if (!record || record.output.message !== message || record.work.admission.producer !== producer ||
      this.closed ||
      captureNativeMessage(message, () => assertClock(record.work, false)).digest !== record.outputDigest)
      fail("MODS_NATIVE_PROTECTION_IDENTITY")
    assertWork(record.work, false)
  }

  assertProtected(receipt: FunctionNativeProtectionReceipt, message: BaseMessage, producer: object): void {
    this.assertResult(receipt, message, producer)
    if (!this.receipts.get(receipt)?.output.protected) fail("MODS_NATIVE_PROTECTION_IDENTITY")
  }

  /** Bind the exact private result to the actual policy, including explicitly inactive policy. */
  assertResultPolicy(result: FunctionProtectedNativeMessage, producer: object,
    actualPolicy: FunctionNativeProtectionPolicy): void {
    if (!result || typeof result !== "object" || types.isProxy(result))
      fail("MODS_NATIVE_PROTECTION_IDENTITY")
    const receipt = Object.getOwnPropertyDescriptor(result, "receipt")
    const message = Object.getOwnPropertyDescriptor(result, "message")
    if (!receipt || !("value" in receipt) || !message || !("value" in message))
      fail("MODS_NATIVE_PROTECTION_IDENTITY")
    const record = this.receipts.get(receipt.value)
    if (!record || record.output !== result || record.output.message !== message.value ||
      record.work.admission.producer !== producer ||
      !samePolicy(record.work.policy, policyCopy(actualPolicy)))
      fail("MODS_NATIVE_PROTECTION_IDENTITY")
    this.assertResult(receipt.value, message.value, producer)
    // The original source guard can synchronously change the caller's expected policy.
    if (this.closed || this.receipts.get(receipt.value) !== record || record.output !== result ||
      record.output.message !== message.value || record.work.admission.producer !== producer ||
      captureNativeMessage(message.value, () => assertClock(record.work, false)).digest !==
        record.outputDigest || !samePolicy(record.work.policy, policyCopy(actualPolicy)))
      fail("MODS_NATIVE_PROTECTION_IDENTITY")
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const work of this.pending) work.controller.abort(failure("MODS_NATIVE_PROTECTOR_CLOSED"))
  }

  async whenDrained(): Promise<void> {
    if ([...captureReservations].some(latch => latch.owner === this && latch.state === "capturing"))
      fail("MODS_NATIVE_PROTECTION_DRAIN_UNKNOWN")
    await Promise.all([...this.pending].map(async work => {
      if (!work.process) fail("MODS_NATIVE_PROTECTION_DRAIN_UNKNOWN")
      await Promise.all([work.terminal.promise, whenNativePolicyProcessWorkDrained(work.process)])
    }))
    if (this.quarantinedCaptures.size) fail("MODS_NATIVE_PROTECTION_DRAIN_UNKNOWN")
  }

  get stats(): Readonly<{ pending: number; running: number; quarantined: number }> {
    return Object.freeze({ pending: this.pending.size + this.quarantinedCaptures.size,
      running: [...this.pending].filter(work => work.state === "starting" || work.state === "running").length,
      quarantined: [...this.pending].filter(work => work.state === "quarantined").length +
        this.quarantinedCaptures.size })
  }
}
