import { once } from "node:events"
import { randomUUID } from "node:crypto"
import { Worker } from "node:worker_threads"
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage }
  from "@langchain/core/messages"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ModObject } from "../../shared/mods/types"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { ModGuestRuntime, type ModHostCall } from "../mods/guest-runtime"
import { captureNativeMessage } from "./native-message-capture"
import { serializeFunctionConversationNativeMessage } from "./function-conversation-native-message"
import { createNativePolicyWorker, NATIVE_POLICY_MIRROR_DIGEST,
  NATIVE_POLICY_MIRROR_VERSION } from "./native-policy-worker"
import { FunctionNativeMessageProtector, type FunctionNativeProtectionAdmission,
  type FunctionNativeProtectionPolicy, type FunctionProtectedNativeMessage }
  from "./native-message-protector"

// The application policy itself runs its actual fixed POLICY_CODE in real QuickJS. Only the
// Electron utility transport is replaced, so this golden does not compare the mirror to itself.
vi.mock("../mods/runtime-client", () => ({
  ModRuntimeClient: class {
    version = 0
    private readonly guests = new Map<string, ModGuestRuntime>()
    async load(id: string, code: string) {
      const guest = await ModGuestRuntime.create(code)
      this.guests.set(id, guest)
      return guest.registrations
    }
    invoke(id: string, handler: string, event: ModObject, call: ModHostCall) {
      const guest = this.guests.get(id)
      if (!guest) throw new Error("TEST_POLICY_NOT_LOADED")
      return guest.invoke(handler, event, call)
    }
    stop() {
      for (const guest of this.guests.values()) guest.dispose()
      this.guests.clear()
      this.version++
    }
  }
}))
import { DEFAULT_MOD_POLICY, ManagedModPolicy } from "../mods/policy"

const protectors = new Set<FunctionNativeMessageProtector>()
const workers = new Set<Worker>()
afterEach(async () => {
  for (const protector of protectors) protector.close()
  for (const worker of workers) await Worker.prototype.terminate.call(worker)
  for (const protector of protectors) await protector.whenDrained()
  workers.clear(); protectors.clear()
})

function actualWorker(): Worker {
  const worker = createNativePolicyWorker()
  workers.add(worker)
  return worker
}

function fixture(options: {
  message?: BaseMessage
  literals?: string[]
  protected?: boolean
  createWorker?: () => Worker
  signal?: AbortSignal
  expiresAtNs?: bigint
  inherit?: FunctionNativeProtectionAdmission["inheritPresentation"]
} = {}) {
  const deployment = { ...DEFAULT_MOD_POLICY, redactLiterals: options.literals ?? [] }
  const managed = new ManagedModPolicy(deployment)
  // Computing this original digest starts no policy VM or native Worker.
  const policy: FunctionNativeProtectionPolicy = { identity: managed,
    protected: options.protected ?? true, digest: managed.digest, epoch: 7, deployment }
  const source = {}, controller = new AbortController()
  const signal = options.signal ?? controller.signal
  let live = true, retained = 0, factsCalls = 0, actualEpoch = policy.epoch
  const message = options.message ?? new HumanMessage({ id: randomUUID(), content: "body" })
  const admission: FunctionNativeProtectionAdmission = {
    message, producer: source, policy, signal, expiresAtNs: options.expiresAtNs,
    assertCurrent() {
      if (!live) throw new ModFunctionError("MODS_TEST_SOURCE_EXPIRED")
      if (actualEpoch !== policy.epoch) throw new ModFunctionError("MODS_TEST_POLICY_CHANGED")
    },
    retainActualWork() {
      retained++
      let active = true
      return () => { if (!active) throw new Error("TEST_DOUBLE_RELEASE"); active = false; retained-- }
    },
    assertExecutionFacts(original, safe) {
      factsCalls++
      expect(Object.getPrototypeOf(safe)).toBe(Object.getPrototypeOf(original))
      expect(safe.id).toBe(original.id)
      expect(safe.name).toBe(original.name)
      if (ToolMessage.isInstance(original)) {
        expect(safe).toBeInstanceOf(ToolMessage)
        if (!ToolMessage.isInstance(safe)) throw new Error("TEST_WRONG_NATIVE_CLASS")
        expect(safe.tool_call_id).toBe(original.tool_call_id)
        expect(safe.status).toBe(original.status)
      }
      if (AIMessage.isInstance(original)) {
        if (!AIMessage.isInstance(safe)) throw new Error("TEST_WRONG_NATIVE_CLASS")
        expect(safe.tool_calls).toEqual(original.tool_calls)
        expect(safe.usage_metadata).toEqual(original.usage_metadata)
      }
    },
    inheritPresentation: options.inherit ?? (() => { /* No private presentation bit in this source. */ })
  }
  const protector = new FunctionNativeMessageProtector({
    createWorker: options.createWorker ?? actualWorker })
  protectors.add(protector)
  return { protector, managed, policy, admission, message, source, controller,
    invalidate: () => { live = false }, changePolicy: () => { actualEpoch++ },
    retained: () => retained, factsCalls: () => factsCalls }
}

function observable(message: BaseMessage): Record<string, unknown> {
  const value = { ...captureNativeMessage(message).data }
  for (const key of ["id", "name", "tool_call_id", "status"]) delete value[key]
  return value
}

