import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { tool } from "@langchain/core/tools"
import { Command } from "@langchain/langgraph"
import { createAgent } from "langchain"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { FunctionConversationStore } from "../db/function-conversation-store"
import { readFunctionConversationProjectionReceipt, readFunctionConversationRawProjection } from
  "../db/function-conversation-projection-receipt"
import { functionNativeHumanProjectionFreshColumns, functionNativeHumanProjectionKind } from
  "../db/function-conversation-native-human-projection"
import { readFunctionConversationPresentationDisposition } from
  "../db/function-conversation-presentation-disposition"
import { ModsManager, type ModThreadBinding } from "../mods/manager"
import { DEFAULT_MOD_POLICY } from "../mods/policy"
import { FunctionConversationCoordinator } from "../mods/v2/conversation-coordinator"
import { projectFunctionSessionApiMessages } from "../mods/v2/session-api-transcript"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "./thread-run-lease"
import { installFunctionConversationNativeNode } from "./function-conversation-native-node"
import { installFunctionConversationNativeTools } from "./function-conversation-native-tools"
import { captureFunctionConversationNativeToolHuman, readFunctionConversationNativeToolHuman } from
  "./function-conversation-native-tool-human"
import { captureFunctionConversationNativeToolHumanPresentation,
  functionConversationNativeHumanProjection, functionConversationNativeHumanPresentationAnchor,
  functionConversationNativeHumanPresentationKind, registerFunctionConversationNativeHumanProtection }
  from "./function-conversation-native-human-presentation"
import { captureNativeMessageForOccurrence, constructCapturedNativeMessage } from "./native-message-capture"
import { serializeFunctionConversationNativeMessage } from "./function-conversation-native-message"
import { FunctionNativeMessageProtector } from "./native-message-protector"
import { FunctionConversationNativeKeeper } from "./function-conversation-native-keeper"
import { createFunctionConversationNativeAdoption } from "./function-conversation-native-adoption"

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
  directory = mkdtempSync(join(tmpdir(), "cmb-tool-human-presentation-"))
  paths.database = join(directory, "actual-app.sqlite")
  await appDb.initializeDatabase()
})
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.restoreAllMocks()
  if (appDb.getDb().inTransaction) appDb.getDb().run("ROLLBACK")
})
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

class LocalModel extends BaseChatModel {
  readonly requests: BaseMessage[][] = []
  constructor(private readonly call: { name: string; id: string }) { super({}) }
  _llmType() { return "actual-tool-human-presentation-provider" }
  bindTools(): this { return this }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.requests.push([...messages])
    const first = this.requests.length === 1
    const message = new AIMessage({ id: randomUUID(), content: first ? "request" : "finished",
      ...(first ? { tool_calls: [{ ...this.call, args: {} }] } : {}) })
    return { generations: [{ message, text: String(message.content) }] }
  }
}

