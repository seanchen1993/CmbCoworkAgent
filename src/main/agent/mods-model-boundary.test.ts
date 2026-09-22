import { AIMessageChunk, HumanMessage } from "@langchain/core/messages"
import { FakeStreamingChatModel } from "@langchain/core/utils/testing"
import { MemorySaver } from "@langchain/langgraph"
import { createAgent } from "langchain"
import { expect, it, vi } from "vitest"
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { FunctionGuestRuntime } from "../mods/v2/guest-runtime"
import {
  dispatchFunctionStream,
  type FunctionStreamOptions
} from "../mods/v2/stream-dispatcher"
import type { ModObject } from "../../shared/mods/types"
import { createModModelBoundary } from "./mods-model-boundary"

const testAuthority = { turnId: "turn", assertLive: () => undefined } as never

async function createFixture() {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("turn.step",async function*($,e,next){
      for await(const frame of next(e)) {
        if (frame.kind === "text") yield {...frame,text:frame.text.replace("RAW_MARKER","SAFE")}
        else yield frame
      }
    })
  }}`)
  const plugin = { name: "boundary-mod", root: "/boundary-mod", tier: "user" as const, guest, capabilities: [] }
  const manager = {
    functionModelStream: vi.fn(
      (_authority: unknown, input: ModObject, core: FunctionStreamOptions["core"], signal: AbortSignal) =>
      Promise.resolve(dispatchFunctionStream([plugin], input, { signal, core }))
    )
  }
  return { guest, manager }
}

it("routes the real createAgent model stream through Mods before callbacks and checkpoints", async () => {
  const { guest, manager } = await createFixture()
  try {
    const provider = new FakeStreamingChatModel({
      chunks: [new AIMessageChunk({ content: "RAW_MARKER" })]
    })
    const model = createModModelBoundary(provider, manager as never, testAuthority, {
      turnId: "turn",
      model: "fixture",
      agentId: "main"
    })
    const tokens: string[] = []
    const ends: string[] = []
    const inspect = tool(async () => "unused", {
      name: "inspect",
      description: "fixture",
      schema: z.object({})
    })
    const agent = createAgent({ model, tools: [inspect], checkpointer: new MemorySaver() })
    const stream = await agent.stream(
      { messages: [new HumanMessage("probe")] },
      {
        configurable: { thread_id: "mods-boundary" },
        callbacks: [
          {
            handleLLMNewToken(token: string) {
              tokens.push(token)
            },
            handleLLMEnd(output: unknown) {
              ends.push(JSON.stringify(output))
            }
          }
        ],
        streamMode: ["messages", "values"]
      }
    )
    const visible: unknown[] = []
    for await (const chunk of stream) visible.push(chunk)
    const state = (await agent.getState({ configurable: { thread_id: "mods-boundary" } })) as unknown as {
      values: unknown
    }
    expect(tokens.join("")).toBe("SAFE")
    expect(JSON.stringify(visible)).toContain("SAFE")
    expect(JSON.stringify(visible)).not.toContain("RAW_MARKER")
    expect(JSON.stringify(state.values)).toContain("SAFE")
    expect(JSON.stringify(state.values)).not.toContain("RAW_MARKER")
    expect(ends.join("")).not.toContain("RAW_MARKER")
    expect(manager.functionModelStream).toHaveBeenCalledOnce()
  } finally {
    guest.dispose()
  }
})

it("propagates cancellation into the provider and bypasses a disabled boundary", async () => {
  const controller = new AbortController()
  let aborted = false
  const provider = new FakeStreamingChatModel({
    chunks: [new AIMessageChunk({ content: "first" })]
  })
  const manager = {
    functionModelStream: vi.fn(
      async (
        _authority: unknown,
        input: ModObject,
        core: FunctionStreamOptions["core"],
        signal: AbortSignal
      ) => {
      const stream = dispatchFunctionStream([], input, { signal, core })
      signal.addEventListener("abort", () => {
        aborted = true
      }, { once: true })
      return stream
      }
    )
  }
  const model = createModModelBoundary(provider, manager as never, testAuthority, {
    turnId: "turn",
    model: "fixture"
  })
  const output: string[] = []
  await expect(
    (async () => {
      for await (const chunk of await model.stream([new HumanMessage("cancel")], {
        signal: controller.signal
      })) {
        output.push(chunk.text)
        controller.abort()
      }
    })()
  ).rejects.toThrow()
  expect(output).toEqual(["first"])
  expect(aborted).toBe(true)

  const direct = new FakeStreamingChatModel({ chunks: [new AIMessageChunk({ content: "raw" })] })
  const bypass = createModModelBoundary(direct, undefined, undefined, {
    turnId: "turn",
    model: "fixture"
  })
  expect((await bypass.invoke([new HumanMessage("off")])).content).toBe("off")
})

it("rejects duplicate opaque frames and plugin model selection changes", async () => {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("turn.step",async function*($,e,next){
      const frames=[]; for await(const frame of next({...e,model:"other-model"})) frames.push(frame)
      for(const frame of frames) { yield frame; yield frame }
    })
  }}`)
  const plugin = { name: "replay-mod", root: "/replay-mod", tier: "user" as const, guest, capabilities: [] }
  const manager = {
    functionModelStream: vi.fn(
      (_authority: unknown, input: ModObject, core: FunctionStreamOptions["core"], signal: AbortSignal) =>
        Promise.resolve(dispatchFunctionStream([plugin], input, { signal, core }))
    )
  }
  try {
    const model = createModModelBoundary(
      new FakeStreamingChatModel({ chunks: [new AIMessageChunk({ content: "raw" })] }),
      manager as never,
      testAuthority,
      { turnId: "turn", model: "fixture" }
    )
    await expect(model.invoke([new HumanMessage("reject")])).rejects.toThrow(
      "MODS_MODEL_SELECTION_UNSUPPORTED"
    )
  } finally {
    guest.dispose()
  }

  const duplicateGuest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("turn.step",async function*($,e,next){
      let first; for await(const frame of next(e)) { first ??= frame; yield frame }
      if(first) yield first
    })
  }}`)
  const duplicatePlugin = {
    name: "duplicate-mod",
    root: "/duplicate-mod",
    tier: "user" as const,
    guest: duplicateGuest,
    capabilities: []
  }
  try {
    const duplicateManager = {
      functionModelStream: vi.fn(
        (_authority: unknown, input: ModObject, core: FunctionStreamOptions["core"], signal: AbortSignal) =>
          Promise.resolve(dispatchFunctionStream([duplicatePlugin], input, { signal, core }))
      )
    }
    const model = createModModelBoundary(
      new FakeStreamingChatModel({ chunks: [new AIMessageChunk({ content: "raw" })] }),
      duplicateManager as never,
      testAuthority,
      { turnId: "turn", model: "fixture" }
    )
    await expect(model.invoke([new HumanMessage("replay")])).rejects.toThrow("MODS_MODEL_REF_REPLAY")
  } finally {
    duplicateGuest.dispose()
  }
})

it("retains a shared turn index through bindTools and rejects replaced authority", async () => {
  const indexes: number[] = []
  const manager = {
    functionModelStream: vi.fn(
      (_authority: unknown, input: ModObject, core: FunctionStreamOptions["core"], signal: AbortSignal) => {
        indexes.push(Number(input.index))
        return Promise.resolve(dispatchFunctionStream([], input, { signal, core }))
      }
    )
  }
  const model = createModModelBoundary(
    new FakeStreamingChatModel({ chunks: [new AIMessageChunk({ content: "raw" })] }),
    manager as never,
    testAuthority,
    { turnId: "turn", model: "fixture" }
  )
  const bound = model.bindTools?.([]) as typeof model
  await bound.invoke([new HumanMessage("one")])
  await bound.invoke([new HumanMessage("two")])
  expect(indexes).toEqual([0, 1])

  const { ModRuntimeAuthorities } = await import("../mods/runtime-instance")
  const authorities = new ModRuntimeAuthorities()
  const first = authorities.create({ workspace: "/workspace", threadId: "thread", turnId: "turn" })
  const stale = createModModelBoundary(
    new FakeStreamingChatModel({ chunks: [new AIMessageChunk({ content: "raw" })] }),
    manager as never,
    first.authority,
    { turnId: "turn", model: "fixture" }
  )
  authorities.create({ workspace: "/workspace", threadId: "thread", turnId: "turn" })
  await expect(stale.invoke([new HumanMessage("stale")])).rejects.toThrow()
  authorities.close()
})

it("bounds host opaque frame retention", async () => {
  const manager = {
    functionModelStream: vi.fn(
      (_authority: unknown, input: ModObject, core: FunctionStreamOptions["core"], signal: AbortSignal) =>
        Promise.resolve(dispatchFunctionStream([], input, { signal, core }))
    )
  }
  const chunks = Array.from({ length: 513 }, (_, index) => new AIMessageChunk({ content: String(index) }))
  const model = createModModelBoundary(
    new FakeStreamingChatModel({ chunks }),
    manager as never,
    testAuthority,
    { turnId: "turn", model: "fixture" }
  )
  await expect(model.invoke([new HumanMessage("bounded")])).rejects.toThrow("MODS_MODEL_STREAM_LIMIT")
})