describe("application-owned complete native protection", () => {
  it("matches only the original receipt source and signal without checking current permission", async () => {
    const f = fixture({ protected: false })
    const current = vi.fn(f.admission.assertCurrent)
    f.admission.assertCurrent = current
    const result = await f.protector.protect(f.protector.capture(f.admission))
    const calls = current.mock.calls.length
    expect(f.protector.matchesResultSource(result.receipt, result.message, f.source,
      current, f.admission.signal)).toBe(true)
    expect(f.protector.matchesResultSource({ ...result.receipt }, result.message, f.source,
      current, f.admission.signal)).toBe(false)
    expect(f.protector.matchesResultSource(result.receipt, result.message, {},
      current, f.admission.signal)).toBe(false)
    expect(f.protector.matchesResultSource(result.receipt, result.message, f.source,
      () => current(), f.admission.signal)).toBe(false)
    expect(f.protector.matchesResultSource(result.receipt, result.message, f.source,
      current, new AbortController().signal)).toBe(false)
    const other = fixture({ protected: false })
    expect(other.protector.matchesResultSource(result.receipt, result.message, f.source,
      current, f.admission.signal)).toBe(false)
    expect(() => f.protector.assertResultData(result.receipt, result.message, f.source,
      () => current(), f.admission.signal)).toThrow(expect.objectContaining({
      code: "MODS_NATIVE_PROTECTION_IDENTITY"
    }))
    expect(current).toHaveBeenCalledTimes(calls)
    f.invalidate()
    expect(f.protector.matchesResultSource(result.receipt, result.message, f.source,
      current, f.admission.signal)).toBe(true)
    expect(() => f.protector.assertResult(result.receipt, result.message, f.source))
      .toThrow(expect.objectContaining({ code: "MODS_NATIVE_PROTECTION_STALE" }))
  })

  it("keeps complete input and protected-output digests in the same-source data check", async () => {
    const f = fixture({ message: new HumanMessage({ id: randomUUID(), content: "private body" }),
      literals: ["private"] })
    const current = f.admission.assertCurrent
    const result = await f.protector.protect(f.protector.capture(f.admission))
    expect(result.message).not.toBe(f.message)
    const check = () => f.protector.assertResultData(result.receipt, result.message, f.source,
      current, f.admission.signal)
    expect(check).not.toThrow()
    const original = f.message.content, safe = result.message.content
    f.message.content = "Changed original input"
    expect(check).toThrow(expect.objectContaining({ code: "MODS_NATIVE_MESSAGE_CHANGED" }))
    f.message.content = original
    result.message.content = "Changed protected output"
    expect(check).toThrow(expect.objectContaining({ code: "MODS_NATIVE_PROTECTION_IDENTITY" }))
    result.message.content = safe
    expect(check).not.toThrow()
  })

  it.each(["close", "abort", "expiry"] as const)("keeps %s in the complete result data check", async kind => {
    const expiry = process.hrtime.bigint() + 60_000_000_000n
    const f = fixture({ protected: false, ...(kind === "expiry" ? { expiresAtNs: expiry } : {}) })
    const current = f.admission.assertCurrent
    const result = await f.protector.protect(f.protector.capture(f.admission))
    if (kind === "close") f.protector.close()
    if (kind === "abort") f.controller.abort(new ModFunctionError("MODS_CANCELLED"))
    const clock = kind === "expiry" ? vi.spyOn(process.hrtime, "bigint").mockReturnValue(expiry) : undefined
    try {
      expect(() => f.protector.assertResultData(result.receipt, result.message, f.source,
        current, f.admission.signal)).toThrow(expect.objectContaining({ code: kind === "close"
        ? "MODS_NATIVE_PROTECTION_IDENTITY" : kind === "abort" ? "MODS_CANCELLED"
          : "MODS_NATIVE_PROTECTION_TIMEOUT" }))
    } finally { clock?.mockRestore() }
  })

  it.each([true, false])("binds the exact original result to the full actual policy (%s)",
    async protectedOutput => {
      const f = fixture({ protected: protectedOutput, literals: ["private"] })
      const result = await f.protector.protect(f.protector.capture(f.admission))
      expect(() => f.protector.assertResultPolicy(result, f.source, f.policy)).not.toThrow()
      expect(() => f.protector.assertResultPolicy({ ...result }, f.source, f.policy)).toThrow()
      const changes: FunctionNativeProtectionPolicy[] = [
        { ...f.policy, identity: {} }, { ...f.policy, epoch: f.policy.epoch + 1 },
        { ...f.policy, digest: `${f.policy.digest}-other` },
        { ...f.policy, protected: !f.policy.protected },
        { ...f.policy, deployment: { ...f.policy.deployment, required: !f.policy.deployment.required } },
        { ...f.policy, deployment: { ...f.policy.deployment, redactLiterals: ["different"] } },
        { ...f.policy, deployment: { ...f.policy.deployment, denyTools: ["different-tool"] } }
      ]
      for (const policy of changes)
        expect(() => f.protector.assertResultPolicy(result, f.source, policy)).toThrow()
      expect(() => f.protector.assertResultPolicy(result, {}, f.policy)).toThrow()
      expect(f.retained()).toBe(0)
    })

  it("rejects result and policy accessors or proxies without invoking them", async () => {
    const f = fixture()
    const result = await f.protector.protect(f.protector.capture(f.admission))
    let calls = 0
    const fake = Object.defineProperty({}, "receipt", { get() { calls++; return result.receipt } })
    expect(() => f.protector.assertResultPolicy(fake as FunctionProtectedNativeMessage,
      f.source, f.policy)).toThrow()
    expect(() => f.protector.assertResultPolicy(new Proxy(result, {
      get(target, key) { calls++; return Reflect.get(target, key) }
    }), f.source, f.policy)).toThrow()
    const policy = Object.defineProperty({ ...f.policy }, "epoch", {
      get() { calls++; return f.policy.epoch }
    })
    expect(() => f.protector.assertResultPolicy(result, f.source, policy)).toThrow()
    expect(() => f.protector.assertResultPolicy(result, f.source, new Proxy(f.policy, {
      get(target, key) { calls++; return Reflect.get(target, key) }
    }))).toThrow()
    expect(calls).toBe(0)
  })

  it("rechecks the expected actual policy after the original source guard", async () => {
    const f = fixture()
    const policy = { ...f.policy }
    const original = f.admission.assertCurrent
    let mutate = false
    f.admission.assertCurrent = () => {
      original()
      if (mutate) policy.epoch++
    }
    const result = await f.protector.protect(f.protector.capture(f.admission))
    mutate = true
    expect(() => f.protector.assertResultPolicy(result, f.source, policy)).toThrow()
    mutate = false
    expect(() => f.protector.assertResultPolicy(result, f.source, f.policy)).not.toThrow()
  })

  it.each(["close", "safe-body"])("rejects source-guard synchronous %s before policy certification",
    async change => {
      const f = fixture()
      let effect: (() => void) | undefined
      const original = f.admission.assertCurrent
      f.admission.assertCurrent = () => { original(); effect?.() }
      const result = await f.protector.protect(f.protector.capture(f.admission))
      effect = change === "close" ? () => f.protector.close()
        : () => { result.message.content = "changed after original output digest" }
      expect(() => f.protector.assertResultPolicy(result, f.source, f.policy)).toThrow()
      expect(f.message.content).toBe("body")
    })

  it("executes two real passes with the original digest, literal order and rule insertion golden", async () => {
    const f = fixture({ literals: ["[REDACTED]", "ABC", "BC", "秘密"],
      message: new ToolMessage({ id: randomUUID(), tool_call_id: "native-call", status: "error",
        content: "sk-secret-123456789012345 Bearer abcDEF+/-= ABC 秘密 boundary:AKIA1234567890123456",
        artifact: { prefix: "ABC", password: "raw password", ordinary: ["ABC", "秘密"] },
        metadata: { DataURL: "raw upper-case media", stable: { retained: true } } }) })
    try {
      const golden = await f.managed.filter(observable(f.message))
      const capture = f.protector.capture(f.admission)
      expect(f.protector.capture(f.admission)).toBe(capture)
      const first = f.protector.protect(capture)
      expect(f.protector.protect(capture)).toBe(first)
      const result = await first
      expect(observable(result.message)).toEqual(golden.value)
      expect(result.ruleIds).toEqual(golden.ruleIds)
      expect(result.policyDigest).toBe(f.managed.digest)
      expect(NATIVE_POLICY_MIRROR_DIGEST).toMatch(/^[a-f0-9]{64}$/)
      expect(NATIVE_POLICY_MIRROR_DIGEST).not.toBe(result.policyDigest)
      expect(f.factsCalls()).toBe(1)
      expect(f.retained()).toBe(0)
      f.protector.assertProtected(result.receipt, result.message, f.source)
    } finally { f.managed.stop() }
  })

  it("protects a complete >1MiB string without cutting an arbitrary token or literal boundary", async () => {
    const prefix = "完整正文".repeat(160_000), token = `sk-${"A".repeat(4096)}`
    const f = fixture({ literals: ["late-secret"], message: new AIMessage({ id: randomUUID(),
      content: `${prefix}${token} late-secret tail`,
      response_metadata: { providerOccurrence: "native-response" } }) })
    const result = await f.protector.protect(f.protector.capture(f.admission))
    expect(result.message.content).toBe(`${prefix}[REDACTED] [REDACTED] tail`)
    expect(result.message.response_metadata).toEqual({ providerOccurrence: "native-response" })
    expect(Buffer.byteLength(serializeFunctionConversationNativeMessage(result.message), "utf8"))
      .toBeGreaterThan(1_048_576)
    expect(f.retained()).toBe(0)
  })

  it("keeps complete binary/media/artifact classification before toJSON", async () => {
    let rawCalls = 0
    const buffer = Buffer.from("raw bytes")
    Object.defineProperty(buffer, "toJSON", { value: () => { rawCalls++; return { leak: "raw" } } })
    const f = fixture({ message: new ToolMessage({ id: randomUUID(), tool_call_id: "actual-call",
      status: "success", content: [{ type: "image", source: { base64: "private" } }],
      artifact: { buffer, text: "Bearer original", secret: "private field", ordinary: { total: 41 } }
    }) })
    try {
      if (!ToolMessage.isInstance(f.message)) throw new Error("TEST_WRONG_NATIVE_CLASS")
      const golden = await f.managed.filter({ content: f.message.content,
        artifact: f.message.artifact })
      const result = await f.protector.protect(f.protector.capture(f.admission))
      expect(result.message.content).toEqual([
        { type: "text", text: "[Non-text output suppressed by project policy]" } ])
      if (!ToolMessage.isInstance(result.message)) throw new Error("TEST_WRONG_NATIVE_CLASS")
      expect({ content: result.message.content, artifact: result.message.artifact }).toEqual(golden.value)
      expect(result.ruleIds).toEqual(golden.ruleIds)
      expect(result.message.artifact).toEqual({ buffer: "[Binary output suppressed]",
        text: "Bearer [REDACTED]", secret: "[REDACTED]", ordinary: { total: 41 } })
      expect(result.message.status).toBe("success")
      expect(rawCalls).toBe(0)
    } finally { f.managed.stop() }
  })

  it("transfers an actual private is_error bit to the new protected Tool instance", async () => {
    const message = new ToolMessage({ id: randomUUID(), tool_call_id: "call", status: "success",
      content: "private body", artifact: { stable: "artifact", secret: "raw" } })
    const bits = new WeakMap<BaseMessage, boolean>([[message, true]])
    const f = fixture({ message, inherit(original, safe) {
      const bit = bits.get(original)
      if (bit !== undefined) bits.set(safe, bit)
    } })
    const result = await f.protector.protect(f.protector.capture(f.admission))
    expect(result.message).not.toBe(message)
    expect(bits.get(result.message)).toBe(true)
    if (!ToolMessage.isInstance(result.message)) throw new Error("TEST_WRONG_NATIVE_CLASS")
    expect(result.message.status).toBe("success")
    expect(message.artifact).toEqual({ stable: "artifact", secret: "raw" })
  })

  it.each(["secret-string", "actual-binary"])("rejects changed actual AI execution args (%s)", async kind => {
    const f = fixture({ literals: ["actual-private"], message: new AIMessage({ id: randomUUID(),
      content: "body", tool_calls: [{ id: "call", name: "actual-tool", type: "tool_call",
        args: { value: kind === "actual-binary" ? Buffer.from("native") : "actual-private" } }] }) })
    await expect(f.protector.protect(f.protector.capture(f.admission))).rejects.toMatchObject({
      code: "MODS_NATIVE_EXECUTION_REDACTION_REQUIRED" })
    expect(f.factsCalls()).toBe(0)
    expect(f.retained()).toBe(0)
  })

  it("preserves exact class/id/v1 normalized AI calls and full usage metadata", async () => {
    const message = new AIMessage({ id: randomUUID(), content: [{ type: "text", text: "body" }],
      response_metadata: { output_version: "v1", provider: "native" },
      tool_calls: [{ id: "call", name: "tool", args: { path: "ordinary" }, type: "tool_call" }],
      usage_metadata: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } })
    const f = fixture({ message })
    const result = await f.protector.protect(f.protector.capture(f.admission))
    expect(serializeFunctionConversationNativeMessage(result.message))
      .toBe(serializeFunctionConversationNativeMessage(message))
  })

  it("keeps inactive protection on the original native path without a Worker", async () => {
    const createWorker = vi.fn(actualWorker)
    const f = fixture({ protected: false, createWorker, message: new SystemMessage({
      id: randomUUID(), content: "sk-original-123456789012" }) })
    const result = await f.protector.protect(f.protector.capture(f.admission))
    expect(result.message).toBe(f.message)
    expect(result.protected).toBe(false)
    expect(result.ruleIds).toEqual([])
    expect(createWorker).not.toHaveBeenCalled()
    expect(() => f.protector.assertResult(result.receipt, result.message, f.source)).not.toThrow()
    expect(() => f.protector.assertProtected(result.receipt, result.message, f.source))
      .toThrow(expect.objectContaining({ code: "MODS_NATIVE_PROTECTION_IDENTITY" }))
  })

  it("keeps policy-off result identity, producer, mutation and current policy checks", async () => {
    const f = fixture({ protected: false })
    const result = await f.protector.protect(f.protector.capture(f.admission))
    expect(() => f.protector.assertResult({ ...result.receipt }, result.message, f.source))
      .toThrow(expect.objectContaining({ code: "MODS_NATIVE_PROTECTION_IDENTITY" }))
    expect(() => f.protector.assertResult(result.receipt, result.message, {}))
      .toThrow(expect.objectContaining({ code: "MODS_NATIVE_PROTECTION_IDENTITY" }))
    const copy = new HumanMessage({ id: result.message.id, content: result.message.content })
    expect(() => f.protector.assertResult(result.receipt, copy, f.source))
      .toThrow(expect.objectContaining({ code: "MODS_NATIVE_PROTECTION_IDENTITY" }))
    const original = result.message.content
    result.message.content = "changed safe native body"
    expect(() => f.protector.assertResult(result.receipt, result.message, f.source))
      .toThrow(expect.objectContaining({ code: "MODS_NATIVE_PROTECTION_IDENTITY" }))
    result.message.content = original
    expect(() => f.protector.assertResult(result.receipt, result.message, f.source)).not.toThrow()
    f.changePolicy()
    expect(() => f.protector.assertResult(result.receipt, result.message, f.source))
      .toThrow(expect.objectContaining({ code: "MODS_NATIVE_PROTECTION_STALE" }))
  })

  it("rejects a sparse native execution value before retain or Worker creation", () => {
    const sparse: unknown[] = new Array(4_294_967_295)
    sparse[4_294_967_294] = "actual tool argument"
    const createWorker = vi.fn(actualWorker)
    const f = fixture({ createWorker, message: new AIMessage({ id: randomUUID(), content: "body",
      tool_calls: [{ id: "call", name: "tool", type: "tool_call", args: { sparse } }] }) })
    expect(() => f.protector.capture(f.admission)).toThrow(expect.objectContaining({
      code: "MODS_NATIVE_CAPTURE_EXPANSION" }))
    expect(f.retained()).toBe(0)
    expect(f.protector.stats).toEqual({ pending: 0, running: 0, quarantined: 0 })
    expect(createWorker).not.toHaveBeenCalled()
  })

  it("rejects stale policy/source at actual Worker exit, without parent abort or adoption", async () => {
    let worker: Worker | undefined
    const f = fixture({ createWorker() {
      worker = new Worker(`const {parentPort}=require('node:worker_threads');
        parentPort.once('message',()=>{});setInterval(()=>{},1000)`, { eval: true })
      workers.add(worker)
      return worker
    } })
    const result = f.protector.protect(f.protector.capture(f.admission))
    if (!worker) throw new Error("TEST_WORKER_NOT_STARTED")
    await once(worker, "online")
    f.invalidate()
    await Worker.prototype.terminate.call(worker)
    await expect(result).rejects.toMatchObject({ code: "MODS_NATIVE_PROTECTION_STALE" })
    expect(f.controller.signal.aborted).toBe(false)
    expect(f.factsCalls()).toBe(0)
    expect(f.retained()).toBe(0)
  })

  it("waits for actual exit after a rejected termination attempt", async () => {
    let worker: Worker | undefined
    const f = fixture({ createWorker() {
      worker = new Worker(`const {parentPort}=require('node:worker_threads');
        parentPort.once('message',()=>{});setInterval(()=>{},1000)`, { eval: true })
      Object.defineProperty(worker, "terminate", { value: () => Promise.reject(new Error("failure")) })
      workers.add(worker)
      return worker
    } })
    const result = f.protector.protect(f.protector.capture(f.admission))
    if (!worker) throw new Error("TEST_WORKER_NOT_STARTED")
    await once(worker, "online")
    f.controller.abort(new ModFunctionError("MODS_PRIVATE_SECRET_CODE"))
    await expect(result).rejects.toMatchObject({ code: "MODS_CANCELLED" })
    expect(f.retained()).toBe(1)
    expect(f.protector.stats.running).toBe(1)
    let drained = false
    const terminal = f.protector.whenDrained().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    await Worker.prototype.terminate.call(worker)
    await terminal
    expect(f.retained()).toBe(0)
    expect(f.protector.stats.pending).toBe(0)
  })

  it("does not adopt a completed response after the actual policy epoch changes", async () => {
    const f = fixture({ createWorker() {
      const worker = actualWorker()
      worker.once("message", () => f.changePolicy())
      return worker
    } })
    const capture = f.protector.capture(f.admission)
    await expect(f.protector.protect(capture)).rejects.toMatchObject({
      code: "MODS_NATIVE_PROTECTION_STALE" })
    expect(f.factsCalls()).toBe(0)
    // Caller rejection precedes the real Worker exit on this response/cancellation path.
    await f.protector.whenDrained()
    expect(f.retained()).toBe(0)
  })

  it("rejects a mismatched private Worker response and does not adopt it", async () => {
    const f = fixture({ createWorker() {
      const worker = new Worker(`const {parentPort}=require('node:worker_threads');
        parentPort.once('message',request=>{parentPort.postMessage({id:'wrong',
          version:${JSON.stringify(NATIVE_POLICY_MIRROR_VERSION)},ok:true,value:request.value,
          ruleIds:['baseline-v1']});parentPort.close()})`, { eval: true })
      workers.add(worker)
      return worker
    } })
    await expect(f.protector.protect(f.protector.capture(f.admission))).rejects.toMatchObject({
      code: "MODS_NATIVE_POLICY_RESPONSE" })
    expect(f.factsCalls()).toBe(0)
    expect(f.retained()).toBe(0)
  })

  it("keeps receipt identity private and rejects a mutated safe instance", async () => {
    const f = fixture()
    const result = await f.protector.protect(f.protector.capture(f.admission))
    expect(() => f.protector.assertProtected({ ...result.receipt }, result.message, f.source))
      .toThrow(expect.objectContaining({ code: "MODS_NATIVE_PROTECTION_IDENTITY" }))
    expect(() => f.protector.assertProtected(result.receipt, result.message, {}))
      .toThrow(expect.objectContaining({ code: "MODS_NATIVE_PROTECTION_IDENTITY" }))
    result.message.content = "new raw body"
    expect(() => f.protector.assertProtected(result.receipt, result.message, f.source))
      .toThrow(expect.objectContaining({ code: "MODS_NATIVE_PROTECTION_IDENTITY" }))
  })

  it("rejects raw method overrides before starting a Worker or actual retained work", () => {
    let rawCalls = 0
    const message = new HumanMessage({ id: randomUUID(), content: "raw body" })
    Object.defineProperty(message, "toJSON", { value: () => { rawCalls++; return {} } })
    const createWorker = vi.fn(actualWorker), f = fixture({ message, createWorker })
    expect(() => f.protector.capture(f.admission)).toThrow(expect.objectContaining({
      code: "MODS_NATIVE_CAPTURE_TYPE" }))
    expect(rawCalls).toBe(0)
    expect(createWorker).not.toHaveBeenCalled()
    expect(f.retained()).toBe(0)
  })

  it("honors a shorter absolute native cut without giving the source a new deadline", async () => {
    const createWorker = vi.fn(actualWorker)
    const f = fixture({ expiresAtNs: process.hrtime.bigint() - 1n, createWorker })
    await expect(Promise.resolve().then(() => f.protector.protect(f.protector.capture(f.admission))))
      .rejects.toMatchObject({
        code: "MODS_NATIVE_PROTECTION_TIMEOUT" })
    expect(createWorker).not.toHaveBeenCalled()
    expect(f.controller.signal.aborted).toBe(false)
    expect(f.retained()).toBe(0)
  })

  it("shares four actual Worker slots across owners and removes cancelled queued admissions", async () => {
    const running = Array.from({ length: 4 }, () => fixture({ createWorker() {
      const worker = new Worker(`const {parentPort}=require('node:worker_threads');
        parentPort.once('message',()=>{});setInterval(()=>{},1000)`, { eval: true })
      workers.add(worker)
      return worker
    } }))
    const active = running.map(f => f.protector.protect(f.protector.capture(f.admission)))
    const createWorker = vi.fn(actualWorker), queued = fixture({ createWorker })
    const pending = queued.protector.protect(queued.protector.capture(queued.admission))
    expect(createWorker).not.toHaveBeenCalled()
    expect(queued.retained()).toBe(1)
    queued.controller.abort(new ModFunctionError("MODS_CANCELLED"))
    await expect(pending).rejects.toMatchObject({ code: "MODS_CANCELLED" })
    await queued.protector.whenDrained()
    expect(queued.protector.stats.pending).toBe(0)
    for (const f of running) f.controller.abort(new ModFunctionError("MODS_CANCELLED"))
    await Promise.all(active.map(promise => expect(promise).rejects.toMatchObject({
      code: "MODS_CANCELLED" })))
    await Promise.all(running.map(f => f.protector.whenDrained()))
    expect(createWorker).not.toHaveBeenCalled()
  })

  it("bounds pending native admissions rather than cumulative completed native history", async () => {
    const f = fixture({ protected: false })
    const captures = Array.from({ length: 256 }, () => f.protector.capture({ ...f.admission }))
    expect(f.retained()).toBe(256)
    expect(() => f.protector.capture({ ...f.admission })).toThrow(expect.objectContaining({
      code: "MODS_NATIVE_PROTECTION_CAPACITY" }))
    await Promise.all(captures.map(capture => f.protector.protect(capture)))
    expect(f.retained()).toBe(0)
    await f.protector.protect(f.protector.capture({ ...f.admission }))
    expect(f.retained()).toBe(0)
  })

  it("keeps a synchronously closed factory admission until its returned real Worker exits", async () => {
    let worker: Worker | undefined, duringClose = -1
    const f = fixture({ createWorker() {
      worker = new Worker(`const {parentPort}=require('node:worker_threads');
        parentPort.once('message',()=>{});setInterval(()=>{},1000)`, { eval: true })
      Object.defineProperty(worker, "terminate", { value: () => Promise.reject(new Error("held")) })
      workers.add(worker)
      f.protector.close()
      duringClose = f.retained()
      expect(f.protector.stats).toEqual({ pending: 1, running: 1, quarantined: 0 })
      return worker
    } })
    const result = f.protector.protect(f.protector.capture(f.admission))
    await expect(result).rejects.toMatchObject({ code: "MODS_NATIVE_PROTECTOR_CLOSED" })
    if (!worker) throw new Error("TEST_WORKER_NOT_STARTED")
    await once(worker, "online")
    expect(duringClose).toBe(1)
    expect(f.retained()).toBe(1)
    expect(f.protector.stats.running).toBe(1)
    expect(f.factsCalls()).toBe(0)
    await Worker.prototype.terminate.call(worker)
    await f.protector.whenDrained()
    expect(f.retained()).toBe(0)
    expect(f.protector.stats).toEqual({ pending: 0, running: 0, quarantined: 0 })
  })

  it("reserves the shared fourth Worker slot before a factory starts nested native admissions", async () => {
    let started = 0
    const heldWorker = () => {
      started++
      const worker = new Worker(`const {parentPort}=require('node:worker_threads');
        parentPort.once('message',()=>{});setInterval(()=>{},1000)`, { eval: true })
      workers.add(worker)
      return worker
    }
    const nested: ReturnType<typeof fixture>[] = []
    const pending: ReturnType<FunctionNativeMessageProtector["protect"]>[] = []
    const outer = fixture({ createWorker() {
      const worker = heldWorker()
      for (let index = 0; index < 4; index++) {
        const child = fixture({ createWorker: heldWorker })
        nested.push(child)
        pending.push(child.protector.protect(child.protector.capture(child.admission)))
      }
      expect(started).toBe(4)
      expect(nested[3]?.protector.stats.running).toBe(0)
      return worker
    } })
    pending.push(outer.protector.protect(outer.protector.capture(outer.admission)))
    expect(started).toBe(4)
    for (const owner of [outer, ...nested]) owner.controller.abort(new ModFunctionError("MODS_CANCELLED"))
    await Promise.all(pending.map(result => expect(result).rejects.toMatchObject({ code: "MODS_CANCELLED" })))
    await Promise.all([outer, ...nested].map(owner => owner.protector.whenDrained()))
    expect(started).toBe(4)
    expect([outer, ...nested].map(owner => owner.retained())).toEqual([0, 0, 0, 0, 0])
  })

  it.each(["guard", "retain"])("latches synchronous native capture reentry before %s", phase => {
    const createWorker = vi.fn(actualWorker), f = fixture({ createWorker })
    const guard = f.admission.assertCurrent.bind(f.admission)
    const retain = f.admission.retainActualWork.bind(f.admission)
    let attempts = 0
    const reenter = () => {
      attempts++
      expect(() => f.protector.capture(f.admission)).toThrow(expect.objectContaining({
        code: "MODS_NATIVE_CAPTURE_REENTRANT" }))
    }
    if (phase === "guard") f.admission.assertCurrent = () => { guard(); reenter() }
    else f.admission.retainActualWork = () => { const release = retain(); reenter(); return release }
    expect(() => f.protector.capture(f.admission)).toThrow(expect.objectContaining({
      code: "MODS_NATIVE_CAPTURE_REENTRANT" }))
    expect(() => f.protector.capture(f.admission)).toThrow(expect.objectContaining({
      code: "MODS_NATIVE_CAPTURE_REENTRANT" }))
    expect(attempts).toBe(1)
    expect(f.retained()).toBe(0)
    expect(f.protector.stats.pending).toBe(0)
    expect(createWorker).not.toHaveBeenCalled()
  })

  it.each(["guard", "retain"])("does not adopt when %s synchronously closes its owner", phase => {
    const createWorker = vi.fn(actualWorker), f = fixture({ createWorker })
    const guard = f.admission.assertCurrent.bind(f.admission)
    const retain = f.admission.retainActualWork.bind(f.admission)
    if (phase === "guard") f.admission.assertCurrent = () => { guard(); f.protector.close() }
    else f.admission.retainActualWork = () => {
      const release = retain(); f.protector.close(); return release
    }
    expect(() => f.protector.capture(f.admission)).toThrow(expect.objectContaining({
      code: "MODS_NATIVE_PROTECTOR_CLOSED" }))
    expect(f.retained()).toBe(0)
    expect(f.protector.stats.pending).toBe(0)
    expect(createWorker).not.toHaveBeenCalled()
  })

  it("observes an actual rejected native Promise guard but does not admit async work", async () => {
    const createWorker = vi.fn(actualWorker), f = fixture({ createWorker })
    const unhandled: unknown[] = []
    const listener = (error: unknown) => { unhandled.push(error) }
    process.on("unhandledRejection", listener)
    try {
      f.admission.assertCurrent = async () => { throw new Error("private async guard") }
      expect(() => f.protector.capture(f.admission)).toThrow(expect.objectContaining({
        code: "MODS_NATIVE_PROTECTION_SYNC_REQUIRED" }))
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(unhandled).toEqual([])
      expect(f.retained()).toBe(0)
      expect(createWorker).not.toHaveBeenCalled()
    } finally { process.off("unhandledRejection", listener) }
  })

  it("does not execute an ordinary then getter returned by a native guard", () => {
    const f = fixture(), value = {}, getter = vi.fn(() => Promise.resolve())
    Object.defineProperty(value, "then", { get: getter })
    Object.defineProperty(f.admission, "assertCurrent", { value: () => value })
    expect(() => f.protector.capture(f.admission)).toThrow(expect.objectContaining({
      code: "MODS_NATIVE_PROTECTION_SYNC_REQUIRED" }))
    expect(getter).not.toHaveBeenCalled()
    expect(f.retained()).toBe(0)
  })

  it("maps legal-shaped private error codes at guard and signal boundaries to fixed codes", () => {
    const guarded = fixture(), aborted = fixture()
    guarded.admission.assertCurrent = () => {
      throw new ModFunctionError("MODS_PRIVATE_SECRET_CODE", "private source body")
    }
    expect(() => guarded.protector.capture(guarded.admission)).toThrow(expect.objectContaining({
      code: "MODS_NATIVE_PROTECTION_STALE" }))
    aborted.controller.abort(new ModFunctionError("MODS_SECRET_CANARY", "private signal body"))
    expect(() => aborted.protector.capture(aborted.admission)).toThrow(expect.objectContaining({
      code: "MODS_CANCELLED" }))
    expect(guarded.retained()).toBe(0)
    expect(aborted.retained()).toBe(0)
  })

  it.each(["assertExecutionFacts", "inheritPresentation"] as const)(
    "rejects an async %s callback and waits for the actual Worker exit", async method => {
      const f = fixture(), callback = vi.fn(async () => { throw new Error("private async callback") })
      Object.defineProperty(f.admission, method, { value: callback })
      await expect(f.protector.protect(f.protector.capture(f.admission))).rejects.toMatchObject({
        code: "MODS_NATIVE_PROTECTION_SYNC_REQUIRED" })
      await f.protector.whenDrained()
      expect(callback).toHaveBeenCalledTimes(1)
      expect(f.retained()).toBe(0)
    }
  )

  it.each(["assertExecutionFacts", "inheritPresentation", "release"] as const)(
    "keeps a synchronous %s owner close terminal without reentering actual release", async method => {
      const f = fixture({ protected: method !== "release" })
      const retain = f.admission.retainActualWork.bind(f.admission)
      const release = vi.fn(() => { /* Filled with the actual retain's release below. */ })
      f.admission.retainActualWork = () => {
        const actualRelease = retain()
        release.mockImplementation(() => {
          if (method === "release") f.protector.close()
          actualRelease()
        })
        return release
      }
      if (method !== "release") Object.defineProperty(f.admission, method, {
        value: () => { f.protector.close() } })
      await expect(f.protector.protect(f.protector.capture(f.admission))).rejects.toMatchObject({
        code: "MODS_NATIVE_PROTECTOR_CLOSED" })
      await f.protector.whenDrained()
      expect(release).toHaveBeenCalledTimes(1)
      expect(f.retained()).toBe(0)
      expect(f.protector.stats).toEqual({ pending: 0, running: 0, quarantined: 0 })
    }
  )

  // These uncertain host-finally cases deliberately keep global credit. They follow the exact
  // 256-admission test so no fake global reset is needed to exercise that capacity boundary.
  it("quarantines an actual async retain without retrying or borrowing its reservation", async () => {
    const protector = new FunctionNativeMessageProtector(), f = fixture({ protected: false })
    const retain = vi.fn(async () => () => { /* Unknown host release was never accepted. */ })
    const admission = { ...f.admission }
    Object.defineProperty(admission, "retainActualWork", { value: retain })
    expect(() => protector.capture(admission)).toThrow(expect.objectContaining({
      code: "MODS_NATIVE_PROTECTION_SYNC_REQUIRED" }))
    expect(() => protector.capture(admission)).toThrow(expect.objectContaining({
      code: "MODS_NATIVE_PROTECTION_SYNC_REQUIRED" }))
    await expect(protector.whenDrained()).rejects.toMatchObject({
      code: "MODS_NATIVE_PROTECTION_DRAIN_UNKNOWN" })
    expect(protector.stats).toEqual({ pending: 1, running: 0, quarantined: 1 })
    protector.close()
    expect(retain).toHaveBeenCalledTimes(1)
  })

  it("quarantines an async actual release after real work without treating Promise return as drain", async () => {
    const protector = new FunctionNativeMessageProtector(), f = fixture({ protected: false })
    const release = vi.fn(async () => { throw new Error("private async release") })
    const capture = protector.capture({ ...f.admission, retainActualWork: () => release })
    await expect(protector.protect(capture)).rejects.toMatchObject({
      code: "MODS_NATIVE_PROTECTION_DRAIN_UNKNOWN" })
    await expect(protector.whenDrained()).rejects.toMatchObject({
      code: "MODS_NATIVE_PROTECTION_DRAIN_UNKNOWN" })
    expect(protector.stats).toEqual({ pending: 1, running: 0, quarantined: 1 })
    protector.close()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it("retains a failed actual release as quarantined work without retrying it", async () => {
    const protector = new FunctionNativeMessageProtector()
    const f = fixture({ protected: false })
    const release = vi.fn(() => { throw new ModFunctionError("MODS_SECRET_CANARY") })
    const capture = protector.capture({ ...f.admission, retainActualWork: () => release })
    await expect(protector.protect(capture)).rejects.toMatchObject({
      code: "MODS_NATIVE_PROTECTION_DRAIN_UNKNOWN" })
    await expect(protector.whenDrained()).rejects.toMatchObject({
      code: "MODS_NATIVE_PROTECTION_DRAIN_UNKNOWN" })
    expect(protector.stats).toEqual({ pending: 1, running: 0, quarantined: 1 })
    protector.close()
    expect(release).toHaveBeenCalledTimes(1)
    // Quarantine deliberately keeps global credit; there is no fake test reset or retry.
  })

  it.each(["throw", "promise", "proxy", "then-getter"])(
    "does not claim an unknown factory outcome as physical completion (%s)", async kind => {
      let traps = 0
      let calls = 0
      const f = fixture({ protected: false }), options = { createWorker: actualWorker }
      // tinyspy inspects returned values with instanceof Promise before returning them to the
      // subject. Use the actual synchronous factory so its Proxy is first seen by production.
      const createWorker = () => {
        calls++
        if (kind === "throw") throw new Error("unknown physical work private body")
        if (kind === "promise") return Promise.reject(new Error("private async factory"))
        if (kind === "proxy") return new Proxy({}, {
          getPrototypeOf() { traps++; return Worker.prototype }
        })
        return Object.defineProperty({}, "then", { get() { traps++; return () => undefined } })
      }
      Object.defineProperty(options, "createWorker", { value: createWorker })
      const protector = new FunctionNativeMessageProtector(options)
      const capture = protector.capture({ ...f.admission, policy: { ...f.policy, protected: true } })
      await expect(protector.protect(capture)).rejects.toMatchObject({
        code: kind === "throw" ? "MODS_NATIVE_POLICY_FAILURE" : "MODS_NATIVE_PROTECTION_SYNC_REQUIRED" })
      await expect(protector.whenDrained()).rejects.toMatchObject({
        code: "MODS_NATIVE_PROTECTION_DRAIN_UNKNOWN" })
      expect(protector.stats).toEqual({ pending: 1, running: 0, quarantined: 1 })
      expect(f.retained()).toBe(1)
      expect(traps).toBe(0)
      protector.close()
      expect(calls).toBe(1)
      // No physical completion receipt exists. The final four unknowns retain all Worker credit.
    }
  )
})
