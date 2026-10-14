import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { ModJson, ModObject } from "../../shared/mods/types"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../agent/thread-run-lease"
import { ModsManager } from "./manager"
import type { ModRuntimeAuthority, ModRuntimeAuthorities } from "./runtime-instance"
import { FUNCTION_STREAM_TERMINAL } from "./v2/host-stream-lifetime"
import { functionCallAuthority, withFunctionAgentExecution } from "./v2/host-call"
import {
  currentFunctionExecution,
  functionExecutionScope,
  withFunctionWriteLease
} from "./v2/execution-context"
import { dispatchFunctionStream, type FunctionStreamOptions } from "./v2/stream-dispatcher"
import { FunctionGuestRuntime } from "./v2/guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./v2/session"
import { functionModelResult } from "./v2/model-sdk"
import { AIMessage, AIMessageChunk, HumanMessage } from "@langchain/core/messages"
import { FakeStreamingChatModel } from "@langchain/core/utils/testing"
import { createModModelBoundary } from "../agent/mods-model-boundary"
import type { FunctionTurnComplete } from "../../shared/mods/v2/turn"
import { bindHostPromptOccurrence } from "./v2/prompt-cache"

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => {} }
}))

const cleanup: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run()
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mods-child-model-stream-"))
  const manager = new ModsManager(
    join(root, "control.sqlite"),
    () => [],
    async () => true,
    () => {}
  )
  manager.configure(root, true, false)
  const workspace = manager.workspaceKey(root)
  const main = manager.createRuntimeAuthority({
    workspace,
    threadId: "thread",
    turnId: "main-turn"
  })
  const child = manager.createRuntimeAuthority({
    workspace,
    threadId: "thread",
    agentId: "flow:review:agent:0",
    turnId: "child-turn"
  })
  const lifecycle = vi.fn(
    async (
      _workspace: string,
      _threadId: string,
      input: ModObject,
      core: FunctionStreamOptions["core"],
      signal: AbortSignal,
      dispatchHooks = true
    ) => {
      expect(typeof dispatchHooks).toBe("boolean")
      return dispatchFunctionStream([], input, { signal, core })
    }
  )
  manager.attachFunctions({
    invalidate: vi.fn(),
    closeThread: vi.fn(),
    close: vi.fn(),
    turnStep: lifecycle
  })
  cleanup.push(() => {
    manager.close()
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("mods-child-model-stream-")
    )
      throw Error("Unexpected cleanup path")
    rmSync(root, { recursive: true, force: true })
  })
  return { manager, workspace, main, child, lifecycle }
}

