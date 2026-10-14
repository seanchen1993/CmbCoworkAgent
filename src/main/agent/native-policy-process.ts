import { types } from "node:util"
import { Worker } from "node:worker_threads"
import { ModFunctionError } from "../../shared/mods/v2/contracts"

const reservationBrand = Symbol("native-policy-process-reservation")
const workBrand = Symbol("native-policy-process-work")
export interface NativePolicyProcessReservation { readonly [reservationBrand]: true }
export interface NativePolicyProcessWork { readonly [workBrand]: true }
export type NativePolicyProcessState = "captured" | "queued" | "starting" | "running" |
  "finishing" | "finished" | "quarantined"

/** Host-owned scheduling callbacks only. Their return values grant no policy or Message proof. */
export interface NativePolicyProcessCallbacks {
  assertCurrent(): void
  onStarting(): void
  createWorker(): Worker
  onWorker(worker: Worker): void
  createPacket(): unknown
  onResponse(response: unknown): void
  onCancel(error: unknown): void
  onFinish(exitCode?: number): "released" | "quarantined"
  onQuarantine(error: unknown): void
}

interface Reservation {
  readonly owner: object
  readonly token: NativePolicyProcessReservation
  state: "reserved" | "committed" | "released" | "quarantined"
}
interface Work {
  readonly reservation: Reservation
  readonly token: NativePolicyProcessWork
  readonly callbacks: Readonly<NativePolicyProcessCallbacks>
  readonly terminal: ReturnType<typeof deferred>
  state: NativePolicyProcessState
  worker?: Worker
  error?: unknown
  responseReceived: boolean
  cancelNotified: boolean
  callbackUncertain: boolean
  terminateStarted: boolean
  exited: boolean
}

export const NATIVE_POLICY_PROCESS_LIMITS = Object.freeze({ workers: 4, admissions: 256 })
const reservations = new WeakMap<NativePolicyProcessReservation, Reservation>()
const admissions = new Set<Reservation>()
const workRecords = new WeakMap<NativePolicyProcessWork, Work>()
const queue: Work[] = []
const workers = new Set<Work>()
const workerOwners = new WeakMap<Worker, Work>()
const nativeThen = Promise.prototype.then
const nativeBind = Function.prototype.bind

