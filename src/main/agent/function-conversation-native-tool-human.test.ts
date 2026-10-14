import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import type { RunnableConfig } from "@langchain/core/runnables"
import { tool } from "@langchain/core/tools"
import { Command } from "@langchain/langgraph"
import { createAgent } from "langchain"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { FunctionConversationStore, type FunctionConversationRow } from "../db/function-conversation-store"
import { ModsManager, type ModThreadBinding } from "../mods/manager"
import { DEFAULT_MOD_POLICY } from "../mods/policy"
import { FunctionConversationCoordinator } from "../mods/v2/conversation-coordinator"
import { projectFunctionSessionApiMessages } from "../mods/v2/session-api-transcript"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "./thread-run-lease"
import { installFunctionConversationNativeNode, readFunctionConversationNativeNodeSlot,
  type FunctionConversationNativeNodeSlot } from "./function-conversation-native-node"
import { installFunctionConversationNativeTools, readFunctionConversationNativeToolReturn,
  type FunctionNativeToolReturnView } from "./function-conversation-native-tools"
import { captureFunctionConversationNativeToolHuman, readFunctionConversationNativeToolHuman,
  captureFunctionConversationNativeToolHumanCurrent, readFunctionConversationNativeToolHumanCurrent,
  type FunctionNativeToolHumanSource } from "./function-conversation-native-tool-human"
import { assertFunctionNativeHumanProjectionVariant,
  captureFunctionNativeToolHumanProjectionVariant } from
  "../db/function-conversation-native-human-projection"
import { captureFunctionConversationNativeToolSide, readFunctionConversationNativeToolSide,
  captureFunctionConversationNativeToolSideCurrent, readFunctionConversationNativeToolSideCurrent } from
  "./function-conversation-native-tool-side"
import { createFunctionConversationNativeAdoption } from "./function-conversation-native-adoption"
import { captureFunctionNativeToolSideProjection, assertFunctionNativeToolSideProjection,
  assertFunctionNativeToolSideProjectionFresh } from
  "../db/function-conversation-native-tool-side-projection"
import { readFunctionConversationRawProjection } from "../db/function-conversation-projection-receipt"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
vi.mock("electron", () => ({ app: { getPath: () => tmpdir(), getName: () => "test",
  getVersion: () => "0" }, BrowserWindow: { getAllWindows: () => [] }, dialog: {},
  ipcMain: { handle: () => {} } }))
import * as appDb from "../db"

let directory = ""
const cleanups: Array<() => void | Promise<void>> = []
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-tool-human-source-"))
  paths.database = join(directory, "actual-app.sqlite")
  await appDb.initializeDatabase()
})
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

class LocalModel extends BaseChatModel {
  readonly requests: BaseMessage[][] = []
  constructor(private readonly call: { name: string; id: string }) { super({}) }
  _llmType() { return "actual-tool-human-local-provider" }
  bindTools(): this { return this }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.requests.push([...messages])
    const message = new AIMessage({ id: randomUUID(), content: this.requests.length === 1
      ? "actual request" : "actual completed turn", ...(this.requests.length === 1
      ? { tool_calls: [{ ...this.call, args: {} }] } : {}) })
    return { generations: [{ message, text: String(message.content) }] }
  }
}

/** Real AppDB/Manager/physical lease and actual ToolNode, without a fake commit adapter. */
async function fixture() {
  const root = mkdtempSync(join(directory, "workspace-"))
  const manager = new ModsManager(join(root, "control.sqlite"), () => [], async () => true,
    () => undefined, undefined, { ...DEFAULT_MOD_POLICY, required: false }, () => true)
  manager.configure(root, false, false)
  const workspace = manager.workspaceKey(root), threadId = randomUUID(), turnId = randomUUID()
  const physicalRunId = randomUUID(), controller = new AbortController()
  const originalThread = appDb.createThread(threadId, { workspacePath: workspace })
  const database = appDb.getDb(), incarnation = captureThreadIncarnation(originalThread)
  const action: { callback?: () => void } = {}
  let retired = false
  const guard = vi.fn(() => {
    controller.signal.throwIfAborted()
    if (retired || appDb.getDb() !== database ||
      !matchesThreadIncarnation(appDb.getThreadCore(threadId), incarnation))
      throw Error("ACTUAL_TOOL_HUMAN_SOURCE_RETIRED")
    action.callback?.()
  })
  const acquired = claimLocalThreadRunLease({ threadId, runId: physicalRunId, owner: "desktop" })
  if (!acquired.acquired) throw Error("ACTUAL_TOOL_HUMAN_LEASE_REQUIRED")
  const binding: ModThreadBinding = { workspace, threadId, turnId,
    signal: controller.signal, assertLive: guard }
  const instance = manager.createRuntimeAuthority(binding)
  const unbind = manager.bindThread({ ...binding, runtimeAuthority: instance.authority })
  const store = new FunctionConversationStore(database)
  const coordinator = new FunctionConversationCoordinator(store, {
    authorities: { get: scope => manager.getFunctionConversationAuthority(scope) },
    assertScope: context => {
      guard()
      if (context.workspace !== workspace || context.threadId !== threadId)
        throw Error("ACTUAL_TOOL_HUMAN_OWNER_CHANGED")
    },
    readCurrentCheckpoint: async (_thread, signal, current) => {
      signal.throwIfAborted(); current(); return null
    },
    protect: async (_context, value, signal, current) => {
      signal.throwIfAborted(); current(); return value
    }, apiMessages: projectFunctionSessionApiMessages, changed: () => undefined
  })
  manager.setFunctionConversations(coordinator)
  const closeOwner = coordinator.openConversationOwner({ owner: {}, workspace, threadId,
    signal: controller.signal, readOnly: false, assertCurrent: guard })
  await coordinator.prepareRuntime(workspace, threadId)
  await manager.prepareFunctionConversationRuntime(instance.authority, controller.signal, physicalRunId)
  const runtime = manager.captureFunctionNativeConversationRuntime(instance.authority)
  if (!runtime) throw Error("ACTUAL_TOOL_HUMAN_RUNTIME_REQUIRED")
  const saver = new SqlJsSaver(join(root, "actual-graph.sqlite"), undefined,
    { maxRootCheckpoints: 3 })
  const config: RunnableConfig = { signal: controller.signal,
    configurable: { thread_id: threadId, checkpoint_ns: "" } }
  cleanups.push(async () => {
    action.callback = undefined
    retired = false
    await saver.close()
    runtime.close(); closeOwner(); coordinator.registry.close(); unbind(); instance.release()
    releaseLocalThreadRunLease(threadId, "desktop", physicalRunId)
    manager.close(); rmSync(root, { recursive: true, force: true })
  })
  return { runtime, store, saver, config, controller, action, guard,
    retire: () => { retired = true }, removeBinding: unbind,
    changePolicy: () => manager.configure(root, false, false) }
}

