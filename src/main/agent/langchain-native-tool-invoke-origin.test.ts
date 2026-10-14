import { BaseCallbackHandler } from "@langchain/core/callbacks/base"
import { BaseMessage, ToolMessage } from "@langchain/core/messages"
import type { ToolCall } from "@langchain/core/messages"
import type { RunnableConfig } from "@langchain/core/runnables"
import { ToolInputParsingException } from "@langchain/core/tools"
import { GraphInterrupt } from "@langchain/langgraph"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"
import { createAgent, createMiddleware, FakeToolCallingModel, tool } from "langchain"
import {
  createNativeToolInvokeAgent, createNativeToolInvokeOperation, executeNativeToolInvokeOperation,
  readNativeToolInvokeSelections, readNativeToolInvokeSelection, readNativeToolInvokeOutcome,
  closeAndDrainNativeToolInvokeOperation, type NativeToolInvokeOperation
} from "langchain/native-tool-invoke-origin"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

const invalid = "LANGCHAIN_NATIVE_TOOL_INVOKE_ORIGIN_INVALID"
const require = createRequire(import.meta.url)
interface DirectNode {
  runTool(call: ToolCall, config: RunnableConfig, state: unknown): Promise<unknown>
}
interface DirectNodeConstructor {
  new(tools: unknown[], options?: { signal?: AbortSignal; wrapToolCall?: unknown; handleToolErrors?: unknown }): DirectNode
}
async function nodeConstructor(): Promise<DirectNodeConstructor> {
  const module: unknown = await import(pathToFileURL(join(dirname(require.resolve("langchain/package.json")), "dist/agents/nodes/ToolNode.js")).href)
  if (!module || typeof module !== "object") throw Error("ACTUAL_SDK_NODE_MODULE_REQUIRED")
  const value: unknown = Object.getOwnPropertyDescriptor(module, "ToolNode")?.value
  if (typeof value !== "function") throw Error("ACTUAL_SDK_NODE_CONSTRUCTOR_REQUIRED")
  return value as DirectNodeConstructor
}
const runs: Promise<unknown>[] = []
const operations: NativeToolInvokeOperation[] = []
const releases: Array<() => void> = []
const controllers: AbortController[] = []
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort()
  for (const release of releases.splice(0)) release()
  await Promise.allSettled(runs.splice(0))
  await Promise.allSettled(operations.splice(0).map(closeAndDrainNativeToolInvokeOperation))
  vi.restoreAllMocks()
})
class Observer extends BaseCallbackHandler {
  name = "selected-invoke-reference"
  order: string[] = []
  errors: unknown[] = []
  handleToolStart() { this.order.push("start") }
  handleToolEnd() { this.order.push("end") }
  handleToolError(reason: unknown) { this.order.push("error"); this.errors.push(reason) }
}
function retain<T>(promise: Promise<T>): Promise<T> { runs.push(promise); return promise }
function config(observer?: BaseCallbackHandler) {
  const controller = new AbortController()
  controllers.push(controller)
  const state = { messages: [], fixtureState: "original-state" }
  const value: RunnableConfig = {
    callbacks: observer ? [observer] : [], tags: ["selected-invoke"], metadata: { fixture: true },
    signal: controller.signal, configurable: { __pregel_scratchpad: { currentTaskInput: state } }
  }
  return { controller, state, value }
}
function call(name = "declared", args: ToolCall["args"] = { text: "original" }): ToolCall {
  return { name, args, id: "actual-tool-call", type: "tool_call" }
}
function codec(value: unknown) {
  if (!(value instanceof BaseMessage)) throw Error("ACTUAL_NATIVE_TOOL_MESSAGE_REQUIRED")
  return value.toDict()
}
function selection(operation: NativeToolInvokeOperation) {
  const selections = readNativeToolInvokeSelections(operation)
  expect(selections).toHaveLength(1)
  const facts = readNativeToolInvokeSelection(selections[0], operation)
  expect(facts?.status).toBe("settled")
  if (!facts?.outcome) throw Error("ACTUAL_SETTLED_INVOKE_REQUIRED")
  const outcome = readNativeToolInvokeOutcome(facts.outcome, selections[0], operation)
  expect(outcome).toBeDefined()
  return { facts, outcome }
}

