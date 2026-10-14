import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { AIMessage, AIMessageChunk, HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs"
import { tool } from "@langchain/core/tools"
import { createAgent, createMiddleware } from "langchain"
import { z } from "zod"
import { afterEach, expect, it, vi } from "vitest"
import { ModsManager } from "../mods/manager"
import { ModError } from "../mods/errors"
import type { ModRuntimeAuthority } from "../mods/runtime-instance"
import { currentFunctionExecution } from "../mods/v2/execution-context"
import { withFunctionAgentExecution } from "../mods/v2/host-call"
import { dispatchFunctionStream } from "../mods/v2/stream-dispatcher"
import type { ModObject } from "../../shared/mods/types"
import { createFunctionTaskModelMiddleware, type FunctionTaskModel } from "./mods-task-model"

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => {} }
}))

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})

type ProviderCall = {
  messages: BaseMessage[]
  tools: unknown[]
  authority?: ModRuntimeAuthority
  mode: "stream" | "generate"
}

/** A real LangChain provider whose endpoint and received payload remain observable. */
class Provider extends BaseChatModel {
  readonly calls: ProviderCall[]

  constructor(
    readonly endpoint: string,
    calls: ProviderCall[] = [],
    private readonly tools: unknown[] = []
  ) {
    super({})
    this.calls = calls
  }

  _llmType() {
    return "task-fixture-provider"
  }

  bindTools(tools: unknown[]): this {
    return new Provider(this.endpoint, this.calls, [...tools]) as this
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.record(messages, "generate")
    return { generations: [{ text: this.endpoint, message: new AIMessage(this.endpoint) }] }
  }

  async *_streamResponseChunks(messages: BaseMessage[]) {
    this.record(messages, "stream")
    await Promise.resolve()
    yield new ChatGenerationChunk({
      text: this.endpoint,
      message: new AIMessageChunk(this.endpoint)
    })
  }

  private record(messages: BaseMessage[], mode: ProviderCall["mode"]) {
    this.calls.push({
      messages: [...messages],
      tools: [...this.tools],
      authority: currentFunctionExecution()?.runtimeAuthority,
      mode
    })
  }
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mods-task-model-"))
  const manager = new ModsManager(
    join(directory, "control.sqlite"), () => [], async () => true, () => {}
  )
  manager.configure(directory, true, false)
  const controller = new AbortController()
  const workspace = manager.workspaceKey(directory)
  const root = manager.createRuntimeAuthority({
    workspace, threadId: "thread", turnId: "root-turn", signal: controller.signal
  })
  manager.bindThread({
    ...root.authority, runtimeAuthority: root.authority, signal: controller.signal
  })
  const steps: Array<{ owner: ModRuntimeAuthority; input: ModObject; hooks: boolean }> = []
  const promptFacts: ModObject[] = []
  manager.attachFunctions({
    invalidate: vi.fn(), closeThread: vi.fn(), close: vi.fn(),
    turnStep: async (_workspace, _thread, input, core, signal, dispatchHooks = true) => {
      steps.push({ owner: currentFunctionExecution()!.runtimeAuthority!, input, hooks: dispatchHooks })
      return dispatchFunctionStream([], input, { signal, core })
    },
    presentationEvent: async (_workspace, _thread, _event, input) =>
      ({ description: `described:${input.description}` }),
    classicEvent: async (_workspace, _thread, event, input, signal, core) => {
      if (!core) throw Error("Missing prompt core")
      const result = await core(input, signal)
      if (event !== "prompt.compose") return result
      promptFacts.push(input)
      return {
        sections: (result.sections as ModObject[]).map(section => ({
          ...section, text: `${section.text}\nTASK_PROMPT_TRANSFORM`
        }))
      }
    }
  })
  const models = new WeakMap<object, FunctionTaskModel>()
  const instructionRequests = vi.fn()
  const middleware = createFunctionTaskModelMiddleware({
    manager, root: root.authority, role: "general-purpose", models, onFinalPrompt: instructionRequests
  })
  const register = (provider: BaseChatModel, model: string, inputBudget = 2048, effort?: string) => {
    const resolveModel = vi.fn(async (
      selection: Parameters<FunctionTaskModel["resolve"]>[0], signal: AbortSignal
    ) => {
      signal.throwIfAborted()
      return { provider, model: selection.model, contextWindow: 4096, inputBudget }
    })
    models.set(provider, { model, ...(effort ? { effort } : {}), resolve: resolveModel })
    return resolveModel
  }
  const run = <T>(
    operation: () => Promise<T>,
    parent = root.authority,
    role = "general-purpose",
    known = true
  ) => manager.withSharedAgent(
    parent, `mod-task:${randomUUID()}`, controller.signal,
    known ? { blockedToolNames: new Set(), readOnly: false, tools: [] } : undefined,
    operation, "root-run", { type: role, description: "Probe task transport" }
  )
  cleanup.push(() => {
    controller.abort()
    manager.close()
    if (dirname(resolve(directory)) !== resolve(tmpdir()) ||
      !basename(directory).startsWith("mods-task-model-")) throw Error("Unexpected cleanup path")
    rmSync(directory, { recursive: true, force: true })
  })
  return { manager, root: root.authority, middleware, models, register, run, steps, promptFacts, instructionRequests }
}

