import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
  type ToolCall
} from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { tool } from "@langchain/core/tools"
import { Command, isCommand, MemorySaver } from "@langchain/langgraph"
import { createAgent, createMiddleware } from "langchain"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import {
  createSubagentLifecycleMiddleware,
  type PendingSubagentStop
} from "./subagent-lifecycle-middleware"

class ScriptedModel extends BaseChatModel {
  calls = 0
  constructor(private readonly responses: AIMessage[]) {
    super({})
  }
  _llmType(): string {
    return "subagent-lifecycle-test"
  }
  bindTools(): this {
    return this
  }
  async _generate(): Promise<ChatResult> {
    this.calls++
    const message = this.responses.shift()
    if (!message) throw new Error("Unexpected model call")
    return { generations: [{ text: String(message.content), message }] }
  }
}

function toolRequest(name: string, id: string) {
  return new AIMessage({ content: "", tool_calls: [{ id, name, args: {} }] })
}

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function taskTool(run: () => string | Promise<string>) {
  return tool(run, { name: "task", description: "Run a subagent", schema: z.object({}) })
}

describe("subagent lifecycle producer gate", () => {
  it("gates a task denied by an inner pre-tool hook without executing its handler", async () => {
    const pendingStops = new Map<string, PendingSubagentStop>()
    const saver = new MemorySaver()
    const config = { configurable: { thread_id: "pre-tool-denied" } }
    const child = vi.fn(() => "must not execute")
    const write = vi.fn(() => "must not write")
    const onStart = vi.fn()
    const model = new ScriptedModel([
      toolRequest("task", "denied-task"),
      toolRequest("write_file", "parent-write"),
      new AIMessage("must not finish")
    ])
    const onStop = vi.fn(async (_call: ToolCall, result: unknown) => {
      if (!ToolMessage.isInstance(result)) throw new Error("Expected denied ToolMessage")
      expect(result.status).toBe("error")
      expect(result.content).toBe("PreToolUse denied task")
      await new Promise((resolve) => setTimeout(resolve, 20))
      throw new Error("stop after denied task")
    })
    const agent = createAgent({
      model,
      checkpointer: saver,
      tools: [
        taskTool(child),
        tool(write, { name: "write_file", description: "Write", schema: z.object({}) })
      ],
      middleware: [
        createSubagentLifecycleMiddleware({ pendingStops, onStart, onStop }),
        createMiddleware({
          name: "preToolDenial",
          wrapToolCall: async (request, handler) => {
            if (request.toolCall.name !== "task") return handler(request)
            return new ToolMessage({
              name: "task",
              content: "PreToolUse denied task",
              status: "error",
              tool_call_id: request.toolCall.id!
            })
          }
        })
      ]
    })
    await expect(
      agent.invoke({ messages: [new HumanMessage("delegate")] }, config)
    ).rejects.toThrow("stop after denied task")
    expect(child).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect(model.calls).toBe(1)
    expect(onStart).toHaveBeenCalledOnce()
    expect(onStop).toHaveBeenCalledOnce()
    const checkpoint = await saver.getTuple(config)
    const messages = checkpoint?.checkpoint.channel_values.messages as BaseMessage[]
    expect(
      messages.some(
        (m) => ToolMessage.isInstance(m) && m.tool_call_id === "denied-task" && m.status === "error"
      )
    ).toBe(true)
  })

  it("waits for the start admission before entering the task handler", async () => {
    const entered = gate()
    const release = gate()
    const task = vi.fn(() => "child result")
    const model = new ScriptedModel([toolRequest("task", "task-1"), new AIMessage("done")])
    const agent = createAgent({
      model,
      tools: [taskTool(task)],
      middleware: [
        createSubagentLifecycleMiddleware({
          pendingStops: new Map(),
          onStart: async () => {
            entered.resolve()
            await release.promise
          },
          onStop: async () => undefined
        })
      ]
    })
    const running = agent.invoke({ messages: [new HumanMessage("delegate")] })
    await entered.promise
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(task).not.toHaveBeenCalled()
    expect(model.calls).toBe(1)
    release.resolve()
    await running
    expect(task).toHaveBeenCalledOnce()
  })

  it("does not add graph checkpoints compared with the same task/model execution", async () => {
    async function checkpointCount(gated: boolean) {
      const saver = new MemorySaver()
      const config = { configurable: { thread_id: `checkpoint-cost-${gated}` } }
      const agent = createAgent({
        model: new ScriptedModel([toolRequest("task", "task-1"), new AIMessage("done")]),
        checkpointer: saver,
        tools: [taskTool(() => "child result")],
        middleware: gated
          ? [
              createSubagentLifecycleMiddleware({
                pendingStops: new Map(),
                onStart: () => undefined,
                onStop: async () => undefined
              })
            ]
          : []
      })
      await agent.invoke({ messages: [new HumanMessage("delegate")] }, config)
      let count = 0
      for await (const checkpoint of saver.list(config)) {
        expect(checkpoint.checkpoint).toBeDefined()
        count++
      }
      return count
    }
    expect(await checkpointCount(true)).toBe(await checkpointCount(false))
  })

  it("gates task failures recovered to ToolMessage by an inner middleware", async () => {
    const pendingStops = new Map<string, PendingSubagentStop>()
    const model = new ScriptedModel([
      toolRequest("task", "failed-task"),
      new AIMessage("must not run")
    ])
    const onStop = vi.fn(async (_call: ToolCall, result: unknown) => {
      if (!ToolMessage.isInstance(result)) throw new Error("Expected a recovered ToolMessage")
      expect(result.status).toBe("error")
      throw new Error("stop after recovered failure")
    })
    const agent = createAgent({
      model,
      tools: [
        taskTool(() => {
          throw new Error("recoverable task failure")
        })
      ],
      middleware: [
        createSubagentLifecycleMiddleware({ pendingStops, onStart: () => undefined, onStop }),
        createMiddleware({
          name: "toolFailureRecovery",
          wrapToolCall: async (request, handler) => {
            try {
              return await handler(request)
            } catch {
              return new ToolMessage({
                name: "task",
                content: "failed",
                status: "error",
                tool_call_id: request.toolCall.id!
              })
            }
          }
        })
      ]
    })
    await expect(agent.invoke({ messages: [new HumanMessage("delegate")] })).rejects.toThrow(
      "stop after recovered failure"
    )
    expect(onStop).toHaveBeenCalledOnce()
    expect(model.calls).toBe(1)
  })

  it("preserves task Command results and awaits every pending stop", async () => {
    const pendingStops = new Map<string, PendingSubagentStop>()
    const stopped: string[] = []
    const agent = createAgent({
      model: new ScriptedModel([
        new AIMessage({
          content: "",
          tool_calls: [
            { id: "first", name: "task", args: { id: "first" } },
            { id: "second", name: "task", args: { id: "second" } }
          ]
        }),
        new AIMessage("done")
      ]),
      tools: [
        tool(
          ({ id }: { id: string }) =>
            new Command({
              update: {
                messages: [
                  new ToolMessage({ name: "task", content: `result-${id}`, tool_call_id: id })
                ]
              }
            }),
          { name: "task", description: "Run child", schema: z.object({ id: z.string() }) }
        )
      ],
      middleware: [
        createSubagentLifecycleMiddleware({
          pendingStops,
          onStart: () => undefined,
          onStop: async (call, result) => {
            expect(isCommand(result)).toBe(true)
            await new Promise((resolve) => setTimeout(resolve, 5))
            stopped.push(call.id!)
          }
        })
      ]
    })
    const result = await agent.invoke({ messages: [new HumanMessage("delegate twice")] })
    expect(stopped.sort()).toEqual(["first", "second"])
    expect(
      result.messages
        .filter(ToolMessage.isInstance)
        .map((m) => m.content)
        .sort()
    ).toEqual(["result-first", "result-second"])
    expect(pendingStops.size).toBe(0)
  })

  it("starts before task execution and checkpoints its result before awaiting stop", async () => {
    const pendingStops = new Map<string, PendingSubagentStop>()
    const events: string[] = []
    const entered = gate()
    const release = gate()
    const saver = new MemorySaver()
    const config = { configurable: { thread_id: "checkpoint-stop" } }
    let writes = 0
    const model = new ScriptedModel([
      toolRequest("task", "task-1"),
      toolRequest("write_file", "write-1"),
      new AIMessage("finished")
    ])
    const agent = createAgent({
      model,
      checkpointer: saver,
      tools: [
        taskTool(() => {
          events.push("task")
          return "child result"
        }),
        tool(
          () => {
            writes++
            return "written"
          },
          {
            name: "write_file",
            description: "Write",
            schema: z.object({})
          }
        )
      ],
      middleware: [
        createSubagentLifecycleMiddleware({
          pendingStops,
          onStart: () => {
            events.push("start")
          },
          onStop: async (call, result) => {
            events.push("stop")
            expect(call.id).toBe("task-1")
            expect(ToolMessage.isInstance(result)).toBe(true)
            const checkpoint = await saver.getTuple(config)
            const messages = checkpoint?.checkpoint.channel_values.messages as BaseMessage[]
            expect(
              messages.some(
                (message) =>
                  ToolMessage.isInstance(message) &&
                  message.tool_call_id === "task-1" &&
                  message.content === "child result"
              )
            ).toBe(true)
            entered.resolve()
            await release.promise
          }
        })
      ]
    })
    const running = agent.invoke({ messages: [new HumanMessage("delegate")] }, config)
    await entered.promise
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(events).toEqual(["start", "task", "stop"])
    expect(model.calls).toBe(1)
    expect(writes).toBe(0)
    release.resolve()
    await running
    expect(model.calls).toBe(3)
    expect(writes).toBe(1)
    expect(pendingStops.size).toBe(0)
  })

  it("propagates stop rejection without a later model/tool and retains the completed checkpoint", async () => {
    const pendingStops = new Map<string, PendingSubagentStop>()
    const saver = new MemorySaver()
    const config = { configurable: { thread_id: "halt-stop" } }
    const stopError = new Error("SubagentStop halted")
    const model = new ScriptedModel([toolRequest("task", "task-1"), new AIMessage("must not run")])
    const agent = createAgent({
      model,
      checkpointer: saver,
      tools: [taskTool(() => "persist me")],
      middleware: [
        createSubagentLifecycleMiddleware({
          pendingStops,
          onStart: () => undefined,
          onStop: async () => {
            throw stopError
          }
        })
      ]
    })
    await expect(
      agent.invoke({ messages: [new HumanMessage("delegate")] }, config)
    ).rejects.toThrow("SubagentStop halted")
    expect(model.calls).toBe(1)
    expect(pendingStops.size).toBe(1)
    const checkpoint = await saver.getTuple(config)
    const messages = checkpoint?.checkpoint.channel_values.messages as BaseMessage[]
    expect(messages.some((m) => ToolMessage.isInstance(m) && m.content === "persist me")).toBe(true)

    // A fresh runtime resumes the failed model node; it must still wait
    // for the pending decision, without executing the completed task again.
    const onStop = vi.fn(async () => undefined)
    const repeatedTask = vi.fn(() => "must not repeat")
    const replacement = createAgent({
      model: new ScriptedModel([new AIMessage("recovered")]),
      checkpointer: saver,
      tools: [taskTool(repeatedTask)],
      middleware: [
        createSubagentLifecycleMiddleware({
          pendingStops,
          onStart: () => undefined,
          onStop
        })
      ]
    })
    await replacement.invoke(null, config)
    expect(onStop).toHaveBeenCalledOnce()
    expect(repeatedTask).not.toHaveBeenCalled()
    expect(pendingStops.size).toBe(0)
  })

  it("leaves non-task tools alone and does not queue failed task invocations", async () => {
    const pendingStops = new Map<string, PendingSubagentStop>()
    const onStart = vi.fn()
    const onStop = vi.fn(async () => undefined)
    const agent = createAgent({
      model: new ScriptedModel([toolRequest("read_file", "read-1"), new AIMessage("done")]),
      tools: [tool(() => "read", { name: "read_file", description: "Read", schema: z.object({}) })],
      middleware: [createSubagentLifecycleMiddleware({ pendingStops, onStart, onStop })]
    })
    await agent.invoke({ messages: [new HumanMessage("read")] })
    expect(onStart).not.toHaveBeenCalled()
    expect(onStop).not.toHaveBeenCalled()
    const failing = createAgent({
      model: new ScriptedModel([toolRequest("task", "task-1")]),
      tools: [
        taskTool(() => {
          throw new Error("task interrupted")
        })
      ],
      middleware: [createSubagentLifecycleMiddleware({ pendingStops, onStart, onStop })]
    })
    await expect(failing.invoke({ messages: [new HumanMessage("delegate")] })).rejects.toThrow(
      "task interrupted"
    )
    expect(onStart).toHaveBeenCalledOnce()
    expect(onStop).not.toHaveBeenCalled()
    expect(pendingStops.size).toBe(0)
  })
})
