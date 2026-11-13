import { beforeEach, describe, expect, it, vi } from "vitest"

const harness = vi.hoisted(() => ({
  events: [] as string[],
  ordinary: { graph: {} },
  native: { graph: {} },
  admitted: {},
  protected: {},
  create: vi.fn(),
  createNative: vi.fn(),
  admit: vi.fn(),
  protect: vi.fn()
}))

vi.mock("langchain", () => ({ createAgent: harness.create }))
vi.mock("./native-agent-factory", () => ({
  createFunctionConversationNativeAgent: harness.createNative
}))
vi.mock("./mods-conversation-invocation", () => ({
  wrapFunctionConversationInvocation: harness.admit
}))
vi.mock("./function-conversation-native-invocation", () => ({
  wrapFunctionConversationNativeInvocation: harness.protect
}))

import { createRuntimeConversationGraph, type RuntimeConversationGraphPlan } from "./native-graph-adapter"

const options = { model: "controlled-model", tools: [] } as unknown as
  Parameters<typeof createRuntimeConversationGraph>[0]

function fixture() {
  const runtime = {
    assertCurrent: vi.fn(function (this: unknown) { expect(this).toBe(runtime) })
  }
  const host = {
    install: vi.fn(() => { harness.events.push("install") }),
    registerHistorical: vi.fn(),
    registerHistoricalAsync: vi.fn(),
    registerIntake: vi.fn()
  }
  const conversation = { store: {}, binding: {} }
  return { host, runtime, conversation, historySaver: {} }
}

beforeEach(() => {
  vi.resetAllMocks()
  harness.events.length = 0
  harness.create.mockImplementation(() => {
    harness.events.push("ordinary-create")
    return harness.ordinary
  })
  harness.createNative.mockImplementation(() => {
    harness.events.push("native-create")
    return harness.native
  })
  harness.admit.mockImplementation(() => {
    harness.events.push("admit")
    return harness.admitted
  })
  harness.protect.mockImplementation(() => {
    harness.events.push("protect")
    return harness.protected
  })
})

describe("runtime conversation graph assembly", () => {
  it("keeps an ordinary graph on the original factory without inspecting Mods state", () => {
    const plan: RuntimeConversationGraphPlan = { kind: "ordinary" }
    for (const name of ["host", "runtime", "conversation", "historySaver", "reconcileCompaction"]) {
      Object.defineProperty(plan, name, { get: () => { throw Error("ordinary Mods access") } })
    }
    expect(createRuntimeConversationGraph(options, plan)).toBe(harness.ordinary)
    expect(harness.create).toHaveBeenCalledWith(options)
    expect(harness.events).toEqual(["ordinary-create"])
    expect(harness.createNative).not.toHaveBeenCalled()
    expect(harness.admit).not.toHaveBeenCalled()
    expect(harness.protect).not.toHaveBeenCalled()
  })

  it("preserves conversation-only invocation without claiming a native installation", () => {
    const f = fixture()
    const plan = { kind: "conversation", conversation: f.conversation } as unknown as RuntimeConversationGraphPlan
    expect(createRuntimeConversationGraph(options, plan)).toBe(harness.admitted)
    expect(harness.events).toEqual(["ordinary-create", "admit"])
    expect(harness.admit).toHaveBeenCalledWith(harness.ordinary, f.conversation)
    expect(harness.createNative).not.toHaveBeenCalled()
    expect(f.host.install).not.toHaveBeenCalled()
    expect(harness.protect).not.toHaveBeenCalled()
  })

  it("binds the tool catalog and installs the exact native graph before either wrapper", () => {
    const f = fixture()
    const reconcileCompaction = vi.fn()
    const plan = { kind: "native", ...f, reconcileCompaction } as unknown as RuntimeConversationGraphPlan
    expect(createRuntimeConversationGraph(options, plan,
      () => { harness.events.push("catalog") })).toBe(harness.protected)
    expect(harness.events).toEqual(["native-create", "catalog", "install", "admit", "protect"])
    expect(f.host.install).toHaveBeenCalledWith(harness.native.graph)
    expect(harness.create).not.toHaveBeenCalled()
    expect(harness.protect).toHaveBeenCalledWith(harness.admitted, f.host, f.runtime)
    const binding = harness.admit.mock.calls[0][1]
    expect(binding.store).toBe(f.conversation.store)
    expect(binding.binding).toBe(f.conversation.binding)
    expect(binding.history.saver).toBe(f.historySaver)
    expect(binding.history.register).toBe(f.host.registerHistorical)
    expect(binding.history.registerAsync).toBe(f.host.registerHistoricalAsync)
    expect(binding.history.reconcileCompaction).toBe(reconcileCompaction)
    expect(reconcileCompaction).not.toHaveBeenCalled()
    expect(binding.onIntakeNotes).toBe(f.host.registerIntake)
    binding.history.assertCurrent()
    expect(f.runtime.assertCurrent).toHaveBeenCalledOnce()
  })

  it("never supplies historical membership authority without an actual Saver", () => {
    const f = fixture()
    const { historySaver: _, ...withoutSaver } = f
    const plan = { kind: "native", ...withoutSaver } as unknown as RuntimeConversationGraphPlan
    Object.defineProperty(plan, "reconcileCompaction", {
      get: () => { throw Error("No actual Saver for compaction reconciliation") }
    })
    createRuntimeConversationGraph(options, plan)
    expect(harness.admit.mock.calls[0][1]).toEqual(f.conversation)
    expect(harness.events).toEqual(["native-create", "install", "admit", "protect"])
  })

  it("protects a native graph without inventing a missing conversation binding", () => {
    const { conversation: _, ...f } = fixture()
    createRuntimeConversationGraph(options,
      { kind: "native", ...f } as unknown as RuntimeConversationGraphPlan)
    expect(harness.admit).not.toHaveBeenCalled()
    expect(harness.protect).toHaveBeenCalledWith(harness.native, f.host, f.runtime)
  })

  it.each(["factory", "catalog", "install", "admit", "protect"])(
    "stops assembly when %s fails and never falls back to an ordinary graph", stage => {
      const f = fixture()
      const failure = Error(stage)
      if (stage === "factory") harness.createNative.mockImplementation(() => { throw failure })
      if (stage === "install") f.host.install.mockImplementation(() => { throw failure })
      if (stage === "admit") harness.admit.mockImplementation(() => { throw failure })
      if (stage === "protect") harness.protect.mockImplementation(() => { throw failure })
      const catalog = () => {
        harness.events.push("catalog")
        if (stage === "catalog") throw failure
      }
      expect(() => createRuntimeConversationGraph(options,
        { kind: "native", ...f } as unknown as RuntimeConversationGraphPlan, catalog)).toThrow(failure)
      expect(harness.create).not.toHaveBeenCalled()
      if (["factory", "catalog"].includes(stage)) expect(f.host.install).not.toHaveBeenCalled()
      if (["factory", "catalog", "install"].includes(stage)) expect(harness.admit).not.toHaveBeenCalled()
      if (stage !== "protect") expect(harness.protect).not.toHaveBeenCalled()
    }
  )
})