function failure(code: string): ModFunctionError { return new ModFunctionError(code) }
function fail(): never { throw failure("MODS_NATIVE_PROTECTION_IDENTITY") }
function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  void promise.catch(() => undefined)
  return { promise, resolve, reject }
}
function assertSync(value: unknown): void {
  if (!value || typeof value !== "object" && typeof value !== "function") return
  if (types.isProxy(value)) throw failure("MODS_NATIVE_PROTECTION_SYNC_REQUIRED")
  if (types.isPromise(value)) {
    const constructor = Object.getOwnPropertyDescriptor(value, "constructor")
    if (Object.getPrototypeOf(value) === Promise.prototype &&
      (!constructor || "value" in constructor && constructor.value === Promise))
      void nativeThen.call(value, undefined, () => undefined)
    throw failure("MODS_NATIVE_PROTECTION_SYNC_REQUIRED")
  }
  let current: object | null = value
  while (current) {
    if (types.isProxy(current)) throw failure("MODS_NATIVE_PROTECTION_SYNC_REQUIRED")
    const then = Object.getOwnPropertyDescriptor(current, "then")
    if (then && (!("value" in then) || typeof then.value === "function"))
      throw failure("MODS_NATIVE_PROTECTION_SYNC_REQUIRED")
    current = Object.getPrototypeOf(current)
  }
}
function actualReservation(token: NativePolicyProcessReservation): Reservation {
  const original = reservations.get(token)
  if (!original || original.token !== token) fail()
  return original
}
function actualWork(token: NativePolicyProcessWork): Work {
  const original = workRecords.get(token)
  if (!original || original.token !== token) fail()
  return original
}
function assertWorkSync(work: Work, value: unknown): void {
  try { assertSync(value) }
  catch (error) { work.callbackUncertain = true; throw error }
}
function assertVoid(work: Work, value: unknown): void {
  assertWorkSync(work, value)
  if (value !== undefined) {
    work.callbackUncertain = true
    throw failure("MODS_NATIVE_PROTECTION_SYNC_REQUIRED")
  }
}
function callbacks(input: NativePolicyProcessCallbacks): Readonly<NativePolicyProcessCallbacks> {
  if (!input || typeof input !== "object" || types.isProxy(input) ||
    Object.getPrototypeOf(input) !== Object.prototype) fail()
  const keys = ["assertCurrent", "onStarting", "createWorker", "onWorker", "createPacket",
    "onResponse", "onCancel", "onFinish", "onQuarantine"] as const
  if (Reflect.ownKeys(input).length !== keys.length) fail()
  const output: Record<string, unknown> = {}
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(input, key)
    if (!field || !("value" in field) || !field.enumerable ||
      typeof field.value !== "function" || types.isProxy(field.value)) fail()
    output[key] = Reflect.apply(nativeBind, field.value, [input])
  }
  return Object.freeze(output) as unknown as Readonly<NativePolicyProcessCallbacks>
}
function dequeue(work: Work): void {
  const index = queue.indexOf(work)
  if (index >= 0) queue.splice(index, 1)
}
function notifyCancellation(work: Work, error: unknown): void {
  work.error ??= error
  if (work.cancelNotified) return
  work.cancelNotified = true
  try { assertVoid(work, work.callbacks.onCancel(work.error)) }
  catch { work.error = failure("MODS_NATIVE_PROTECTION_SYNC_REQUIRED") }
}
function quarantine(work: Work, error: unknown): void {
  work.error ??= error
  work.state = "quarantined"
  work.reservation.state = "quarantined"
  dequeue(work)
  try { assertVoid(work, work.callbacks.onQuarantine(work.error)) }
  catch { /* No uncertain owner callback returns admission or Worker capacity. */ }
  work.terminal.reject(failure("MODS_NATIVE_PROTECTION_DRAIN_UNKNOWN"))
  if (work.exited) workers.delete(work)
  pump()
}
function finish(work: Work, exitCode?: number): void {
  if (work.state === "finished" || work.state === "quarantined" ||
    work.state === "finishing") return
  // A no-worker completion is a known never-started operation, never fabricated exit proof.
  if (work.worker && !work.exited) fail()
  work.state = "finishing"
  dequeue(work)
  let result: unknown
  try { result = work.callbacks.onFinish(exitCode); assertWorkSync(work, result) }
  catch (error) { quarantine(work, error); return }
  if (result !== "released" || work.callbackUncertain) {
    quarantine(work, failure("MODS_NATIVE_PROTECTION_DRAIN_UNKNOWN"))
    return
  }
  // The owner proves actual release in its original finally. No full callback follows this.
  work.state = "finished"
  work.reservation.state = "released"
  admissions.delete(work.reservation)
  workers.delete(work)
  work.terminal.resolve()
  pump()
}
function finishNeverStarted(work: Work): void {
  // Only the queue-start path calls this, before invoking the physical factory. Returning a
  // reserved slot is a never-started fact; the admission still needs the owner's actual release.
  if (work.worker) fail()
  workers.delete(work)
  finish(work)
}
function cancel(work: Work, error: unknown): void {
  if (work.state === "finished" || work.state === "quarantined") return
  notifyCancellation(work, error)
  const observed = actualWork(work.token).state
  if (observed === "finished" || observed === "quarantined") return
  if (work.state === "finishing" || work.state === "starting") return
  if (!work.worker) { finish(work); return }
  if (work.terminateStarted) return
  work.terminateStarted = true
  // Sending/settling termination is not the actual exit listener's proof.
  try {
    const termination = work.worker.terminate()
    void termination.catch(() => {
      notifyCancellation(work, failure("MODS_NATIVE_POLICY_TERMINATION_FAILED"))
    })
  } catch { notifyCancellation(work, failure("MODS_NATIVE_POLICY_TERMINATION_FAILED")) }
}
function pump(): void {
  // Reentrant factory/release calls preserve the original FIFO semantics. Each starting slot
  // is counted before any callback can start another protector's physical Worker.
  while (workers.size < NATIVE_POLICY_PROCESS_LIMITS.workers && queue.length) {
    const work = queue.shift()
    if (!work || work.state !== "queued") continue
    // Reserve the actual FIFO head before even the source guard can synchronously start
    // another brand's work. Factory-only reservation would permit a fifth physical Worker.
    work.state = "starting"
    workers.add(work)
    try {
      assertVoid(work, work.callbacks.onStarting())
      assertVoid(work, work.callbacks.assertCurrent())
    }
    catch (error) {
      // Factory has not been called: the driver knows no physical work was started.
      notifyCancellation(work, error)
      finishNeverStarted(work)
      continue
    }
    if (actualWork(work.token).state !== "starting" || work.cancelNotified) {
      finishNeverStarted(work)
      continue
    }
    let worker: Worker
    try {
      const created: unknown = work.callbacks.createWorker()
      if (!created || typeof created !== "object" || types.isProxy(created) ||
        !(created instanceof Worker)) {
        assertSync(created)
        throw failure("MODS_NATIVE_POLICY_FAILURE")
      }
      if (workerOwners.has(created)) throw failure("MODS_NATIVE_POLICY_FAILURE")
      worker = created
    } catch (error) { quarantine(work, error); continue }
    work.worker = worker
    workerOwners.set(worker, work)
    work.state = "running"
    let exitBound = false
    try {
      worker.once("exit", code => {
        work.exited = true
        // Actual exit returns only physical capacity. The owner's release can reenter the
        // FIFO while this admission is still finishing, or leave its admission quarantined.
        workers.delete(work)
        finish(work, code)
      })
      exitBound = true
      assertVoid(work, work.callbacks.onWorker(worker))
      worker.once("error", () => cancel(work, failure("MODS_NATIVE_POLICY_FAILURE")))
      worker.on("message", response => {
        if (work.state !== "running" || work.cancelNotified) return
        if (work.responseReceived) {
          cancel(work, failure("MODS_NATIVE_POLICY_RESPONSE"))
          return
        }
        work.responseReceived = true
        try {
          assertVoid(work, work.callbacks.assertCurrent())
          if (work.state !== "running" || work.cancelNotified) return
          assertVoid(work, work.callbacks.onResponse(response))
        } catch (error) { cancel(work, error) }
      })
      if (work.cancelNotified) { cancel(work, work.error); continue }
      assertVoid(work, work.callbacks.assertCurrent())
      if (work.state !== "running" || work.cancelNotified) continue
      const packet = work.callbacks.createPacket()
      assertWorkSync(work, packet)
      if (work.state !== "running" || work.cancelNotified) continue
      worker.postMessage(packet)
    } catch (error) {
      if (exitBound) cancel(work, error)
      else quarantine(work, error)
    }
  }
}