const messages = () => ({ messages: [new HumanMessage("Inspect the task")] })

it("wraps the current role-selected provider with its own endpoint, facts, tools and resolver", async () => {
  const f = fixture()
  const main = new Provider("main-endpoint")
  const override = new Provider("registry-endpoint")
  const mainResolve = f.register(main, "same-public-model")
  const overrideResolve = f.register(override, "same-public-model", 2048, "high")
  const inspect = tool(async () => "unused", {
    name: "inspect", description: "Inspect", schema: z.object({})
  })
  const agent = createAgent({
    model: main, systemPrompt: "ROLE_PROMPT", tools: [inspect],
    middleware: [createMiddleware({
      name: "roleModelOverride",
      wrapModelCall: (request, handler) => handler({ ...request, model: override })
    }), f.middleware]
  })
  await f.run(async () => {
    const owner = currentFunctionExecution()!.runtimeAuthority!
    const result = await agent.invoke(messages())
    expect(result.messages.at(-1)?.content).toBe("registry-endpoint")
    expect(override.calls[0].authority).toBe(owner)
    expect(f.steps[0]).toMatchObject({
      owner, hooks: true,
      input: { agentId: owner.agentId, turnId: owner.turnId, model: "same-public-model", effort: "high" }
    })
  })
  expect(main.calls).toEqual([])
  expect(mainResolve).not.toHaveBeenCalled()
  expect(overrideResolve).toHaveBeenCalledExactlyOnceWith(
    { model: "same-public-model", effort: "high" }, expect.any(AbortSignal)
  )
  expect(override.calls[0].mode).toBe("stream")
  expect(override.calls[0].tools).toEqual([
    expect.objectContaining({ name: "inspect", description: "described:Inspect" })
  ])
  expect(override.calls[0].messages[0].content).toContain("TASK_PROMPT_TRANSFORM")
  expect(f.promptFacts[0]).toMatchObject({ model: "same-public-model", tools: ["inspect"] })
  expect(f.instructionRequests).toHaveBeenCalledWith(
    expect.stringContaining("TASK_PROMPT_TRANSFORM"), f.steps[0].owner.agentId, f.steps[0].owner.turnId
  )
  f.root.assertLive()
})

it("keeps one shared provider's parallel owners and per-owner step counters independent", async () => {
  const f = fixture()
  const provider = new Provider("shared-endpoint")
  f.register(provider, "shared-model")
  const agent = createAgent({ model: provider, middleware: [f.middleware] })
  const owners: ModRuntimeAuthority[] = []
  await Promise.all([1, 2].map(() => f.run(async () => {
    owners.push(currentFunctionExecution()!.runtimeAuthority!)
    await agent.invoke(messages())
    await agent.invoke(messages())
  })))
  expect(new Set(owners).size).toBe(2)
  expect(provider.calls).toHaveLength(4)
  for (const owner of owners) {
    expect(f.steps.filter(step => step.owner === owner).map(step => step.input.index)).toEqual([0, 1])
    expect(provider.calls.filter(call => call.authority === owner)).toHaveLength(2)
    expect(() => owner.assertLive()).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
  }
  expect(f.steps.every(step => step.hooks === true)).toBe(true)
  f.root.assertLive()
})

it("accepts a real nested task receipt without replacing its parent's owner", async () => {
  const f = fixture()
  const provider = new Provider("nested-endpoint")
  f.register(provider, "nested-model")
  const agent = createAgent({ model: provider, middleware: [f.middleware] })
  await f.run(async () => {
    const parent = currentFunctionExecution()!.runtimeAuthority!
    await f.run(async () => {
      const child = currentFunctionExecution()!.runtimeAuthority!
      expect(child).not.toBe(parent)
      await agent.invoke(messages())
      expect(provider.calls[0].authority).toBe(child)
      expect(f.instructionRequests).toHaveBeenCalledWith(
        expect.any(String), child.agentId, child.turnId
      )
    }, parent)
    expect(currentFunctionExecution()?.runtimeAuthority).toBe(parent)
    parent.assertLive()
  })
  expect(f.steps[0].input.index).toBe(0)
})

