import { afterEach, describe, expect, it, vi } from "vitest"
import { FakeToolCallingModel } from "langchain"
import { HumanMessage } from "@langchain/core/messages"
import { createFlowPromptRuntime, readFlowPromptRuntimeProof } from "./flow-prompt-runtime"
import {
  flowPromptResultSchema,
  describeFlowPromptRuntime,
  flowPromptDigest
} from "./flow-prompt-runtime-contract"
import { createPromptOnlyStructuredOutputTool, runWorkflowSubagent } from "./workflow/subagent"

const fixture = vi.hoisted(() => ({
  config: {
    id: "fixture",
    ref: "custom:fixture",
    source: "custom",
    name: "fixture",
    model: "fixture",
    baseUrl: "http://fixture.invalid",
    apiKey: "test-only"
  },
  model: undefined as unknown,
  failGraphConstruction: false
}))
vi.mock("../models/registry", async (original) => ({
  ...(await original<typeof import("../models/registry")>()),
  getModelConfigByRef: () => fixture.config
}))
vi.mock("./runtime", async () => {
  const { MemorySaver } = await import("@langchain/langgraph")
  return { getModelInstance: () => fixture.model, getCheckpointer: async () => new MemorySaver() }
})
vi.mock("langchain", async (original) => {
  const actual = await original<typeof import("langchain")>()
  return {
    ...actual,
    createAgent: (...args: Parameters<typeof actual.createAgent>) => {
      if (fixture.failGraphConstruction) throw Error("graph-construction-failed")
      return actual.createAgent(...args)
    }
  }
})
const fixtureConfig = fixture.config
const setFixtureModel = (model: FakeToolCallingModel) => {
  fixture.model = model
}

const readers: Array<{ dispose(): void }> = []
afterEach(() => {
  fixture.failGraphConstruction = false
  vi.useRealTimers()
  for (const reader of readers.splice(0)) reader.dispose()
})
async function setup(options: { current?: () => void; calls?: string[] } = {}) {
  setFixtureModel(
    new FakeToolCallingModel({
      toolCalls: [
        (options.calls ?? ["structured_output"]).map((name, index) => ({
          id: `call-${index}`,
          name,
          args: { passed: true, summary: "accepted" }
        }))
      ]
    })
  )
  const invocation = Object.freeze({})
  const descriptor = describeFlowPromptRuntime({
    model: fixtureConfig as never,
    rolePrompt: "role",
    mandatoryPolicyDigest: "f".repeat(64)
  })
  const controller = new AbortController()
  const runtime = await createFlowPromptRuntime({
    threadId: "fixture",
    modelId: fixtureConfig.ref,
    abortSignal: controller.signal,
    additionalTools: [createPromptOnlyStructuredOutputTool(flowPromptResultSchema(), invocation)],
    flowPromptOnly: {
      profile: "prompt-only-v1",
      invocation,
      rolePrompt: "role",
      expectedModelRef: fixtureConfig.ref,
      expectedModelDigest: descriptor.modelConfigurationDigest,
      mandatoryPolicyDigest: descriptor.mandatoryPolicyDigest,
      deadline: Date.now() + 5000,
      assertCurrent: options.current ?? (() => {})
    }
  } as never)
  const reader = readFlowPromptRuntimeProof(runtime, invocation)!
  readers.push(reader)
  return { runtime, reader, invocation, controller, descriptor }
}
const invoke = (runtime: Awaited<ReturnType<typeof setup>>["runtime"]) =>
  runtime.invoke(
    { messages: [new HumanMessage("business prompt")] },
    { configurable: { thread_id: "fixture" }, recursionLimit: 12 }
  )