/** Real physical lease, Manager, actual ToolNode and original AppDB writer/receipts. */
async function fixture(protectedValue = false) {
  const root = mkdtempSync(join(directory, "workspace-"))
  const manager = new ModsManager(join(root, "control.sqlite"), () => [], async () => true,
    () => undefined, undefined, { ...DEFAULT_MOD_POLICY, required: false }, () => true)
  manager.configure(root, false, protectedValue)
  const workspace = manager.workspaceKey(root), threadId = randomUUID(), turnId = randomUUID()
  const physicalRunId = randomUUID(), controller = new AbortController()
  const thread = appDb.createThread(threadId, { workspacePath: workspace })
  const database = appDb.getDb(), incarnation = captureThreadIncarnation(thread)
  const action: { callback?: () => void } = {}
  const guard = () => {
    controller.signal.throwIfAborted()
    if (appDb.getDb() !== database || !matchesThreadIncarnation(appDb.getThreadCore(threadId), incarnation))
      throw Error("ACTUAL_TOOL_PRESENTATION_SOURCE_CHANGED")
    action.callback?.()
  }
  const acquired = claimLocalThreadRunLease({ threadId, runId: physicalRunId, owner: "desktop" })
  if (!acquired.acquired) throw Error("ACTUAL_TOOL_PRESENTATION_LEASE_REQUIRED")
  const binding: ModThreadBinding = { workspace, threadId, turnId, signal: controller.signal,
    assertLive: guard }
  const authority = manager.createRuntimeAuthority(binding)
  const unbind = manager.bindThread({ ...binding, runtimeAuthority: authority.authority })
  const store = new FunctionConversationStore(database)
  const coordinator = new FunctionConversationCoordinator(store, {
    authorities: { get: scope => manager.getFunctionConversationAuthority(scope) },
    assertScope: context => {
      guard()
      if (context.workspace !== workspace || context.threadId !== threadId) throw Error("ACTUAL_OWNER_CHANGED")
    }, readCurrentCheckpoint: async (_thread, signal, current) => {
      signal.throwIfAborted(); current(); return null
    }, protect: async (_context, value, signal, current) => {
      signal.throwIfAborted(); current(); return value
    }, apiMessages: projectFunctionSessionApiMessages, changed: () => undefined
  })
  manager.setFunctionConversations(coordinator)
  const closeOwner = coordinator.openConversationOwner({ owner: {}, workspace, threadId,
    signal: controller.signal, readOnly: false, assertCurrent: guard })
  await coordinator.prepareRuntime(workspace, threadId)
  await manager.prepareFunctionConversationRuntime(authority.authority, controller.signal, physicalRunId)
  const runtime = manager.captureFunctionNativeConversationRuntime(authority.authority)
  if (!runtime) throw Error("ACTUAL_TOOL_PRESENTATION_RUNTIME_REQUIRED")
  const protector = new FunctionNativeMessageProtector()
  const keeper = new FunctionConversationNativeKeeper(runtime, protector)
  const saver = new SqlJsSaver(join(root, "actual-checkpoint.sqlite"), undefined, { maxRootCheckpoints: 3 })
  const config = { signal: controller.signal, configurable: { thread_id: threadId, checkpoint_ns: "" } }
  cleanups.push(async () => {
    action.callback = undefined
    keeper.close(); await keeper.whenDrained()
    protector.close(); await protector.whenDrained()
    await saver.close()
    runtime.close(); closeOwner(); coordinator.registry.close(); unbind(); authority.release()
    releaseLocalThreadRunLease(threadId, "desktop", physicalRunId)
    manager.close(); rmSync(root, { recursive: true, force: true })
  })
  return { root, database, threadId, incarnation, guard, action, runtime, store, protector,
    keeper, saver, config, controller }
}

