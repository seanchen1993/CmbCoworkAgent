import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages"
import { expect, it, vi } from "vitest"
import { createFunctionToolBatchMiddleware, type FunctionToolBatchCall } from "./mods-tool-batch"

const ai = () =>
  new AIMessage({
    id: "batch-one",
    content: "",
    tool_calls: [
      { id: "first", name: "read_file", args: { file_path: "a" }, type: "tool_call" },
      { id: "second", name: "read_file", args: { file_path: "b" }, type: "tool_call" }
    ]
  })
const replies = () => [
  new ToolMessage({ tool_call_id: "second", content: "failed", status: "error" }),
  new ToolMessage({ tool_call_id: "first", content: "done" })
]
function fixture(
  notify = vi.fn(async (_calls: FunctionToolBatchCall[], _signal: AbortSignal) => {
    void _calls
    void _signal
    return "batch context"
  })
) {
  const controller = new AbortController()
  const assertLive = vi.fn()
  let enabled = true
  // Exercise the actual middleware hooks with native LangChain message instances.
  const middleware = createFunctionToolBatchMiddleware({
    notify,
    assertLive,
    enabled: () => enabled,
    signal: controller.signal
  })
  const after = middleware.afterModel as (
    state: { messages: unknown[] },
    runtime: unknown
  ) => unknown
  const wrap = middleware.wrapModelCall as unknown as (
    request: unknown,
    handler: (request: unknown) => Promise<unknown>
  ) => Promise<unknown>
  const handler = vi.fn(async (request: unknown) => request)
  const run = (messages: unknown[]) =>
    wrap(
      {
        state: { messages },
        messages,
        systemMessage: new SystemMessage("original"),
        runtime: { signal: controller.signal }
      },
      handler
    )
  return {
    controller,
    notify,
    assertLive,
    handler,
    run,
    observe: (message: unknown) => after({ messages: [message] }, {}),
    off: () => {
      enabled = false
    }
  }
}
it("emits one complete batch in call order before the next model and preserves tool errors", async () => {
  const f = fixture()
  const batch = ai()
  await f.observe(batch)
  await f.run([batch, ...replies()])
  expect(f.notify).toHaveBeenCalledTimes(1)
  expect(f.notify.mock.calls[0][0]).toEqual([
    {
      tool_name: "read_file",
      tool_input: { file_path: "a" },
      tool_use_id: "first",
      tool_response: "done"
    },
    {
      tool_name: "read_file",
      tool_input: { file_path: "b" },
      tool_use_id: "second",
      tool_response: "failed"
    }
  ])
  expect(f.notify.mock.invocationCallOrder[0]).toBeLessThan(f.handler.mock.invocationCallOrder[0])
  expect(
    (f.handler.mock.calls[0][0] as { systemMessage: SystemMessage }).systemMessage.text
  ).toContain("batch context")
  await f.run([batch, ...replies()])
  expect(f.notify).toHaveBeenCalledTimes(1)
})
it("does not turn history, partial batches or duplicate tool responses into completion", async () => {
  const f = fixture()
  const batch = ai()
  await f.run([new HumanMessage("old"), batch, ...replies()])
  expect(f.notify).not.toHaveBeenCalled()
  await f.observe(batch)
  await f.run([batch, replies()[0], replies()[0]])
  expect(f.notify).not.toHaveBeenCalled()
  await f.run([batch, ...replies()])
  expect(f.notify).toHaveBeenCalledTimes(1)
})
it("off bypasses batch checks and preserves the original model request", async () => {
  const f = fixture()
  await f.observe(ai())
  f.off()
  const result = (await f.run([ai(), ...replies()])) as { systemMessage: SystemMessage }
  expect(result.systemMessage.text).toBe("original")
  expect(f.notify).not.toHaveBeenCalled()
})
it("cancellation during a batch hook prevents the following model request", async () => {
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = fixture(
    vi.fn(async () => {
      entered()
      await pending
      return "late"
    })
  )
  await f.observe(ai())
  const result = f.run([ai(), ...replies()])
  await started
  f.controller.abort()
  release()
  await expect(result).rejects.toThrow()
  expect(f.handler).not.toHaveBeenCalled()
})
it("hook failure is remembered without repeating checks or calling the model", async () => {
  const f = fixture(
    vi.fn(async () => {
      throw Error("batch blocked")
    })
  )
  await f.observe(ai())
  await expect(f.run([ai(), ...replies()])).rejects.toThrow("batch blocked")
  await expect(f.run([ai(), ...replies()])).rejects.toThrow("batch blocked")
  expect(f.notify).toHaveBeenCalledTimes(1)
  expect(f.handler).not.toHaveBeenCalled()
})