async function actualRun(f: Awaited<ReturnType<typeof fixture>>,
  finalizer: (view: FunctionNativeToolReturnView, slot: FunctionConversationNativeNodeSlot) =>
    Promise<BaseMessage>, side: HumanMessage | AIMessage | SystemMessage =
      new HumanMessage("original tool side"),
  invocationSignal?: AbortSignal) {
  const callId = randomUUID(), effect = vi.fn()
  const paired = new ToolMessage({ tool_call_id: callId, content: "original paired result" })
  const actualTool = tool(() => {
    effect()
    return new Command({ update: { messages: [paired, side] } })
  }, { name: "actual_tool_human_origin", schema: z.object({}) })
  const model = new LocalModel({ name: actualTool.name, id: callId })
  const agent = createAgent({ model, tools: [actualTool], checkpointer: f.saver })
  const ledger = installFunctionConversationNativeTools({ graph: agent.graph, runtime: f.runtime })
  cleanups.push(async () => { ledger.close(); await ledger.whenDrained() })
  const control = installFunctionConversationNativeNode({ graph: agent.graph, node: "tools",
    assertCurrent: f.runtime.assertCurrent,
    finalize: async slot => finalizer(ledger.read(slot), slot) })
  cleanups.push(async () => { control.close(); await control.whenDrained() })
  const run = agent.invoke({ messages: [new HumanMessage("actual user request")] },
    { ...f.config, signal: invocationSignal ?? f.config.signal })
  void run.catch(() => undefined)
  return { run, agent, ledger, control, model, effect, side, paired, callId }
}

async function exactMessages(f: Awaited<ReturnType<typeof fixture>>): Promise<BaseMessage[]> {
  const latest = await f.saver.getTuple(f.config)
  if (!latest) throw Error("ACTUAL_TOOL_HUMAN_CHECKPOINT_REQUIRED")
  const tuple = await f.saver.getTuple(latest.config)
  const messages: unknown = tuple?.checkpoint.channel_values.messages
  if (!tuple || tuple.checkpoint.id !== latest.checkpoint.id || !Array.isArray(messages) ||
    !messages.every(BaseMessage.isInstance)) throw Error("EXACT_TOOL_HUMAN_MESSAGES_REQUIRED")
  return messages
}