async function run(f: Awaited<ReturnType<typeof fixture>>, side: HumanMessage,
  mode?: "collision" | "clone" | "reentry" | "safe-mutation" | "enhanced") {
  const callId = randomUUID(), effect = vi.fn(), producer = {}
  const paired = new ToolMessage({ content: "paired result", tool_call_id: callId, status: "success" })
  const actualTool = tool(() => {
    effect()
    return new Command({ update: { messages: [paired, side] } })
  }, { name: "original_tool_request_name", schema: z.object({}) })
  const model = new LocalModel({ name: actualTool.name, id: callId })
  const agent = createAgent({ model, tools: [actualTool], checkpointer: f.saver })
  const ledger = installFunctionConversationNativeTools({ graph: agent.graph, runtime: f.runtime })
  cleanups.push(async () => { ledger.close(); await ledger.whenDrained() })
  let saved: Awaited<ReturnType<FunctionConversationNativeKeeper["retain"]>> | undefined
  let uuid = ""
  const control = installFunctionConversationNativeNode({ graph: agent.graph, node: "tools",
    assertCurrent: f.runtime.assertCurrent, finalize: async slot => {
      const view = ledger.read(slot)
      if (view.message instanceof ToolMessage) return view.message
      const token = captureFunctionConversationNativeToolHuman({ receipt: view.receipt,
        slot, runtime: f.runtime })
      const source = readFunctionConversationNativeToolHuman(token)
      uuid = source.uuid
      const input = { source: token, protector: f.protector, producer }
      if (mode === "reentry") f.action.callback = () => {
        f.action.callback = undefined
        expect(() => captureFunctionConversationNativeToolHumanPresentation(input)).toThrow()
      }
      const presentation = captureFunctionConversationNativeToolHumanPresentation(input)
      expect(functionConversationNativeHumanPresentationKind(presentation)).toBe("tool-side")
      expect(functionConversationNativeHumanPresentationAnchor(presentation)).toBeUndefined()
      const variant = functionConversationNativeHumanProjection(presentation)
      expect(functionNativeHumanProjectionKind(variant)).toBe("tool-side")
      expect(functionNativeHumanProjectionFreshColumns(variant, { producer, run: f.runtime.run,
        occurrence: source.occurrence, target: f.runtime.target.ref, threadId: f.threadId,
        uuid: source.uuid }, undefined)?.provider_source_id).toBeNull()
      if (mode === "collision") appDb.upsertThreadMessages(f.threadId, [{ id: source.uuid,
        role: "user", content: "foreign existing user", created_at: new Date(17) }])
      const capture = captureNativeMessageForOccurrence(source.message, source.uuid,
        () => source.signal.throwIfAborted())
      const safeInput = constructCapturedNativeMessage(capture.snapshot.type, capture.snapshot.data)
      const current = () => { functionConversationNativeHumanProjection(presentation) }
      const adoption = createFunctionConversationNativeAdoption({ runtime: f.runtime, store: f.store,
        producer, occurrence: source.occurrence, nativeHumanPresentation: presentation,
        facts: { uuid: source.uuid, role: "user", providerSourceId: source.uuid, providerOccurrence: 1 },
        assertCurrent: current, seal: () => undefined, flush: () => undefined })
      saved = await f.keeper.retain({ producer, occurrence: source.occurrence, message: safeInput,
        door: source.door, origin: source.origin, signal: source.signal, policy: source.policy.value,
        expiresAtNs: source.expiresAtNs, assertCurrent: current, seal: () => undefined,
        captureProjection: adoption.captureProjection, prepare: adoption.prepare,
        retainActualWork: () => () => undefined,
        assertExecutionFacts: (raw, safe) => { expect(safe.id).toBe(raw.id) },
        inheritPresentation: () => undefined, onProtected: result => {
          if (mode === "clone") registerFunctionConversationNativeHumanProtection(presentation, { ...result })
          if (mode === "safe-mutation") {
            const verify = f.protector.assertResultPolicy.bind(f.protector)
            vi.spyOn(f.protector, "assertResultPolicy").mockImplementation((...args) => {
              verify(...args)
              f.action.callback = () => { result.message.content = "late unsafe substitution" }
            })
          }
          registerFunctionConversationNativeHumanProtection(presentation, result)
        } })
      await f.keeper.whenDrained()
      return saved.message
    } })
  cleanups.push(async () => { control.close(); await control.whenDrained() })
  const promise = agent.invoke({ messages: [new HumanMessage("actual user request")] }, f.config)
  void promise.catch(() => undefined)
  return { promise, agent, effect, model, paired, side, uuid: () => uuid, saved: () => saved }
}

