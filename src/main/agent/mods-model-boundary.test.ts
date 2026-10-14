import { AIMessageChunk, HumanMessage, SystemMessage } from "@langchain/core/messages"
import { FakeStreamingChatModel } from "@langchain/core/utils/testing"
import { MemorySaver } from "@langchain/langgraph"
import { createAgent } from "langchain"
import { afterEach, expect, it, vi } from "vitest"
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { ChatGenerationChunk } from "@langchain/core/outputs"
import type { HandleLLMNewTokenCallbackFields } from "@langchain/core/callbacks/base"
import { FunctionGuestRuntime } from "../mods/v2/guest-runtime"
import { dispatchFunctionStream, type FunctionStreamOptions } from "../mods/v2/stream-dispatcher"
import type { ModJson, ModObject } from "../../shared/mods/types"
import { createModModelBoundary, type FunctionModelStreamHost } from "./mods-model-boundary"
import { createFunctionStepModelResolver, getModelInstance } from "./runtime"
import { ModsManager } from "../mods/manager"
import { ModRuntimeAuthorities } from "../mods/runtime-instance"
import { createFunctionSessionViewMiddleware } from "./mods-session-view"
import { queryFunctionSessionRead } from "../mods/v2/session-read-host"
import { mkdtempSync, rmSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const testAuthority = { turnId: "turn", agentId: "main", assertLive: () => undefined } as never

it("pins model boundary identity to the actual independent child authority", async () => {
  const owners = new ModRuntimeAuthorities()
  const { authority } = owners.create({
    workspace: "/boundary-workspace",
    threadId: "thread",
    agentId: "flow:actual:agent:0",
    turnId: "actual-child-turn"
  })
  const input = vi.fn()
  const manager: FunctionModelStreamHost = {
    functionModelStream: async (owner, value, core, signal) => {
      expect(owner).toBe(authority)
      input(value)
      return dispatchFunctionStream([], value, { signal, core })
    }
  }
  try {
    const boundary = createModModelBoundary(
      new FakeStreamingChatModel({ chunks: [new AIMessageChunk("actual request")] }),
      manager,
      authority,
      { turnId: "wrong-turn", agentId: "main", model: "fixture" }
    )
    await boundary.invoke([new HumanMessage("probe")])
    expect(input).toHaveBeenCalledWith(expect.objectContaining({
      turnId: "actual-child-turn", agentId: "flow:actual:agent:0"
    }))
  } finally {
    owners.close()
  }
})

async function createFixture() {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("turn.step",async function*($,e,next){
      for await(const frame of next(e)) {
        if (frame.kind === "text") yield {...frame,text:frame.text.replace("RAW_MARKER","SAFE")}
        else yield frame
      }
    })
  }}`)
  const plugin = {
    name: "boundary-mod",
    root: "/boundary-mod",
    tier: "user" as const,
    guest,
    capabilities: []
  }
  const manager = {
    functionModelStream: vi.fn(
      (
        _authority: unknown,
        input: ModObject,
        core: FunctionStreamOptions["core"],
        signal: AbortSignal
      ) => Promise.resolve(dispatchFunctionStream([plugin], input, { signal, core }))
    )
  }
  return { guest, manager }
}

it("routes the real createAgent model stream through Mods before callbacks and checkpoints", async () => {
  const { guest, manager } = await createFixture()
  try {
    const provider = new FakeStreamingChatModel({
      chunks: [
        new AIMessageChunk({
          content: "RAW_MARKER",
          additional_kwargs: { reasoning_content: "host reasoning" }
        })
      ]
    })
    const model = createModModelBoundary(provider, manager as never, testAuthority, {
      turnId: "turn",
      model: "fixture",
      agentId: "main"
    })
    const tokens: string[] = []
    const callbackChunks: unknown[] = []
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
            handleLLMNewToken(
              token: string,
              _indices: unknown,
              _runId: string,
              _parentRunId?: string,
              _tags?: string[],
              fields?: HandleLLMNewTokenCallbackFields
            ) {
              tokens.push(token)
              callbackChunks.push(fields?.chunk)
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
    const state = (await agent.getState({
      configurable: { thread_id: "mods-boundary" }
    })) as unknown as {
      values: unknown
    }
    expect(tokens.join("")).toBe("SAFE")
    expect(callbackChunks).toEqual([
      expect.objectContaining({
        text: "SAFE",
        message: expect.objectContaining({
          content: "SAFE",
          id: expect.any(String),
          additional_kwargs: { reasoning_content: "host reasoning" }
        })
      })
    ])
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

it("preserves reused provider IDs in live graph packets across empty-Mods model calls", async () => {
  const manager = {
    functionModelStream: (
      _authority: unknown,
      input: ModObject,
      core: FunctionStreamOptions["core"],
      signal: AbortSignal
    ) => Promise.resolve(dispatchFunctionStream([], input, { signal, core }))
  }
  let invocation = 0
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      invocation += 1
      const data = {
        id: "provider-reused-741",
        object: "chat.completion.chunk",
        model: "fixture",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: `checking${invocation}` },
            finish_reason: "stop"
          }
        ]
      }
      return new Response(`data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" }
      })
    })
  )
  const provider = getModelInstance(defaultModelConfig, undefined, 1)
  const model = createModModelBoundary(provider, manager, testAuthority, {
    turnId: "turn",
    model: "fixture"
  })
  const agent = createAgent({ model, tools: [], checkpointer: new MemorySaver() })
  const observed: Array<{ id?: string; content: unknown }> = []
  for (const step of [1, 2]) {
    const stream = await agent.stream(
      { messages: [new HumanMessage(`turn ${step}`)] },
      {
        configurable: { thread_id: "empty-mods-reused-provider" },
        streamMode: ["messages", "values"]
      }
    )
    const live: AIMessageChunk[] = []
    for await (const [mode, packet] of stream) {
      if (mode === "messages" && packet[0] instanceof AIMessageChunk) live.push(packet[0])
    }
    const content = live.filter((chunk) => chunk.content === `checking${step}`)
    expect(content).toHaveLength(1)
    expect(content[0].id).toBe("provider-reused-741")
    observed.push({ id: content[0].id, content: content[0].content })
  }
  expect(observed.map((row) => row.content)).toEqual(["checking1", "checking2"])
})