describe("actual closed graph assembly (mock provider and memory checkpoint)", () => {
  it("cleans admission timers when the real graph constructor rejects assembly", async () => {
    vi.useFakeTimers()
    fixture.failGraphConstruction = true
    await expect(setup()).rejects.toThrow("graph-construction-failed")
    expect(vi.getTimerCount()).toBe(0)
  })
  it("executes the actual fixed result tool once and seals private facts", async () => {
    const { runtime, reader, invocation, descriptor } = await setup()
    await invoke(runtime)
    const facts = await reader.seal()
    expect(facts.modelCalls).toBe(1)
    expect(facts.businessInputDigest).toBe(flowPromptDigest("business prompt"))
    expect(facts.actualCapabilitiesDigest).toBe(descriptor.actualCapabilitiesDigest)
    expect(facts.structuredOutputDigest).toBe(
      flowPromptDigest(JSON.stringify({ passed: true, summary: "accepted" }))
    )
    expect(readFlowPromptRuntimeProof({ ...runtime }, invocation)).toBeUndefined()
    expect(readFlowPromptRuntimeProof(new Proxy(runtime, {}), invocation)).toBeUndefined()
    expect(readFlowPromptRuntimeProof(runtime, {})).toBeUndefined()
  })
  it("rejects sealing before any graph call or accepted tool", async () => {
    const { reader } = await setup()
    await expect(reader.seal()).rejects.toThrow("FLOW_PROMPT_UNSETTLED_RESULT")
  })
  it("does not seal after authority revocation following the last graph callback", async () => {
    let live = true
    const { runtime, reader } = await setup({
      current: () => {
        if (!live) throw Error("revoked")
      }
    })
    await invoke(runtime)
    live = false
    await expect(reader.seal()).rejects.toThrow("revoked")
  })
  it("does not authorize unknown business tools or a parallel extra result", async () => {
    for (const calls of [["read_file"], ["structured_output", "structured_output"]]) {
      const { runtime, reader } = await setup({ calls })
      await expect(invoke(runtime)).rejects.toThrow()
      await expect(reader.seal()).rejects.toThrow()
    }
  })
  it("does not accept model credentials changed after the graph settles", async () => {
    const { runtime, reader } = await setup()
    await invoke(runtime)
    const prior = fixtureConfig.apiKey
    try {
      fixtureConfig.apiKey = "changed-test-only"
      await expect(reader.seal()).rejects.toThrow("FLOW_PROMPT_MODEL_CHANGED")
    } finally {
      fixtureConfig.apiKey = prior
    }
  })
  it("keeps abort as failure even when a valid result was previously observed", async () => {
    const { runtime, reader, controller } = await setup()
    await invoke(runtime)
    controller.abort()
    await expect(reader.seal()).rejects.toThrow()
  })
  it.each([false, true])(
    "private subagent seals before cleanup; cleanup failure=%s",
    async (failCleanup) => {
      setFixtureModel(
        new FakeToolCallingModel({
          toolCalls: [
            [
              {
                id: "result",
                name: "structured_output",
                args: { passed: true, summary: "accepted" }
              }
            ]
          ]
        })
      )
      const descriptor = describeFlowPromptRuntime({
        model: fixtureConfig as never,
        rolePrompt: "role",
        mandatoryPolicyDigest: "f".repeat(64)
      })
      const events: string[] = []
      const work = runWorkflowSubagent(
        {
          parentThreadId: "parent",
          isRetryableApiError: () => false,
          cleanupThread: async () => {
            events.push("cleanup")
            if (failCleanup && events.length > 1) throw Error("cleanup-failed")
          },
          createRuntime: async (options) => {
            expect(Object.isFrozen(options.flowPromptOnly?.invocation)).toBe(true)
            const runtime = await createFlowPromptRuntime({
              ...options,
              flowPromptOnly: { ...options.flowPromptOnly!, assertCurrent: () => {} }
            } as never)
            const reader = readFlowPromptRuntimeProof(runtime, options.flowPromptOnly!.invocation)!
            readers.push(reader)
            return {
              stream: runtime.stream.bind(runtime) as never,
              completeTurn: async () => {
                expect((await reader.seal()).modelCalls).toBe(1)
                events.push("sealed")
              }
            }
          }
        },
        {
          prompt: "business prompt",
          model: "custom:fixture",
          agentIndex: 0,
          label: "fixture",
          runId: "flow-fixture",
          signal: new AbortController().signal,
          schema: flowPromptResultSchema(),
          singleAttempt: true,
          strictModel: true,
          roleSystemPrompt: "role",
          flowPromptOnly: {
            profile: "prompt-only-v1",
            expectedModelDigest: descriptor.modelConfigurationDigest,
            mandatoryPolicyDigest: descriptor.mandatoryPolicyDigest,
            deadline: Date.now() + 5000
          }
        }
      )
      if (failCleanup) await expect(work).rejects.toThrow("cleanup-failed")
      else expect((await work).structured).toEqual({ passed: true, summary: "accepted" })
      expect(events).toEqual(["cleanup", "sealed", "cleanup"])
    }
  )
})
