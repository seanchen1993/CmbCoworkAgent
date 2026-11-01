import { AIMessageChunk, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages"
import { ChatGenerationChunk } from "@langchain/core/outputs"
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { FakeListChatModel, FakeStreamingChatModel } from "@langchain/core/utils/testing"
import { MemorySaver } from "@langchain/langgraph"
import { createAgent } from "langchain"
import { afterEach, expect, it, vi } from "vitest"
import { createModModelBoundary, type FunctionModelStreamHost } from "./mods-model-boundary"
import { dispatchFunctionStream } from "../mods/v2/stream-dispatcher"
import { FunctionGuestRuntime } from "../mods/v2/guest-runtime"
import { createCmbContextController } from "./context-summarization-middleware"
import { fitFinalModelInput, withFinalModelInputRecovery } from "./final-model-budget"

const summary =
  "## Goal\nContinue the user's task.\n## Constraints\nPreserve permissions.\n" +
  "## Completed\nRead source.\n## Current State\nDraft retained.\n## Blockers\nNone.\n" +
  "## Key Decisions\nKeep exact identity.\n## Next Step\nVerify draft.\n## Critical Evidence\nSource retained."

const guests: FunctionGuestRuntime[] = []
afterEach(() => {
  for (const guest of guests.splice(0)) guest.dispose()
  vi.restoreAllMocks()
})

it.each([
  [45080, false],
  [4000, false],
  [4000, true]
] as const)(
  "recovers final Hook budget %i after prior compaction=%s without replay",
  async (budget, priorCompaction) => {
    const provider = new FakeStreamingChatModel({ chunks: [new AIMessageChunk("continued")] })
    const send = vi.spyOn(FakeStreamingChatModel.prototype, "_streamResponseChunks")
    const guest = priorCompaction
      ? await FunctionGuestRuntime.create(`var entries=0;
      var __cmbFunctionMod={register(on){on("turn.step",async function*($,event,next){
        if(++entries>2) throw Error("HOOK_REPLAYED");
        for await(const frame of next(event)) yield frame;
      })}}`)
      : undefined
    if (guest) guests.push(guest)
    const manager: FunctionModelStreamHost = {
      functionModelStream: vi.fn(async (_owner, input, core, signal) =>
        dispatchFunctionStream(
          guest
            ? [{ name: "budget-hook", root: "/budget-hook", tier: "user", guest, capabilities: [] }]
            : [],
          input,
          { core, signal }
        )
      ),
      promptComposition: vi.fn(async (_workspace, _thread, event, input, signal, core) => {
        const result = await core(input, signal)
        if (event === "prompt.compose")
          return {
            sections: [
              ...(result.sections as []),
              { id: "hook", scope: "session", text: "F".repeat(budget * 2) }
            ]
          }
        return result
      })
    }
    const authority = { turnId: "turn", agentId: "main", assertLive: () => undefined } as never
    const model = createModModelBoundary(
      provider,
      manager,
      authority,
      { turnId: "turn", model: "selected" },
      {
        resolve: async () => ({
          provider,
          model: "selected",
          contextWindow: 128000,
          inputBudget: budget
        })
      }
    )
    const summaryModel = new FakeListChatModel({ responses: [summary] })
    const summarize = vi.spyOn(summaryModel, "invoke")
    const archive = vi.fn(async (path: string) => ({ path }))
    const controller = createCmbContextController({
      model: summaryModel,
      backend: { write: archive } as never,
      trigger: { type: "tokens", value: priorCompaction ? 2500 : 100000 },
      keep: { type: "messages", value: 1 },
      maxInputTokens: 128000,
      postCompactionInputBudgetTokens: 45080
    })
    const saver = new MemorySaver()
    const graph = createAgent({
      model,
      systemPrompt: "Original rules",
      tools: [],
      middleware: [controller.middleware],
      checkpointer: saver
    })
    const config = { configurable: { thread_id: `budget-${budget}` } }
    const messages = [new HumanMessage("User request"), new HumanMessage("h".repeat(budget * 3))]
    const result = await graph.invoke({ messages }, config)
    expect(result.messages.at(-1)?.content).toBe("continued")
    expect(send).toHaveBeenCalledTimes(1)
    expect(manager.functionModelStream).toHaveBeenCalledTimes(1)
    const compositionCalls = vi.mocked(manager.promptComposition!).mock.calls
    expect(compositionCalls.filter((call) => call[2] === "prompt.compose")).toHaveLength(1)
    expect(summarize).toHaveBeenCalledTimes(priorCompaction ? 2 : 1)
    const sent = send.mock.calls[0][0] as SystemMessage[]
    expect(sent.filter((message) => message.type === "system")[0].content).toContain(
      "F".repeat(budget * 2)
    )
    expect(sent.some((message) => String(message.content).includes("## Goal"))).toBe(true)
    expect(archive).toHaveBeenCalledTimes(priorCompaction ? 2 : 1)
    const checkpoint = (await saver.getTuple(config))!.checkpoint.channel_values
    expect(checkpoint._summarizationEvent).toMatchObject({
      cutoffIndex: 2,
      usageStartIndex: 2
    })
    expect(checkpoint.messages).toHaveLength(3)
    await graph.invoke({ messages: [new HumanMessage("Continue now")] }, config)
    expect(send).toHaveBeenCalledTimes(2)
    expect(manager.functionModelStream).toHaveBeenCalledTimes(2)
    expect(
      (send.mock.calls[1][0] as SystemMessage[])
        .map((message) => String(message.content))
        .join("\n")
    ).not.toContain("h".repeat(50))
    expect(summarize).toHaveBeenCalledTimes(priorCompaction ? 2 : 1)
  }
)

it.each(["system", "tools"])(
  "rejects fixed %s payload without requesting a summary",
  async (kind) => {
    const recover = vi.fn()
    await expect(
      withFinalModelInputRecovery(recover, () =>
        fitFinalModelInput({
          messages: [
            ...(kind === "system" ? [new SystemMessage("x".repeat(4000))] : []),
            new HumanMessage("task")
          ],
          tools: kind === "tools" ? [{ name: "large", description: "x".repeat(4000) }] : [],
          model: "small",
          contextWindow: 2000,
          inputBudget: 900,
          signal: new AbortController().signal
        })
      )
    ).rejects.toThrow("固定指令或工具已经占满")
    expect(recover).not.toHaveBeenCalled()
  }
)

it("does not treat another error as input overflow or leak a recovery scope to another request", async () => {
  const calls = [vi.fn(), vi.fn()]
  await Promise.all(
    calls.map((recover, index) =>
      withFinalModelInputRecovery(
        async () => {
          recover()
          if (index === 0) throw Error("permission denied")
          return { messages: [new HumanMessage("safe")], usageStartIndex: index }
        },
        async () => {
          const request = fitFinalModelInput({
            messages: [new HumanMessage("x".repeat(4000))],
            model: "small",
            contextWindow: 2000,
            inputBudget: 900,
            signal: new AbortController().signal
          })
          if (index === 0) await expect(request).rejects.toThrow("permission denied")
          else expect((await request)?.usageStartIndex).toBe(index)
        }
      )
    )
  )
  expect(calls.map((call) => call.mock.calls.length)).toEqual([1, 1])
})

it("rejects no progress, cancellation, and repeat recovery in the same request", async () => {
  const controller = new AbortController()
  const input = {
    messages: [new HumanMessage("x".repeat(4000))],
    model: "small",
    contextWindow: 2000,
    inputBudget: 900,
    signal: controller.signal
  }
  await expect(
    withFinalModelInputRecovery(
      async () => ({ messages: input.messages, usageStartIndex: 1 }),
      () => fitFinalModelInput(input)
    )
  ).rejects.toThrow("压缩后仍无法容纳")
  const recover = vi.fn(async () => ({
    messages: [new HumanMessage("summary")],
    usageStartIndex: 1
  }))
  await withFinalModelInputRecovery(recover, async () => {
    await fitFinalModelInput(input)
    await expect(fitFinalModelInput(input)).rejects.toThrow("不能重复压缩同一请求")
  })
  expect(recover).toHaveBeenCalledTimes(1)
  await expect(
    withFinalModelInputRecovery(
      async () => {
        controller.abort(Error("cancelled"))
        return { messages: [new HumanMessage("summary")], usageStartIndex: 1 }
      },
      () => fitFinalModelInput(input)
    )
  ).rejects.toThrow("cancelled")
})

it("retires inherited callbacks when the owning model request has settled", async () => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let late!: Promise<unknown>
  const recover = vi.fn()
  await withFinalModelInputRecovery(recover, async () => {
    late = pending.then(() =>
      fitFinalModelInput({
        messages: [new HumanMessage("x".repeat(4000))],
        model: "small",
        contextWindow: 2000,
        inputBudget: 900,
        signal: new AbortController().signal
      })
    )
  })
  const rejected = expect(late).rejects.toThrow("不能重复压缩同一请求")
  release()
  await rejected
  expect(recover).not.toHaveBeenCalled()
})