it.each([false, true])(
  "keeps usage-tail identity in one provider message when text rewrite is %s",
  async (rewrite) => {
    const { guest, manager } = await createFixture()
    let invocation = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        invocation++
        const common = {
          id: `provider-usage-${invocation}`,
          object: "chat.completion.chunk",
          model: "fixture"
        }
        const events = [
          {
            ...common,
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "RAW_MARKER" },
                finish_reason: "stop"
              }
            ]
          },
          {
            ...common,
            choices: [],
            usage: { prompt_tokens: 13, completion_tokens: 7, total_tokens: 20 }
          }
        ]
        return new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } }
        )
      })
    )
    const passThrough: FunctionModelStreamHost = {
      functionModelStream: (_owner, input, core, signal) =>
        Promise.resolve(dispatchFunctionStream([], input, { core, signal }))
    }
    try {
      const provider = getModelInstance(defaultModelConfig, undefined, 1)
      const model = createModModelBoundary(
        provider,
        rewrite ? manager : passThrough,
        testAuthority,
        { turnId: "turn", model: "fixture" }
      )
      const agent = createAgent({ model, tools: [], checkpointer: new MemorySaver() })
      const config = { configurable: { thread_id: `usage-tail-${rewrite}` } }
      for (const step of [1, 2]) {
        const stream = await agent.stream(
          { messages: [new HumanMessage(`turn ${step}`)] },
          {
            ...config,
            streamMode: ["messages", "values"]
          }
        )
        const live: AIMessageChunk[] = []
        for await (const [mode, packet] of stream) {
          if (mode === "messages" && packet[0] instanceof AIMessageChunk) live.push(packet[0])
        }
        expect(new Set(live.map((chunk) => chunk.id))).toEqual(new Set([`provider-usage-${step}`]))
        expect(live.map((chunk) => chunk.content).join("")).toBe(rewrite ? "SAFE" : "RAW_MARKER")
        const state = (await agent.getState(config)) as unknown as {
          values: { messages: AIMessageChunk[] }
        }
        const assistants = state.values.messages.filter((message) => message.getType() === "ai")
        expect(assistants).toHaveLength(step)
        expect(assistants.at(-1)?.id).toBe(`provider-usage-${step}`)
        expect(assistants.at(-1)?.usage_metadata).toMatchObject({
          input_tokens: 13,
          output_tokens: 7,
          total_tokens: 20
        })
      }
    } finally {
      guest.dispose()
    }
  }
)

