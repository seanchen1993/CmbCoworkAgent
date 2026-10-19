import { expect, it, vi } from "vitest"
import { AIMessage } from "@langchain/core/messages"
import {
  createRuntimeWithModelFallback,
  runWorkflowSubagent,
  type WorkflowSubagentDeps
} from "./subagent"

vi.mock("../../services/subagent-session-capture", () => ({
  withSubagentSessionCapture: (_context: unknown, _label: string, run: () => Promise<unknown>) =>
    run(),
  subagentSessionCallbacks: () => []
}))
vi.mock("../../services/adoption-tracker", () => ({ setAdoptionContext: vi.fn() }))

function deps() {
  return {
    createRuntime: vi.fn<WorkflowSubagentDeps["createRuntime"]>(async () => {
      throw Error("Custom model not configured")
    }),
    cleanupThread: vi.fn(async () => {}),
    isRetryableApiError: () => true,
    parentThreadId: "parent",
    defaultModelId: "custom:default"
  } satisfies WorkflowSubagentDeps
}

it.each([false, true])("strict native cleanup failure cannot become success or an API retry (cancelled=%s)", async cancelled => {
  const d: WorkflowSubagentDeps = { ...deps(), strictRuntimeCleanup: true }
  const signal = new AbortController()
  const create = vi.fn<WorkflowSubagentDeps["createRuntime"]>(async () => ({
    stream: async () => (async function* () {
      if (cancelled) signal.abort()
      yield ["values", { messages: [new AIMessage("done")] }]
    })()
  }))
  d.createRuntime = create
  const cleanup = vi.fn().mockResolvedValueOnce(undefined)
    .mockRejectedValue(Error("Timeout waiting for physical VM exit"))
  d.cleanupThread = cleanup
  await expect(runWorkflowSubagent(d, { prompt: "actual native owner", agentIndex: 0,
    label: "cleanup", runId: "native-run", signal: signal.signal }))
    .rejects.toThrow("WORKFLOW_RUNTIME_CLEANUP_UNCONFIRMED")
  expect(create).toHaveBeenCalledOnce()
  expect(cleanup).toHaveBeenCalledTimes(2)
})
it("strict model choice never retries using the session default", async () => {
  const d = deps()
  await expect(
    createRuntimeWithModelFallback(d, {
      threadId: "child",
      agentId: "a",
      model: "custom:chosen",
      strictModel: true,
      extraSystemPrompt: "",
      label: "step",
      abortSignal: new AbortController().signal
    })
  ).rejects.toThrow("Custom model not configured")
  expect(d.createRuntime).toHaveBeenCalledTimes(1)
  expect(d.createRuntime.mock.calls[0][0]).toMatchObject({ modelId: "custom:chosen" })
})
it("legacy calls retain unavailable-model fallback", async () => {
  const d = deps()
  const runtime = { stream: vi.fn() }
  d.createRuntime
    .mockRejectedValueOnce(Error("Custom model not configured"))
    .mockResolvedValueOnce(runtime as never)
  expect(
    await createRuntimeWithModelFallback(d, {
      threadId: "child",
      agentId: "a",
      model: "chosen",
      extraSystemPrompt: "",
      label: "step",
      abortSignal: new AbortController().signal
    })
  ).toEqual({ runtime, modelFellBack: true })
  expect(d.createRuntime).toHaveBeenCalledTimes(2)
})
it("singleAttempt leaves whole-step retry ownership with FlowManager", async () => {
  const d = deps()
  await expect(
    runWorkflowSubagent(d, {
      prompt: "work",
      model: "chosen",
      agentIndex: 0,
      label: "step",
      runId: "flow_run",
      signal: new AbortController().signal,
      strictModel: true,
      singleAttempt: true
    })
  ).rejects.toThrow()
  expect(d.createRuntime).toHaveBeenCalledTimes(1)
})

it("prepares a host Skill prompt and completes its lifecycle before child cleanup", async () => {
  const d = deps()
  const events: string[] = []
  const preparePrompt = vi.fn(async () => {
    events.push("prepare")
    return "host trusted skill"
  })
  const completeTurn = vi.fn(async () => {
    events.push("complete")
  })
  const stream = vi.fn(async function* (input: unknown) {
    events.push("model")
    const message = (input as { messages: { content: string; id?: string }[] }).messages[0]
    expect(message.content).toBe("host trusted skill")
    expect(message.id).toEqual(expect.any(String))
    expect(message.id).not.toBe("")
    yield ["values", { messages: [new AIMessage("done")] }]
  })
  d.createRuntime.mockResolvedValue({
    preparePrompt,
    completeTurn,
    stream: async (input) => stream(input)
  })
  d.cleanupThread.mockImplementation(async () => {
    events.push("cleanup")
  })
  const result = await runWorkflowSubagent(d, {
    prompt: "original",
    agentIndex: 0,
    label: "skill",
    runId: "skill-run",
    signal: new AbortController().signal,
    singleAttempt: true,
    strictModel: true
  })
  expect(result.text).toBe("done")
  expect(events).toEqual(["cleanup", "prepare", "model", "complete", "cleanup"])
  expect(preparePrompt).toHaveBeenCalledWith("original")
})

it.each(["prepare", "complete"])("fails closed when host Skill %s rejects", async (stage) => {
  const d = deps()
  const stream = vi.fn(async function* () {
    yield ["values", { messages: [new AIMessage("done")] }]
  })
  d.createRuntime.mockResolvedValue({
    stream: async () => stream(),
    preparePrompt: async (prompt) => {
      if (stage === "prepare") throw Error("host gate rejected")
      return prompt
    },
    completeTurn: async () => {
      throw Error("host gate rejected")
    }
  })
  await expect(
    runWorkflowSubagent(d, {
      prompt: "original",
      agentIndex: 0,
      label: "skill",
      runId: "skill-run",
      signal: new AbortController().signal,
      singleAttempt: true,
      strictModel: true
    })
  ).rejects.toThrow("host gate rejected")
  expect(stream).toHaveBeenCalledTimes(stage === "prepare" ? 0 : 1)
  expect(d.createRuntime).toHaveBeenCalledTimes(1)
  expect(d.cleanupThread).toHaveBeenCalledTimes(2)
})

it("does not repeat Skill activation for the structured-output correction turn", async () => {
  const d = deps()
  const preparePrompt = vi.fn(async () => "trusted initial prompt")
  const completeTurn = vi.fn(async () => {})
  const prompts: unknown[] = []
  d.createRuntime.mockImplementation(async (options) => ({
    preparePrompt,
    completeTurn,
    stream: async (input) =>
      (async function* () {
        prompts.push((input as { messages: { content: string }[] }).messages[0].content)
        if (prompts.length === 2) await options.additionalTools![0].invoke({ passed: true })
        yield ["values", { messages: [new AIMessage("done")] }]
      })()
  }))
  const result = await runWorkflowSubagent(d, {
    prompt: "original",
    schema: { type: "object", properties: { passed: { type: "boolean" } }, required: ["passed"] },
    agentIndex: 0,
    label: "skill",
    runId: "skill-nudge",
    signal: new AbortController().signal,
    singleAttempt: true,
    strictModel: true
  })
  expect(result.structured).toEqual({ passed: true })
  expect(prompts[0]).toBe("trusted initial prompt")
  expect(prompts[1]).toContain("You have not returned a valid structured result")
  expect(preparePrompt).toHaveBeenCalledTimes(1)
  expect(completeTurn).toHaveBeenCalledTimes(1)
})