describe("SDK selected original invoke settlement without application permission", () => {
  it("matches an unwrapped ToolNode full codec and original callback order", async () => {
    const Node = await nodeConstructor()
    const ordinaryObserver = new Observer(), nativeObserver = new Observer()
    const ordinaryConfig = config(ordinaryObserver), nativeConfig = config(nativeObserver)
    const effects: string[] = []
    const declared = tool(async ({ text }) => { effects.push(text); return "actual-result" }, { name: "declared", description: "synthetic reference", schema: z.object({ text: z.string() }) })
    const node = new Node([declared], { signal: ordinaryConfig.controller.signal })
    const ordinary = await retain(node.runTool(call(), ordinaryConfig.value, ordinaryConfig.state))
    const agent = createNativeToolInvokeAgent({ model: new FakeToolCallingModel({ toolCalls: [[]] }), tools: [declared], signal: nativeConfig.controller.signal })
    const operation = createNativeToolInvokeOperation(agent, call(), nativeConfig.value, nativeConfig.state)
    operations.push(operation)
    const native = await retain(executeNativeToolInvokeOperation(operation))
    expect(codec(native)).toStrictEqual(codec(ordinary))
    expect(nativeObserver.order).toStrictEqual(ordinaryObserver.order)
    expect(nativeObserver.errors).toStrictEqual(ordinaryObserver.errors)
    expect(effects).toStrictEqual(["original", "original"])
    const { facts, outcome } = selection(operation)
    expect(facts.tool).toBe(declared)
    expect(facts.receiver).toBe(declared)
    expect(facts.invoke).toBe(declared.invoke)
    expect(outcome?.status).toBe("fulfilled")
    expect(await closeAndDrainNativeToolInvokeOperation(operation)).toBeUndefined()
  })
  it.each([undefined, null])("records the exact raw rejected reason %s before the original handler", async reason => {
    const Node = await nodeConstructor()
    const ordinaryObserver = new Observer(), nativeObserver = new Observer()
    const ordinaryConfig = config(ordinaryObserver), nativeConfig = config(nativeObserver)
    const declared = tool(async () => { throw reason }, { name: "declared", description: "synthetic rejection", schema: z.object({ text: z.string() }) })
    const [ordinary] = await Promise.allSettled([
      retain(new Node([declared], { signal: ordinaryConfig.controller.signal }).runTool(call(), ordinaryConfig.value, ordinaryConfig.state))
    ])
    const agent = createNativeToolInvokeAgent({ model: new FakeToolCallingModel({ toolCalls: [[]] }), tools: [declared], signal: nativeConfig.controller.signal })
    const operation = createNativeToolInvokeOperation(agent, call(), nativeConfig.value, nativeConfig.state)
    operations.push(operation)
    const [native] = await Promise.allSettled([retain(executeNativeToolInvokeOperation(operation))])
    expect(nativeObserver.order).toStrictEqual(ordinaryObserver.order)
    expect(nativeObserver.errors).toStrictEqual(ordinaryObserver.errors)
    const outcome = selection(operation).outcome
    expect(outcome?.status).toBe("rejected")
    if (outcome?.status !== "rejected") throw Error("RAW_REJECTION_REQUIRED")
    expect(outcome.reason).toBe(reason)
    const [drained] = await Promise.allSettled([closeAndDrainNativeToolInvokeOperation(operation)])
    expect(drained.status).toBe("rejected")
    if (drained.status !== "rejected") throw Error("ACTUAL_TICKET_FAILURE_REQUIRED")
    if (reason === undefined) {
      expect(ordinary.status).toBe("fulfilled")
      expect(native.status).toBe("fulfilled")
      if (ordinary.status !== "fulfilled" || native.status !== "fulfilled")
        throw Error("ORIGINAL_UNDEFINED_HANDLER_MESSAGE_REQUIRED")
      expect(codec(native.value)).toStrictEqual(codec(ordinary.value))
      expect(drained.reason).toBeUndefined()
    } else {
      expect(ordinary.status).toBe("rejected")
      expect(native.status).toBe("rejected")
      if (ordinary.status !== "rejected" || native.status !== "rejected")
        throw Error("ORIGINAL_NULL_CLASSIFICATION_FAILURE_REQUIRED")
      expect(ordinary.reason).toBeInstanceOf(TypeError)
      expect(native.reason).toBeInstanceOf(TypeError)
      if (!(ordinary.reason instanceof TypeError) || !(native.reason instanceof TypeError))
        throw Error("ACTUAL_ORIGINAL_TYPE_ERROR_REQUIRED")
      expect(native.reason.constructor).toBe(ordinary.reason.constructor)
      expect(native.reason.name).toBe(ordinary.reason.name)
      expect(native.reason.message).toBe(ordinary.reason.message)
      expect(drained.reason).toBeInstanceOf(AggregateError)
      if (!(drained.reason instanceof AggregateError)) throw Error("ACTUAL_TWO_TICKET_FAILURES_REQUIRED")
      expect(drained.reason.errors).toStrictEqual([native.reason, null])
      expect(drained.reason.errors[0]).toBe(native.reason)
    }
  })
  it("keeps schema early failure separate from handler parsing and full native output", async () => {
    const Node = await nodeConstructor(), c = config()
    let effects = 0, invokeCalls = 0, referenceCalls = 0, referenceEffects = 0
    const declared = tool(async () => { effects++; return "must-not-run" }, { name: "declared", description: "schema", schema: z.object({ text: z.string() }) })
    const originalInvoke = declared.invoke, failures: unknown[] = []
    Object.defineProperty(declared, "invoke", { configurable: true, writable: true,
      value: async function(this: typeof declared, ...args: Parameters<typeof originalInvoke>) {
        expect(this).toBe(declared)
        invokeCalls++
        try { return await Reflect.apply(originalInvoke, this, args) }
        catch (reason) { failures.push(reason); throw reason }
      } })
    const bad = call("declared", { text: 42 })
    const ordinary = await retain(new Node([declared]).runTool(bad, c.value, c.state))
    const agent = createNativeToolInvokeAgent({ model: new FakeToolCallingModel({ toolCalls: [[]] }), tools: [declared] })
    const operation = createNativeToolInvokeOperation(agent, bad, c.value, c.state)
    operations.push(operation)
    const native = await retain(executeNativeToolInvokeOperation(operation))
    expect(invokeCalls).toBe(2)
    expect(failures).toHaveLength(2)
    expect(failures[0]).toBeInstanceOf(ToolInputParsingException)
    expect(failures[1]).toBeInstanceOf(ToolInputParsingException)
    expect(failures[1]).not.toBe(failures[0])
    const outcome = selection(operation).outcome
    expect(outcome?.status).toBe("rejected")
    if (outcome?.status !== "rejected") throw Error("ACTUAL_SCHEMA_REJECTION_REQUIRED")
    expect(outcome.reason).toBe(failures[1])
    // These ordinary-only nodes format each actual captured error without changing its stack.
    const originalFormatting = async (reason: unknown) => {
      const reference = tool(async () => { referenceEffects++; return "must-not-run" },
        { name: "declared", description: "original formatter", schema: z.object({ text: z.string() }) })
      Object.defineProperty(reference, "invoke", { configurable: true, writable: true,
        value: async function(this: typeof reference) {
          expect(this).toBe(reference)
          referenceCalls++
          throw reason
        } })
      return retain(new Node([reference]).runTool(bad, c.value, c.state))
    }
    const ordinaryReference = await originalFormatting(failures[0])
    const nativeReference = await originalFormatting(failures[1])
    expect(codec(ordinary)).toStrictEqual(codec(ordinaryReference))
    expect(codec(native)).toStrictEqual(codec(nativeReference))
    expect(referenceCalls).toBe(2)
    expect(referenceEffects).toBe(0)
    expect(effects).toBe(0)
    expect(bad.args).toStrictEqual({ text: 42 })
  })
  it("retains a declared own invoke wrapper with the exact original receiver", async () => {
    const c = config(), declared = tool(async () => "base", { name: "declared", description: "own wrapper", schema: z.object({ text: z.string() }) })
    const original = declared.invoke
    let receiver: unknown, invokes = 0
    Object.defineProperty(declared, "invoke", { configurable: true, writable: true, value: function(this: typeof declared, ...args: Parameters<typeof original>) {
      receiver = this; invokes++
      return Reflect.apply(original, this, args)
    } })
    const own = declared.invoke
    const agent = createNativeToolInvokeAgent({ model: new FakeToolCallingModel({ toolCalls: [[]] }), tools: [declared] })
    const operation = createNativeToolInvokeOperation(agent, call(), c.value, c.state)
    operations.push(operation)
    expect(await retain(executeNativeToolInvokeOperation(operation))).toBeInstanceOf(ToolMessage)
    const current = selection(operation)
    expect(current.facts.invoke).toBe(own)
    expect(receiver).toBe(declared)
    expect(invokes).toBe(1)
  })
  it.each(["accessor", "value", "flags"] as const)("refuses a late selected invoke %s before any tool effect", async mode => {
    const c = config()
    let effects = 0, gets = 0
    const declared = tool(async () => { effects++; return "actual" }, { name: "declared", description: "late", schema: z.object({ text: z.string() }) })
    const agent = createNativeToolInvokeAgent({ model: new FakeToolCallingModel({ toolCalls: [[]] }), tools: [declared] })
    const operation = createNativeToolInvokeOperation(agent, call(), c.value, c.state)
    operations.push(operation)
    const old = Object.getOwnPropertyDescriptor(declared, "invoke")
    if (mode === "accessor") Object.defineProperty(declared, "invoke", { configurable: true, get() { gets++; return () => "fake" } })
    else Object.defineProperty(declared, "invoke", { configurable: true, writable: mode !== "flags", value: mode === "flags" ? declared.invoke : () => "fake" })
    let failure: unknown
    try { await executeNativeToolInvokeOperation(operation) } catch (error) { failure = error }
    finally { if (old) Object.defineProperty(declared, "invoke", old); else Reflect.deleteProperty(declared, "invoke") }
    expect(failure).toMatchObject({ message: invalid })
    expect(gets).toBe(0)
    expect(effects).toBe(0)
  })
  it("rejects a member changed while original config arguments are evaluated", async () => {
    const c = config()
    let effects = 0, fake = 0
    const declared = tool(async () => { effects++; return "actual" }, { name: "declared", description: "config", schema: z.object({ text: z.string() }) })
    const agent = createNativeToolInvokeAgent({ model: new FakeToolCallingModel({ toolCalls: [[]] }), tools: [declared] })
    const original = Object.getOwnPropertyDescriptor(declared, "invoke")
    const configValue = { ...c.value }
    let reads = 0
    Object.defineProperty(configValue, "configurable", { configurable: true, enumerable: true, get() {
      reads++
      // runtime consumes once; the second read is the original argument spread.
      if (reads === 2) Object.defineProperty(declared, "invoke", { configurable: true, value: () => { fake++; return "fake" } })
      return c.value.configurable
    } })
    const operation = createNativeToolInvokeOperation(agent, call(), configValue, c.state)
    operations.push(operation)
    let failed = false, failure: unknown
    try { await retain(executeNativeToolInvokeOperation(operation)) }
    catch (error) { failed = true; failure = error }
    finally { if (original) Object.defineProperty(declared, "invoke", original); else Reflect.deleteProperty(declared, "invoke") }
    const recorded = readNativeToolInvokeSelections(operation)
    expect(recorded).toHaveLength(1)
    expect(readNativeToolInvokeSelection(recorded[0], operation)?.outcome).toBeUndefined()
    expect(effects).toBe(0)
    expect(fake).toBe(0)
    expect(failed).toBe(true)
    expect(failure).toMatchObject({ message: invalid })
    const [drained] = await Promise.allSettled([closeAndDrainNativeToolInvokeOperation(operation)])
    expect(drained.status).toBe("rejected")
    if (drained.status !== "rejected") throw Error("ORIGINAL_HANDLER_FAILURE_REQUIRED")
    expect(drained.reason).toMatchObject({ message: invalid })
    expect(() => executeNativeToolInvokeOperation(operation)).toThrow(invalid)
  })
  it("records a true synchronous own invoke throw without adding Core callback errors", async () => {
    const Node = await nodeConstructor(), c = config(new Observer()), reason = new Error("synchronous-reference")
    const declared = tool(async () => "unused", { name: "declared", description: "sync", schema: z.object({ text: z.string() }) })
    const invoke = vi.fn(function(this: typeof declared) { expect(this).toBe(declared); throw reason })
    Object.defineProperty(declared, "invoke", { configurable: true, writable: true, value: invoke })
    const ordinary = await retain(new Node([declared]).runTool(call(), c.value, c.state))
    const agent = createNativeToolInvokeAgent({ model: new FakeToolCallingModel({ toolCalls: [[]] }), tools: [declared] })
    const operation = createNativeToolInvokeOperation(agent, call(), c.value, c.state)
    operations.push(operation)
    const native = await retain(executeNativeToolInvokeOperation(operation))
    expect(codec(native)).toStrictEqual(codec(ordinary))
    const outcome = selection(operation).outcome
    expect(outcome?.status).toBe("rejected")
    if (outcome?.status === "rejected") expect(outcome.reason).toBe(reason)
    expect(invoke).toHaveBeenCalledTimes(2)
  })
  it.each(["retry", "parallel"] as const)("records every actual %s middleware handler independently", async mode => {
    const c = config(), reason = new Error("first-attempt"), effects: number[] = []
    const declared = tool(async () => { const index = effects.length + 1; effects.push(index); if (mode === "retry" && index === 1) throw reason; return "actual-result" }, { name: "declared", description: "multiple", schema: z.object({ text: z.string() }) })
    const middleware = createMiddleware({ name: "multiple-handlers", wrapToolCall: async (request, handler) => {
      if (mode === "parallel") { const values = await Promise.all([handler(request), handler(request)]); return values[0] }
      try { return await handler(request) } catch { return handler(request) }
    } })
    const agent = createNativeToolInvokeAgent({ model: new FakeToolCallingModel({ toolCalls: [[]] }), tools: [declared], middleware: [middleware] })
    const operation = createNativeToolInvokeOperation(agent, call(), c.value, c.state)
    operations.push(operation)
    const value = await retain(executeNativeToolInvokeOperation(operation))
    expect(value).toBeInstanceOf(ToolMessage)
    expect((value as ToolMessage).content).toBe("actual-result")
    expect(effects).toStrictEqual([1, 2])
    const selected = readNativeToolInvokeSelections(operation)
    expect(selected).toHaveLength(2)
    const facts = selected.map(token => readNativeToolInvokeSelection(token, operation))
    expect(facts.map(value => value?.index)).toStrictEqual([1, 2])
    expect(facts.every(value => value?.tool === declared && value.receiver === declared && value.status === "settled")).toBe(true)
    const outcomes = facts.map((value, index) => value?.outcome && readNativeToolInvokeOutcome(value.outcome, selected[index], operation))
    expect(outcomes.map(value => value?.status)).toStrictEqual(mode === "retry" ? ["rejected", "fulfilled"] : ["fulfilled", "fulfilled"])
    if (mode === "retry") {
      const first = outcomes[0]
      if (first?.status !== "rejected") throw Error("FIRST_RAW_REJECTION_REQUIRED")
      expect(first.reason).toBe(reason)
    }
  })
  it("allows another declared static tool and refuses a newly introduced tool before invoke", async () => {
    const c = config(), effects: string[] = []
    const declared = tool(async () => { effects.push("declared"); return "base" }, { name: "declared", description: "base", schema: z.object({ text: z.string() }) })
    const other = tool(async () => { effects.push("other"); return "other-result" }, { name: "other", description: "other", schema: z.object({ text: z.string() }) })
    const dynamic = tool(async () => { effects.push("dynamic"); return "must-not-run" }, { name: "dynamic", description: "dynamic", schema: z.object({ text: z.string() }) })
    let override: typeof other | typeof dynamic = other
    const middleware = createMiddleware({ name: "override", wrapToolCall: (request, handler) => handler({ ...request, tool: override }) })
    const agent = createNativeToolInvokeAgent({ model: new FakeToolCallingModel({ toolCalls: [[]] }), tools: [declared, other], middleware: [middleware] })
    const first = createNativeToolInvokeOperation(agent, call(), c.value, c.state)
    operations.push(first)
    const value = await retain(executeNativeToolInvokeOperation(first))
    expect((value as ToolMessage).content).toBe("other-result")
    expect(selection(first).facts.tool).toBe(other)
    override = dynamic
    const second = createNativeToolInvokeOperation(agent, call(), c.value, c.state)
    operations.push(second)
    await expect(retain(executeNativeToolInvokeOperation(second))).rejects.toThrow(invalid)
    expect(effects).toStrictEqual(["other"])
    expect(readNativeToolInvokeSelections(second)).toStrictEqual([])
  })
  it.each([false, true, "function"] as const)("keeps ordinary handleToolErrors %s behavior and exact raw reason", async mode => {
    const Node = await nodeConstructor(), c = config(), reason = new Error("ordinary-handler-reference")
    const declared = tool(async () => { throw reason }, { name: "declared", description: "ordinary-error", schema: z.object({ text: z.string() }) })
    const handleToolErrors = mode === "function" ? (error: unknown, toolCall: ToolCall) => {
      expect(error).toBe(reason)
      return new ToolMessage({ content: "original-custom-handler", name: toolCall.name, tool_call_id: toolCall.id ?? "actual-tool-call" })
    } : mode
    const node = new Node([declared], { handleToolErrors })
    if (mode === false) await expect(retain(node.runTool(call(), c.value, c.state))).rejects.toBe(reason)
    else {
      const value = await retain(node.runTool(call(), c.value, c.state))
      expect(value).toBeInstanceOf(ToolMessage)
      expect((value as ToolMessage).content).toBe(mode === true ? `${reason}\n Please fix your mistakes.` : "original-custom-handler")
    }
  })
  it.each(["abort", "interrupt"] as const)("preserves the original actual %s reason and callback handling", async mode => {
    const Node = await nodeConstructor(), c = config(), reason = mode === "interrupt" ? new GraphInterrupt([]) : new Error("actual-abort")
    const declared = tool(async () => { if (mode === "abort") c.controller.signal.throwIfAborted(); throw reason }, { name: "declared", description: "abort-interrupt", schema: z.object({ text: z.string() }) })
    const agent = createNativeToolInvokeAgent({ model: new FakeToolCallingModel({ toolCalls: [[]] }), tools: [declared], signal: c.controller.signal })
    if (mode === "abort") c.controller.abort(reason)
    const node = new Node([declared], { signal: c.controller.signal })
    await expect(retain(node.runTool(call(), c.value, c.state))).rejects.toBe(reason)
    const operation = createNativeToolInvokeOperation(agent, call(), c.value, c.state)
    operations.push(operation)
    await expect(retain(executeNativeToolInvokeOperation(operation))).rejects.toBe(reason)
    const outcome = selection(operation).outcome
    if (outcome?.status !== "rejected") throw Error("ACTUAL_RAW_FAILURE_REQUIRED")
    expect(outcome.reason).toBe(reason)
  })
  it("does not turn a Core ToolEvent callback error into a rejected invoke outcome", async () => {
    const Node = await nodeConstructor(), callbackFailure = new Error("actual-generator-callback")
    const ordinaryObserver = new Observer(), nativeObserver = new Observer(), events = [0, 0]
    for (const [index, observer] of [ordinaryObserver, nativeObserver].entries()) {
      observer.raiseError = true
      observer.awaitHandlers = true
      observer.handleToolEvent = () => { events[index]++; throw callbackFailure }
    }
    const ordinaryConfig = config(ordinaryObserver), c = config(nativeObserver)
    let finished = 0
    const declared = tool(async function* () {
      try { yield { name: "synthetic-progress", data: { step: 1 } }; return "actual-generator-return" }
      finally { finished++ }
    }, { name: "declared", description: "generator", schema: z.object({ text: z.string() }) })
    const ordinary = await retain(new Node([declared]).runTool(call(), ordinaryConfig.value, ordinaryConfig.state))
    expect(finished).toBe(1)
    const agent = createNativeToolInvokeAgent({ model: new FakeToolCallingModel({ toolCalls: [[]] }), tools: [declared] })
    const operation = createNativeToolInvokeOperation(agent, call(), c.value, c.state)
    operations.push(operation)
    const value = await retain(executeNativeToolInvokeOperation(operation))
    expect(codec(value)).toStrictEqual(codec(ordinary))
    expect((value as ToolMessage).content).toBe("actual-generator-return")
    expect(events).toStrictEqual([1, 1])
    expect(finished).toBe(2)
    expect(ordinaryObserver.errors).toStrictEqual([callbackFailure])
    expect(nativeObserver.errors).toStrictEqual(ordinaryObserver.errors)
    expect(nativeObserver.errors[0]).toBe(callbackFailure)
    expect(ordinaryObserver.order).toStrictEqual(["start", "error", "end"])
    expect(nativeObserver.order).toStrictEqual(ordinaryObserver.order)
    const outcome = selection(operation).outcome
    expect(outcome?.status).toBe("fulfilled")
    if (outcome?.status !== "fulfilled") throw Error("ACTUAL_GENERATOR_INVOKE_SUCCESS_REQUIRED")
    expect(outcome.value).toBe(value)
    expect(await closeAndDrainNativeToolInvokeOperation(operation)).toBeUndefined()
  })
  it("keeps an unawaited real handler alive until its actual finally and settlement", async () => {
    const c = config()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    releases.push(release)
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    let finished = false, effects = 0
    const declared = tool(async () => { effects++; entered(); try { await gate; return "actual" } finally { finished = true } }, { name: "declared", description: "held", schema: z.object({ text: z.string() }) })
    const middleware = createMiddleware({ name: "unawaited", wrapToolCall: async (request, handler) => {
      const handlerPromise = handler(request)
      if (!(handlerPromise instanceof Promise)) throw Error("ACTUAL_HELD_HANDLER_PROMISE_REQUIRED")
      retain(handlerPromise)
      return new ToolMessage({ name: request.toolCall.name, content: "outer-short-circuit", tool_call_id: request.toolCall.id ?? "actual-tool-call" })
    } })
    const agent = createNativeToolInvokeAgent({ model: new FakeToolCallingModel({ toolCalls: [[]] }), tools: [declared], middleware: [middleware] })
    const operation = createNativeToolInvokeOperation(agent, call(), c.value, c.state)
    operations.push(operation)
    await retain(executeNativeToolInvokeOperation(operation))
    await started
    let drained = false
    const drain = retain(closeAndDrainNativeToolInvokeOperation(operation).then(() => { drained = true }))
    await Promise.resolve()
    expect(drained).toBe(false)
    expect(finished).toBe(false)
    release()
    await drain
    expect(drained).toBe(true)
    expect(finished).toBe(true)
    expect(effects).toBe(1)
    expect(selection(operation).outcome?.status).toBe("fulfilled")
  })
  it("registers outer occupancy before a runtime getter synchronously closes the operation", async () => {
    const c = config()
    let effects = 0, drain: Promise<void> | undefined, drained = false
    const declared = tool(async () => { effects++; return "actual" }, { name: "declared", description: "outer-close", schema: z.object({ text: z.string() }) })
    const agent = createNativeToolInvokeAgent({ model: new FakeToolCallingModel({ toolCalls: [[]] }), tools: [declared] })
    const value = { ...c.value }
    let operation!: NativeToolInvokeOperation
    Object.defineProperty(value, "context", { enumerable: true, get() {
      drain = retain(closeAndDrainNativeToolInvokeOperation(operation))
      drain.then(() => { drained = true }, () => { drained = true })
      expect(drained).toBe(false)
      return undefined
    } })
    operation = createNativeToolInvokeOperation(agent, call(), value, c.state)
    operations.push(operation)
    await Promise.allSettled([retain(executeNativeToolInvokeOperation(operation))])
    expect(drain).toBeDefined()
    await Promise.allSettled([drain])
    expect(drained).toBe(true)
    expect(effects).toBe(0)
  })
  it("does not certify an ordinary withConfig child or cloned operation", () => {
    const c = config(), declared = tool(async () => "actual", { name: "declared", description: "clone", schema: z.object({ text: z.string() }) })
    const agent = createNativeToolInvokeAgent({ model: new FakeToolCallingModel({ toolCalls: [[]] }), tools: [declared] })
    const ordinary = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[]] }), tools: [declared] })
    expect(() => createNativeToolInvokeOperation(ordinary, call(), c.value, c.state)).toThrow(invalid)
    expect(() => createNativeToolInvokeOperation(agent.withConfig({ tags: ["child"] }), call(), c.value, c.state)).toThrow(invalid)
    const operation = createNativeToolInvokeOperation(agent, call(), c.value, c.state)
    operations.push(operation)
    let traps = 0
    const unknown = new Proxy({}, { get() { traps++; throw Error("UNEXPECTED_TRAP") } })
    expect(readNativeToolInvokeSelections(unknown as NativeToolInvokeOperation)).toStrictEqual([])
    expect(() => executeNativeToolInvokeOperation(unknown as NativeToolInvokeOperation)).toThrow(invalid)
    expect(traps).toBe(0)
  })
  it.each(["node-first", "agent-first"])("preserves real CJS construction origin in %s loading order", order => {
    const root = dirname(require.resolve("langchain/package.json"))
    const script = `const root = ${JSON.stringify(root)};\nconst nodePath = root + "/dist/agents/nodes/ToolNode.cjs";\nconst agentPath = root + "/dist/agents/ReactAgent.cjs";\nrequire(${JSON.stringify(order)} === "node-first" ? nodePath : agentPath);\nconst lc = require("langchain");\nconst native = require(root + "/dist/native-tool-invoke-origin.cjs");\nconst z = require("zod").z;\nlet effects = 0;\nconst declared = lc.tool(async () => { effects++; return "actual" }, { name: "declared", description: "CJS", schema: z.object({text:z.string()}) });\nconst agent = native.createNativeToolInvokeAgent({model:new lc.FakeToolCallingModel({toolCalls:[[]]}),tools:[declared]});\nconst op = native.createNativeToolInvokeOperation(agent,{name:"declared",args:{text:"original"},id:"actual-tool-call",type:"tool_call"},{},{messages:[]});\nnative.executeNativeToolInvokeOperation(op).then(async value => { await native.closeAndDrainNativeToolInvokeOperation(op); if(effects !== 1 || value.content !== "actual") throw Error("CJS_ACTUAL_RESULT_REQUIRED"); process.stdout.write("CJS_ORIGIN_OK\\n") }).catch(error => {process.stderr.write(String(error)); process.exitCode=1});`
    const result = spawnSync(process.execPath, ["-e", script], { cwd: root, encoding: "utf8", timeout: 4500, windowsHide: true })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe("CJS_ORIGIN_OK")
  })
})