it("preserves fully ID-less requests and explicitly different provider IDs", async () => {
  const manager: FunctionModelStreamHost = {
    functionModelStream: (_owner, input, core, signal) =>
      Promise.resolve(dispatchFunctionStream([], input, { core, signal }))
  }
  const usage = { input_tokens: 13, output_tokens: 7, total_tokens: 20 }
  const provider = (explicit: boolean) => {
    const model = new FakeStreamingChatModel({})
    // FakeStreamingChatModel itself discards IDs and usage; retain native chunks here.
    vi.spyOn(model, "_streamResponseChunks").mockImplementation(async function* () {
      const chunks = explicit
        ? [
            new AIMessageChunk({ content: "first", id: "provider-first" }),
            new AIMessageChunk({ content: "second", id: "run-explicit-provider" })
          ]
        : [new AIMessageChunk({ content: "same answer" })]
      chunks.push(new AIMessageChunk({ content: "", usage_metadata: usage }))
      for (const message of chunks)
        yield new ChatGenerationChunk({ text: String(message.content), message })
    })
    return model
  }
  const idless = createModModelBoundary(provider(false), manager, testAuthority, {
    turnId: "turn",
    model: "fixture"
  })
  const requestIds: string[] = []
  for (const step of [1, 2]) {
    const chunks: AIMessageChunk[] = []
    for await (const chunk of await idless.stream([new HumanMessage(`request ${step}`)]))
      chunks.push(chunk as AIMessageChunk)
    expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(1)
    expect(chunks[0].id).toMatch(/^run-/)
    expect(chunks.at(-1)?.usage_metadata).toEqual(usage)
    requestIds.push(chunks[0].id!)
  }
  expect(new Set(requestIds).size).toBe(2)

  const explicit = createModModelBoundary(provider(true), manager, testAuthority, {
    turnId: "turn",
    model: "fixture"
  })
  const chunks: AIMessageChunk[] = []
  for await (const chunk of await explicit.stream([new HumanMessage("explicit IDs")]))
    chunks.push(chunk as AIMessageChunk)
  expect(chunks.map((chunk) => chunk.id)).toEqual([
    "provider-first",
    "run-explicit-provider",
    "run-explicit-provider"
  ])
  expect(chunks.at(-1)?.usage_metadata).toEqual(usage)
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
        signal.addEventListener(
          "abort",
          () => {
            aborted = true
          },
          { once: true }
        )
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
  const resolve = vi.fn()
  const bypass = createModModelBoundary(
    direct,
    undefined,
    undefined,
    {
      turnId: "turn",
      model: "fixture"
    },
    { resolve }
  )
  expect((await bypass.invoke([new HumanMessage("off")])).content).toBe("off")
  expect(resolve).not.toHaveBeenCalled()
})