describe("real ToolReturn Human presentation and specialized native adoption", () => {
  it.each([[false, undefined], [false, "reused-provider-id"], [true, undefined],
    [true, "reused-provider-id"]] as const)("keeps policy %s and raw id %s in the next natural request",
    async (protectedValue, rawId) => {
      const f = await fixture(protectedValue), side = new HumanMessage({ id: rawId,
        content: "side sk-abcdefghijklmnopqrstuv", name: "raw name is not tool origin" })
      const actual = await run(f, side)
      await actual.promise
      const saved = actual.saved()
      if (!saved) throw Error("ACTUAL_TOOL_SIDE_ACK_REQUIRED")
      const columns = readFunctionConversationProjectionReceipt(f.database, { target: f.runtime.target.ref,
        row: saved.row, threadId: f.threadId, incarnation: f.incarnation, assertCurrent: f.guard })
      const expected = protectedValue ? "side [REDACTED]" : side.content
      expect(saved.message.content).toBe(expected)
      expect(saved.row.origin).toEqual({ kind: "tool", tool: "original_tool_request_name" })
      expect(saved.row.door).toBe("tool-message")
      expect(saved.row.nativePayload).toBe(serializeFunctionConversationNativeMessage(saved.message))
      expect(columns.content_json).toBe(JSON.stringify(expected))
      expect(columns.created_at).toBe(saved.row.createdAt)
      expect(columns.stream_authority).toBe(7)
      expect(columns.recovery_integrity).toBe(1)
      for (const field of ["provider_source_id", "provider_occurrence", "prompt_origin_json",
        "reasoning", "tool_calls_json", "tool_call_id", "name", "status", "is_error", "content_priority",
        "goal_id", "active_window_id", "start_at", "end_at"] as const) expect(columns[field]).toBeNull()
      expect(readFunctionConversationPresentationDisposition(f.database, { target: f.runtime.target.ref,
        row: saved.row, threadId: f.threadId, incarnation: f.incarnation, assertCurrent: f.guard }, columns).kind)
        .toBe("visible")
      expect(actual.effect).toHaveBeenCalledTimes(1)
      expect(actual.model.requests).toHaveLength(2)
      expect(actual.model.requests[1].find(message => message.id === actual.uuid())?.content).toBe(expected)
      const latest = await f.saver.getTuple(f.config)
      if (!latest) throw Error("ACTUAL_NATIVE_CHECKPOINT_REQUIRED")
      const exact = await f.saver.getTuple(latest.config), messages: unknown = exact?.checkpoint.channel_values.messages
      if (!Array.isArray(messages)) throw Error("ACTUAL_CHECKPOINT_MESSAGES_REQUIRED")
      const restored = messages.find((message): message is HumanMessage =>
        HumanMessage.isInstance(message) && message.id === saved.row.uuid)
      expect(restored?.content).toBe(expected)
      expect(restored?.additional_kwargs.function_row).toEqual(saved.message.additional_kwargs.function_row)
      expect(side.id).toBe(rawId)
      expect(side.content).toBe("side sk-abcdefghijklmnopqrstuv")
      expect(f.store.highWater(f.runtime.target.ref)).toBe(1)
    })
  it.each(["collision", "clone", "reentry", "safe-mutation"] as const)(
    "rejects %s without replaying the tool or publishing a canonical row", async mode => {
      const f = await fixture(), actual = await run(f, new HumanMessage("actual original side"), mode)
      await expect(actual.promise).rejects.toThrow()
      f.action.callback = undefined
      expect(actual.effect).toHaveBeenCalledTimes(1)
      expect(actual.model.requests).toHaveLength(1)
      expect(f.store.highWater(f.runtime.target.ref)).toBe(0)
      const uuid = actual.uuid()
      if (!uuid) throw Error("ACTUAL_SOURCE_UUID_REQUIRED")
      const raw = readFunctionConversationRawProjection(f.database, f.threadId, uuid)
      if (mode === "collision") expect(raw?.content_json).toBe(JSON.stringify("foreign existing user"))
      else expect(raw).toBeUndefined()
    })
  it("does not borrow enhanced Input presentation from public Tool-Human metadata", async () => {
    const f = await fixture(), actual = await run(f, new HumanMessage({ content: "hidden source body",
      additional_kwargs: { cmb_coordinator_augmented_user_message: true,
        cmb_visible_user_message: "public visible claim" } }))
    await expect(actual.promise).rejects.toThrow("MODS_CONVERSATION_TOOL_HUMAN_INVALID")
    expect(actual.effect).toHaveBeenCalledTimes(1)
    expect(actual.model.requests).toHaveLength(1)
    expect(f.store.highWater(f.runtime.target.ref)).toBe(0)
  })
})