it.each(["main", "child"])("keeps %s authority resources until actual provider yielding cleanup finishes", async (owner) => {
  const f = fixture()
  const authority = f[owner].authority
  const release = Promise.withResolvers<void>(), cleaning = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>()
  const registry = (f.manager as unknown as { runtimeAuthorities: ModRuntimeAuthorities }).runtimeAuthorities
  const register = registry.registerResource.bind(registry)
  let detached = 0, calls = 0, cleanupOwner: ModRuntimeAuthority | undefined
  vi.spyOn(registry, "registerResource").mockImplementation((authority, dispose) => {
    const detach = register(authority, dispose)
    return () => { detached++; detach() }
  })
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("turn.step",async function*($,e,next){return yield* next(e)})
  }}`)
  cleanup.push(() => guest.dispose())
  f.manager.attachFunctions({ invalidate: vi.fn(), closeThread: vi.fn(), close: vi.fn(),
    turnStep: async (_workspace, _thread, input, core, signal, _dispatch, _skip, transport) =>
      dispatchFunctionStream([{ name: "actual-cleanup", root: f.workspace, tier: "user", guest, capabilities: [] }],
        input, { core, signal, transport, timeoutMs: 40 }) })
  try {
    const stream = await f.manager.functionModelStream(authority, {}, async function* () {
      calls++
      try { await release.promise; yield { text: "late" }; return {} }
      finally {
        cleanupOwner = functionCallAuthority(f.workspace, "thread")
        cleaning.resolve(); yield { text: "cleanup-must-not-publish" }; await finish.promise
      }
    }, new AbortController().signal)
    await expect(stream.next()).rejects.toThrow("组件处理超过总等待期限")
    expect(detached).toBe(0)
    release.resolve()
    await cleaning.promise
    expect(detached).toBe(0)
    expect(cleanupOwner).toBe(authority)
    finish.resolve()
    await (stream as unknown as Record<symbol, Promise<void>>)[FUNCTION_STREAM_TERMINAL]
    await Promise.resolve()
    expect(detached).toBe(1)
    expect(calls).toBe(1)
  } finally { release.resolve(); finish.resolve() }
})

it.each(["hit", "fill"])("a real context %s cannot publish or fill after same-authority binding replacement", async mode => {
  const f = fixture()
  const authority = f.main.authority
  const binding = { workspace: f.workspace, threadId: "thread", turnId: authority.turnId,
    runtimeAuthority: authority }
  cleanup.push(f.manager.bindThread(binding))
  let barrier = false, cores = 0, providerCalls = 0
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("prompt.context",async($,e,next)=>{const out=await next(e);return {...out,blocks:[...out.blocks,{name:"count",text:"1"}]}})
  }}`)
  const session = new FunctionSession([{ name: "context", root: f.workspace, tier: "user", guest,
    capabilities: [...SESSION_CAPABILITIES] }], { workspace: f.workspace, threadId: "thread",
    assertLive() { authority.assertLive() }, publish: async value => {
      if (barrier && value && typeof value === "object" && !Array.isArray(value) &&
        Array.isArray(value.blocks) && value.blocks.some(block => block && typeof block === "object" &&
          !Array.isArray(block) && block.name === "count")) { entered.resolve(); await release.promise }
      return structuredClone(value)
    } })
  cleanup.push(() => session.close())
  f.manager.attachFunctions({ invalidate: vi.fn(), closeThread: vi.fn(), close: vi.fn(),
    classicEvent: (_w, _t, event, input, signal, core) => session.promptComposition(
      event as "prompt.context", input, signal, core ?? (async value => value)) })
  let source = {}
  const request = () => withFunctionAgentExecution({ ...binding, agentId: "main",
    userInitiated: false, leased: true, immediate: false }, () => f.manager.promptComposition(
    f.workspace, "thread", "prompt.context", { blocks: [{ name: "claudeMd", text: "NATIVE" }] },
    new AbortController().signal, bindHostPromptOccurrence(async input => { cores++; return input },
      "prompt.context", source)))
  await request()
  expect(cores).toBe(1)
  if (mode === "fill") source = {}
  barrier = true
  const pending = request().then(() => { providerCalls++ })
  const rejected = expect(pending).rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
  await entered.promise
  cleanup.push(f.manager.bindThread({ ...binding }))
  expect(() => authority.assertLive()).not.toThrow()
  release.resolve()
  await rejected
  expect(cores).toBe(mode === "hit" ? 1 : 2)
  expect(providerCalls).toBe(0)
  if (mode === "fill") {
    barrier = false
    await request()
    expect(cores).toBe(3)
  }
})

