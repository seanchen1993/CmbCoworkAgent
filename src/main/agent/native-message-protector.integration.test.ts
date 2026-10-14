import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { ModObject } from "../../shared/mods/types"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { FunctionConversationStore } from "../db/function-conversation-store"
import { createFunctionConversationTranscriptAccess } from "../db/function-conversation-transcript"
import { FunctionConversationRegistry } from "../mods/v2/conversation-registry"
import { ModRuntimeAuthorities } from "../mods/runtime-instance"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { FunctionConversationNativeRetainer, type FunctionNativeRetentionHost }
  from "./function-conversation-native-retainer"
import { FunctionNativeMessageProtector } from "./native-message-protector"
import { captureNativeMessage } from "./native-message-capture"
import { deserializeFunctionConversationNativeMessage } from "./function-conversation-native-message"

const state = vi.hoisted(() => ({ path: "" }))
vi.mock("../storage", () => ({ getDbPath: () => state.path,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
import * as threadDb from "../db"

let directory = ""
const cleanup: Array<() => void | Promise<void>> = []
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-native-protect-before-codec-"))
  state.path = join(directory, "actual.sqlite")
  await threadDb.initializeDatabase()
})
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
afterAll(async () => {
  await threadDb.closeDatabase()
  rmSync(directory, { force: true, recursive: true })
})

/** A foundation native factory, not the application producer doors or official backend proof. */
function nativeFactory(raw: HumanMessage) {
  const threadId = `protected-native:${randomUUID()}`, thread = threadDb.createThread(threadId)
  const database = threadDb.getDb(), store = new FunctionConversationStore(database)
  const registry = new FunctionConversationRegistry(store, new ModRuntimeAuthorities())
  const protector = new FunctionNativeMessageProtector()
  const owner = {}, producer = {}, sealed = {}, controller = new AbortController()
  let live = true, captureDigest: string | undefined, retained = 0, constructed = 0, seals = 0
  const guard = () => {
    if (!live) throw new ModFunctionError("MODS_TEST_SOURCE_EXPIRED")
    if (captureDigest !== undefined && captureNativeMessage(raw).digest !== captureDigest)
      throw new ModFunctionError("MODS_NATIVE_MESSAGE_CHANGED")
  }
  const ref = store.ensureMain({ threadId, workspace: "C:/native-protect-workspace",
    incarnation: captureThreadIncarnation(thread), checkpointNamespace: "" }, guard)
  const target = registry.registerMain(owner, { identity: {}, ref, checkpointThreadId: ref.threadId,
    signal: controller.signal, assertCurrent: guard })
  cleanup.push(async () => {
    live = false
    protector.close()
    await protector.whenDrained()
    registry.retire(target)
  })
  const protect = async (message: BaseMessage): Promise<BaseMessage> => {
    guard()
    const result = await protector.protect(protector.capture({ message, producer,
      signal: controller.signal,
      policy: { identity: owner, protected: true, epoch: 1, digest: "actual-foundation-policy",
        deployment: { version: 1, id: "cmb.baseline/v1", required: true,
          redactLiterals: ["private-literal"], denyTools: [] } },
      assertCurrent: guard,
      retainActualWork() { retained++; return () => { retained-- } },
      assertExecutionFacts(original, safe) {
        if (Object.getPrototypeOf(original) !== Object.getPrototypeOf(safe) || original.id !== safe.id)
          throw new ModFunctionError("MODS_TEST_NATIVE_FACT_CHANGED")
      },
      inheritPresentation() { /* This Human producer has no tool presentation sidecar. */ }
    }))
    protector.assertProtected(result.receipt, result.message, producer)
    return result.message
  }
  const project = (message: BaseMessage): ModObject => {
    if (typeof message.content !== "string") throw new Error("TEST_NON_TEXT_PROJECTION")
    return { type: "user", role: "user", content: [{ type: "text", text: message.content }] }
  }
  const commits = vi.fn(), dispatch = vi.fn<FunctionNativeRetentionHost["dispatch"]>(
    ticket => ticket.core(ticket.input))
  const host: FunctionNativeRetentionHost = {
    captureProjection() { guard(); return sealed },
    protectNative: message => protect(message),
    project,
    apply(message, rendering) {
      const block = Array.isArray(rendering.content) ? rendering.content[0] : undefined
      if (!block || typeof block !== "object" || Array.isArray(block) ||
        block.type !== "text" || typeof block.text !== "string")
        throw new Error("TEST_NON_TEXT_RENDERING")
      const changed = new HumanMessage({ id: message.id, content: block.text,
        additional_kwargs: message.additional_kwargs, response_metadata: message.response_metadata })
      return changed
    },
    dispatch,
    async prepare(candidate, signal, check) {
      signal.throwIfAborted(); check()
      if (candidate.projectionOwner !== sealed) throw new Error("TEST_WRONG_SEAL")
      const access = createFunctionConversationTranscriptAccess((_target, row) => ({
        id: row.uuid, role: "user", content: JSON.stringify(row.message.content),
        created_at: new Date(row.createdAt)
      }))
      return {
        commit(assertCurrent) {
          commits()
          return store.commit(ref, { uuid: candidate.uuid, inputDigest: candidate.inputDigest,
            door: candidate.door, origin: candidate.origin, message: candidate.rendering,
            nativePayload: candidate.nativePayload, orderAnchor: { source: "native-foundation" },
            inbox: false, sdk: false }, assertCurrent, access.write, access.verify)
        },
        read() {
          const row = store.readReceipt(ref, candidate.uuid)
          if (row) access.verify(database, ref, row)
          return row
        }
      }
    }
  }
  return { store, ref, dispatch, commits, retained: () => retained,
    constructed: () => constructed, seals: () => seals,
    async run() {
      // The real integration must install this ordering before its raw codec/Retainer constructor.
      seals++
      captureDigest = captureNativeMessage(raw).digest
      const safe = await protect(raw)
      constructed++
      const retainer = new FunctionConversationNativeRetainer({ message: safe, target, producer,
        signal: controller.signal, door: "prompt", origin: { kind: "composer" },
        assertCurrent: guard, host })
      const first = retainer.retain()
      expect(retainer.retain()).toBe(first)
      return first
    }
  }
}

describe("pre-codec full protector and actual native SQLite foundation", () => {
  it("suppresses binary before raw toJSON and commits one complete protected native row", async () => {
    let rawCalls = 0
    const buffer = Buffer.from("private actual bytes")
    Object.defineProperty(buffer, "toJSON", { value: () => { rawCalls++; return "leaked" } })
    const raw = new HumanMessage({ id: randomUUID(), content: "private-literal body",
      additional_kwargs: { buffer, ordinary: { complete: true, sequence: [1, 2, 3] } } })
    const factory = nativeFactory(raw), result = await factory.run()
    const saved = factory.store.readReceipt(factory.ref, raw.id ?? "")
    expect(saved).toEqual(result.row)
    expect(factory.commits).toHaveBeenCalledTimes(1)
    expect(factory.dispatch).toHaveBeenCalledTimes(1)
    expect(factory.seals()).toBe(1)
    expect(factory.constructed()).toBe(1)
    const actual = deserializeFunctionConversationNativeMessage(result.row.nativePayload)
    expect(actual.content).toBe("[REDACTED] body")
    expect(actual.additional_kwargs).toEqual({ buffer: "[Binary output suppressed]",
      ordinary: { complete: true, sequence: [1, 2, 3] } })
    expect(rawCalls).toBe(0)
    expect(factory.retained()).toBe(0)
  })

  it("never constructs Retainer or commits after rejected raw executable data", async () => {
    let rawCalls = 0
    const raw = new HumanMessage({ id: randomUUID(), content: "body" })
    Object.defineProperty(raw, "toJSON", { value: () => { rawCalls++; return {} } })
    const factory = nativeFactory(raw)
    await expect(factory.run()).rejects.toMatchObject({ code: "MODS_NATIVE_CAPTURE_TYPE" })
    expect(factory.seals()).toBe(1)
    expect(factory.constructed()).toBe(0)
    expect(factory.commits).not.toHaveBeenCalled()
    expect(factory.store.readReceipt(factory.ref, raw.id ?? "")).toBeUndefined()
    expect(rawCalls).toBe(0)
  })

  it("keeps a >1MiB canonical row complete while skipping its bounded public Hook", async () => {
    const body = `${"完整正文".repeat(160_000)} private-literal tail`
    const raw = new HumanMessage({ id: randomUUID(), content: body,
      response_metadata: { provider: "native" } })
    const factory = nativeFactory(raw), result = await factory.run()
    expect(result.publicAvailability).toBe("limit")
    expect(factory.dispatch).not.toHaveBeenCalled()
    expect(factory.commits).toHaveBeenCalledTimes(1)
    const actual = deserializeFunctionConversationNativeMessage(result.row.nativePayload)
    expect(actual.content).toBe(`${"完整正文".repeat(160_000)} [REDACTED] tail`)
    expect(actual.response_metadata).toEqual({ provider: "native" })
    expect(Buffer.byteLength(result.row.nativePayload, "utf8")).toBeGreaterThan(1_048_576)
    expect(factory.retained()).toBe(0)
  })
})