it("rejects an unregistered current provider before its native model can execute", async () => {
  const f = fixture()
  const known = new Provider("known-endpoint")
  const unknown = new Provider("unknown-endpoint")
  f.register(known, "same-public-model")
  const agent = createAgent({ model: unknown, middleware: [f.middleware] })
  await expect(f.run(() => agent.invoke(messages()))).rejects.toThrow("MODS_TASK_MODEL_UNAVAILABLE")
  expect(unknown.calls).toEqual([])
  expect(known.calls).toEqual([])
  expect(f.steps).toEqual([])
})

it.each(["outside", "main", "wrong-role", "opaque"] as const)(
  "rejects the actual %s receipt instead of borrowing main or calling the raw provider",
  async (source) => {
    const f = fixture()
    const provider = new Provider("receipt-endpoint")
    f.register(provider, "receipt-model")
    const agent = createAgent({ model: provider, middleware: [f.middleware] })
    const invoke = () => agent.invoke(messages())
    const request = source === "outside" ? invoke() : source === "main"
      ? withFunctionAgentExecution({
          ...f.root, runtimeAuthority: f.root, userInitiated: false, leased: true, immediate: false
        }, invoke)
      : f.run(invoke, f.root, source === "wrong-role" ? "Explore" : "general-purpose",
          source !== "opaque")
    await expect(request).rejects.toThrow("MODS_TASK_OWNER_REQUIRED")
    expect(provider.calls).toEqual([])
    expect(f.steps).toEqual([])
  }
)

it.each(["resolver", "budget"] as const)(
  "rejects the role's %s failure without issuing a provider request",
  async (failure) => {
    const f = fixture()
    const provider = new Provider("restricted-endpoint")
    const resolveModel = f.register(provider, "restricted-model", failure === "budget" ? 1 : 2048)
    if (failure === "resolver") resolveModel.mockRejectedValue(new ModError("CLAW_MODEL_NOT_ALLOWED"))
    const agent = createAgent({ model: provider, middleware: [f.middleware] })
    await expect(f.run(() => agent.invoke(messages()))).rejects.toThrow(
      failure === "resolver" ? "CLAW_MODEL_NOT_ALLOWED" : "MODS_MODEL_INPUT_BUDGET"
    )
    expect(resolveModel).toHaveBeenCalledOnce()
    expect(provider.calls).toEqual([])
  }
)

it.each(["native-resume", "next-request"] as const)(
  "does not renew a task receipt after disable/re-enable at its %s boundary",
  async boundary => {
    const f = fixture()
    let enter!: () => void
    let resume!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const released = new Promise<void>(resolve => { resume = resolve })
    let providerCalls = 0
    class HoldingProvider extends BaseChatModel {
      _llmType() { return "task-held-native-provider" }
      bindTools(): this { return this }
      async _generate(): Promise<ChatResult> { throw Error("Raw model fallback") }
      async *_streamResponseChunks() {
        providerCalls++
        const message = providerCalls === 1 ? new AIMessageChunk({
          content: "",
          tool_call_chunks: [{ name: "hold", id: "held-tool", args: "{}", index: 0,
            type: "tool_call_chunk" }]
        }) : new AIMessageChunk("MUST_NOT_RENEW_OLD_TASK")
        yield new ChatGenerationChunk({ text: "", message })
      }
    }
    const provider = new HoldingProvider({})
    f.register(provider, "held-task-model")
    const hold = tool(async () => {
      const ownScope = f.manager.functionRuntimeScope(f.root.workspace, f.root.threadId)
      enter()
      await released
      if (boundary === "native-resume") ownScope.assertLive()
      return "native read completed"
    }, { name: "hold", description: "Hold an actual native tool", schema: z.object({}) })
    const agent = createAgent({ model: provider, tools: [hold], middleware: [f.middleware] })
    const running = f.run(() => agent.invoke(messages()))
    const rejected = expect(running).rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
    await entered
    f.manager.configure(f.root.workspace, false, false)
    f.manager.configure(f.root.workspace, true, false)
    resume()
    await rejected
    expect(providerCalls).toBe(1)
    expect(f.steps).toHaveLength(1)
    expect(f.steps[0].hooks).toBe(true)
    f.root.assertLive()
  }
)


it("does not let a read-only instruction observer interrupt the original Task model", async () => {
  const f = fixture()
  const provider = new Provider("original-result")
  f.register(provider,"model")
  f.instructionRequests.mockImplementation(() => { throw Error("observation unavailable") })
  const agent = createAgent({model:provider,middleware:[f.middleware]})
  await f.run(async () => {
    const result = await agent.invoke(messages())
    expect(result.messages.at(-1)?.content).toBe("original-result")
  })
  expect(f.instructionRequests).toHaveBeenCalled()
})