it.each(["cancel after delivery", "cancel inside callback"] as const)(
  "preserves only delivered private-child output on %s",
  async (ending) => {
    const f = fixture()
    const parent = f.main.authority
    const controller = new AbortController()
    const completions: FunctionTurnComplete[] = []
    f.manager.attachFunctions({
      invalidate: vi.fn(),
      closeThread: vi.fn(),
      close: vi.fn(),
      turnStep: f.lifecycle,
      turnComplete: async (_workspace, _thread, input) => {
        completions.push(input)
        return { text: input.answer }
      }
    })
    cleanup.push(
      f.manager.bindThread({
        workspace: f.workspace,
        threadId: "thread",
        turnId: parent.turnId,
        runtimeAuthority: parent,
        signal: controller.signal
      })
    )
    await f.manager.withSharedAgent(
      parent,
      "mod-task:private",
      controller.signal,
      { blockedToolNames: new Set(), readOnly: true },
      async () => {
        const authority = currentFunctionExecution()!.runtimeAuthority!
        // Complete earlier step contributes usage; the cancelled step contributes only text.
        f.manager.observeSharedAgentTurn(
          new AIMessage({
            id: "completed-step",
            content: "earlier",
            response_metadata: { model_name: "fixture" },
            usage_metadata: { input_tokens: 3, output_tokens: 2, total_tokens: 5 }
          })
        )
        const model = createModModelBoundary(
          new FakeStreamingChatModel({
            chunks: [new AIMessageChunk({ id: "partial-step", content: "partial" })]
          }),
          f.manager,
          authority,
          { model: "fixture", turnId: authority.turnId }
        )
        const opening = model.stream([new HumanMessage("probe")], {
          signal: controller.signal,
          callbacks: [
            {
              handleLLMNewToken: async () => {
                if (ending === "cancel inside callback") controller.abort()
              }
            }
          ]
        })
        if (ending === "cancel inside callback") {
          await expect(opening).rejects.toThrow()
        } else {
          const stream = await opening
          expect((await stream.next()).value?.content).toBe("partial")
          // Old IPC ingress must not append the same frame or a different child's frame.
          f.manager.functionTurns.observeChildStream(
            "thread",
            "parent-run",
            authority.agentId,
            [{ type: "ai", id: "partial-step", content: "duplicate" }],
            "delta"
          )
          controller.abort()
          await stream.return()
        }
      },
      "parent-run"
    )
    await vi.waitFor(() => expect(completions).toHaveLength(1))
    expect(completions[0]).toMatchObject({
      agentId: "mod-task:private",
      reason: "aborted",
      answer: ending === "cancel after delivery" ? "partial" : "earlier",
      usage: { model: "fixture", input_tokens: 3, output_tokens: 2 }
    })
    expect(completions[0].turnId).not.toBe(parent.turnId)
  }
)