it.each(["tool", "cancel"])(
  "preserves the graph's real %s boundary during final recovery",
  async (mode) => {
    const signal = new AbortController()
    const provider = new FakeStreamingChatModel({ chunks: [] })
    let sends = 0
    vi.spyOn(FakeStreamingChatModel.prototype, "_streamResponseChunks").mockImplementation(
      async function* () {
        sends++
        const message =
          sends === 1
            ? new AIMessageChunk({
                content: "",
                tool_call_chunks: [{ name: "inspect", args: "{}", id: "call-1", index: 0 }]
              })
            : new AIMessageChunk("finished")
        yield new ChatGenerationChunk({ text: "", message })
      }
    )
    const inspect = vi.fn(async () => "actual tool evidence")
    const manager: FunctionModelStreamHost = {
      functionModelStream: vi.fn(async (_owner, input, core, active) =>
        dispatchFunctionStream([], input, { core, signal: active })
      )
    }
    const authority = { turnId: "turn", agentId: "main", assertLive: () => undefined } as never
    const model = createModModelBoundary(
      provider,
      manager,
      authority,
      { turnId: "turn", model: "small" },
      {
        resolve: async () => ({ provider, model: "small", contextWindow: 8000, inputBudget: 2000 })
      }
    )
    const summaryModel = new FakeListChatModel({ responses: [summary] })
    const summarize = vi.spyOn(summaryModel, "invoke")
    if (mode === "cancel")
      summarize.mockImplementation(async () => {
        signal.abort(Error("cancel recovery"))
        return new AIMessageChunk(summary)
      })
    const archive = vi.fn(async (path: string) => ({ path }))
    const controller = createCmbContextController({
      model: summaryModel,
      backend: { write: archive } as never,
      trigger: { type: "tokens", value: 100000 },
      maxInputTokens: 128000,
      postCompactionInputBudgetTokens: 45080
    })
    const saver = new MemorySaver()
    const graph = createAgent({
      model,
      tools: [tool(inspect, { name: "inspect", schema: z.object({}) })],
      middleware: [controller.middleware],
      checkpointer: saver
    })
    const config = { configurable: { thread_id: mode }, signal: signal.signal }
    const run = graph.invoke(
      { messages: [new HumanMessage("task"), new HumanMessage("x".repeat(12000))] },
      config
    )
    if (mode === "cancel") {
      await expect(run).rejects.toThrow()
      expect(sends).toBe(0)
      expect(archive).not.toHaveBeenCalled()
      expect(
        (await saver.getTuple(config))!.checkpoint.channel_values._summarizationEvent
      ).toBeUndefined()
    } else {
      const result = await run
      expect(result.messages.at(-1)?.content).toBe("finished")
      expect(inspect).toHaveBeenCalledTimes(1)
      expect(
        result.messages.some(
          (message) => ToolMessage.isInstance(message) && message.tool_call_id === "call-1"
        )
      ).toBe(true)
      expect(sends).toBe(2)
      expect(manager.functionModelStream).toHaveBeenCalledTimes(2)
      expect(summarize).toHaveBeenCalledTimes(1)
      expect(
        (await saver.getTuple(config))!.checkpoint.channel_values._summarizationEvent
      ).toMatchObject({
        cutoffIndex: 2,
        usageStartIndex: 2
      })
    }
  }
)