/** Reserve before the first external callback, including typed capture and actual retain. */
export function reserveNativePolicyProcessAdmission(owner: object): NativePolicyProcessReservation {
  if (!owner || typeof owner !== "object" || types.isProxy(owner)) fail()
  if (admissions.size >= NATIVE_POLICY_PROCESS_LIMITS.admissions)
    throw failure("MODS_NATIVE_PROTECTION_CAPACITY")
  const token: NativePolicyProcessReservation = Object.freeze({ [reservationBrand]: true as const })
  const record: Reservation = { owner, token, state: "reserved" }
  reservations.set(token, record)
  admissions.add(record)
  return token
}
export function commitNativePolicyProcessAdmission(reservation: NativePolicyProcessReservation,
  input: NativePolicyProcessCallbacks): NativePolicyProcessWork {
  const original = actualReservation(reservation)
  if (original.state !== "reserved" || !admissions.has(original)) fail()
  const fixed = callbacks(input)
  const token: NativePolicyProcessWork = Object.freeze({ [workBrand]: true as const })
  const work: Work = { reservation: original, token, callbacks: fixed, terminal: deferred(),
    state: "captured", responseReceived: false, cancelNotified: false, callbackUncertain: false,
    terminateStarted: false,
    exited: false }
  original.state = "committed"
  workRecords.set(token, work)
  return token
}
/** Only a known unsuccessful, uncommitted capture with proven release may call this. */
export function releaseNativePolicyCaptureReservation(token: NativePolicyProcessReservation): void {
  const original = actualReservation(token)
  if (original.state !== "reserved" || !admissions.has(original)) fail()
  original.state = "released"
  admissions.delete(original)
}
export function quarantineNativePolicyCaptureReservation(token: NativePolicyProcessReservation): void {
  const original = actualReservation(token)
  if (original.state !== "reserved" || !admissions.has(original)) fail()
  original.state = "quarantined"
}
export function startNativePolicyProcessWork(token: NativePolicyProcessWork, useWorker: boolean): void {
  const work = actualWork(token)
  if (typeof useWorker !== "boolean") fail()
  if (work.state !== "captured") return
  if (!useWorker) { finish(work); return }
  work.state = "queued"
  queue.push(work)
  pump()
}
export function cancelNativePolicyProcessWork(token: NativePolicyProcessWork, error: unknown): void {
  cancel(actualWork(token), error)
}
export function readNativePolicyProcessState(token: NativePolicyProcessWork): NativePolicyProcessState {
  return actualWork(token).state
}
export function whenNativePolicyProcessWorkDrained(token: NativePolicyProcessWork): Promise<void> {
  return actualWork(token).terminal.promise
}