it.each(["main", "child"] as const)(
  "keeps the real %s stream owner for guest RPC and SDK calls after the first pull closes",
  async (owner) => {
    const f = fixture()
    const authority = f[owner].authority
    const phases: string[] = []
    const observe = (phase: string) => {
      expect(functionCallAuthority(f.workspace, "thread")).toBe(authority)
      expect(currentFunctionExecution()?.userInitiated).toBe(false)
      phases.push(phase)
    }
    const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
      on("turn.step",async function*($,e,next){
        let first=true;
        for await(const chunk of next(e)){
          yield chunk;
          if(first){
            first=false;
            if(await $.session.id()!=="thread")throw Error("wrong session");
            await $.ui.log("after-yield");
            const reply=await $.model.complete({model:"fixture",prompt:"independent"});
            if(reply.isAnswered!==true||reply.text!=="answer")
              throw Error("wrong model reply");
          }
        }
        return {answer:"done"}
      })
    }}`)
    const session = new FunctionSession(
      [
        {
          name: "stream",
          root: f.workspace,
          tier: "user",
          guest,
          capabilities: [...SESSION_CAPABILITIES]
        }
      ],
      {
        workspace: f.workspace,
        threadId: "thread",
        assertLive() {
          observe("host")
        },
        publish: async (v) => {
          observe("publish")
          return v
        },
        debugLog: (_plugin, text) => {
          observe(`log:${text}`)
        },
        completeModelResult: async () => {
          observe("model SDK")
          return functionModelResult({ text: "answer" })
        }
      }
    )
    cleanup.push(() => session.close())
    f.manager.attachFunctions({
      invalidate: vi.fn(),
      closeThread: vi.fn(),
      close: vi.fn(),
      turnStep: async (_workspace, _threadId, input, core, signal, hooks, skip, transport) =>
        session.turnStep(input, core, signal, hooks, skip, transport)
    })
    const stream = await f.manager.functionModelStream(
      authority,
      { model: "fixture", turnId: authority.turnId, index: 0, messageCount: 1 },
      async function* () {
        try {
          observe("provider first")
          yield { text: "first" }
          observe("provider second")
          yield { text: "second" }
          return { answer: "done" }
        } finally {
          observe("provider cleanup")
        }
      },
      new AbortController().signal
    )
    expect(await stream.next()).toEqual({ done: false, value: { text: "first" } })
    expect(currentFunctionExecution()).toBeUndefined()
    expect(await stream.next()).toEqual({ done: false, value: { text: "second" } })
    expect(await stream.next()).toEqual({ done: true, value: { answer: "done" } })
    expect(await stream.result).toEqual({ answer: "done" })
    expect(phases).toContain("model SDK")
    expect(phases).toContain("provider cleanup")
    expect(phases).toContain("log:after-yield")
    expect(guest.stats).toMatchObject({ frames: 0, replies: 0 })
  }
)

it.each(["release", "disable-reenable", "cancel"] as const)(
  "stops real streamed SDK/provider continuations after %s and cleans under an expired owner",
  async (change) => {
    const f = fixture()
    const authority = f.child.authority
    const entered = Promise.withResolvers<void>()
    const cleaned = Promise.withResolvers<void>()
    const finishSdk = Promise.withResolvers<string>()
    const controller = new AbortController()
    let laterProviderCalls = 0
    let lateLogs = 0
    let cleanupError: string | undefined
    const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
      on("turn.step",async function*($,e,next){
        for await(const chunk of next(e)){
          yield chunk;
          await $.model.complete({model:"fixture",prompt:"wait"});
          await $.ui.log("late");
        }
        return {}
      })
    }}`)
    const session = new FunctionSession(
      [
        {
          name: "stream",
          root: f.workspace,
          tier: "user",
          guest,
          capabilities: [...SESSION_CAPABILITIES]
        }
      ],
      {
        workspace: f.workspace,
        threadId: "thread",
        assertLive() {
          expect(functionCallAuthority(f.workspace, "thread")).toBe(authority)
        },
        publish: async (v) => v,
        debugLog: () => {
          lateLogs++
        },
        completeModelResult: async (_plugin, _input, signal) => {
          entered.resolve()
          const text = await new Promise<string>((_resolve, reject) => {
            void finishSdk.promise.then(_resolve, reject)
            signal.addEventListener("abort", () => reject(signal.reason), { once: true })
            if (signal.aborted) reject(signal.reason)
          })
          return functionModelResult({ text })
        }
      }
    )
    cleanup.push(() => session.close())
    f.manager.attachFunctions({
      invalidate: vi.fn(),
      closeThread: vi.fn(),
      close: vi.fn(),
      turnStep: async (_workspace, _threadId, input, core, signal, hooks, skip, transport) =>
        session.turnStep(input, core, signal, hooks, skip, transport)
    })
    const stream = await f.manager.functionModelStream(
      authority,
      { model: "fixture", turnId: authority.turnId, index: 0, messageCount: 1 },
      async function* () {
        try {
          yield { text: "first" }
          laterProviderCalls++
          yield { text: "late" }
          return {}
        } finally {
          try {
            functionCallAuthority(f.workspace, "thread")
          } catch (error) {
            cleanupError = (error as Error).message
          }
          cleaned.resolve()
        }
      },
      controller.signal
    )
    const terminal = expect(stream.result).rejects.toThrow()
    expect(await stream.next()).toEqual({ done: false, value: { text: "first" } })
    const pending = stream.next()
    void pending.catch(() => {})
    await entered.promise
    if (change === "release") f.child.release()
    else if (change === "disable-reenable") {
      f.manager.configure(f.workspace, false, false)
      f.manager.configure(f.workspace, true, false)
      finishSdk.resolve("answer")
    } else controller.abort(Error("cancelled"))
    await expect(pending).rejects.toThrow()
    await terminal
    await stream.return(null)
    await cleaned.promise
    expect(laterProviderCalls).toBe(0)
    expect(lateLogs).toBe(0)
    if (change !== "cancel") expect(cleanupError).toBe("MODS_CALL_SCOPE_EXPIRED")
    expect(() => f.main.authority.assertLive()).not.toThrow()
  }
)