it("rejects duplicate opaque frames and plugin model selection changes", async () => {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("turn.step",async function*($,e,next){
      const frames=[]; for await(const frame of next({...e,model:"other-model"})) frames.push(frame)
      for(const frame of frames) { yield frame; yield frame }
    })
  }}`)
  const plugin = {
    name: "replay-mod",
    root: "/replay-mod",
    tier: "user" as const,
    guest,
    capabilities: []
  }
  const manager = {
    functionModelStream: vi.fn(
      (
        _authority: unknown,
        input: ModObject,
        core: FunctionStreamOptions["core"],
        signal: AbortSignal
      ) => Promise.resolve(dispatchFunctionStream([plugin], input, { signal, core }))
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
        (
          _authority: unknown,
          input: ModObject,
          core: FunctionStreamOptions["core"],
          signal: AbortSignal
        ) => Promise.resolve(dispatchFunctionStream([duplicatePlugin], input, { signal, core }))
      )
    }
    const model = createModModelBoundary(
      new FakeStreamingChatModel({ chunks: [new AIMessageChunk({ content: "raw" })] }),
      duplicateManager as never,
      testAuthority,
      { turnId: "turn", model: "fixture" }
    )
    await expect(model.invoke([new HumanMessage("replay")])).rejects.toThrow(
      "MODS_MODEL_REF_REPLAY"
    )
  } finally {
    duplicateGuest.dispose()
  }
})

it("retains a shared turn index through bindTools and rejects replaced authority", async () => {
  const indexes: number[] = []
  const manager = {
    functionModelStream: vi.fn(
      (
        _authority: unknown,
        input: ModObject,
        core: FunctionStreamOptions["core"],
        signal: AbortSignal
      ) => {
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

it("allows long incremental streams while bounding only retained opaque frames", async () => {
  const manager = {
    functionModelStream: vi.fn(
      (
        _authority: unknown,
        input: ModObject,
        core: FunctionStreamOptions["core"],
        signal: AbortSignal
      ) => Promise.resolve(dispatchFunctionStream([], input, { signal, core }))
    )
  }
  const chunks = Array.from(
    { length: 513 },
    (_, index) => new AIMessageChunk({ content: String(index) })
  )
  const model = createModModelBoundary(
    new FakeStreamingChatModel({ chunks }),
    manager as never,
    testAuthority,
    { turnId: "turn", model: "fixture" }
  )
  await expect(model.invoke([new HumanMessage("bounded")])).resolves.toBeDefined()
})

it("bounds opaque frames retained by a buffering plugin", async () => {
  const manager = {
    functionModelStream: async (
      _authority: unknown,
      input: ModObject,
      core: FunctionStreamOptions["core"],
      signal: AbortSignal
    ) =>
      dispatchFunctionStream([], input, {
        signal,
        core: async function* (value, context) {
          const buffered: ModJson[] = []
          for await (const frame of core(value, context)) buffered.push(frame)
          yield* buffered
          return null
        }
      })
  }
  const model = createModModelBoundary(
    new FakeStreamingChatModel({
      chunks: Array.from({ length: 513 }, () => new AIMessageChunk({ content: "x" }))
    }),
    manager,
    testAuthority,
    { turnId: "turn", model: "fixture" }
  )
  await expect(model.invoke([new HumanMessage("buffered")])).rejects.toThrow(
    "MODS_MODEL_STREAM_LIMIT"
  )
})

const defaultModelConfig = {
  id: "default",
  model: "deepseek-default",
  baseUrl: "https://default.example.test/v1",
  apiKey: "fixture-key",
  maxTokens: 32000,
  maxOutputTokens: 512
}

function removeStepFixture(directory: string): void {
  if (
    dirname(resolve(directory)) !== resolve(tmpdir()) ||
    !basename(directory).startsWith("mods-step-model-")
  )
    throw Error("Unexpected fixture cleanup path")
  rmSync(directory, { recursive: true, force: true })
}

function stepManager(guest?: FunctionGuestRuntime) {
  return {
    functionModelStream: vi.fn(
      (
        _authority: unknown,
        input: ModObject,
        core: FunctionStreamOptions["core"],
        signal: AbortSignal
      ) =>
        Promise.resolve(
          dispatchFunctionStream(
            guest
              ? [
                  {
                    name: "select-model",
                    root: "/select-model",
                    tier: "user",
                    guest,
                    capabilities: []
                  }
                ]
              : [],
            input,
            { signal, core }
          )
        )
    )
  }
}

function providerReply(model: string, toolCall: boolean): Response {
  const delta = toolCall
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "inspect-call",
            type: "function",
            function: { name: "inspect", arguments: '{"path":"a.txt"}' }
          }
        ]
      }
    : { role: "assistant", content: "finished" }
  const chunks = [
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: toolCall ? "tool_calls" : "stop" }] },
    {
      choices: [],
      usage: {
        prompt_tokens: toolCall ? 21 : 35,
        completion_tokens: 5,
        total_tokens: toolCall ? 26 : 40
      }
    }
  ].map((part) => ({
    id: `response-${model}`,
    object: "chat.completion.chunk",
    created: 1,
    model,
    ...part
  }))
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
    {
      headers: { "content-type": "text/event-stream" }
    }
  )
}

it("sends changed tool descriptions to the provider while preserving execution and schemas", async () => {
  const seen: Array<{ tools: Array<{ function: unknown }> }> = []
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    seen.push(body)
    return providerReply(defaultModelConfig.model, seen.length === 1)
  }))
  const execute = vi.fn(async ({path}: {path:string}) => `read ${path}`)
  const inspect = tool(execute, {name:"inspect",description:"original",schema:z.object({path:z.string()})})
  const manager = {
    ...stepManager(),
    presentationEvent: vi.fn(async (_w, _t, _event, input) => ({description:`DIY ${input.description}`}))
  }
  const model = createModModelBoundary(getModelInstance(defaultModelConfig,undefined,1), manager,
    {workspace:"/project",threadId:"thread",turnId:"turn",assertLive: () => undefined} as never,
    {turnId:"turn",model:defaultModelConfig.model})
  const agent = createAgent({model,tools:[inspect]})
  await agent.invoke({messages:[new HumanMessage("inspect")]})
  expect(execute).toHaveBeenCalledOnce()
  expect(execute.mock.calls[0][0]).toEqual({path:"a.txt"})
  expect(seen).toHaveLength(2)
  for (const body of seen) {
    expect(body.tools[0].function).toMatchObject({name:"inspect",description:"DIY original",
      parameters:{type:"object",properties:{path:{type:"string"}},required:["path"]}})
  }
  expect(inspect.description).toBe("original")
})

it("sends composed sections to the real HTTP transport and previews that exact final system text", async () => {
  const seen: Array<{ messages: Array<{ role: string; content: string }> }> = []
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    seen.push(JSON.parse(String(init?.body)))
    return providerReply(defaultModelConfig.model, false)
  }))
  const preview = vi.fn()
  const manager: FunctionModelStreamHost = { ...stepManager(), promptComposition: async (_w, _t, event, input, signal, core): Promise<ModObject> => {
    if (event === "prompt.section") return { text: "SECTION_CHANGED" }
    expect(input.tools).toContain("nested")
    const out = await core(input, signal)
    return { sections: [{ id: "policy", text: "COMPOSE_POLICY", scope: "shared" }, ...(out.sections as ModObject[])] }
  } }
  const model = createModModelBoundary(getModelInstance(defaultModelConfig, undefined, 1), manager,
    { workspace: "/project", threadId: "thread", turnId: "turn", assertLive: () => {} } as never,
    { turnId: "turn", model: defaultModelConfig.model, onFinalPrompt: preview })
    .bindTools!([{ type: "function", function: { name: "nested", description: "Nested tool",
      parameters: { type: "object", properties: {} } } }])
  await model.invoke([new SystemMessage("OLD_BODY"), new HumanMessage("keep-user")])
  expect(seen).toHaveLength(1)
  expect(seen[0].messages[0].content).toBe("COMPOSE_POLICY\n\nSECTION_CHANGED")
  expect(JSON.stringify(seen[0].messages)).not.toContain("OLD_BODY")
  expect(seen[0].messages[1].content).toBe("keep-user")
  expect(preview).toHaveBeenCalledWith("COMPOSE_POLICY\n\nSECTION_CHANGED")
})

it("checks the final composed prompt budget before activating or sending the selected model", async () => {
  const provider = new FakeStreamingChatModel({ responses: [new AIMessageChunk("unused")] })
  const send = vi.spyOn(provider, "stream")
  const activate = vi.fn(() => () => {})
  const preview = vi.fn()
  const manager: FunctionModelStreamHost = { ...stepManager(), promptComposition: async () => ({ sections: [
    { id: "large", text: "large ".repeat(300), scope: "session" }
  ] }) }
  const model = createModModelBoundary(provider, manager,
    { workspace: "/project", threadId: "thread", turnId: "turn", assertLive: () => {} } as never,
    { turnId: "turn", model: "small", onFinalPrompt: preview }, {
      resolve: async () => ({ provider, model: "small", contextWindow: 2048, inputBudget: 10 }), activate
    })
  await expect(model.invoke([new SystemMessage("short"), new HumanMessage("hi")]))
    .rejects.toThrow("MODS_MODEL_INPUT_BUDGET")
  expect(send).not.toHaveBeenCalled()
  expect(activate).not.toHaveBeenCalled()
  expect(preview).not.toHaveBeenCalled()
})

it("selects a real provider for one createAgent tool step and restores the default with truthful session usage", async () => {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("turn.step",async function*($,e,next){
      for await(const frame of next(e.index===0 ? {...e,model:"selected",effort:"high"} : e)) yield frame
    })
  }}`)
  const directory = mkdtempSync(join(tmpdir(), "mods-step-model-"))
  const manager = new ModsManager(
    join(directory, "control.sqlite"),
    () => [],
    async () => true,
    () => {}
  )
  const workspace = manager.workspaceKey(directory)
  manager.configure(workspace, true, false)
  const controller = new AbortController()
  const { authority } = manager.createRuntimeAuthority({
    workspace,
    threadId: "thread",
    turnId: "turn",
    signal: controller.signal
  })
  const selected = {
    ...defaultModelConfig,
    id: "selected",
    model: "deepseek-selected",
    baseUrl: "https://selected.example.test/v1",
    maxTokens: 16000
  }
  const resolveStep = createFunctionStepModelResolver(defaultModelConfig, {
    lookup: (name) => (name === "selected" ? selected : null),
    maxRetryAttempts: 1
  })
  const seen: Array<{
    body: Record<string, unknown>
    url: string
    model: unknown
    usage: unknown
  }> = []
  const snapshots: ReturnType<ModsManager["captureFunctionSession"]>[] = []
  const query = (method: "session.model" | "session.usage") =>
    queryFunctionSessionRead(
      manager,
      () => {},
      () => {},
      workspace,
      "thread",
      method,
      controller.signal,
      undefined,
      method === "session.usage" ? { breakdown: "full" } : {}
    )
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      seen.push({
        body,
        url: String(url),
        model: await query("session.model"),
        usage: await query("session.usage")
      })
      snapshots.push(manager.captureFunctionSession(workspace, "thread"))
      return providerReply(String(body.model), body.model === selected.model)
    })
  )
  const bridge = stepManager(guest)
  const model = createModModelBoundary(
    getModelInstance(defaultModelConfig, undefined, 1),
    bridge,
    authority,
    { turnId: "turn", model: defaultModelConfig.model },
    {
      resolve: resolveStep,
      activate: (selection) => {
        manager.updateFunctionSessionModel(authority, selection.model, selection.contextWindow)
        return () =>
          manager.updateFunctionSessionModel(
            authority,
            defaultModelConfig.model,
            defaultModelConfig.maxTokens
          )
      }
    }
  )
  const inspect = vi.fn(async ({ path }: { path: string }) => `read ${path}`)
  try {
    const agent = createAgent({
      model,
      tools: [
        tool(inspect, {
          name: "inspect",
          description: "Inspect a file",
          schema: z.object({ path: z.string() })
        })
      ],
      middleware: [
        createFunctionSessionViewMiddleware(
          manager,
          authority,
          defaultModelConfig.model,
          undefined,
          defaultModelConfig.maxTokens
        )
      ],
      checkpointer: new MemorySaver()
    })
    const result = await agent.invoke(
      { messages: [new HumanMessage("inspect")] },
      {
        configurable: { thread_id: "model-selection" },
        signal: controller.signal
      }
    )
    expect(inspect).toHaveBeenCalledOnce()
    expect(inspect.mock.calls[0][0]).toEqual({ path: "a.txt" })
    expect(seen.map((entry) => entry.body.model)).toEqual([
      selected.model,
      defaultModelConfig.model
    ])
    expect(seen.map((entry) => entry.url)).toEqual([
      "https://selected.example.test/v1/chat/completions",
      "https://default.example.test/v1/chat/completions"
    ])
    expect(seen[0].body.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ function: expect.objectContaining({ name: "inspect" }) })
      ])
    )
    expect(seen[0].body.reasoning_effort).toBe("high")
    expect(seen[0].body.max_tokens).toBe(512)
    expect(seen[1].body).not.toHaveProperty("reasoning_effort")
    expect(seen[0].model).toBe(selected.model)
    expect(seen[0].usage).toMatchObject({
      context: { window: 16000, breakdown: { model: selected.model } }
    })
    expect(seen[1].model).toBe(defaultModelConfig.model)
    expect(seen[1].usage).toMatchObject({
      context: {
        window: 32000,
        breakdown: { model: defaultModelConfig.model, apiUsage: { input_tokens: 21 } }
      }
    })
    expect(await query("session.model")).toBe(defaultModelConfig.model)
    expect(await query("session.usage")).toMatchObject({ context: { window: 32000, tokens: 35 } })
    const responses = result.messages.filter((message) => message.getType() === "ai")
    expect(
      responses.map((message) => (message.response_metadata as { model_name?: string }).model_name)
    ).toEqual([selected.model, defaultModelConfig.model])
    expect(bridge.functionModelStream.mock.calls.map((call) => call[1].model)).toEqual([
      defaultModelConfig.model,
      defaultModelConfig.model
    ])
    expect(defaultModelConfig).not.toHaveProperty("enableThinking")
    expect(() => snapshots[0].assertLive()).toThrow("MODS_CALL_SCOPE_CHANGED")
  } finally {
    for (const snapshot of snapshots) snapshot.release()
    guest.dispose()
    manager.close()
    removeStepFixture(directory)
  }
})

