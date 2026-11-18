import { ToolMessage } from "@langchain/core/messages"
import { tool } from "langchain"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { getShellTaskOwnerId, SHELL_TASK_OWNER_CONFIG_KEY } from "./shell-monitor-tool"
import {
  createGradedToolConcurrencyMiddleware,
  createRuntimeToolDenylistMiddleware,
  wrapTaskToolWithOwnerMetadata
} from "./runtime"

function testTool(name: string) {
  return tool(() => "", { name, description: name, schema: z.object({}) })
}

describe("shell monitor runtime dispatch", () => {
  it("assigns private shell owners to distinct Task invocations with reused or missing IDs", async () => {
    const owners: Array<string | undefined> = []
    const metadata: Array<unknown> = []
    const delegatedTask = tool(
      (_input, config) => {
        owners.push(getShellTaskOwnerId(config))
        metadata.push(config?.metadata?.[SHELL_TASK_OWNER_CONFIG_KEY])
        return "ok"
      },
      { name: "task", description: "Task fixture", schema: z.object({}) }
    )
    const task = wrapTaskToolWithOwnerMetadata(delegatedTask)
    const reused = { type: "tool_call" as const, id: "reused", name: "task", args: {} }
    await task.invoke(reused)
    await task.invoke(reused)
    await task.invoke({})
    await task.invoke({})

    expect(owners).toEqual(Array(4).fill(expect.any(String)))
    expect(new Set(owners).size).toBe(4)
    expect(owners).not.toContain("reused")
    expect(metadata).toEqual(Array(4).fill(undefined))
  })

  it.each(["monitor", "task_output"])(
    "lets an exclusive tool progress while the built-in %s is waiting",
    async (name) => {
      const monitor = testTool(name)
      const exclusive = testTool("code_exec")
      const waiting = Promise.withResolvers<ToolMessage>()
      const entered = Promise.withResolvers<void>()
      const output = new ToolMessage({ content: "done", tool_call_id: "test" })
      const middleware = createGradedToolConcurrencyMiddleware(
        name + "-dispatch",
        new WeakSet([monitor])
      )
      const invoke = middleware.wrapToolCall!
      const request = (instance: typeof monitor) =>
        ({
          tool: instance,
          toolCall: { id: "test", name: instance.name, args: {} },
          state: { messages: [] },
          runtime: { signal: AbortSignal.timeout(1_000) }
        }) as unknown as Parameters<typeof invoke>[0]
      const pendingMonitor = invoke(request(monitor), async () => {
        entered.resolve()
        return waiting.promise
      })
      await entered.promise
      try {
        await expect(invoke(request(exclusive), () => output)).resolves.toBe(output)
      } finally {
        waiting.resolve(output)
        await pendingMonitor
      }
    }
  )

  it("keeps an unregistered tool with a monitor name under the tool lock", async () => {
    const builtin = testTool("monitor")
    const other = testTool("monitor")
    const output = new ToolMessage({ content: "done", tool_call_id: "test" })
    const waiting = Promise.withResolvers<ToolMessage>()
    const entered = Promise.withResolvers<void>()
    const middleware = createGradedToolConcurrencyMiddleware(
      "non-builtin-monitor-dispatch",
      new WeakSet([builtin])
    )
    const invoke = middleware.wrapToolCall!
    const request = (instance: typeof builtin) =>
      ({
        tool: instance,
        toolCall: { id: "test", name: instance.name, args: {} },
        state: { messages: [] },
        runtime: { signal: AbortSignal.timeout(1_000) }
      }) as unknown as Parameters<typeof invoke>[0]
    const exclusive = invoke(request(testTool("code_exec")), async () => {
      entered.resolve()
      return waiting.promise
    })
    await entered.promise
    const handler = vi.fn(() => output)
    const queued = invoke(request(other), handler)
    try {
      await Promise.resolve()
      expect(handler).not.toHaveBeenCalled()
    } finally {
      waiting.resolve(output)
      await exclusive
      await queued
    }
    expect(handler).toHaveBeenCalledOnce()
  })

  it.each(["monitor", "task_output"])(
    "hides and rejects both monitor aliases when %s is denied",
    async (denied) => {
      const middleware = createRuntimeToolDenylistMiddleware([denied])
      const handleTool = vi.fn()
      const invoke = middleware.wrapToolCall!
      for (const name of ["monitor", "task_output"]) {
        const request = { toolCall: { id: "monitor-call", name, args: {} } }
        const result = await invoke(request as Parameters<typeof invoke>[0], handleTool)
        expect(result).toMatchObject({ name, status: "error" })
      }
      expect(handleTool).not.toHaveBeenCalled()

      const tools = [testTool("monitor"), testTool("task_output"), testTool("execute")]
      const handleModel = vi.fn()
      const invokeModel = middleware.wrapModelCall!
      await invokeModel({ tools } as unknown as Parameters<typeof invokeModel>[0], handleModel)
      expect(handleModel.mock.calls[0][0].tools).toEqual([tools[2]])
    }
  )
})
