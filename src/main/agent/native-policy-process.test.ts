import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { Worker } from "node:worker_threads"
import { HumanMessage } from "@langchain/core/messages"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { FunctionNativeMessageProtector, type FunctionNativeProtectionAdmission } from
  "./native-message-protector"
import { createNativePolicyWorker } from "./native-policy-worker"
import { reserveNativePolicyProcessAdmission, commitNativePolicyProcessAdmission,
  releaseNativePolicyCaptureReservation, startNativePolicyProcessWork,
  cancelNativePolicyProcessWork, readNativePolicyProcessState,
  whenNativePolicyProcessWorkDrained, type NativePolicyProcessCallbacks,
  type NativePolicyProcessWork } from "./native-policy-process"

const physical = new Set<Worker>()
const jobs = new Set<NativePolicyProcessWork>()
const owners = new Set<FunctionNativeMessageProtector>()
function heldWorker(): Worker {
  const worker = new Worker(`const {parentPort}=require("node:worker_threads");
    parentPort.once("message",()=>{});setInterval(()=>{},1000)`, { eval: true })
  physical.add(worker)
  return worker
}
afterEach(async () => {
  for (const job of jobs) cancelNativePolicyProcessWork(job, new ModFunctionError("MODS_CANCELLED"))
  for (const owner of owners) owner.close()
  await Promise.allSettled([...physical].map(worker => Worker.prototype.terminate.call(worker)))
  await Promise.allSettled([...jobs].map(job => whenNativePolicyProcessWorkDrained(job)))
  await Promise.allSettled([...owners].map(owner => owner.whenDrained()))
  physical.clear(); jobs.clear(); owners.clear()
})

/** Independent host transport brand only; it is not a diagnostic or Message protection proof. */
function transport(options: Partial<NativePolicyProcessCallbacks> = {}) {
  const owner = {}, reservation = reserveNativePolicyProcessAdmission(owner)
  let retained = 1, cancelled = 0, completed = 0, quarantined = 0
  const callbacks: NativePolicyProcessCallbacks = {
    assertCurrent: () => undefined,
    onStarting: () => undefined,
    createWorker: heldWorker,
    onWorker: () => undefined,
    createPacket: () => ({ id: randomUUID(), typed: true }),
    onResponse: () => undefined,
    onCancel: () => { cancelled++ },
    onFinish: () => { completed++; retained--; return "released" },
    onQuarantine: () => { quarantined++ },
    ...options
  }
  const token = commitNativePolicyProcessAdmission(reservation, callbacks)
  jobs.add(token)
  return { token, reservation, callbacks, retained: () => retained,
    cancelled: () => cancelled, completed: () => completed, quarantined: () => quarantined,
    start: (active = true) => startNativePolicyProcessWork(token, active),
    cancel: () => cancelNativePolicyProcessWork(token, new ModFunctionError("MODS_CANCELLED")),
    drain: () => whenNativePolicyProcessWorkDrained(token) }
}
function message(active = true, createWorker = heldWorker, onAssertCurrent?: () => void) {
  const protector = new FunctionNativeMessageProtector({ createWorker })
  owners.add(protector)
  const controller = new AbortController()
  let retained = 0
  const admission: FunctionNativeProtectionAdmission = {
    message: new HumanMessage({ id: randomUUID(), content: "actual complete Message" }),
    producer: {}, policy: { identity: {}, protected: active, digest: "actual-process-test-policy",
      epoch: 1, deployment: { version: 1, id: "cmb.baseline/v1", required: active,
        redactLiterals: [], denyTools: [] } }, signal: controller.signal,
    assertCurrent() { onAssertCurrent?.(); controller.signal.throwIfAborted() },
    retainActualWork() { retained++; return () => { retained-- } },
    assertExecutionFacts() {}, inheritPresentation() {}
  }
  const capture = protector.capture(admission)
  return { protector, controller, admission, capture, retained: () => retained,
    start: () => protector.protect(capture) }
}