it.each(["low", "high", "max"])(
  "maps explicit %s effort through the existing provider transport",
  async (effort) => {
    const resolve = createFunctionStepModelResolver(defaultModelConfig)
    const selected = await resolve(
      { model: defaultModelConfig.model, effort },
      new AbortController().signal
    )
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        reasoning_effort: effort,
        thinking: { type: "enabled" },
        chat_template_kwargs: { enable_thinking: true, reasoning_effort: effort }
      })
      return providerReply(defaultModelConfig.model, false)
    })
    vi.stubGlobal("fetch", fetch)
    for await (const chunk of await selected.provider.stream([new HumanMessage("effort")]))
      expect(chunk).toBeInstanceOf(AIMessageChunk)
    expect(fetch).toHaveBeenCalledOnce()
  }
)

it.each(["medium", "xhigh", 42, null, false])(
  "rejects an unmapped effort %s without any provider call",
  async (effort) => {
    const resolve = createFunctionStepModelResolver(defaultModelConfig)
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    await expect(
      resolve({ model: defaultModelConfig.model, effort } as never, new AbortController().signal)
    ).rejects.toThrow("MODS_MODEL_EFFORT_UNSUPPORTED")
    expect(fetch).not.toHaveBeenCalled()
  }
)

it.each(["gpt-fixture", "minimax-fixture", "unknown-provider"])(
  "keeps %s native transport but refuses unsupported explicit effort before a request",
  async (modelName) => {
    const config = { ...defaultModelConfig, model: modelName }
    const resolve = createFunctionStepModelResolver(config)
    const fetch = vi.fn(async () => providerReply(modelName, false))
    vi.stubGlobal("fetch", fetch)
    const baseline = await resolve({ model: modelName }, new AbortController().signal)
    for await (const chunk of await baseline.provider.stream([new HumanMessage("native")]))
      expect(chunk).toBeInstanceOf(AIMessageChunk)
    expect(fetch).toHaveBeenCalledOnce()
    fetch.mockClear()
    await expect(
      resolve({ model: modelName, effort: "high" }, new AbortController().signal)
    ).rejects.toThrow("MODS_MODEL_EFFORT_UNSUPPORTED")
    expect(fetch).not.toHaveBeenCalled()
  }
)