describe("private actual ToolReturn Human source", () => {
  it("shares only the factory's exact current while every variant read retains its full source", async () => {
    const f = await fixture()
    const actual = await actualRun(f, async (view, slot) => {
      if (view.message instanceof ToolMessage) return view.message
      const token = captureFunctionConversationNativeToolHuman({ receipt: view.receipt,
        slot, runtime: f.runtime })
      const source = readFunctionConversationNativeToolHuman(token)
      const current = captureFunctionConversationNativeToolHumanCurrent(token,
        { failed: false }, { failed: false })
      const certificate = readFunctionConversationNativeToolHumanCurrent(token, current)
      expect(certificate).toBeDefined()
      expect(readFunctionConversationNativeToolHumanCurrent({ ...token }, current)).toBeUndefined()
      expect(readFunctionConversationNativeToolHumanCurrent(token, current.bind(undefined)))
        .toBeUndefined()
      let traps = 0
      const foreign = new Proxy(current, {
        get: () => { traps++; return undefined },
        getPrototypeOf: () => { traps++; return Function.prototype }
      })
      expect(readFunctionConversationNativeToolHumanCurrent(token, foreign)).toBeUndefined()
      expect(traps).toBe(0)
      const context = { producer: {}, run: f.runtime.run, occurrence: source.occurrence,
        target: f.runtime.target.ref, threadId: f.runtime.destination.threadId, uuid: source.uuid }
      const certified = captureFunctionNativeToolHumanProjectionVariant({ ...context, source: token,
        assertCurrent: current, assertCandidate: () => undefined })
      const independent = () => source.assertCurrent()
      expect(readFunctionConversationNativeToolHumanCurrent(token, independent)).toBeUndefined()
      const generic = captureFunctionNativeToolHumanProjectionVariant({ ...context, source: token,
        assertCurrent: independent, assertCandidate: () => undefined })
      let before = f.guard.mock.calls.length
      source.assertCurrent()
      const full = f.guard.mock.calls.length - before
      expect(full).toBeGreaterThan(0)
      before = f.guard.mock.calls.length
      assertFunctionNativeHumanProjectionVariant(certified, context)
      expect(f.guard.mock.calls.length - before).toBe(full * 2)
      before = f.guard.mock.calls.length
      assertFunctionNativeHumanProjectionVariant(certified, context)
      expect(f.guard.mock.calls.length - before).toBe(full * 2)
      before = f.guard.mock.calls.length
      assertFunctionNativeHumanProjectionVariant(generic, context)
      expect(f.guard.mock.calls.length - before).toBe(full * 6)
      before = f.guard.mock.calls.length
      certificate?.assertTail()
      expect(f.guard.mock.calls.length).toBe(before)
      return view.message
    })
    await actual.run
    expect(actual.effect).toHaveBeenCalledTimes(1)
    expect(actual.model.requests).toHaveLength(2)
    expect(f.store.highWater(f.runtime.target.ref)).toBe(0)
  })

  it.each(["body", "policy", "binding", "latch-getter", "latch-extra"] as const)(
    "rejects an original full callback changing %s in a certified current", async changed => {
      const f = await fixture()
      let callbacks = 0, getters = 0
      const actual = await actualRun(f, async (view, slot) => {
        if (view.message instanceof ToolMessage) return view.message
        const token = captureFunctionConversationNativeToolHuman({ receipt: view.receipt,
          slot, runtime: f.runtime })
        const first = { failed: false }, second = { failed: false }
        const current = captureFunctionConversationNativeToolHumanCurrent(token, first, second)
        f.action.callback = () => {
          f.action.callback = undefined
          callbacks++
          if (changed === "body") view.message.content = "changed certified source body"
          else if (changed === "policy") f.changePolicy()
          else if (changed === "binding") f.removeBinding()
          else if (changed === "latch-getter") Object.defineProperty(second, "failed", {
            get: () => { getters++; return false }
          })
          else Object.defineProperty(first, "extra", { value: false, enumerable: true })
        }
        current()
        return view.message
      })
      await expect(actual.run).rejects.toThrow()
      expect(callbacks).toBe(1)
      expect(getters).toBe(0)
      expect(actual.effect).toHaveBeenCalledTimes(1)
      expect(actual.model.requests).toHaveLength(1)
      expect((await exactMessages(f)).some(message =>
        message.content === "original tool side" || message.content === "changed certified source body"))
        .toBe(false)
      expect(f.store.highWater(f.runtime.target.ref)).toBe(0)
    })

  it.each(["current", "pure-tail"] as const)(
    "poisons a certified current after the original callback catches %s reentry", async kind => {
      const f = await fixture()
      let reentries = 0
      const actual = await actualRun(f, async (view, slot) => {
        if (view.message instanceof ToolMessage) return view.message
        const token = captureFunctionConversationNativeToolHuman({ receipt: view.receipt,
          slot, runtime: f.runtime })
        const current = captureFunctionConversationNativeToolHumanCurrent(token,
          { failed: false }, { failed: false })
        const certificate = readFunctionConversationNativeToolHumanCurrent(token, current)
        if (!certificate) throw Error("ACTUAL_SOURCE_CURRENT_CERTIFICATE_REQUIRED")
        f.action.callback = () => {
          f.action.callback = undefined
          expect(() => kind === "current" ? current() : certificate.assertTail())
            .toThrow("MODS_CONVERSATION_TOOL_HUMAN_INVALID")
          reentries++
        }
        expect(() => current()).toThrow("MODS_CONVERSATION_TOOL_HUMAN_INVALID")
        current()
        return view.message
      })
      await expect(actual.run).rejects.toThrow("MODS_CONVERSATION_TOOL_HUMAN_INVALID")
      expect(reentries).toBe(1)
      expect(actual.effect).toHaveBeenCalledTimes(1)
      expect(actual.model.requests).toHaveLength(1)
      expect((await exactMessages(f)).some(message => message.content === "original tool side"))
        .toBe(false)
      expect(f.store.highWater(f.runtime.target.ref)).toBe(0)
    })

  it.each(["body", "policy", "binding"] as const)(
    "rechecks captured full view after its original callback changes %s", async changed => {
      const f = await fixture()
      let callbacks = 0
      const actual = await actualRun(f, async (view, slot) => {
        if (view.message instanceof ToolMessage) return view.message
        const token = captureFunctionConversationNativeToolHuman({ receipt: view.receipt,
          slot, runtime: f.runtime })
        const source = readFunctionConversationNativeToolHuman(token)
        f.action.callback = () => {
          f.action.callback = undefined
          callbacks++
          if (changed === "body") view.message.content = "changed original source body"
          else if (changed === "policy") f.changePolicy()
          else f.removeBinding()
        }
        source.assertCurrent()
        return view.message
      })
      await expect(actual.run).rejects.toThrow()
      expect(callbacks).toBe(1)
      expect(actual.effect).toHaveBeenCalledTimes(1)
      expect(actual.model.requests).toHaveLength(1)
      expect((await exactMessages(f)).some(message =>
        message.content === "changed original source body" || message.content === "original tool side"))
        .toBe(false)
      expect(f.store.highWater(f.runtime.target.ref)).toBe(0)
    })

  it("poisons captured-view source reads when the original callback catches source reentry", async () => {
    const f = await fixture()
    let reentries = 0
    const actual = await actualRun(f, async (view, slot) => {
      if (view.message instanceof ToolMessage) return view.message
      const token = captureFunctionConversationNativeToolHuman({ receipt: view.receipt,
        slot, runtime: f.runtime })
      const source = readFunctionConversationNativeToolHuman(token)
      f.action.callback = () => {
        f.action.callback = undefined
        expect(() => readFunctionConversationNativeToolHuman(token))
          .toThrow("MODS_CONVERSATION_TOOL_HUMAN_INVALID")
        reentries++
      }
      source.assertCurrent()
      return view.message
    })
    await expect(actual.run).rejects.toThrow("MODS_CONVERSATION_TOOL_HUMAN_INVALID")
    expect(reentries).toBe(1)
    expect(actual.effect).toHaveBeenCalledTimes(1)
    expect(actual.model.requests).toHaveLength(1)
    expect((await exactMessages(f)).some(message => message.content === "original tool side"))
      .toBe(false)
    expect(f.store.highWater(f.runtime.target.ref)).toBe(0)
  })

  it("performs a fresh full private read on every certified source read", async () => {
    const f = await fixture()
    const actual = await actualRun(f, async (view, slot) => {
      if (view.message instanceof ToolMessage) return view.message
      const before = f.guard.mock.calls.length
      const first = readFunctionConversationNativeToolReturn(view.receipt, slot, f.runtime)
      const middle = f.guard.mock.calls.length
      const second = readFunctionConversationNativeToolReturn(view.receipt, slot, f.runtime)
      expect(middle).toBeGreaterThan(before)
      expect(f.guard.mock.calls.length).toBeGreaterThan(middle)
      expect(second.receipt).toBe(first.receipt)
      expect(second.message).toBe(first.message)
      return view.message
    })
    await actual.run
    expect(actual.effect).toHaveBeenCalledTimes(1)
    expect(actual.model.requests).toHaveLength(2)
    expect(f.store.highWater(f.runtime.target.ref)).toBe(0)
  })

  it.each(["policy", "retire", "binding", "node-task"] as const)(
    "refuses a synchronous original source %s change during the certified read", async changed => {
      const f = await fixture()
      let callbacks = 0
      const actual = await actualRun(f, async (view, slot) => {
        if (view.message instanceof ToolMessage) return view.message
        const node = readFunctionConversationNativeNodeSlot(slot)
        const configurable = node.config.configurable
        if (!configurable) throw Error("ACTUAL_TOOL_NODE_CONFIG_REQUIRED")
        f.action.callback = () => {
          f.action.callback = undefined
          callbacks++
          if (changed === "policy") f.changePolicy()
          else if (changed === "retire") f.retire()
          else if (changed === "binding") f.removeBinding()
          else configurable.__pregel_task_id = randomUUID()
        }
        return readFunctionConversationNativeToolReturn(view.receipt, slot, f.runtime).message
      })
      await expect(actual.run).rejects.toThrow()
      expect(callbacks).toBe(1)
      expect(actual.effect).toHaveBeenCalledTimes(1)
      expect(actual.model.requests).toHaveLength(1)
      expect((await exactMessages(f)).some(message => message.content === "original tool side"))
        .toBe(false)
      expect(f.store.highWater(f.runtime.target.ref)).toBe(0)
    })

  it("poisons the outer read when an original callback catches same-receipt reentry", async () => {
    const f = await fixture()
    let reentries = 0
    const actual = await actualRun(f, async (view, slot) => {
      if (view.message instanceof ToolMessage) return view.message
      f.action.callback = () => {
        f.action.callback = undefined
        expect(() => readFunctionConversationNativeToolReturn(view.receipt, slot, f.runtime))
          .toThrow("MODS_CONVERSATION_NATIVE_TOOL_SOURCE_INVALID")
        reentries++
      }
      return readFunctionConversationNativeToolReturn(view.receipt, slot, f.runtime).message
    })
    await expect(actual.run).rejects.toThrow("MODS_CONVERSATION_NATIVE_TOOL_SOURCE_INVALID")
    expect(reentries).toBe(1)
    expect(actual.effect).toHaveBeenCalledTimes(1)
    expect(actual.model.requests).toHaveLength(1)
    expect((await exactMessages(f)).some(message => message.content === "original tool side"))
      .toBe(false)
    expect(f.store.highWater(f.runtime.target.ref)).toBe(0)
  })

  it.each([undefined, "reused-provider-id"])("uses one actual occurrence for raw id %s", async rawId => {
    const f = await fixture(), side = new HumanMessage({ content: "original tool side", id: rawId })
    const saved: { source?: FunctionNativeToolHumanSource; slot?: FunctionConversationNativeNodeSlot } = {}
    const actual = await actualRun(f, async (view, slot) => {
      if (view.message instanceof ToolMessage) return new ToolMessage({ id: view.uuid,
        tool_call_id: view.message.tool_call_id, content: "safe paired result" })
      const token = captureFunctionConversationNativeToolHuman({ receipt: view.receipt,
        slot, runtime: f.runtime })
      const source = readFunctionConversationNativeToolHuman(token)
      saved.source = source; saved.slot = slot
      expect(source.message).toBe(side)
      expect(source.occurrence).toBe(view.receipt)
      expect(source.origin).toEqual({ kind: "tool", tool: "actual_tool_human_origin" })
      expect(source.door).toBe("tool-message")
      expect(source.uuid).toBe(view.uuid)
      expect(source.uuid).not.toBe(rawId)
      expect(Object.isFrozen(source)).toBe(true)
      expect(source.expiresAtNs).toBeGreaterThan(process.hrtime.bigint())
      const reads = f.guard.mock.calls.length
      source.assertDataCurrent()
      expect(f.guard.mock.calls).toHaveLength(reads)
      return new HumanMessage({ id: source.uuid, content: "safe completed tool side" })
    }, side)
    await actual.run
    const source = saved.source
    if (!source) throw Error("ACTUAL_TOOL_HUMAN_SOURCE_REQUIRED")
    expect(actual.effect).toHaveBeenCalledTimes(1)
    expect(actual.model.requests).toHaveLength(2)
    expect(actual.model.requests[1].find(message => message.id === source.uuid)?.content)
      .toBe("safe completed tool side")
    expect((await exactMessages(f)).find(message => message.id === source.uuid)?.content)
      .toBe("safe completed tool side")
    expect(side.content).toBe("original tool side")
    expect(side.id).toBe(rawId)
    expect(f.store.highWater(f.runtime.target.ref)).toBe(0)
    f.retire()
    expect(() => source.assertCurrent()).toThrow("ACTUAL_TOOL_HUMAN_SOURCE_RETIRED")
  })

  it("requires genuine receipt, original runtime and the same actual completed slot", async () => {
    const f = await fixture()
    let pairedSlot: FunctionConversationNativeNodeSlot | undefined
    const actual = await actualRun(f, async (view, slot) => {
      if (view.message instanceof ToolMessage) { pairedSlot = slot; return view.message }
      const originalPairedSlot = pairedSlot
      if (!originalPairedSlot) throw Error("ACTUAL_PAIRED_SLOT_REQUIRED")
      expect(() => readFunctionConversationNativeToolReturn(view.receipt, originalPairedSlot, f.runtime))
        .toThrow("MODS_CONVERSATION_NATIVE_TOOL_SOURCE_INVALID")
      expect(() => captureFunctionConversationNativeToolHuman({ receipt: { ...view.receipt },
        slot, runtime: f.runtime })).toThrow("MODS_CONVERSATION_NATIVE_TOOL_SOURCE_INVALID")
      expect(() => captureFunctionConversationNativeToolHuman({ receipt: view.receipt,
        slot, runtime: { ...f.runtime } })).toThrow("MODS_CONVERSATION_NATIVE_TOOL_SOURCE_INVALID")
      return view.message
    })
    await actual.run
    expect(actual.effect).toHaveBeenCalledTimes(1)
    expect(actual.model.requests).toHaveLength(2)
  })

  it("rejects a cloned or public source token without publishing a row", async () => {
    const f = await fixture()
    const actual = await actualRun(f, async (view, slot) => {
      if (view.message instanceof ToolMessage) return view.message
      const token = captureFunctionConversationNativeToolHuman({ receipt: view.receipt,
        slot, runtime: f.runtime })
      expect(() => readFunctionConversationNativeToolHuman({ ...token }))
        .toThrow("MODS_CONVERSATION_TOOL_HUMAN_INVALID")
      expect(readFunctionConversationNativeToolHuman(token).message).toBe(view.message)
      return view.message
    })
    await actual.run
    expect(f.store.highWater(f.runtime.target.ref)).toBe(0)
  })

  it.each(["function_row", "cmb_visible_user_message", "cmb_coordinator_augmented_user_message"])(
    "refuses %s as a ToolHuman presentation source", async key => {
      const f = await fixture(), side = new HumanMessage({ content: "raw tool hidden body",
        additional_kwargs: { [key]: { text: "public source claim" } } })
      const actual = await actualRun(f, async (view, slot) => {
        if (view.message instanceof ToolMessage) return view.message
        captureFunctionConversationNativeToolHuman({ receipt: view.receipt, slot, runtime: f.runtime })
        return view.message
      }, side)
      await expect(actual.run).rejects.toThrow("MODS_CONVERSATION_TOOL_HUMAN_INVALID")
      expect(actual.effect).toHaveBeenCalledTimes(1)
      expect(actual.model.requests).toHaveLength(1)
      expect((await exactMessages(f)).some(message => message.content === side.content)).toBe(false)
    })

  it("does not execute a raw getter or toJSON method during typed-first capture", async () => {
    const f = await fixture(), getter = vi.fn(() => "raw accessor"), toJSON = vi.fn()
    const actual = await actualRun(f, async (view, slot) => {
      if (view.message instanceof ToolMessage) return view.message
      const original = Object.getOwnPropertyDescriptor(view.message, "content")
      Object.defineProperty(view.message, "content", { get: getter, enumerable: true, configurable: true })
      Object.defineProperty(view.message, "toJSON", { value: toJSON, enumerable: true, configurable: true })
      try {
        captureFunctionConversationNativeToolHuman({ receipt: view.receipt, slot, runtime: f.runtime })
      } finally {
        if (original) Object.defineProperty(view.message, "content", original)
        Reflect.deleteProperty(view.message, "toJSON")
      }
      return view.message
    })
    await expect(actual.run).rejects.toThrow("MODS_NATIVE_CAPTURE_ACCESSOR")
    expect(getter).not.toHaveBeenCalled()
    expect(toJSON).not.toHaveBeenCalled()
    expect(actual.effect).toHaveBeenCalledTimes(1)
    expect(actual.model.requests).toHaveLength(1)
  })

  it("keeps the first capture cut on later pure and full reads", async () => {
    const f = await fixture()
    const actual = await actualRun(f, async (view, slot) => {
      if (view.message instanceof ToolMessage) return view.message
      const token = captureFunctionConversationNativeToolHuman({ receipt: view.receipt,
        slot, runtime: f.runtime })
      const source = readFunctionConversationNativeToolHuman(token), deadline = source.expiresAtNs
      const clock = vi.spyOn(process.hrtime, "bigint").mockReturnValue(deadline)
      const reads = f.guard.mock.calls.length
      try {
        expect(() => source.assertDataCurrent()).toThrow("MODS_CONVERSATION_TOOL_HUMAN_DEADLINE")
        expect(() => readFunctionConversationNativeToolHuman(token))
          .toThrow("MODS_CONVERSATION_TOOL_HUMAN_DEADLINE")
        expect(source.expiresAtNs).toBe(deadline)
        expect(f.guard.mock.calls).toHaveLength(reads)
      } finally { clock.mockRestore() }
      return view.message
    })
    await actual.run
    expect(actual.effect).toHaveBeenCalledTimes(1)
  })

  it("rejects raw nested Proxy data without executing its traps", async () => {
    const f = await fixture(), traps = vi.fn()
    const actual = await actualRun(f, async (view, slot) => {
      if (view.message instanceof ToolMessage) return view.message
      const original = view.message.additional_kwargs
      view.message.additional_kwargs = { nested: new Proxy({}, {
        get: () => { traps(); return undefined }, ownKeys: () => { traps(); return [] },
        getOwnPropertyDescriptor: () => { traps(); return undefined }
      }) }
      try {
        captureFunctionConversationNativeToolHuman({ receipt: view.receipt, slot, runtime: f.runtime })
      } finally { view.message.additional_kwargs = original }
      return view.message
    })
    await expect(actual.run).rejects.toThrow("MODS_NATIVE_CAPTURE_PROXY")
    expect(traps).not.toHaveBeenCalled()
    expect(actual.effect).toHaveBeenCalledTimes(1)
    expect(actual.model.requests).toHaveLength(1)
  })

  it("rejects original runtime cancellation without replaying the completed tool", async () => {
    const f = await fixture()
    const actual = await actualRun(f, async (view, slot) => {
      if (view.message instanceof ToolMessage) return view.message
      const token = captureFunctionConversationNativeToolHuman({ receipt: view.receipt,
        slot, runtime: f.runtime })
      f.controller.abort(Error("ACTUAL_TOOL_HUMAN_ABORTED"))
      readFunctionConversationNativeToolHuman(token)
      return view.message
    })
    await expect(actual.run).rejects.toThrow("ACTUAL_TOOL_HUMAN_ABORTED")
    expect(actual.effect).toHaveBeenCalledTimes(1)
    expect(actual.model.requests).toHaveLength(1)
  })

  it("propagates the independent actual invocation cut while the runtime remains live", async () => {
    const f = await fixture(), invocation = new AbortController()
    const actual = await actualRun(f, async (view, slot) => {
      if (view.message instanceof ToolMessage) return view.message
      const token = captureFunctionConversationNativeToolHuman({ receipt: view.receipt,
        slot, runtime: f.runtime })
      const source = readFunctionConversationNativeToolHuman(token)
      expect(view.signal?.aborted).toBe(false)
      invocation.abort(Error("ACTUAL_TOOL_HUMAN_INVOCATION_CUT"))
      expect(source.signal.aborted).toBe(true)
      expect(f.runtime.signal.aborted).toBe(false)
      expect(f.runtime.target.signal.aborted).toBe(false)
      expect(() => source.assertDataCurrent()).toThrow("ACTUAL_TOOL_HUMAN_INVOCATION_CUT")
      readFunctionConversationNativeToolHuman(token)
      return view.message
    }, new HumanMessage("actual independently cancelled side"), invocation.signal)
    await expect(actual.run).rejects.toThrow("ACTUAL_TOOL_HUMAN_INVOCATION_CUT")
    expect(actual.effect).toHaveBeenCalledTimes(1)
    expect(actual.model.requests).toHaveLength(1)
    expect(f.runtime.signal.aborted).toBe(false)
  })

  it("latches capture before a source callback can reenter the same occurrence", async () => {
    const f = await fixture(), reentered = vi.fn()
    const actual = await actualRun(f, async (view, slot) => {
      if (view.message instanceof ToolMessage) return view.message
      const input = { receipt: view.receipt, slot, runtime: f.runtime }
      f.action.callback = () => {
        f.action.callback = undefined
        reentered()
        expect(() => captureFunctionConversationNativeToolHuman(input))
          .toThrow("MODS_CONVERSATION_TOOL_HUMAN_INVALID")
      }
      captureFunctionConversationNativeToolHuman(input)
      return view.message
    })
    await expect(actual.run).rejects.toThrow("MODS_CONVERSATION_TOOL_HUMAN_INVALID")
    expect(reentered).toHaveBeenCalledTimes(1)
    expect(actual.effect).toHaveBeenCalledTimes(1)
    expect(actual.model.requests).toHaveLength(1)
    expect((await exactMessages(f)).some(message => message.content === actual.side.content)).toBe(false)
  })

  it.each(["body", "policy"])("rejects a full source callback changing %s before publication", async kind => {
    const f = await fixture()
    const actual = await actualRun(f, async (view, slot) => {
      if (view.message instanceof ToolMessage) return view.message
      const token = captureFunctionConversationNativeToolHuman({ receipt: view.receipt,
        slot, runtime: f.runtime })
      const source = readFunctionConversationNativeToolHuman(token)
      f.action.callback = () => {
        f.action.callback = undefined
        if (kind === "body") view.message.content = "late changed raw body"
        else f.changePolicy()
      }
      source.assertCurrent()
      return view.message
    })
    await expect(actual.run).rejects.toThrow(kind === "body"
      ? "MODS_CONVERSATION_TOOL_HUMAN_INVALID" : "MODS_CALL_SCOPE_CHANGED")
    expect(actual.effect).toHaveBeenCalledTimes(1)
    expect(actual.model.requests).toHaveLength(1)
    expect((await exactMessages(f)).some(message => message.content === actual.side.content))
      .toBe(false)
  })
})