describe("shared native policy process scheduling", () => {
  it("keeps reservation/job addresses opaque and distinguishes never-started release from exit", async () => {
    const factory = vi.fn(heldWorker), f = transport({ createWorker: factory })
    expect(() => releaseNativePolicyCaptureReservation({ ...f.reservation })).toThrow()
    expect(() => commitNativePolicyProcessAdmission(f.reservation, f.callbacks)).toThrow()
    expect(() => releaseNativePolicyCaptureReservation(f.reservation)).toThrow()
    expect(() => readNativePolicyProcessState({ ...f.token })).toThrow()
    let traps = 0
    expect(() => readNativePolicyProcessState(new Proxy(f.token, {
      get() { traps++; return undefined }
    }))).toThrow()
    f.start(false)
    await f.drain()
    expect(factory).not.toHaveBeenCalled()
    expect(f.completed()).toBe(1)
    expect(f.retained()).toBe(0)
    expect(readNativePolicyProcessState(f.token)).toBe("finished")
    expect(traps).toBe(0)
  })

  it("shares all 256 initial/captured reservations with genuine Message captures", async () => {
    const transportCaptures = Array.from({ length: 128 }, () => transport())
    const first = message(false)
    const captures = [first.capture, ...Array.from({ length: 127 }, () =>
      first.protector.capture({ ...first.admission }))]
    expect(first.retained()).toBe(128)
    expect(() => reserveNativePolicyProcessAdmission({})).toThrow(expect.objectContaining({
      code: "MODS_NATIVE_PROTECTION_CAPACITY" }))
    expect(() => first.protector.capture({ ...first.admission })).toThrow(expect.objectContaining({
      code: "MODS_NATIVE_PROTECTION_CAPACITY" }))
    for (const f of transportCaptures) f.start(false)
    await Promise.all(captures.map(capture => first.protector.protect(capture)))
    await Promise.all(transportCaptures.map(f => f.drain()))
    expect(first.retained()).toBe(0)
    const fresh = reserveNativePolicyProcessAdmission({})
    releaseNativePolicyCaptureReservation(fresh)
  })

  it("shares four real Worker slots across Message and other host brands without queued cancel allocation", async () => {
    const native = [message(), message()], other = [transport(), transport()]
    const pending = native.map(f => f.start())
    for (const result of pending) void result.catch(() => undefined)
    for (const f of other) f.start()
    expect(native.map(f => f.protector.stats.running)).toEqual([1, 1])
    expect(other.map(f => readNativePolicyProcessState(f.token))).toEqual(["running", "running"])
    const factory = vi.fn(heldWorker), waiting = transport({ createWorker: factory })
    waiting.start()
    expect(readNativePolicyProcessState(waiting.token)).toBe("queued")
    expect(factory).not.toHaveBeenCalled()
    waiting.cancel()
    await waiting.drain()
    expect(waiting.cancelled()).toBe(1)
    expect(waiting.retained()).toBe(0)
    expect(factory).not.toHaveBeenCalled()
    for (const f of native) f.controller.abort(new ModFunctionError("MODS_CANCELLED"))
    for (const f of other) f.cancel()
    await Promise.all(pending.map(result => expect(result).rejects.toMatchObject({ code: "MODS_CANCELLED" })))
    await Promise.all(native.map(f => f.protector.whenDrained()))
    await Promise.all(other.map(f => f.drain()))
    expect(native.map(f => f.retained())).toEqual([0, 0])
  })

  it("uses one FIFO when a true exit frees a slot for a different host brand", async () => {
    const active = Array.from({ length: 4 }, () => transport())
    for (const f of active) f.start()
    const starts: string[] = []
    const queued = transport({ createWorker() { starts.push("other"); return heldWorker() } })
    queued.start()
    const native = message(true, () => { starts.push("Message"); return heldWorker() })
    const result = native.start()
    void result.catch(() => undefined)
    expect(starts).toEqual([])
    active[0].cancel()
    await active[0].drain()
    expect(starts).toEqual(["other"])
    queued.cancel()
    await queued.drain()
    expect(starts).toEqual(["other", "Message"])
    native.controller.abort(new ModFunctionError("MODS_CANCELLED"))
    await expect(result).rejects.toMatchObject({ code: "MODS_CANCELLED" })
    await native.protector.whenDrained()
  })

  it("counts the starting slot before a factory recursively starts the other available slots", () => {
    let started = 0
    const nested: ReturnType<typeof transport>[] = []
    const factory = () => { started++; return heldWorker() }
    const outer = transport({ createWorker() {
      const worker = factory()
      for (let index = 0; index < 4; index++) {
        const f = transport({ createWorker: factory }); nested.push(f); f.start()
      }
      expect(started).toBe(4)
      expect(readNativePolicyProcessState(nested[3].token)).toBe("queued")
      return worker
    } })
    outer.start()
    expect(started).toBe(4)
  })

  it("reserves the FIFO head before its actual source guard starts four cross-brand jobs", async () => {
    const starts: string[] = []
    const create = (name: string) => () => { starts.push(name); return heldWorker() }
    const other = [transport({ createWorker: create("other-1") }),
      transport({ createWorker: create("other-2") })]
    const native = [message(true, create("Message-1")), message(true, create("Message-2"))]
    const results: Array<ReturnType<ReturnType<typeof message>["start"]>> = []
    let entered = false
    const head = transport({ createWorker: create("head"), assertCurrent() {
      if (entered) return
      entered = true
      expect(readNativePolicyProcessState(head.token)).toBe("starting")
      other[0].start()
      results.push(native[0].start())
      other[1].start()
      results.push(native[1].start())
      for (const result of results) void result.catch(() => undefined)
      expect(starts).toEqual(["other-1", "Message-1", "other-2"])
      expect(native[1].protector.stats.running).toBe(0)
      expect(native[1].retained()).toBe(1)
    } })
    head.start()
    expect(starts).toEqual(["other-1", "Message-1", "other-2", "head"])
    expect(physical.size).toBe(4)
    other[0].cancel()
    await other[0].drain()
    expect(starts).toEqual(["other-1", "Message-1", "other-2", "head", "Message-2"])
    for (const f of native) f.controller.abort(new ModFunctionError("MODS_CANCELLED"))
    await Promise.all(results.map(result => expect(result).rejects.toMatchObject({ code: "MODS_CANCELLED" })))
    await Promise.all(native.map(f => f.protector.whenDrained()))
  })

  it("finishes a genuine Message source cancellation before factory as known never-started work", async () => {
    let armed = false
    const factory = vi.fn(heldWorker)
    const native = message(true, factory, () => {
      if (armed) native.controller.abort(new ModFunctionError("MODS_CANCELLED"))
    })
    expect(native.retained()).toBe(1)
    armed = true
    await expect(native.start()).rejects.toMatchObject({ code: "MODS_CANCELLED" })
    await native.protector.whenDrained()
    expect(factory).not.toHaveBeenCalled()
    expect(native.retained()).toBe(0)
    expect(native.protector.stats).toEqual({ pending: 0, running: 0, quarantined: 0 })
  })

  it("waits for actual exit when starting cancellation cannot terminate its returned real Worker", async () => {
    let worker: Worker | undefined
    const f = transport({ createWorker() {
      worker = heldWorker()
      Object.defineProperty(worker, "terminate", { value: () => Promise.reject(Error("held")) })
      f.cancel()
      expect(readNativePolicyProcessState(f.token)).toBe("starting")
      expect(f.retained()).toBe(1)
      return worker
    } })
    f.start()
    if (!worker) throw Error("ACTUAL_WORKER_REQUIRED")
    await once(worker, "online")
    let drained = false
    const terminal = f.drain().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    expect(readNativePolicyProcessState(f.token)).toBe("running")
    expect(f.retained()).toBe(1)
    await Worker.prototype.terminate.call(worker)
    await terminal
    expect(f.retained()).toBe(0)
  })

  it("latches finishing before a real owner release synchronously cancels itself", async () => {
    let finishes = 0, cancels = 0
    const f = transport({ onCancel() { cancels++ }, onFinish() {
      finishes++
      expect(readNativePolicyProcessState(f.token)).toBe("finishing")
      f.cancel()
      return "released"
    } })
    f.start(false)
    await f.drain()
    expect(finishes).toBe(1)
    expect(cancels).toBe(1)
    expect(readNativePolicyProcessState(f.token)).toBe("finished")
  })

  it("returns a real exited slot to the same FIFO before a finishing owner reenters it", async () => {
    const active = Array.from({ length: 3 }, () => transport())
    for (const f of active) f.start()
    const factory = vi.fn(heldWorker), queued = transport({ createWorker: factory })
    let observed = false
    const finishing = transport({ onFinish() {
      expect(readNativePolicyProcessState(finishing.token)).toBe("finishing")
      queued.start()
      expect(factory).toHaveBeenCalledTimes(1)
      expect(readNativePolicyProcessState(queued.token)).toBe("running")
      observed = true
      return "released"
    } })
    finishing.start()
    finishing.cancel()
    await finishing.drain()
    expect(observed).toBe(true)
  })

  it("keeps the genuine Message policy Worker and private result receipt unchanged", async () => {
    const native = message(true, () => {
      const worker = createNativePolicyWorker(); physical.add(worker); return worker
    })
    const result = await native.start()
    expect(result.message.content).toBe("actual complete Message")
    expect(result.protected).toBe(true)
    expect(result.ruleIds).toEqual(["baseline-v1"])
    native.protector.assertProtected(result.receipt, result.message, native.admission.producer)
    expect(() => native.protector.assertProtected({ ...result.receipt }, result.message,
      native.admission.producer)).toThrow()
    expect(native.retained()).toBe(0)
  })

  // Uncertain releases deliberately remain quarantined after the file; no reset hook exists.
  it("never calls an unknown then getter or returns capacity for an invalid actual release result", async () => {
    let getters = 0
    const uncertain = Object.defineProperty({}, "then", { get() { getters++; return () => {} } })
    const f = transport({ onFinish: (() => uncertain) as unknown as NativePolicyProcessCallbacks["onFinish"] })
    f.start(false)
    await expect(f.drain()).rejects.toMatchObject({ code: "MODS_NATIVE_PROTECTION_DRAIN_UNKNOWN" })
    expect(readNativePolicyProcessState(f.token)).toBe("quarantined")
    expect(f.quarantined()).toBe(1)
    expect(f.retained()).toBe(1)
    expect(getters).toBe(0)
    expect(() => releaseNativePolicyCaptureReservation(f.reservation)).toThrow()
  })
})