it("rejects an unknown model without silently using the default", async () => {
  const resolve = createFunctionStepModelResolver(defaultModelConfig, { lookup: () => null })
  await expect(resolve({ model: "unconfigured" }, new AbortController().signal)).rejects.toThrow(
    "MODS_MODEL_NOT_CONFIGURED"
  )
})

it.each(["cancel", "replace"])(
  "never calls a provider when %s occurs during model resolution",
  async (kind) => {
    const controller = new AbortController()
    let live = true
    const authority = {
      turnId: "turn",
      assertLive: () => {
        if (!live) throw Error("replaced")
      }
    } as never
    const provider = new FakeStreamingChatModel({
      chunks: [new AIMessageChunk({ content: "forbidden" })]
    })
    const send = vi.spyOn(provider, "stream")
    const activate = vi.fn()
    const model = createModModelBoundary(
      provider,
      stepManager(),
      authority,
      { turnId: "turn", model: "default" },
      {
        resolve: async () => {
          if (kind === "cancel") controller.abort(Error("cancelled"))
          else live = false
          return { provider, model: "default", contextWindow: 32000, inputBudget: 30000 }
        },
        activate
      }
    )
    await expect(
      model.invoke([new HumanMessage("blocked")], { signal: controller.signal })
    ).rejects.toThrow()
    expect(send).not.toHaveBeenCalled()
    expect(activate).not.toHaveBeenCalled()
  }
)