describe("actual Tool Command AI/System source and fresh projection qualification", () => {
  it("certifies only the factory's exact current and original runtime without a source callback", async () => {
    const f = await fixture(), side = new SystemMessage("actual certified System")
    const actual = await actualRun(f, async (view, slot) => {
      if (view.message instanceof ToolMessage) return view.message
      const token = captureFunctionConversationNativeToolSide({ receipt: view.receipt, slot,
        runtime: f.runtime })
      const current = captureFunctionConversationNativeToolSideCurrent(token, { failed: false })
      const before = f.guard.mock.calls.length
      const certificate = readFunctionConversationNativeToolSideCurrent(current, f.runtime)
      if (!certificate) throw Error("ACTUAL_SIDE_CURRENT_CERTIFICATE_REQUIRED")
      certificate.assertTail()
      expect(f.guard.mock.calls).toHaveLength(before)
      expect(readFunctionConversationNativeToolSideCurrent(current, { ...f.runtime })).toBeUndefined()
      expect(readFunctionConversationNativeToolSideCurrent(current.bind(undefined), f.runtime))
        .toBeUndefined()
      expect(readFunctionConversationNativeToolSideCurrent(() => current(), f.runtime)).toBeUndefined()
      let traps = 0
      const foreign = new Proxy(current, { get: () => { traps++; return undefined },
        getPrototypeOf: () => { traps++; return Function.prototype } })
      expect(readFunctionConversationNativeToolSideCurrent(foreign, f.runtime)).toBeUndefined()
      expect(traps).toBe(0)
      current()
      expect(f.guard.mock.calls.length).toBeGreaterThan(before)
      return view.message
    }, side)
    await actual.run
    expect(actual.effect).toHaveBeenCalledTimes(1)
    expect(actual.model.requests).toHaveLength(2)
  })

  it("keeps fresh full source checks while a foreign Adoption callback retains its extra runtime check", async () => {
    const f = await fixture(), side = new SystemMessage("actual Adoption System")
    const actual = await actualRun(f, async (view, slot) => {
      if (view.message instanceof ToolMessage) return view.message
      const token = captureFunctionConversationNativeToolSide({ receipt: view.receipt, slot,
        runtime: f.runtime })
      const current = captureFunctionConversationNativeToolSideCurrent(token, { failed: false })
      const create = (assertCurrent: () => void) => createFunctionConversationNativeAdoption({
        runtime: f.runtime, store: f.store, producer: {}, occurrence: view.receipt,
        facts: { uuid: view.uuid, role: "system", providerSourceId: view.uuid, providerOccurrence: 1 },
        assertCurrent, seal: () => undefined, flush: () => undefined })
      let before = f.guard.mock.calls.length
      create(current)
      const certified = f.guard.mock.calls.length - before
      expect(certified).toBeGreaterThan(0)
      before = f.guard.mock.calls.length
      create(() => current())
      expect(f.guard.mock.calls.length - before).toBeGreaterThan(certified)
      before = f.guard.mock.calls.length
      create(current)
      expect(f.guard.mock.calls.length - before).toBe(certified)
      expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(0)
      return view.message
    }, side)
    await actual.run
    expect(actual.effect).toHaveBeenCalledTimes(1)
    expect(actual.model.requests).toHaveLength(2)
  })

  it("does not read a genuine current's own bind getter when installing its Adoption guard", async () => {
    const f = await fixture(), side = new SystemMessage("actual original closure System")
    let getters = 0
    const actual = await actualRun(f, async (view, slot) => {
      if (view.message instanceof ToolMessage) return view.message
      const token = captureFunctionConversationNativeToolSide({ receipt: view.receipt, slot,
        runtime: f.runtime })
      const current = captureFunctionConversationNativeToolSideCurrent(token, { failed: false })
      Object.defineProperty(current, "bind", { get() {
        getters++
        throw Error("OWN_CURRENT_BIND_MUST_NOT_EXECUTE")
      }, configurable: true })
      const before = f.guard.mock.calls.length
      createFunctionConversationNativeAdoption({ runtime: f.runtime, store: f.store,
        producer: {}, occurrence: view.receipt,
        facts: { uuid: view.uuid, role: "system", providerSourceId: view.uuid, providerOccurrence: 1 },
        assertCurrent: current, seal: () => undefined, flush: () => undefined })
      expect(getters).toBe(0)
      expect(f.guard.mock.calls.length).toBeGreaterThan(before)
      return view.message
    }, side)
    await actual.run
    expect(getters).toBe(0)
    expect(actual.effect).toHaveBeenCalledTimes(1)
    expect(actual.model.requests).toHaveLength(2)
  })

  it("keeps the callback-free certificate tail fresh and a caught changed-body failure sticky", async () => {
    const f = await fixture(), side = new SystemMessage("original pure-tail System")
    const actual = await actualRun(f, async (view, slot) => {
      if (view.message instanceof ToolMessage) return view.message
      const token = captureFunctionConversationNativeToolSide({ receipt: view.receipt, slot,
        runtime: f.runtime })
      const current = captureFunctionConversationNativeToolSideCurrent(token, { failed: false })
      const certificate = readFunctionConversationNativeToolSideCurrent(current, f.runtime)
      if (!certificate) throw Error("ACTUAL_SIDE_CURRENT_CERTIFICATE_REQUIRED")
      current()
      const before = f.guard.mock.calls.length
      side.content = "changed after the original complete source"
      expect(() => certificate.assertTail()).toThrow("MODS_CONVERSATION_TOOL_SIDE_INVALID")
      expect(f.guard.mock.calls).toHaveLength(before)
      side.content = "original pure-tail System"
      expect(() => readFunctionConversationNativeToolSideCurrent(current, f.runtime))
        .toThrow("MODS_CONVERSATION_TOOL_SIDE_INVALID")
      current()
      return view.message
    }, side)
    await expect(actual.run).rejects.toThrow("MODS_CONVERSATION_TOOL_SIDE_INVALID")
    expect(actual.effect).toHaveBeenCalledTimes(1)
    expect(actual.model.requests).toHaveLength(1)
    expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(0)
  })

  it.each(["body", "metadata", "policy", "binding", "host", "reentry"])(
    "rejects a genuine Adoption source guard's final %s change", async kind => {
      const f = await fixture(), side = new SystemMessage("original Adoption source System")
      let sideUuid: string | undefined
      const actual = await actualRun(f, async (view, slot) => {
        if (view.message instanceof ToolMessage) return view.message
        sideUuid = view.uuid
        const token = captureFunctionConversationNativeToolSide({ receipt: view.receipt, slot,
          runtime: f.runtime }), latch = { failed: false }
        const current = captureFunctionConversationNativeToolSideCurrent(token, latch)
        f.action.callback = () => {
          f.action.callback = undefined
          if (kind === "body") side.content = "late changed Adoption body"
          else if (kind === "metadata") side.response_metadata = { changed: true }
          else if (kind === "policy") f.changePolicy()
          else if (kind === "binding") f.removeBinding()
          else if (kind === "host") latch.failed = true
          else expect(() => current()).toThrow("MODS_CONVERSATION_TOOL_SIDE_INVALID")
        }
        createFunctionConversationNativeAdoption({ runtime: f.runtime, store: f.store,
          producer: {}, occurrence: view.receipt,
          facts: { uuid: view.uuid, role: "system", providerSourceId: view.uuid, providerOccurrence: 1 },
          assertCurrent: current, seal: () => undefined, flush: () => undefined })
        return view.message
      }, side)
      await expect(actual.run).rejects.toThrow(kind === "policy" || kind === "binding"
        ? "MODS_CALL_SCOPE_CHANGED" : "MODS_CONVERSATION_TOOL_SIDE_INVALID")
      expect(actual.effect).toHaveBeenCalledTimes(1)
      expect(actual.model.requests).toHaveLength(1)
      expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(0)
      if (!sideUuid) throw Error("ACTUAL_SIDE_UUID_REQUIRED")
      expect(readFunctionConversationRawProjection(f.runtime.database,
        f.runtime.destination.threadId, sideUuid)).toBeUndefined()
      expect((await exactMessages(f)).some(message => message.content === side.content)).toBe(false)
    })

  it("runs the original full source for every independently captured side current call", async () => {
    const f = await fixture(), side = new SystemMessage("actual provider System")
    const actual = await actualRun(f, async (view, slot) => {
      if (view.message instanceof ToolMessage) return view.message
      const token = captureFunctionConversationNativeToolSide({ receipt: view.receipt, slot,
        runtime: f.runtime })
      const current = captureFunctionConversationNativeToolSideCurrent(token, { failed: false })
      const before = f.guard.mock.calls.length
      current()
      const first = f.guard.mock.calls.length
      expect(first).toBeGreaterThan(before)
      current()
      expect(f.guard.mock.calls.length).toBeGreaterThan(first)
      return view.message
    }, side)
    await actual.run
    expect(actual.effect).toHaveBeenCalledTimes(1)
    expect(actual.model.requests).toHaveLength(2)
    expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(0)
  })

  it.each(["body", "metadata", "policy", "binding", "host"])(
    "rejects the last original side current callback changing %s", async kind => {
      const f = await fixture(), side = new SystemMessage("original guarded System")
      const actual = await actualRun(f, async (view, slot) => {
        if (view.message instanceof ToolMessage) return view.message
        const token = captureFunctionConversationNativeToolSide({ receipt: view.receipt, slot,
          runtime: f.runtime })
        const latch = { failed: false }
        const current = captureFunctionConversationNativeToolSideCurrent(token, latch)
        f.action.callback = () => {
          f.action.callback = undefined
          if (kind === "body") side.content = "late changed side body"
          else if (kind === "metadata") side.response_metadata = { changed: true }
          else if (kind === "policy") f.changePolicy()
          else if (kind === "binding") f.removeBinding()
          else latch.failed = true
        }
        current()
        return view.message
      }, side)
      await expect(actual.run).rejects.toThrow(kind === "policy" || kind === "binding"
        ? "MODS_CALL_SCOPE_CHANGED" : "MODS_CONVERSATION_TOOL_SIDE_INVALID")
      expect(actual.effect).toHaveBeenCalledTimes(1)
      expect(actual.model.requests).toHaveLength(1)
      expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(0)
      expect((await exactMessages(f)).some(message => message.content === side.content)).toBe(false)
    })

  it.each(["construct", "read"])("keeps a caught side current %s reentry sticky", async kind => {
    const f = await fixture(), side = new AIMessage("original current tool AI")
    const actual = await actualRun(f, async (view, slot) => {
      if (view.message instanceof ToolMessage) return view.message
      const token = captureFunctionConversationNativeToolSide({ receipt: view.receipt, slot,
        runtime: f.runtime }), latch = { failed: false }
      let current: (() => void) | undefined
      if (kind === "read") current = captureFunctionConversationNativeToolSideCurrent(token, latch)
      f.action.callback = () => {
        f.action.callback = undefined
        expect(() => kind === "construct"
          ? captureFunctionConversationNativeToolSideCurrent(token, latch) : current!())
          .toThrow("MODS_CONVERSATION_TOOL_SIDE_INVALID")
      }
      if (kind === "construct") captureFunctionConversationNativeToolSideCurrent(token, latch)
      else current!()
      return view.message
    }, side)
    await expect(actual.run).rejects.toThrow("MODS_CONVERSATION_TOOL_SIDE_INVALID")
    expect(actual.effect).toHaveBeenCalledTimes(1)
    expect(actual.model.requests).toHaveLength(1)
    expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(0)
  })

  it("rejects a projection row origin Proxy before any reflection trap", async () => {
    const f = await fixture(), side = new SystemMessage("actual origin guard System")
    let traps = 0
    const actual = await actualRun(f, async (view, slot) => {
      if (view.message instanceof ToolMessage) return view.message
      const token = captureFunctionConversationNativeToolSide({ receipt: view.receipt, slot,
        runtime: f.runtime }), producer = Object.freeze({})
      const projection = captureFunctionNativeToolSideProjection({ source: token, producer })
      const origin = new Proxy({ kind: "tool", tool: view.origin.tool }, {
        ownKeys(target) { traps++; return Reflect.ownKeys(target) },
        getOwnPropertyDescriptor(target, key) { traps++; return Reflect.getOwnPropertyDescriptor(target, key) }
      })
      // Deliberately invalid row data; only the original ToolReturn grants the tested source.
      const row: FunctionConversationRow = { uuid: view.uuid, sequence: 1, receiptId: "invalid-origin",
        branchId: f.runtime.target.ref.branchId, inputDigest: "invalid-origin", door: "tool-message",
        origin, message: { type: "system", content: [{ type: "text", text: "actual origin guard System" }] },
        nativePayload: "unreachable invalid-origin fixture", orderAnchor: {}, inbox: false,
        bytes: 0, createdAt: 0 }
      expect(() => assertFunctionNativeToolSideProjection(projection, { producer, run: f.runtime.run,
        occurrence: view.receipt, target: f.runtime.target.ref,
        threadId: f.runtime.destination.threadId, uuid: view.uuid, role: "system" }, row))
        .toThrow("MODS_CONVERSATION_TOOL_SIDE_PROJECTION_INVALID")
      expect(traps).toBe(0)
      expect(readFunctionConversationRawProjection(f.runtime.database,
        f.runtime.destination.threadId, view.uuid)).toBeUndefined()
      return view.message
    }, side)
    await actual.run
    expect(actual.effect).toHaveBeenCalledTimes(1)
    expect(actual.model.requests).toHaveLength(2)
    expect(traps).toBe(0)
    expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(0)
  })

  it.each(["ai", "system"] as const)("qualifies only the original %s return and its fresh target", async type => {
    const f = await fixture(), producer = Object.freeze({})
    const side = type === "ai" ? new AIMessage({ content: "original side", name: "native_name",
      usage_metadata: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } })
      : new SystemMessage({ id: "original-provider-system", content: "original side",
        name: "native_name", response_metadata: { actual: "retained" } })
    const actual = await actualRun(f, async (view, slot) => {
      if (view.message instanceof ToolMessage) return view.message
      const token = captureFunctionConversationNativeToolSide({ receipt: view.receipt, slot,
        runtime: f.runtime })
      const source = readFunctionConversationNativeToolSide(token)
      expect(source.message).toBe(side)
      expect(source.nativeType).toBe(type)
      expect(source.occurrence).toBe(view.receipt)
      expect(source.origin).toEqual({ kind: "tool", tool: "actual_tool_human_origin" })
      expect(source.uuid).toBe(view.uuid)
      expect(() => readFunctionConversationNativeToolSide({ ...token })).toThrow(
        "MODS_CONVERSATION_TOOL_SIDE_INVALID")
      const variant = captureFunctionNativeToolSideProjection({ source: token, producer })
      const context = { producer, run: f.runtime.run, occurrence: view.receipt,
        target: f.runtime.target.ref, threadId: f.runtime.destination.threadId, uuid: view.uuid,
        role: type === "ai" ? "assistant" as const : "system" as const }
      expect(() => assertFunctionNativeToolSideProjectionFresh(variant, context, undefined))
        .not.toThrow()
      for (const changed of [{ producer: {} }, { occurrence: {} }, { run: {} },
        { threadId: "foreign" }, { target: { ...context.target, branchId: "foreign" } },
        { role: "user" as const }])
        expect(() => assertFunctionNativeToolSideProjection(variant, { ...context, ...changed }))
          .toThrow("MODS_CONVERSATION_TOOL_SIDE_PROJECTION_INVALID")
      // A real ordinary row is not permission to adopt a tool side under the fresh contract.
      appDb.upsertThreadMessages(f.runtime.destination.threadId, [{ id: view.uuid,
        role: context.role, content: "actual existing visible row", created_at: new Date() }])
      const baseline = readFunctionConversationRawProjection(f.runtime.database,
        f.runtime.destination.threadId, view.uuid)
      expect(baseline).toBeDefined()
      expect(() => assertFunctionNativeToolSideProjectionFresh(variant, context, baseline))
        .toThrow("MODS_CONVERSATION_TOOL_SIDE_PROJECTION_INVALID")
      return view.message
    }, side)
    await actual.run
    expect(actual.effect).toHaveBeenCalledTimes(1)
    expect(actual.model.requests).toHaveLength(2)
  })

  it.each(["body", "policy", "binding"])("rejects a last original side guard changing %s", async kind => {
    const f = await fixture(), side = new SystemMessage("original provider System")
    const actual = await actualRun(f, async (view, slot) => {
      if (view.message instanceof ToolMessage) return view.message
      const token = captureFunctionConversationNativeToolSide({ receipt: view.receipt, slot,
        runtime: f.runtime })
      const source = readFunctionConversationNativeToolSide(token)
      f.action.callback = () => {
        f.action.callback = undefined
        if (kind === "body") side.content = "late changed System"
        else if (kind === "policy") f.changePolicy()
        else f.removeBinding()
      }
      source.assertCurrent()
      return view.message
    }, side)
    await expect(actual.run).rejects.toThrow(kind === "body"
      ? "MODS_CONVERSATION_TOOL_SIDE_INVALID" : "MODS_CALL_SCOPE_CHANGED")
    expect(actual.effect).toHaveBeenCalledTimes(1)
    expect(actual.model.requests).toHaveLength(1)
    expect((await exactMessages(f)).some(message => message.content === side.content)).toBe(false)
  })

  it("rejects a caught same-side source reentry without permitting the outer continuation", async () => {
    const f = await fixture(), side = new AIMessage("original tool AI")
    const actual = await actualRun(f, async (view, slot) => {
      if (view.message instanceof ToolMessage) return view.message
      const token = captureFunctionConversationNativeToolSide({ receipt: view.receipt, slot,
        runtime: f.runtime })
      const source = readFunctionConversationNativeToolSide(token)
      f.action.callback = () => {
        f.action.callback = undefined
        expect(() => source.assertCurrent()).toThrow("MODS_CONVERSATION_TOOL_SIDE_INVALID")
      }
      source.assertCurrent()
      return view.message
    }, side)
    await expect(actual.run).rejects.toThrow("MODS_CONVERSATION_TOOL_SIDE_INVALID")
    expect(actual.effect).toHaveBeenCalledTimes(1)
    expect(actual.model.requests).toHaveLength(1)
  })
})
