import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { Session } from "node:inspector"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { claimLocalThreadRunLease, getLocalThreadRunLease,
  releaseLocalThreadRunLease } from "./thread-run-lease"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import { ModsManager, type ModThreadBinding } from "../mods/manager"
import { DEFAULT_MOD_POLICY } from "../mods/policy"
import { FunctionConversationCoordinator } from "../mods/v2/conversation-coordinator"
import { projectFunctionSessionApiMessages } from "../mods/v2/session-api-transcript"
import { FunctionConversationStore, type FunctionConversationRow } from "../db/function-conversation-store"
import { FUNCTION_CONVERSATION_PROJECTION_COLUMNS, readFunctionConversationRawProjection,
  readFunctionConversationProjectionReceipt } from "../db/function-conversation-projection-receipt"
import * as humanProjectionFactory from "../db/function-conversation-native-human-projection"
import { assertFunctionNativeHumanProjectionVariant } from
  "../db/function-conversation-native-human-projection"
import { captureFunctionConversationNativeInput } from "./function-conversation-native-input"
import { readFunctionConversationPresentationDisposition } from
  "../db/function-conversation-presentation-disposition"
import { FunctionNativeMessageProtector, type FunctionProtectedNativeMessage } from "./native-message-protector"
import { serializeFunctionConversationNativeMessage } from "./function-conversation-native-message"
import { captureNativeMessage } from "./native-message-capture"
import { FunctionConversationNativeKeeper } from "./function-conversation-native-keeper"
import { createFunctionConversationNativeAdoption } from "./function-conversation-native-adoption"
import { createFunctionConversationTranscriptAccess } from "../db/function-conversation-transcript"
import { functionConversationCanonicalStamp } from
  "../checkpointer/function-conversation-checkpoint-membership"
import { createNativeConversationStreamProjection, readNativeConversationStreamProjection,
  serializeNativeConversationStreamData, projectNativeConversationMessageForStream } from "./native-conversation-stream-projection"
import { createStreamDataSerializer, createSerializedValuesMessageAccumulator } from
  "../ipc/stream-data-serialization"
import type { FunctionSessionAppendOrigin } from "../../shared/mods/v2/session-append"
import { readFunctionNativeHumanCandidateCurrent, captureFunctionConversationNativeInputPresentation,
  functionConversationNativeHumanProjection, functionConversationHumanTranscriptContent,
  projectFunctionConversationNativeHuman, registerFunctionConversationNativeHumanProtection } from
  "./function-conversation-native-human-presentation"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
vi.mock("electron", () => ({ app: { getPath: () => tmpdir(), getName: () => "test",
  getVersion: () => "0" }, BrowserWindow: { getAllWindows: () => [] }, dialog: {},
  ipcMain: { handle: () => {} } }))
import * as appDb from "../db"