it.each(["main", "child"] as const)(
  "routes the real %s authority through the protected lifecycle with its own Hook setting",
  async (owner) => {
    const f = fixture()
    const authority = f[owner].authority
    const observations: unknown[] = []
    await withFunctionAgentExecution(
      {
        ...f.main.authority,
        runtimeAuthority: f.main.authority,
        userInitiated: false,
        leased: false,
        immediate: false
      },
      async () => {
        const stream = await f.manager.functionModelStream(
          authority,
          { model: "actual-model" },
          async function* (input, { signal }): AsyncGenerator<ModJson, ModJson> {
            signal.throwIfAborted()
            observations.push({
              authority: functionCallAuthority(f.workspace, "thread"),
              agentId: currentFunctionExecution()?.agentId,
              model: input.model
            })
            yield { text: "first" }
            return { text: "complete" }
          },
          new AbortController().signal
        )
        expect(await stream.next()).toEqual({ done: false, value: { text: "first" } })
        expect(await stream.next()).toEqual({ done: true, value: { text: "complete" } })
        await expect(stream.result).resolves.toEqual({ text: "complete" })
      }
    )
    expect(f.lifecycle).toHaveBeenCalledOnce()
    expect(f.lifecycle.mock.calls[0][5]).toBe(true)
    expect(observations).toEqual([{ authority, agentId: authority.agentId, model: "actual-model" }])
    expect(() => f.main.authority.assertLive()).not.toThrow()
  }
)

it("binds the actual main authority at initialization and every pull without an ambient Function scope", async () => {
  const f = fixture()
  const observations: unknown[] = []
  const observe = (phase: string) => {
    const scope = currentFunctionExecution()
    observations.push({
      phase,
      authority: functionCallAuthority(f.workspace, "thread"),
      agentId: scope?.agentId,
      userInitiated: scope?.userInitiated
    })
  }
  f.lifecycle.mockImplementationOnce(async (_workspace, _threadId, input, core, signal) => {
    observe("initialize")
    return dispatchFunctionStream([], input, { signal, core })
  })
  expect(currentFunctionExecution()).toBeUndefined()
  const stream = await f.manager.functionModelStream(
    f.main.authority,
    {},
    async function* () {
      observe("first pull")
      yield { text: "first" }
      observe("second pull")
      return { text: "complete" }
    },
    new AbortController().signal
  )
  expect(currentFunctionExecution()).toBeUndefined()
  expect(await stream.next()).toEqual({ done: false, value: { text: "first" } })
  expect(currentFunctionExecution()).toBeUndefined()
  expect(await stream.next()).toEqual({ done: true, value: { text: "complete" } })
  await expect(stream.result).resolves.toEqual({ text: "complete" })
  expect(currentFunctionExecution()).toBeUndefined()
  expect(f.lifecycle.mock.calls[0][5]).toBe(true)
  expect(observations).toEqual(
    ["initialize", "first pull", "second pull"].map((phase) => ({
      phase,
      authority: f.main.authority,
      agentId: "main",
      userInitiated: false
    }))
  )
})

it("pulls and closes a main stream under its actual owner inside another agent's ambient scope", async () => {
  const f = fixture()
  const observations: unknown[] = []
  const observe = (phase: string) => {
    const scope = currentFunctionExecution()
    observations.push({
      phase,
      authority: functionCallAuthority(f.workspace, "thread"),
      agentId: scope?.agentId,
      userInitiated: scope?.userInitiated
    })
  }
  const stream = await f.manager.functionModelStream(
    f.main.authority,
    {},
    async function* () {
      try {
        observe("pull")
        yield { text: "first" }
        return { text: "must not arrive" }
      } finally {
        observe("cleanup")
      }
    },
    new AbortController().signal
  )
  const terminal = expect(stream.result).rejects.toThrow("MODS_STREAM_CLOSED")
  await withFunctionAgentExecution(
    {
      ...f.child.authority,
      runtimeAuthority: f.child.authority,
      userInitiated: true,
      leased: false,
      immediate: false
    },
    async () => {
      expect(functionCallAuthority(f.workspace, "thread")).toBe(f.child.authority)
      expect(await stream.next()).toEqual({ done: false, value: { text: "first" } })
      expect(functionCallAuthority(f.workspace, "thread")).toBe(f.child.authority)
      await stream.return(null)
      expect(functionCallAuthority(f.workspace, "thread")).toBe(f.child.authority)
      expect(currentFunctionExecution()?.userInitiated).toBe(true)
    }
  )
  await terminal
  expect(f.lifecycle.mock.calls[0][5]).toBe(true)
  expect(observations).toEqual(
    ["pull", "cleanup"].map((phase) => ({
      phase,
      authority: f.main.authority,
      agentId: "main",
      userInitiated: false
    }))
  )
  expect(currentFunctionExecution()).toBeUndefined()
  expect(() => f.main.authority.assertLive()).not.toThrow()
  expect(() => f.child.authority.assertLive()).not.toThrow()
})

