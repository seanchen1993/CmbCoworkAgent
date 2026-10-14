import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { BaseCallbackHandler } from "@langchain/core/callbacks/base"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, AIMessageChunk, HumanMessage } from "@langchain/core/messages"
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs"
import { createAgent } from "langchain"
import { afterEach, expect, it, vi } from "vitest"
import { ModsManager } from "../mods/manager"
import { getModCallContext, modCallContext } from "../mods/context"
import type { ModRuntimeAuthority } from "../mods/runtime-instance"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { currentFunctionExecution, functionExecutionScope } from "../mods/v2/execution-context"
import { functionCallAuthority } from "../mods/v2/host-call"
import { createFunctionTaskModelMiddleware, type FunctionTaskModel } from "./mods-task-model"

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => {} }
}))

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

class Provider extends BaseChatModel {
  readonly requests = vi.fn()

  _llmType() {
    return "task-callback-fence-provider"
  }

  bindTools(): this {
    return this
  }

  async _generate(): Promise<ChatResult> {
    this.requests("generate")
    return { generations: [{ text: "answer", message: new AIMessage("answer") }] }
  }

  async *_streamResponseChunks() {
    this.requests("stream")
    yield new ChatGenerationChunk({ text: "answer", message: new AIMessageChunk("answer") })
  }
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mods-task-callback-fence-"))
  const manager = new ModsManager(
    join(directory, "control.sqlite"),
    () => [],
    async () => true,
    () => {}
  )
  manager.configure(directory, true, false)
  const controller = new AbortController()
  const workspace = manager.workspaceKey(directory)
  const root = manager.createRuntimeAuthority({
    workspace,
    threadId: "thread",
    turnId: "root-turn",
    signal: controller.signal
  })
  manager.bindThread({
    ...root.authority,
    runtimeAuthority: root.authority,
    signal: controller.signal
  })
  const run = <T>(operation: () => Promise<T>) =>
    manager.withSharedAgent(
      root.authority,
      `mod-task:${randomUUID()}`,
      controller.signal,
      { blockedToolNames: new Set(), readOnly: false, tools: [] },
      operation,
      "root-run",
      { type: "general-purpose", description: "Callback fence regression" }
    )
  const changeEpoch = () => {
    manager.configure(workspace, false, false)
    manager.configure(workspace, true, false)
  }
  cleanups.push(() => {
    controller.abort()
    manager.close()
    if (
      dirname(resolve(directory)) !== resolve(tmpdir()) ||
      !basename(directory).startsWith("mods-task-callback-fence-")
    )
      throw Error("Unexpected callback fixture cleanup path")
    rmSync(directory, { recursive: true, force: true })
  })
  return { manager, root: root.authority, controller, workspace, run, changeEpoch }
}

it("rejects an old task after a real awaited LangChain model-start callback before any provider call", async () => {
  const f = fixture()
  const provider = new Provider({})
  const resolveModel = vi.fn<FunctionTaskModel["resolve"]>(async (selection, signal) => {
    signal.throwIfAborted()
    return { provider, model: selection.model, contextWindow: 4096, inputBudget: 2048 }
  })
  const models = new WeakMap<object, FunctionTaskModel>()
  models.set(provider, { model: "same-public-model", resolve: resolveModel })
  const middleware = createFunctionTaskModelMiddleware({
    manager: f.manager,
    root: f.root,
    role: "general-purpose",
    models
  })
  const ownerLookup = vi.spyOn(f.manager, "functionSharedModelAuthority")
  const transport = vi.spyOn(f.manager, "functionModelStream")
  const started = gate()
  const resume = gate()
  let owner: ModRuntimeAuthority | undefined
  let callbackOwner: ModRuntimeAuthority | undefined
  class HeldStart extends BaseCallbackHandler {
    name = "held-task-model-start"
    constructor() {
      super({ _awaitHandler: true, raiseError: true })
    }
    async handleChatModelStart() {
      callbackOwner = currentFunctionExecution()?.runtimeAuthority
      started.resolve()
      await resume.promise
    }
  }
  cleanups.push(resume.resolve)
  const agent = createAgent({
    model: provider,
    systemPrompt: "ROLE_PROMPT",
    middleware: [middleware]
  })
  const running = f.run(async () => {
    owner = currentFunctionExecution()!.runtimeAuthority!
    return agent.invoke(
      { messages: [new HumanMessage("Inspect the task")] },
      {
        callbacks: [new HeldStart()]
      }
    )
  })
  // Observe settlement immediately, including an assertion failure before the barrier resumes.
  const outcome = running.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error })
  )
  await Promise.race([
    started.promise,
    outcome.then(() => {
      throw Error("Model invocation finished before its start barrier")
    })
  ])
  expect(ownerLookup).toHaveBeenCalledExactlyOnceWith(f.root, "general-purpose")
  expect(callbackOwner).toBe(owner)
  expect(transport).not.toHaveBeenCalled()
  expect(resolveModel).not.toHaveBeenCalled()
  expect(provider.requests).not.toHaveBeenCalled()
  f.changeEpoch()
  // The object itself is live: its task creation epoch is the revoked fact.
  expect(() => owner!.assertLive()).not.toThrow()
  resume.resolve()
  await expect(running).rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
  expect(transport).toHaveBeenCalledOnce()
  expect(resolveModel).not.toHaveBeenCalled()
  expect(provider.requests).not.toHaveBeenCalled()
  f.root.assertLive()
})

it("runs epoch-expired transport finally under a closed owner without borrowing ancestor receipts", async () => {
  const f = fixture()
  let finalized = false
  let scopeFailure: unknown
  let authorityFailure: unknown
  let borrowedContext: ReturnType<typeof getModCallContext>
  await f.run(async () => {
    const owner = currentFunctionExecution()!.runtimeAuthority!
    const stream = await f.manager.functionModelStream(
      owner,
      {
        turnId: owner.turnId,
        agentId: owner.agentId,
        index: 0,
        model: "fixture-model"
      },
      async function* () {
        try {
          yield { kind: "text", text: "visible", ref: "fixture-frame", index: 0 }
          return { kind: "complete" }
        } finally {
          finalized = true
          borrowedContext = getModCallContext()
          try {
            functionExecutionScope(owner.workspace, owner.threadId)
          } catch (error) {
            scopeFailure = error
          }
          try {
            functionCallAuthority(owner.workspace, owner.threadId)
          } catch (error) {
            authorityFailure = error
          }
        }
      },
      f.controller.signal
    )
    expect((await stream.next()).value).toMatchObject({ text: "visible" })
    f.changeEpoch()
    expect(() => owner.assertLive()).not.toThrow()
    // Cleanup is entered from a caller carrying the real parent's receipt, which must be cleared.
    await modCallContext.run(
      {
        runtimeAuthority: f.root,
        identity: {
          workspace: f.root.workspace,
          threadId: f.root.threadId,
          turnId: f.root.turnId,
          agentId: f.root.agentId,
          callId: randomUUID(),
          origin: "user-action",
          grantEpoch: 0
        },
        toolId: "host:caller",
        routeClaimed: false,
        protectedOutput: false,
        readOnly: false
      },
      () => stream.return(null)
    )
    expect(finalized).toBe(true)
    expect(borrowedContext).toBeUndefined()
    expect(scopeFailure).toBeInstanceOf(ModFunctionError)
    expect(scopeFailure).toMatchObject({ code: "MODS_CALL_SCOPE_EXPIRED" })
    expect(authorityFailure).toMatchObject({ code: "MODS_CALL_SCOPE_EXPIRED" })
  })
  f.root.assertLive()
})