let directory = ""
let profileSession: Session | undefined
const profilePath = process.env.CMB_NATIVE_HUMAN_CPU_PROFILE
const cleanups: Array<() => void | Promise<void>> = []
beforeAll(async () => {
  if (profilePath) {
    const session = new Session()
    session.connect()
    try {
      await new Promise<void>((yes, no) => session.post("Profiler.enable",
        error => error ? no(error) : yes()))
      await new Promise<void>((yes, no) => session.post("Profiler.start",
        error => error ? no(error) : yes()))
      profileSession = session
    } catch (error) { session.disconnect(); throw error }
  }
  directory = mkdtempSync(join(tmpdir(), "cmb-native-human-presentation-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.restoreAllMocks()
  if (appDb.getDb().inTransaction) appDb.getDb().run("ROLLBACK")
})
afterAll(async () => {
  try { await appDb.closeDatabase() }
  finally {
    const session = profileSession
    profileSession = undefined
    try {
      if (session && profilePath) {
        const result = await new Promise<import("node:inspector").Profiler.StopReturnType>(
          (yes, no) => session.post("Profiler.stop", (error, result) =>
            error ? no(error) : yes(result)))
        const path = resolve(profilePath)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, JSON.stringify(result.profile), "utf8")
      }
    } finally { session?.disconnect(); rmSync(directory, { recursive: true, force: true }) }
  }
})

/** Real AppDB/physical lease/Manager policy; no public stamp or JSON mints the source. */
async function fixture(options: { enhanced?: boolean; protected?: boolean; fresh?: boolean;
  large?: boolean; plugin?: boolean; integrity?: "verified" | "unverified";
  intent?: "persisted" | "blank" | "plumbing" } = {}) {
  const root = realpathSync(mkdtempSync(join(directory, "workspace-")))
  const workspace = process.platform === "win32" ? root.toLowerCase() : root
  const threadId = randomUUID(), physicalRunId = randomUUID(), uuid = randomUUID()
  const thread = appDb.createThread(threadId, { workspacePath: workspace })
  const database = appDb.getDb(), incarnation = captureThreadIncarnation(thread)
  const controller = new AbortController()
  const lease = claimLocalThreadRunLease({ threadId, runId: physicalRunId, owner: "desktop" })
  if (!lease.acquired) throw Error("ACTUAL_HUMAN_LEASE_REQUIRED")
  let onGuard: (() => void) | undefined
  const guard = () => {
    controller.signal.throwIfAborted()
    if (appDb.getDb() !== database ||
      !matchesThreadIncarnation(appDb.getThreadCore(threadId), incarnation))
      throw Error("ACTUAL_HUMAN_SOURCE_RETIRED")
    onGuard?.()
  }
  cleanups.push(() => {
    onGuard = undefined
    const current = getLocalThreadRunLease(threadId)
    if (current) releaseLocalThreadRunLease(threadId, current.owner, current.runId)
    rmSync(root, { recursive: true, force: true })
  })
  const original = options.large ? "safe long body ".repeat(90_000) : "original sk-abcdefghijklmnopqrstuv"
  const visible = "visible sk-abcdefghijklmnopqrstuv"
  const message = new HumanMessage({ id: uuid,
    content: options.enhanced ? `${visible}\nprivate engine context` : original,
    additional_kwargs: options.enhanced ? { cmb_coordinator_augmented_user_message: true,
      cmb_visible_user_message: visible } : { actualInput: true } })
  const origin: FunctionSessionAppendOrigin = options.plugin
    ? { kind: "plugin", name: "ActualOriginalPlugin" } : { kind: "composer" }
  const transcriptWrite = { id: uuid, role: "user" as const,
    content: options.intent === "blank" ? "" : options.intent === "plumbing" ? "plumbing"
      : options.enhanced ? visible : original,
    created_at: new Date(100), start_at: new Date(90), end_at: new Date(110),
    goal_id: "original-goal", active_window_id: "original-window", content_priority: 2,
    recovery_integrity: options.integrity ?? "verified" as const }
  const persist = () => appDb.upsertThreadMessages(threadId, [transcriptWrite], options.plugin ? {
    hostPromptOrigin: { messageId: uuid, text: options.enhanced ? visible : original,
      origin: { kind: "plugin", name: "ActualOriginalPlugin" } }
  } : {})
  if (options.intent === "persisted") expect(persist()).toBe(1)
  const source = captureFunctionConversationNativeInput({ message, threadId, physicalRunId,
    workspace, signal: controller.signal, origin, assertCurrent: guard,
    ...(options.intent ? { transcript: { write: transcriptWrite, disposition: options.intent } } : {}),
    ...(options.enhanced ? { visible } : {}) })
  const manager = new ModsManager(join(root, "mods.sqlite"), () => [], async () => true,
    () => undefined, undefined, { ...DEFAULT_MOD_POLICY, required: false }, () => true)
  manager.configure(workspace, false, options.protected ?? true)
  const binding: ModThreadBinding = { workspace, threadId, turnId: randomUUID(),
    signal: controller.signal, assertLive: guard }
  const authority = manager.createRuntimeAuthority(binding)
  const unbind = manager.bindThread({ ...binding, runtimeAuthority: authority.authority })
  const store = new FunctionConversationStore(database)
  const coordinator = new FunctionConversationCoordinator(store, {
    authorities: { get: scope => manager.getFunctionConversationAuthority(scope) },
    assertScope: context => {
      guard()
      if (context.workspace !== workspace || context.threadId !== threadId) throw Error("WRONG_SCOPE")
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
  await manager.prepareFunctionConversationRuntime(authority.authority, controller.signal, physicalRunId)
  const runtime = manager.captureFunctionNativeConversationRuntime(authority.authority)
  if (!runtime) throw Error("ACTUAL_HUMAN_RUNTIME_REQUIRED")
  const policy = runtime.capturePolicy(), protector = new FunctionNativeMessageProtector()
  cleanups.push(() => {
    onGuard = undefined
    runtime.close(); closeOwner(); coordinator.registry.close(); unbind(); authority.release()
    manager.close()
  })
  cleanups.push(async () => { onGuard = undefined; protector.close(); await protector.whenDrained() })
  const producer = {}, occurrence = {}
  const input = { source, runtime, policy, producer, occurrence, protector }
  const presentation = captureFunctionConversationNativeInputPresentation(input)
  const current = () => { functionConversationNativeHumanProjection(presentation) }
  const protect = async (native: BaseMessage = message, actualProducer = producer,
    actualPolicy = policy.value): Promise<FunctionProtectedNativeMessage> => {
    const capture = protector.capture({ message: native, producer: actualProducer,
      policy: actualPolicy, signal: controller.signal, assertCurrent: current,
      retainActualWork: () => () => undefined,
      assertExecutionFacts: (raw, safe) => {
        expect(captureNativeMessage(safe).data.id).toBe(captureNativeMessage(raw).data.id)
      }, inheritPresentation: () => undefined })
    return protector.protect(capture)
  }
  // Unit candidate metadata only. Keeper tests below obtain the row from actual Store COMMIT.
  const row = (native: BaseMessage): FunctionConversationRow => {
    const payload = serializeFunctionConversationNativeMessage(native)
    return { uuid, sequence: 1, receiptId: randomUUID(), branchId: runtime.target.ref.branchId,
      inputDigest: uuid, door: "prompt", origin, message: { type: "user", role: "user",
        content: [{ type: "text", text: "protected public note" }] }, nativePayload: payload,
      orderAnchor: { kind: "native-input" }, createdAt: 123, inbox: false, bytes: payload.length }
  }
  if (!options.fresh && !options.intent) persist()
  const before = readFunctionConversationRawProjection(database, threadId, uuid)
  const retain = async () => {
    const adoption = createFunctionConversationNativeAdoption({ runtime, store, producer, occurrence,
      facts: { uuid, role: "user", providerSourceId: uuid, providerOccurrence: 1 },
      nativeHumanPresentation: presentation, assertCurrent: current, seal: () => undefined,
      flush: () => undefined })
    const keeper = new FunctionConversationNativeKeeper(runtime, protector)
    cleanups.push(async () => { keeper.close(); await keeper.whenDrained() })
    const result = await keeper.retain({ producer, occurrence, message, door: "prompt", origin,
      signal: controller.signal, policy: policy.value, assertCurrent: current,
      seal: () => undefined, captureProjection: adoption.captureProjection, prepare: adoption.prepare,
      retainActualWork: () => () => undefined,
      assertExecutionFacts: (raw, safe) => { expect(safe.id).toBe(raw.id) },
      inheritPresentation: () => undefined,
      onProtected: result => registerFunctionConversationNativeHumanProtection(presentation, result) })
    await keeper.whenDrained()
    const columns = readFunctionConversationProjectionReceipt(database, {
      target: runtime.target.ref, row: result.row, threadId, incarnation, assertCurrent: guard })
    return { result, columns }
  }
  return { source, runtime, policy, protector, producer, occurrence, input, presentation, protect,
    row, retain, message, uuid, database, threadId, store, before, controller, manager,
    transcriptWrite, incarnation, onGuard: (action: (() => void) | undefined) => { onGuard = action } }
}

describe("private protected Human presentation and original native adoption", () => {
  it.each(["blank", "plumbing"] as const)(
    "retains and seals full %s input without producing a visible body", async disposition => {
      const f = await fixture({ intent: disposition, fresh: true, protected: false })
      const saved = await f.retain()
      expect(saved.result.row.nativePayload).toBe(serializeFunctionConversationNativeMessage(f.message))
      expect(saved.columns.content_json).toBe(JSON.stringify(""))
      expect(saved.columns.recovery_integrity).toBe(0)
      expect(saved.columns.content_priority).toBe(2)
      expect(saved.columns.stream_authority).toBe(0)
      expect(saved.columns.created_at).toBe(100)
      expect(saved.columns.goal_id).toBe("original-goal")
      expect(saved.columns.provider_source_id).toBeNull()
      const value = readFunctionConversationPresentationDisposition(f.database, {
        target: f.runtime.target.ref, row: saved.result.row, threadId: f.threadId,
        incarnation: f.incarnation, assertCurrent: () => { throw Error("NO_CALLBACK") }
      }, saved.columns)
      expect(value.kind).toBe(disposition)
      expect(f.database.inTransaction).toBe(false)
      const projection = createNativeConversationStreamProjection({ runtime: f.runtime, store: f.store })
      cleanups.push(() => projection.close())
      projection.register(saved.result.message, saved.result.row)
      expect(projection.omitMessage(saved.result.message)).toBe(true)
      expect(projection.omitMessage(new HumanMessage("unknown ordinary empty claim"))).toBe(false)
      expect(serializeNativeConversationStreamData("messages", [saved.result.message, {}]))
        .toBeUndefined()
      expect(createStreamDataSerializer()("messages", [saved.result.message, {}]).data)
        .toBeUndefined()
      const visibleId = randomUUID(), visible = new AIMessage({ id: visibleId, content: "visible completion" })
      const access = createFunctionConversationTranscriptAccess((_target, row) => ({ id: row.uuid,
        role: "assistant", content: "visible completion", created_at: new Date(row.createdAt) }))
      const row = f.store.commit(f.runtime.target.ref, { uuid: visibleId, inputDigest: visibleId,
        door: "response", origin: { kind: "model", model: "actual-visible-model" },
        message: { type: "assistant", role: "assistant", content: [{ type: "text", text: "visible completion" }] },
        nativePayload: serializeFunctionConversationNativeMessage(visible),
        orderAnchor: { kind: "native-producer" }, sdk: false, inbox: false },
      () => f.runtime.assertCurrent(), access.write, access.verify)
      visible.additional_kwargs = { function_row: functionConversationCanonicalStamp(f.runtime.target.ref, row) }
      projection.register(visible, row)
      const original = [saved.result.message, visible]
      // The old boundary scan constructed both intermediate wires even though hidden values
      // cannot use a cached incremental snapshot. Its final serializer receives the originals.
      let boundaryCalls = 0
      f.onGuard(() => { boundaryCalls++ })
      projectNativeConversationMessageForStream(visible)
      projectNativeConversationMessageForStream(saved.result.message)
      const expectedBoundary = serializeNativeConversationStreamData("values", { messages: original })
      const oldBoundaryCalls = boundaryCalls
      boundaryCalls = 0
      const boundaryFrame = createStreamDataSerializer()("values", {
        messages: [new HumanMessage("previous turn must be omitted"), ...original] })
      expect(boundaryFrame.data).toEqual(expectedBoundary)
      expect(boundaryFrame.valuesMessageIndexOffset).toBe(1)
      expect(boundaryFrame.valuesSnapshotKind).toBe("full")
      expect(boundaryCalls).toBeGreaterThan(0)
      expect(boundaryCalls).toBeLessThan(oldBoundaryCalls)
      f.onGuard(undefined)
      for (const mode of ["values", "updates"] as const) {
        const output = serializeNativeConversationStreamData(mode,
          mode === "values" ? { messages: original } : { tools: { messages: original } }) as {
          messages: unknown[]; tools: { messages: unknown[] }
        }
        const messages = mode === "values" ? output.messages : output.tools.messages
        expect(messages).toHaveLength(1)
        expect(readNativeConversationStreamProjection(messages[0], f.threadId)?.id).toBe(visibleId)
      }
      expect(original).toEqual([saved.result.message, visible])
      expect(saved.result.message.content).toBe(f.message.content)
      const serializer = createStreamDataSerializer(), accumulator = createSerializedValuesMessageAccumulator()
      const appended = new AIMessage({ id: randomUUID(), content: "later visible completion" })
      for (const messages of [original, [...original, appended], [...original, appended]]) {
        const frame = serializer("values", { messages })
        expect(frame.valuesSnapshotKind).toBe("full")
        const complete = accumulator.update(frame)
        expect(complete.messages).toHaveLength(messages.length - 1)
        expect(readNativeConversationStreamProjection(complete.messages[0], f.threadId)?.id).toBe(visibleId)
      }
    })
  it.each(["messages", "values", "updates"] as const)(
    "rejects late ledger removal before returning any hidden %s frame", async mode => {
      const f = await fixture({ intent: "plumbing", fresh: true, protected: false })
      const saved = await f.retain()
      const projection = createNativeConversationStreamProjection({ runtime: f.runtime, store: f.store })
      cleanups.push(() => projection.close())
      projection.register(saved.result.message, saved.result.row)
      let changes = 0
      f.onGuard(() => {
        if (changes) return
        changes++
        f.database.run("DELETE FROM function_conversation_presentation_dispositions WHERE thread_id=? AND uuid=?",
          [f.threadId, f.uuid])
      })
      try {
        const data = mode === "messages" ? [saved.result.message, {}]
          : mode === "values" ? { messages: [saved.result.message] }
          : { tools: { messages: [saved.result.message] } }
        expect(() => serializeNativeConversationStreamData(mode, data)).toThrow()
        expect(changes).toBe(1)
        expect(saved.result.message.content).toBe(f.message.content)
      } finally { f.onGuard(undefined) }
    })

  it.each(["messages", "values", "updates"] as const)(
    "refuses stale blank %s frames after body changes, cancellation or owner close", async mode => {
      const f = await fixture({ intent: "blank", fresh: true, protected: false })
      const saved = await f.retain()
      const projection = createNativeConversationStreamProjection({ runtime: f.runtime, store: f.store })
      cleanups.push(() => projection.close())
      projection.register(saved.result.message, saved.result.row)
      const data = mode === "messages" ? [saved.result.message, {}]
        : mode === "values" ? { messages: [saved.result.message] }
        : { tools: { messages: [saved.result.message] } }
      const original = saved.result.message.content
      saved.result.message.content = "changed full hidden native body"
      expect(() => serializeNativeConversationStreamData(mode, data)).toThrow()
      expect(() => createStreamDataSerializer()(mode, data)).toThrow()
      saved.result.message.content = original
      // A previously rejected frame never grants the next frame stale authority.
      if (mode === "messages") expect(serializeNativeConversationStreamData(mode, data)).toBeUndefined()
      else expect(serializeNativeConversationStreamData(mode, data)).toBeDefined()
      f.controller.abort()
      expect(() => serializeNativeConversationStreamData(mode, data)).toThrow()
      expect(() => createStreamDataSerializer()(mode, data)).toThrow()
      projection.close()
      expect(() => serializeNativeConversationStreamData(mode, data)).toThrow()
    })

  it("uses an actual after-success intent without changing existing source columns", async () => {
    const f = await fixture({ intent: "persisted", protected: false }), saved = await f.retain()
    for (const key of FUNCTION_CONVERSATION_PROJECTION_COLUMNS)
      if (!["content_json", "function_row_json", "recovery_integrity"].includes(key))
        expect(saved.columns[key]).toBe(f.before![key])
    expect(readFunctionConversationPresentationDisposition(f.database, {
      target: f.runtime.target.ref, row: saved.result.row, threadId: f.threadId,
      incarnation: f.incarnation, assertCurrent: () => undefined
    }, saved.columns).kind).toBe("visible")
  })
  it("rejects a changed private original writer instead of choosing a new disposition", async () => {
    const f = await fixture({ intent: "blank", fresh: true, protected: false })
    f.onGuard(() => { f.transcriptWrite.created_at.setTime(200) })
    await expect(f.retain()).rejects.toThrow()
    f.onGuard(undefined)
    expect(f.store.readReceipt(f.runtime.target.ref, f.uuid)).toBeUndefined()
    expect(readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)).toBeUndefined()
  })
  it("does not turn a new no-bubble marker into legacy-visible when its ledger is removed", async () => {
    const f = await fixture({ intent: "blank", fresh: true, protected: false }), saved = await f.retain()
    f.database.run("DELETE FROM function_conversation_presentation_dispositions WHERE thread_id=?",
      [f.threadId])
    expect(() => readFunctionConversationPresentationDisposition(f.database, {
      target: f.runtime.target.ref, row: saved.result.row, threadId: f.threadId,
      incarnation: f.incarnation, assertCurrent: () => undefined
    }, saved.columns)).toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
  })
  it("uses the final protected visible field for enhanced input and keeps full native context", async () => {
    const f = await fixture({ enhanced: true }), safe = await f.protect()
    registerFunctionConversationNativeHumanProtection(f.presentation, safe)
    const write = projectFunctionConversationNativeHuman(f.presentation, safe.message, f.row(safe.message))
    expect(write.content).toBe("visible [REDACTED]")
    expect(safe.message.content).toContain("private engine context")
    expect(write.content).not.toContain("private engine context")
    expect(f.message.content).toContain("sk-abcdefghijklmnopqrstuv")
  })

  it("uses ordinary final safe body only after a real inactive-policy receipt", async () => {
    const f = await fixture({ protected: false }), safe = await f.protect()
    registerFunctionConversationNativeHumanProtection(f.presentation, safe)
    expect(projectFunctionConversationNativeHuman(f.presentation, safe.message, f.row(safe.message)).content)
      .toBe(f.message.content)
  })

  it.each(["token", "message", "result", "producer", "epoch"] as const)(
    "does not let a cloned or foreign %s open protected presentation", async kind => {
      const f = await fixture(), safe = await f.protect()
      if (kind === "producer") {
        const other = await f.protect(f.message, {})
        expect(() => registerFunctionConversationNativeHumanProtection(f.presentation, other)).toThrow()
      } else if (kind === "epoch") {
        const other = await f.protect(f.message, f.producer, { ...f.policy.value,
          epoch: f.policy.value.epoch + 1 })
        expect(() => registerFunctionConversationNativeHumanProtection(f.presentation, other)).toThrow()
      } else if (kind === "result") {
        expect(() => registerFunctionConversationNativeHumanProtection(f.presentation, { ...safe })).toThrow()
      } else {
        registerFunctionConversationNativeHumanProtection(f.presentation, safe)
        const token = kind === "token" ? { ...f.presentation } : f.presentation
        const message = kind === "message" ? new HumanMessage({ id: f.uuid,
          content: safe.message.content }) : safe.message
        expect(() => projectFunctionConversationNativeHuman(token, message, f.row(message))).toThrow()
      }
    })

  it.each(["origin", "door", "uuid", "nativePayload"] as const)(
    "rejects a candidate with changed %s before projection", async key => {
      const f = await fixture(), safe = await f.protect()
      registerFunctionConversationNativeHumanProtection(f.presentation, safe)
      const original = f.row(safe.message)
      const values = { origin: { kind: "plugin", name: "foreign" }, door: "note",
        uuid: randomUUID(), nativePayload: serializeFunctionConversationNativeMessage(f.message) }
      expect(() => projectFunctionConversationNativeHuman(f.presentation, safe.message,
        { ...original, [key]: values[key] })).toThrow()
    })

  it("latches recapture before source callbacks and invalidates the original presentation", async () => {
    const f = await fixture()
    expect(() => captureFunctionConversationNativeInputPresentation(f.input)).toThrow()
    expect(() => functionConversationNativeHumanProjection(f.presentation)).toThrow()
  })

  it.each(["body", "getter"] as const)(
    "rejects late safe %s mutation after genuine result verification with zero publication", async kind => {
      const f = await fixture(), safe = await f.protect()
      let proofFinished = false, behavior = 0
      const verify = f.protector.assertResultPolicy.bind(f.protector)
      vi.spyOn(f.protector, "assertResultPolicy").mockImplementation((...args) => {
        verify(...args)
        proofFinished = true
      })
      f.onGuard(() => {
        if (!proofFinished) return
        if (kind === "body") safe.message.content = "late unsafe replacement"
        else Object.defineProperty(safe.message, "content", { enumerable: true, configurable: true,
          get: () => { behavior++; return "late unsafe replacement" } })
      })
      expect(() => registerFunctionConversationNativeHumanProtection(f.presentation, safe)).toThrow()
      f.onGuard(undefined)
      expect(behavior).toBe(0)
      expect(f.database.exec("SELECT uuid FROM function_conversation_rows WHERE conversation_id=?",
        [f.runtime.target.ref.conversationId])[0]?.values ?? []).toHaveLength(0)
      expect(readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)).toEqual(f.before)
    })

  it.each(["uuid", "branch", "door", "origin", "nativePayload", "type", "isMeta",
    "createdAt", "createdAt-getter", "content", "orderAnchor", "sequence", "receiptId"] as const)(
    "rejects final-callback row %s mutation without selecting or publishing it", async kind => {
      const f = await fixture(), safe = await f.protect()
      registerFunctionConversationNativeHumanProtection(f.presentation, safe)
      const variant = functionConversationNativeHumanProjection(f.presentation)
      const candidate = f.row(safe.message)
      let proofFinished = false, behavior = 0
      const verify = f.protector.assertResultPolicy.bind(f.protector)
      vi.spyOn(f.protector, "assertResultPolicy").mockImplementation((...args) => {
        verify(...args)
        proofFinished = true
      })
      f.onGuard(() => {
        if (!proofFinished) return
        if (kind === "createdAt-getter") {
          Object.defineProperty(candidate, "createdAt", { enumerable: true, configurable: true,
            get: () => { behavior++; return 999 } })
        } else if (kind === "content") {
          Object.defineProperty(candidate.message, "content", { enumerable: true, configurable: true,
            value: [{ type: "text", text: "late changed public body" }] })
        } else if (kind === "type" || kind === "isMeta") {
          Object.defineProperty(candidate.message, kind, { enumerable: true, configurable: true,
            value: kind === "type" ? "system" : true })
        } else {
          const key = kind === "branch" ? "branchId" : kind
          const value = kind === "origin" ? { kind: "plugin", name: "changed" }
            : kind === "orderAnchor" ? { kind: "changed" }
            : kind === "createdAt" || kind === "sequence" ? 999 : `changed-${kind}`
          Object.defineProperty(candidate, key, { enumerable: true, configurable: true, value })
        }
      })
      expect(() => projectFunctionConversationNativeHuman(f.presentation, safe.message, candidate))
        .toThrow()
      f.onGuard(undefined)
      expect(behavior).toBe(0)
      // Even a subsequent valid row cannot borrow selection from the failed synchronous scope.
      expect(() => assertFunctionNativeHumanProjectionVariant(variant, {
        producer: f.producer, run: f.runtime.run, occurrence: f.occurrence,
        target: f.runtime.target.ref, threadId: f.runtime.destination.threadId, uuid: f.uuid
      }, f.row(safe.message))).toThrow("MODS_CONVERSATION_HUMAN_PRESENTATION_INVALID")
      expect(f.database.exec("SELECT uuid FROM function_conversation_rows WHERE conversation_id=?",
        [f.runtime.target.ref.conversationId])[0]?.values ?? []).toHaveLength(0)
      expect(readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)).toEqual(f.before)
    })

  it.each(["project", "register"] as const)(
    "latches same-address %s reentry inside the genuine codec and publishes no selection", async kind => {
      const f = await fixture(), safe = await f.protect()
      registerFunctionConversationNativeHumanProtection(f.presentation, safe)
      const candidate = f.row(safe.message), original = HumanMessage.prototype.toDict
      let reentered = false, nested: unknown
      vi.spyOn(HumanMessage.prototype, "toDict").mockImplementation(function (this: HumanMessage) {
        const stored = original.call(this)
        if (this === safe.message && !reentered) {
          reentered = true
          try {
            if (kind === "project")
              projectFunctionConversationNativeHuman(f.presentation, safe.message, candidate)
            else registerFunctionConversationNativeHumanProtection(f.presentation, safe)
          } catch (error) { nested = error }
        }
        return stored
      })
      expect(() => projectFunctionConversationNativeHuman(f.presentation, safe.message, candidate))
        .toThrow("MODS_CONVERSATION_HUMAN_PRESENTATION_INVALID")
      expect(reentered).toBe(true)
      expect(nested).toBeInstanceOf(Error)
      expect(() => functionConversationNativeHumanProjection(f.presentation)).toThrow()
      expect(f.database.exec("SELECT uuid FROM function_conversation_rows WHERE conversation_id=?",
        [f.runtime.target.ref.conversationId])[0]?.values ?? []).toHaveLength(0)
      expect(readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)).toEqual(f.before)
    })

  it("rejects source mutation during a real source callback and saves no canonical row", async () => {
    const f = await fixture()
    f.onGuard(() => { f.message.content = "synchronous source replacement" })
    await expect(f.retain()).rejects.toThrow()
    f.onGuard(undefined)
    expect(f.database.exec("SELECT uuid FROM function_conversation_rows WHERE conversation_id=?",
      [f.runtime.target.ref.conversationId])[0]?.values ?? []).toHaveLength(0)
    expect(readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)).toEqual(f.before)
  })

  it("runs actual Keeper, protector, Store and index while preserving every original source column", async () => {
    const f = await fixture({ enhanced: true, plugin: true }), saved = await f.retain()
    expect(saved.columns.content_json).toBe(JSON.stringify("visible [REDACTED]"))
    for (const key of FUNCTION_CONVERSATION_PROJECTION_COLUMNS)
      if (!["content_json", "function_row_json", "recovery_integrity"].includes(key))
        expect(saved.columns[key]).toBe(f.before![key])
    expect(saved.columns.content_priority).toBe(f.before!.content_priority)
    expect(saved.columns.stream_authority).toBe(f.before!.stream_authority)
    expect(saved.result.row.nativePayload).toContain("private engine context")
    expect(saved.result.row.nativePayload).not.toContain("sk-abcdefghijklmnopqrstuv")
    expect(appDb.getThreadMessages(f.threadId)[0].content).toBe("visible [REDACTED]")
  })

  it("does not upgrade a genuinely unverified UI baseline after canonical full-body retention", async () => {
    const f = await fixture({ integrity: "unverified", protected: false }), saved = await f.retain()
    expect(saved.columns.recovery_integrity).toBe(0)
    expect(saved.result.row.nativePayload).toBe(serializeFunctionConversationNativeMessage(f.message))
  })

  it("keeps a large full native payload and truthfully downgrades the bounded UI projection", async () => {
    const f = await fixture({ large: true, protected: false }), saved = await f.retain()
    expect(Buffer.byteLength(saved.result.row.nativePayload, "utf8")).toBeGreaterThan(1_048_576)
    expect(saved.columns.recovery_integrity).toBe(0)
    expect(String(saved.columns.content_json).length).toBeLessThan(saved.result.row.nativePayload.length)
  })

  it("requires a separate actual fresh-write intent rather than inventing a user row", async () => {
    const f = await fixture({ fresh: true, protected: false })
    await expect(f.retain()).rejects.toThrow("MODS_CONVERSATION_HUMAN_WRITE_INTENT_REQUIRED")
    expect(readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)).toBeUndefined()
    expect(f.store.readReceipt(f.runtime.target.ref, f.uuid)).toBeUndefined()
  })

  it.each(["nested-getter", "proxy", "sparse", "cycle"] as const)(
    "pure formatting rejects %s without executing behavior or creating provenance", kind => {
      let calls = 0
      const block = { type: "text", text: "visible" }
      let content: unknown = [block]
      if (kind === "nested-getter") Object.defineProperty(block, "extra", {
        enumerable: true, get: () => { calls++; return "raw" } })
      else if (kind === "proxy") content = new Proxy(content as object, {
        ownKeys: () => { calls++; return [] } })
      else if (kind === "sparse") content = new Array(2)
      else Object.defineProperty(block, "extra", { enumerable: true, value: block })
      expect(() => functionConversationHumanTranscriptContent(content)).toThrow()
      expect(calls).toBe(0)
    })

  it("converts data-only blocks into an independent safe copy", () => {
    const original = [{ type: "text", text: "safe", extra: { stable: true } }]
    const content = functionConversationHumanTranscriptContent(original)
    expect(content).toEqual(original)
    expect(content).not.toBe(original)
    if (!Array.isArray(content)) throw Error("CONTENT_ARRAY_REQUIRED")
    expect(content[0]).not.toBe(original[0])
  })

  it("does not pretend an unknown block is a supported visible UI shape", () => {
    expect(() => functionConversationHumanTranscriptContent([{ type: "unknown", raw: "secret" }]))
      .toThrow()
  })
})