it("does not inherit an expired parent file-write fence at the real main transport boundary", async () => {
  const f = fixture()
  const runId = "parent-write-run"
  expect(claimLocalThreadRunLease({ threadId: "thread", owner: "desktop", runId }).acquired).toBe(
    true
  )
  cleanup.push(() => {
    releaseLocalThreadRunLease("thread", "desktop", runId)
  })
  const observations: ModRuntimeAuthority[] = []
  await expect(
    withFunctionAgentExecution(
      {
        ...f.child.authority,
        runtimeAuthority: f.child.authority,
        userInitiated: true,
        leased: true,
        immediate: false
      },
      () =>
        withFunctionWriteLease(f.workspace, "thread", async () => {
          expect(functionCallAuthority(f.workspace, "thread")).toBe(f.child.authority)
          const stream = await f.manager.functionModelStream(
            f.main.authority,
            {},
            async function* () {
              const scope = functionExecutionScope(f.workspace, "thread")
              expect(scope?.runtimeAuthority).toBe(f.main.authority)
              expect(scope?.userInitiated).toBe(false)
              expect(() => functionExecutionScope(join(f.workspace, "other"), "thread")).toThrow(
                "MODS_CALL_SCOPE_CHANGED"
              )
              await expect(
                withFunctionWriteLease(f.workspace, "thread", async () => {})
              ).rejects.toThrow("MODS_WRITE_REQUIRES_USER_ACTION")
              observations.push(functionCallAuthority(f.workspace, "thread")!)
              yield { text: "first" }
              observations.push(functionCallAuthority(f.workspace, "thread")!)
              return { text: "complete" }
            },
            new AbortController().signal
          )
          expect(releaseLocalThreadRunLease("thread", "desktop", runId)).toBe(true)
          expect(() => functionExecutionScope(f.workspace, "thread")).toThrow("MODS_FS_WRITE_LEASE")
          expect(await stream.next()).toEqual({ done: false, value: { text: "first" } })
          expect(() => functionExecutionScope(f.workspace, "thread")).toThrow("MODS_FS_WRITE_LEASE")
          expect(await stream.next()).toEqual({ done: true, value: { text: "complete" } })
          await expect(stream.result).resolves.toEqual({ text: "complete" })
        })
    )
  ).rejects.toThrow("MODS_FS_WRITE_LEASE")
  expect(observations).toEqual([f.main.authority, f.main.authority])
  expect(f.lifecycle.mock.calls[0][5]).toBe(true)
  expect(currentFunctionExecution()).toBeUndefined()
  expect(() => f.main.authority.assertLive()).not.toThrow()
  expect(() => f.child.authority.assertLive()).not.toThrow()
})

it("closing a child stream closes only its provider and leaves the physical authorities live", async () => {
  const f = fixture()
  let closed = false
  let resumed = false
  let providerSignal: AbortSignal | undefined
  let cleanupOwner: ModRuntimeAuthority | undefined
  const stream = await f.manager.functionModelStream(
    f.child.authority,
    {},
    async function* (_input, { signal }) {
      providerSignal = signal
      try {
        yield { text: "first" }
        resumed = true
        return { text: "late" }
      } finally {
        cleanupOwner = functionCallAuthority(f.workspace, "thread")
        closed = true
      }
    },
    new AbortController().signal
  )
  const terminal = expect(stream.result).rejects.toThrow("MODS_STREAM_CLOSED")
  await stream.next()
  await stream.return(null)
  await terminal
  expect(providerSignal?.aborted).toBe(true)
  expect(closed).toBe(true)
  expect(resumed).toBe(false)
  expect(cleanupOwner).toBe(f.child.authority)
  expect(() => f.child.authority.assertLive()).not.toThrow()
  expect(() => f.main.authority.assertLive()).not.toThrow()
})