it("checks the selected model's input budget including bound tool schemas before sending", async () => {
  const provider = new FakeStreamingChatModel({
    chunks: [new AIMessageChunk({ content: "forbidden" })]
  })
  const send = vi.spyOn(provider, "stream")
  const activate = vi.fn()
  const model = createModModelBoundary(
    provider,
    stepManager(),
    testAuthority,
    { turnId: "turn", model: "small" },
    {
      resolve: async () => ({ provider, model: "small", contextWindow: 2048, inputBudget: 10 }),
      activate
    }
  )
  const inspect = tool(async () => "unused", {
    name: "inspect",
    description: "Long host tool description ".repeat(30),
    schema: z.object({ path: z.string() })
  })
  await expect(model.bindTools!([inspect]).invoke([new HumanMessage("small")])).rejects.toThrow(
    "MODS_MODEL_INPUT_BUDGET"
  )
  expect(send).not.toHaveBeenCalled()
  expect(activate).not.toHaveBeenCalled()
})

it.each(["failure", "consumer-close"])(
  "restores the default session selection after %s",
  async (mode) => {
    const provider = new FakeStreamingChatModel({
      chunks: [new AIMessageChunk({ content: "first" }), new AIMessageChunk({ content: "second" })]
    })
    if (mode === "failure") vi.spyOn(provider, "stream").mockRejectedValue(Error("provider failed"))
    let effective = "default"
    const release = vi.fn(() => {
      effective = "default"
    })
    const model = createModModelBoundary(
      provider,
      stepManager(),
      testAuthority,
      { turnId: "turn", model: "default" },
      {
        resolve: async () => ({
          provider,
          model: "selected",
          contextWindow: 32000,
          inputBudget: 30000
        }),
        activate: (selection) => {
          effective = selection.model
          return release
        }
      }
    )
    if (mode === "failure")
      await expect(model.invoke([new HumanMessage("fail")])).rejects.toThrow("provider failed")
    else {
      const stream = await model.stream([new HumanMessage("close")])
      expect((await stream.next()).done).toBe(false)
      expect(effective).toBe("selected")
      await stream.return()
    }
    expect(effective).toBe("default")
    expect(release).toHaveBeenCalledOnce()
  }
)