describe("actual human candidate current pairing", () => {
  it("does not surround an already fully guarded real candidate with duplicate input checks", async () => {
    const f = await fixture({ protected: false })
    const result = await f.protect()
    registerFunctionConversationNativeHumanProtection(f.presentation, result)
    const row = f.row(result.message)
    projectFunctionConversationNativeHuman(f.presentation, result.message, row)
    const variant = functionConversationNativeHumanProjection(f.presentation)
    const context = { producer: f.producer, run: f.runtime.run, occurrence: f.occurrence,
      target: f.runtime.target.ref, threadId: f.threadId, uuid: f.uuid }
    let calls = 0
    f.onGuard(() => { calls++ })
    assertFunctionNativeHumanProjectionVariant(variant, context)
    const twoOriginalChecks = calls
    calls = 0
    projectFunctionConversationNativeHuman(f.presentation, result.message, row)
    const originalCandidateChecks = calls
    calls = 0
    assertFunctionNativeHumanProjectionVariant(variant, context, row)
    expect(twoOriginalChecks).toBeGreaterThan(0)
    expect(originalCandidateChecks).toBeGreaterThan(twoOriginalChecks)
    expect(calls).toBe(originalCandidateChecks)
  })
})


describe("human candidate pairing boundaries", () => {
  it("rejects copied context and callback wrappers without changing the generic path", async () => {
    const capture = humanProjectionFactory.captureFunctionNativeHumanProjectionVariant
    let original: Parameters<typeof capture>[0] | undefined
    vi.spyOn(humanProjectionFactory, "captureFunctionNativeHumanProjectionVariant")
      .mockImplementation(input => { original = input; return capture(input) })
    const f = await fixture({ protected: false })
    if (!original) throw Error("ACTUAL_PRESENTATION_FACTORY_REQUIRED")
    const input = original
    expect(readFunctionNativeHumanCandidateCurrent(input.assertCandidate, input.assertCurrent, input)).toBe(true)
    for (const key of ["producer", "run", "occurrence", "target"] as const)
      expect(readFunctionNativeHumanCandidateCurrent(input.assertCandidate, input.assertCurrent,
        { ...input, [key]: {} })).toBe(false)
    expect(readFunctionNativeHumanCandidateCurrent(row => input.assertCandidate(row), input.assertCurrent, input)).toBe(false)
    expect(readFunctionNativeHumanCandidateCurrent(input.assertCandidate, () => input.assertCurrent(), input)).toBe(false)
    const result = await f.protect()
    registerFunctionConversationNativeHumanProtection(f.presentation, result)
    const row = f.row(result.message)
    projectFunctionConversationNativeHuman(f.presentation, result.message, row)
    const forged = capture(Object.assign({ ...input,
      assertCandidate: (value: FunctionConversationRow) => input.assertCandidate(value) },
      { pairedCandidate: true }))
    let calls = 0
    f.onGuard(() => { calls++ })
    input.assertCandidate(row)
    const candidateChecks = calls
    calls = 0
    input.assertCurrent(); input.assertCurrent()
    const surroundingChecks = calls
    calls = 0
    assertFunctionNativeHumanProjectionVariant(forged, input, row)
    expect(calls).toBe(candidateChecks + surroundingChecks)
  })

  it.each(["source", "safe-result", "row", "row-getter", "policy", "reentry"] as const)(
    "rejects the last original callback's %s change", async change => {
      const f = await fixture({ protected: false })
      const result = await f.protect()
      registerFunctionConversationNativeHumanProtection(f.presentation, result)
      const row = f.row(result.message)
      projectFunctionConversationNativeHuman(f.presentation, result.message, row)
      const variant = functionConversationNativeHumanProjection(f.presentation)
      const context = { producer: f.producer, run: f.runtime.run, occurrence: f.occurrence,
        target: f.runtime.target.ref, threadId: f.threadId, uuid: f.uuid }
      let count = 0, getters = 0
      f.onGuard(() => { count++ })
      assertFunctionNativeHumanProjectionVariant(variant, context, row)
      const last = count
      count = 0
      let fired = false
      f.onGuard(() => {
        if (++count !== last) return
        fired = true
        f.onGuard(undefined)
        if (change === "source") f.message.content = "changed original source"
        else if (change === "safe-result") result.message.content = "changed safe result"
        else if (change === "row") Object.defineProperty(row, "message", {
          enumerable: true, configurable: true, writable: true, value: { type: "user", changed: true } })
        else if (change === "row-getter") Object.defineProperty(row, "createdAt", {
          enumerable: true, configurable: true, get() { getters++; return 123 } })
        else if (change === "policy") f.manager.configure(f.runtime.target.ref.workspace, false, true)
        else {
          try { assertFunctionNativeHumanProjectionVariant(variant, context, row) } catch { /* poison survives */ }
        }
      })
      expect(() => assertFunctionNativeHumanProjectionVariant(variant, context, row)).toThrow()
      expect(fired).toBe(true)
      expect(getters).toBe(0)
      expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(0)
    })
})