it("throwing into a child stream runs provider cleanup under that same live owner", async () => {
  const f = fixture()
  let cleanupOwner: ModRuntimeAuthority | undefined
  let closed = false
  const stream = await f.manager.functionModelStream(
    f.child.authority,
    {},
    async function* () {
      try {
        yield { text: "first" }
        return { text: "must not arrive" }
      } finally {
        cleanupOwner = functionCallAuthority(f.workspace, "thread")
        closed = true
      }
    },
    new AbortController().signal
  )
  const terminal = expect(stream.result).rejects.toThrow("consumer failure")
  await stream.next()
  await withFunctionAgentExecution(
    {
      ...f.main.authority,
      runtimeAuthority: f.main.authority,
      userInitiated: false,
      leased: false,
      immediate: false
    },
    async () => {
      await expect(stream.throw(Error("consumer failure"))).rejects.toThrow("consumer failure")
    }
  )
  await terminal
  expect(closed).toBe(true)
  expect(cleanupOwner).toBe(f.child.authority)
  expect(() => f.main.authority.assertLive()).not.toThrow()
})

it("expired child cleanup rejects SDK scope instead of inheriting the surrounding main authority", async () => {
  const f = fixture()
  const cleaned = Promise.withResolvers<void>()
  let cleanupOwner: ModRuntimeAuthority | undefined
  let cleanupError: string | undefined
  await withFunctionAgentExecution(
    {
      ...f.main.authority,
      runtimeAuthority: f.main.authority,
      userInitiated: false,
      leased: false,
      immediate: false
    },
    async () => {
      const stream = await f.manager.functionModelStream(
        f.child.authority,
        {},
        async function* () {
          try {
            yield { text: "first" }
            return { text: "must not arrive" }
          } finally {
            try {
              cleanupOwner = functionCallAuthority(f.workspace, "thread")
            } catch (error) {
              cleanupError = error instanceof Error ? error.message : String(error)
            } finally {
              cleaned.resolve()
            }
          }
        },
        new AbortController().signal
      )
      const terminal = expect(stream.result).rejects.toThrow()
      await stream.next()
      f.child.release()
      await cleaned.promise
      await terminal
      expect(functionCallAuthority(f.workspace, "thread")).toBe(f.main.authority)
    }
  )
  expect(cleanupOwner).toBeUndefined()
  expect(cleanupError).toBe("MODS_CALL_SCOPE_EXPIRED")
  expect(() => f.main.authority.assertLive()).not.toThrow()
})

it("replacing the exact child authority aborts its pending provider without borrowing the main owner", async () => {
  const f = fixture()
  const entered = Promise.withResolvers<void>()
  let providerSignal: AbortSignal | undefined
  let closed = false
  const stream = await f.manager.functionModelStream(
    f.child.authority,
    {},
    async function* (_input, { signal }) {
      providerSignal = signal
      try {
        entered.resolve()
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
          if (signal.aborted) reject(signal.reason)
        })
        yield { text: "must not arrive" }
        return null
      } finally {
        closed = true
      }
    },
    new AbortController().signal
  )
  const terminal = expect(stream.result).rejects.toThrow()
  const pending = stream.next()
  void pending.catch(() => {})
  await entered.promise
  const replacement = f.manager.createRuntimeAuthority({
    workspace: f.workspace,
    threadId: "thread",
    agentId: f.child.authority.agentId,
    turnId: "replacement-turn"
  })
  expect(providerSignal?.aborted).toBe(true)
  await expect(pending).rejects.toThrow()
  await terminal
  expect(closed).toBe(true)
  expect(() => f.child.authority.assertLive()).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
  expect(() => replacement.authority.assertLive()).not.toThrow()
  expect(() => f.main.authority.assertLive()).not.toThrow()
})

it.each([false, true])(
  "fences an opened child stream after disabling Mods, including re-enabled=%s",
  async (reenable) => {
    const f = fixture()
    let resumed = false
    let closed = false
    const stream = await f.manager.functionModelStream(
      f.child.authority,
      {},
      async function* () {
        try {
          yield { text: "first" }
          resumed = true
          return { text: "must not arrive" }
        } finally {
          closed = true
        }
      },
      new AbortController().signal
    )
    const terminal = expect(stream.result).rejects.toThrow()
    await stream.next()
    f.manager.configure(f.workspace, false, false)
    if (reenable) f.manager.configure(f.workspace, true, false)
    await expect(stream.next()).rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
    await stream.return(null)
    await terminal
    expect(resumed).toBe(false)
    expect(closed).toBe(true)
    expect(() => f.child.authority.assertLive()).not.toThrow()
  }
)
