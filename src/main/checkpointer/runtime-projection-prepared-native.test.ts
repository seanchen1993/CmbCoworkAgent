import { createHash } from "node:crypto"
import { mkdtemp, rm, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DatabaseSync, StatementSync } from "node:sqlite"
import { HumanMessage, AIMessage, AIMessageChunk, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { afterEach, expect, it, vi } from "vitest"
import { createDefaultCheckpointMetadataCodec } from "./checkpoint-metadata-codec"
import { readCheckpointDatabaseFileIdentity } from "./checkpoint-database-identity"
import { readPreparedNativeDataFacts } from "./runtime-projection-store"
import {
  createNativeCheckpointMessageDigest,
  preparedNativeSnapshotRowDigest,
  preparedNativeSourcePlanDigest
} from "./function-conversation-canonical-display-worker"
import { serializeFunctionConversationNativeMessage } from "../agent/function-conversation-native-message"
import {
  readFunctionConversationTranscriptStamp,
  sameFunctionConversationTranscriptStamp
} from "../../shared/mods/v2/conversation-transcript"
import { CHECKPOINT_RUNTIME_PROJECTION_CANCELLED } from "./runtime-projection-protocol"
import type {
  PreparedNativeDataRequest,
  PreparedNativeDataSource
} from "./runtime-projection-protocol"
import { LegacyTranscriptWorkerDriver } from "./legacy-transcript-worker-driver"
import {
  LEGACY_TRANSCRIPT_WRITE_PROTOCOL,
  type LegacyTranscriptWriteMessage
} from "./legacy-transcript-write-protocol"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const state = {
  version: 1 as const,
  logicalSessionId: "logical",
  conversationId: "conversation",
  branchId: "branch",
  frontier: 1
}
const stamp = {
  conversationId: "conversation",
  branchId: "branch",
  uuid: "note",
  sequence: 1,
  door: "note" as const,
  messageType: "user" as const,
  isMeta: true as const,
  origin: { kind: "plugin" as const, name: "original", asUser: true as const }
}
const serde = createDefaultCheckpointMetadataCodec()
async function encoded(value: unknown) {
  const [type, bytes] = await serde.dumpsTyped(value)
  return { type, bytes }
}
async function fixture(
  messages: BaseMessage[] = [
    new HumanMessage({
      id: "note",
      content: "original",
      additional_kwargs: { function_row: stamp }
    }),
    new AIMessage("ordinary")
  ]
) {
  const root = await mkdtemp(join(tmpdir(), "prepared-native-worker-")),
    path = join(root, "cp.sqlite")
  const database = new DatabaseSync(path)
  database.exec(`CREATE TABLE checkpoint_message_snapshots(thread_id TEXT,checkpoint_ns TEXT,
    checkpoint_id TEXT,parent_checkpoint_id TEXT,prefix_length INTEGER,message_count INTEGER,
    generation TEXT,type TEXT,suffix BLOB,PRIMARY KEY(thread_id,checkpoint_ns,checkpoint_id))`)
  cleanups.push(async () => {
    database.close()
    await rm(root, { recursive: true, force: true })
  })
  const request: PreparedNativeDataRequest = {
    type: "prepared-native-data",
    databasePath: path,
    requestId: 1,
    threadId: "physical",
    checkpointNs: "native",
    checkpointId: "point",
    cancellationBuffer: new SharedArrayBuffer(4)
  }
  const source: PreparedNativeDataSource = {
    file: await readCheckpointDatabaseFileIdentity(path),
    parentCheckpointId: "ordinary-parent",
    checkpoint: await encoded({
      id: "point",
      ts: "timestamp",
      channel_values: {
        cmbFunctionConversation: state,
        messages: { __cmb_sqljs_external_messages_v1: true, messageCount: messages.length }
      }
    }),
    metadata: await encoded({ source: "loop", step: 1 }),
    messages: {
      ...(await encoded(messages)),
      parentCheckpointId: null,
      prefixLength: 0,
      messageCount: messages.length,
      expectedParentCount: null,
      expectedParentGeneration: null
    }
  }
  return { root, path, request, source, database, messages }
}
function originalNativeDigest(messages: BaseMessage[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        messages.map((message) =>
          readFunctionConversationTranscriptStamp(message)
            ? serializeFunctionConversationNativeMessage(message)
            : JSON.stringify(message.toDict())
        )
      )
    )
    .digest("hex")
}

it("matches actual default-codec storage and old digest while returning full stamps and no body", async () => {
  const f = await fixture(),
    before = f.database.prepare("SELECT total_changes() AS n").get()
  const facts = await readPreparedNativeDataFacts(f.request, f.source)
  expect(facts.nativeSnapshotDigest).toBe(originalNativeDigest(f.messages))
  expect(facts.state).toEqual(state)
  expect(facts.nativeMessageCount).toBe(2)
  expect(facts.stamped).toHaveLength(1)
  expect(facts.stamped[0].ordinal).toBe(0)
  expect(sameFunctionConversationTranscriptStamp(facts.stamped[0].stamp, stamp)).toBe(true)
  expect(facts.sealedPlanDigest).toBe(preparedNativeSourcePlanDigest(f.source))
  expect(JSON.stringify(facts)).not.toContain('"content"')
  expect(f.database.prepare("SELECT total_changes() AS n").get()).toEqual(before)
})

it("uses exact retained prefix, full raw seal and suffix ordinal ordering", async () => {
  const f = await fixture(),
    bytes = await encoded(f.messages.slice(0, 1))
  f.database
    .prepare("INSERT INTO checkpoint_message_snapshots VALUES (?,?,?,?,?,?,?,?,?)")
    .run("physical", "native", "retained", null, 0, 1, "generation", bytes.type, bytes.bytes)
  const source: PreparedNativeDataSource = {
    ...f.source,
    messages: {
      ...(await encoded(f.messages.slice(1))),
      parentCheckpointId: "retained",
      prefixLength: 1,
      messageCount: 2,
      expectedParentCount: 1,
      expectedParentGeneration: "generation"
    }
  }
  const facts = await readPreparedNativeDataFacts(f.request, source)
  expect(facts.nativeSnapshotDigest).toBe(originalNativeDigest(f.messages))
  expect(facts.stamped[0].ordinal).toBe(0)
  expect(facts.chainSeal).toEqual([
    {
      checkpointId: "retained",
      parentCheckpointId: null,
      prefixLength: 0,
      messageCount: 1,
      generation: "generation",
      type: bytes.type,
      rawDigest: preparedNativeSnapshotRowDigest({
        checkpointId: "retained",
        parentCheckpointId: null,
        prefixLength: 0,
        messageCount: 1,
        generation: "generation",
        type: bytes.type,
        bytes: bytes.bytes
      })
    }
  ])
  f.database.prepare("UPDATE checkpoint_message_snapshots SET generation='other'").run()
  await expect(readPreparedNativeDataFacts(f.request, source)).rejects.toThrow(
    "PREPARED_NATIVE_PREFIX_CHANGED"
  )
})

it("separately preserves reordered provenance that native payload serialization strips", async () => {
  const reordered = {
    origin: { asUser: true as const, name: "original", kind: "plugin" as const },
    isMeta: true as const,
    messageType: "user" as const,
    door: "note" as const,
    sequence: 1,
    uuid: "note",
    branchId: "branch",
    conversationId: "conversation"
  }
  const f = await fixture([
    new HumanMessage({
      id: "note",
      content: "same",
      additional_kwargs: { function_row: reordered }
    })
  ])
  const facts = await readPreparedNativeDataFacts(f.request, f.source)
  expect(sameFunctionConversationTranscriptStamp(facts.stamped[0].stamp, stamp)).toBe(true)
  const changed = new HumanMessage({
    id: "note",
    content: "same",
    additional_kwargs: {
      function_row: { ...reordered, branchId: "other", sequence: 2 }
    }
  })
  const other = await fixture([changed]),
    next = await readPreparedNativeDataFacts(other.request, other.source)
  expect(next.nativeSnapshotDigest).toBe(facts.nativeSnapshotDigest)
  expect(
    sameFunctionConversationTranscriptStamp(next.stamped[0].stamp, facts.stamped[0].stamp)
  ).toBe(false)
})

it("decodes the five original builtin forms through the actual codec", async () => {
  const message = new HumanMessage({
    content: "unicode \ud800 😀",
    additional_kwargs: {
      values: {
        set: new Set([1, "one"]),
        map: new Map([["key", 2]]),
        regexp: /original/gi,
        error: new Error("original"),
        bytes: new Uint8Array([0, 255])
      }
    }
  })
  const f = await fixture([message]),
    facts = await readPreparedNativeDataFacts(f.request, f.source)
  expect(facts.nativeSnapshotDigest).toBe(originalNativeDigest(f.messages))
  expect(facts.stamped).toEqual([])
})

for (const bad of [
  { lc: 2, type: "constructor", id: ["Uint8Array"], method: "of", args: [[1]], kwargs: {} },
  { lc: 2, type: "constructor", id: ["Unknown"], method: null, args: [], kwargs: {} },
  { lc: 1, type: "constructor", id: ["langchain_core", "prompts", "PromptTemplate"], kwargs: {} },
  { __lc_escaped__: { lc: 1, type: "secret", id: ["NEVER_READ_ENV"] } },
  JSON.parse('{"__proto__":{"lc":2,"type":"constructor"}}') as unknown
])
  it("rejects an unsupported raw constructor/method/escaped source without fallback", async () => {
    const f = await fixture(),
      source = { ...f.source, metadata: { type: "json", bytes: JSON.stringify(bad) } }
    await expect(readPreparedNativeDataFacts(f.request, source)).rejects.toThrow(
      "PREPARED_NATIVE_CODEC_UNSUPPORTED"
    )
  })

it("rejects invalid stamp, wrong point, missing chain, cancellation and original-file replacement", async () => {
  const f = await fixture([
    new HumanMessage({ content: "invalid", additional_kwargs: { function_row_invalid: false } })
  ])
  await expect(readPreparedNativeDataFacts(f.request, f.source)).rejects.toThrow(
    "PREPARED_NATIVE_CODEC_UNSUPPORTED"
  )
  const valid = await fixture()
  await expect(
    readPreparedNativeDataFacts({ ...valid.request, checkpointId: "wrong" }, valid.source)
  ).rejects.toThrow("PREPARED_NATIVE_SOURCE_CHANGED")
  const missing = {
    ...valid.source,
    messages: {
      ...valid.source.messages!,
      parentCheckpointId: "missing",
      prefixLength: 1,
      expectedParentCount: 1,
      expectedParentGeneration: "generation"
    }
  }
  await expect(readPreparedNativeDataFacts(valid.request, missing)).rejects.toThrow(
    "PREPARED_NATIVE_PREFIX_CHANGED"
  )
  Atomics.store(new Int32Array(valid.request.cancellationBuffer), 0, 1)
  await expect(readPreparedNativeDataFacts(valid.request, valid.source)).rejects.toMatchObject({
    name: "CHECKPOINT_RUNTIME_PROJECTION_CANCELLED"
  })
  const swapped = await fixture()
  swapped.database.close()
  // Remove its normal cleanup now that its live handle was explicitly closed for the rename.
  cleanups.pop()
  cleanups.push(() => rm(swapped.root, { recursive: true, force: true }))
  await rename(swapped.path, join(swapped.root, "old.sqlite"))
  await writeFile(swapped.path, "new actual inode")
  await expect(readPreparedNativeDataFacts(swapped.request, swapped.source)).rejects.toThrow(
    "SQLJS_SAVER_DATABASE_IDENTITY_CHANGED"
  )
})

it("retains a legal 5MiB single native message without truncation", async () => {
  const f = await fixture([new HumanMessage("x".repeat(5 * 1024 * 1024))])
  const facts = await readPreparedNativeDataFacts(f.request, f.source)
  expect(facts.nativeSnapshotDigest).toBe(originalNativeDigest(f.messages))
  expect(facts.nativeMessageCount).toBe(1)
})

it("shares one full-body lane, pulls only active metadata and never pulls a canceled queued body", async () => {
  const f = await fixture(),
    writes: LegacyTranscriptWriteMessage[] = [],
    pulls: number[] = []
  const driver = new LegacyTranscriptWorkerDriver(
    (wire) => writes.push(wire),
    (wire) => pulls.push(wire.requestId)
  )
  const legacyCancellation = new SharedArrayBuffer(4)
  const legacy = driver
    .enqueue({
      requestId: 90,
      databasePath: f.path,
      threadId: "physical",
      checkpointNs: "native",
      cancellationBuffer: legacyCancellation,
      legacyWriter: {
        protocol: LEGACY_TRANSCRIPT_WRITE_PROTOCOL,
        nonce: "original",
        requestId: 90,
        workerGeneration: 1
      }
    })
    .catch((error) => error as Error)
  const first = driver.enqueuePrepared(f.request),
    secondRequest = { ...f.request, requestId: 2, cancellationBuffer: new SharedArrayBuffer(4) }
  void first.catch(() => undefined)
  const second = driver.enqueuePrepared(secondRequest).catch((error) => error as Error)
  cleanups.push(async () => {
    await driver.shutdown()
    await Promise.allSettled([legacy, first, second])
  })
  expect(writes).toHaveLength(1)
  expect(pulls).toEqual([])
  Atomics.store(new Int32Array(legacyCancellation), 0, 1)
  Atomics.store(new Int32Array(secondRequest.cancellationBuffer), 0, 1)
  expect(
    driver.acceptAcknowledgement({
      ...writes[0],
      type: "legacy-transcript-write-ack",
      ok: true,
      result: { ordinary: true, marker: null }
    })
  ).toBe(true)
  expect(await legacy).toMatchObject({ name: "CHECKPOINT_RUNTIME_PROJECTION_CANCELLED" })
  await Promise.resolve()
  expect(pulls).toEqual([1])
  expect(
    driver.acceptPreparedSource({
      type: "prepared-native-source-response",
      requestId: 2,
      ok: true,
      source: f.source
    })
  ).toBe(false)
  expect(
    driver.acceptPreparedSource({
      type: "prepared-native-source-response",
      requestId: 1,
      ok: true,
      source: f.source
    })
  ).toBe(true)
  expect(
    driver.acceptPreparedSource({
      type: "prepared-native-source-response",
      requestId: 1,
      ok: true,
      source: f.source
    })
  ).toBe(false)
  expect((await first).nativeMessageCount).toBe(2)
  expect(await second).toMatchObject({ name: "CHECKPOINT_RUNTIME_PROJECTION_CANCELLED" })
  expect(pulls).toEqual([1])
})

it("streaming exact digest preserves empty and ordered arbitrary payload strings", () => {
  for (const values of [[], ["one"], ["\ud800", "😀", "\n", "same", "same"]]) {
    const digest = createNativeCheckpointMessageDigest()
    for (const value of values) digest.append(value)
    expect(digest.finish()).toBe(createHash("sha256").update(JSON.stringify(values)).digest("hex"))
    expect(() => digest.finish()).toThrow()
  }
})

it("uses captured stringify and actual Hash methods for shared Main/Worker digest calls", async () => {
  const f = await fixture()
  const expected = preparedNativeSourcePlanDigest(f.source)
  const prototype = Object.getPrototypeOf(createHash("sha256")) as {
    update: (...args: unknown[]) => unknown
    digest: (...args: unknown[]) => unknown
  }
  const stringify = vi.spyOn(JSON, "stringify").mockImplementation(() => "poison")
  const update = vi.spyOn(prototype, "update").mockImplementation(() => {
    throw Error("poison update")
  })
  const digest = vi.spyOn(prototype, "digest").mockImplementation(() => {
    throw Error("poison digest")
  })
  let actual: string
  try {
    actual = preparedNativeSourcePlanDigest(f.source)
  } finally {
    digest.mockRestore()
    update.mockRestore()
    stringify.mockRestore()
  }
  expect(actual).toBe(expected)
})

it("bounds the shared full-body queue and drains canceled metadata without any body pull", async () => {
  const f = await fixture(),
    pulls: number[] = []
  const driver = new LegacyTranscriptWorkerDriver(
    () => {
      throw Error("unexpected write")
    },
    (request) => pulls.push(request.requestId)
  )
  const requests = Array.from({ length: 128 }, (_, index) =>
    driver
      .enqueuePrepared({
        ...f.request,
        requestId: index + 1,
        cancellationBuffer: new SharedArrayBuffer(4)
      })
      .catch((error) => error as Error)
  )
  cleanups.push(async () => {
    await driver.shutdown()
    await Promise.allSettled(requests)
  })
  await expect(driver.enqueuePrepared({ ...f.request, requestId: 129 })).rejects.toThrow(
    "CHECKPOINT_QUERY_CAPACITY"
  )
  expect(pulls).toEqual([1])
  await driver.shutdown()
  const results = await Promise.all(requests)
  expect(results).toHaveLength(128)
  expect(
    results.every(
      (result) =>
        result instanceof Error && result.name === "CHECKPOINT_RUNTIME_PROJECTION_CANCELLED"
    )
  ).toBe(true)
  expect(pulls).toEqual([1])
})

it("does not dispatch inherited toJSON while hashing private fixed storage tuples", async () => {
  const f = await fixture(),
    expected = preparedNativeSourcePlanDigest(f.source)
  const originalObject = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON")
  const originalArray = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON")
  let calls = 0,
    actual: string
  try {
    for (const target of [Object.prototype, Array.prototype])
      Object.defineProperty(target, "toJSON", {
        configurable: true,
        value: () => {
          calls++
          return "poison"
        }
      })
    actual = preparedNativeSourcePlanDigest(f.source)
  } finally {
    if (originalObject) Object.defineProperty(Object.prototype, "toJSON", originalObject)
    else Reflect.deleteProperty(Object.prototype, "toJSON")
    if (originalArray) Object.defineProperty(Array.prototype, "toJSON", originalArray)
    else Reflect.deleteProperty(Array.prototype, "toJSON")
  }
  expect(actual).toBe(expected)
  expect(calls).toBe(0)
})

it("executes the immutable preflight text even if its original typed view changes", async () => {
  const f = await fixture()
  const view = f.source.messages!.bytes
  if (typeof view === "string") throw Error("NOT_MET: default codec did not produce typed storage")
  const before = new TextDecoder().decode(view)
  expect(before.indexOf('"HumanMessage"')).toBeGreaterThanOrEqual(0)
  expect(before.indexOf('"HumanMessage"')).toBe(before.lastIndexOf('"HumanMessage"'))
  const replacement = new TextEncoder().encode(before.replace('"HumanMessage"', '"UnsafeSecret"'))
  expect(replacement.byteLength).toBe(view.byteLength)
  const seal = preparedNativeSourcePlanDigest(f.source),
    original = TextDecoder.prototype.decode
  let changed = false
  const decoder = vi.spyOn(TextDecoder.prototype, "decode").mockImplementation(function (
    this: TextDecoder,
    ...args: Parameters<TextDecoder["decode"]>
  ) {
    const text = Reflect.apply(original, this, args) as string
    if (args[0] === view && !changed) {
      view.set(replacement)
      changed = true
    }
    return text
  })
  let result: Awaited<ReturnType<typeof readPreparedNativeDataFacts>>
  try {
    result = await readPreparedNativeDataFacts(f.request, f.source)
  } finally {
    decoder.mockRestore()
  }
  expect(changed).toBe(true)
  expect(result.nativeSnapshotDigest).toBe(originalNativeDigest(f.messages))
  // The changed source seal is still rejected by the Main private plan comparison; this is data only.
  expect(result.sealedPlanDigest).not.toBe(seal)
})

it("rejects shared-backed serialized storage before any decoder executes", async () => {
  const f = await fixture(),
    bytes = f.source.messages!.bytes
  if (typeof bytes === "string") throw Error("NOT_MET: default codec did not produce typed storage")
  const shared = new Uint8Array(new SharedArrayBuffer(bytes.byteLength))
  shared.set(bytes)
  let bufferGetters = 0
  Object.defineProperty(shared, "buffer", {
    get: () => {
      bufferGetters++
      return new ArrayBuffer(bytes.byteLength)
    }
  })
  const source = { ...f.source, messages: { ...f.source.messages!, bytes: shared } }
  const original = Object.getPrototypeOf(serde) as typeof serde
  const decode = vi.spyOn(original, "loadsTyped")
  try {
    // This is the Main pre-dispatch seal, not a direct-reader admission capability.
    expect(() => preparedNativeSourcePlanDigest(source)).toThrow("PREPARED_NATIVE_CODEC_UNSUPPORTED")
    expect(decode).not.toHaveBeenCalled()
    expect(bufferGetters).toBe(0)
  } finally {
    decode.mockRestore()
  }
})

async function preparedSourceWithBody(f: Awaited<ReturnType<typeof fixture>>, bytes: string | Uint8Array,
  count: number): Promise<PreparedNativeDataSource> {
  const checkpoint = await serde.loadsTyped(f.source.checkpoint.type, f.source.checkpoint.bytes) as {
    channel_values: { messages: { messageCount: number } }
  }
  checkpoint.channel_values.messages.messageCount = count
  return { ...f.source, checkpoint: await encoded(checkpoint), messages: { ...f.source.messages!,
    type: "json", bytes, messageCount: count } }
}

it("matches the original whole-array codec for five classes, escaped LC, numeric tokens and Unicode", async () => {
  const f = await fixture([
    new HumanMessage({ id: "safe", content: "emoji 😀 lone \ud800", additional_kwargs: {
      literal: { lc: 9, value: "user data" }, nativeLooking: { lc: 1, type: "constructor",
        id: ["langchain_core", "messages", "HumanMessage"], kwargs: { content: "nested safe" } } } }),
    new AIMessage({ id: "ai", content: "answer" }),
    new AIMessageChunk({ id: "chunk", content: "partial" }),
    new SystemMessage({ id: "system", content: "instruction" }),
    new ToolMessage({ id: "tool", content: "tool output", tool_call_id: "actual-tool" })
  ])
  const original = await serde.loadsTyped(f.source.messages!.type, f.source.messages!.bytes) as BaseMessage[]
  const actual = await readPreparedNativeDataFacts(f.request, f.source)
  expect(actual.nativeMessageCount).toBe(5)
  expect(actual.nativeSnapshotDigest).toBe(originalNativeDigest(original))
  expect(actual.stamped).toEqual([])
  const raw = `[{"lc":1,"type":"constructor","id":["langchain_core","messages","HumanMessage"],
    "kwargs":{"id":"numeric","content":"first","content":"last","additional_kwargs":{
      "large":9223372036854775807,"negative":-0,"n":1e400,"nul":"\\u0000","lone":"\\ud800"}}}]`
  const source = await preparedSourceWithBody(f, raw, 1)
  const oracle = await serde.loadsTyped("json", raw) as BaseMessage[]
  expect((await readPreparedNativeDataFacts(f.request, source)).nativeSnapshotDigest)
    .toBe(originalNativeDigest(oracle))
})

it("keeps metadata-only chain headers, exact nearest-first seals and a truncated inert integer tail", async () => {
  const f = await fixture(), base = await encoded(f.messages)
  const text = (typeof base.bytes === "string" ? base.bytes : new TextDecoder().decode(base.bytes))
    .replace(/]$/, ",9223372036854775807]")
  f.database.prepare("INSERT INTO checkpoint_message_snapshots VALUES (?,?,?,?,?,?,?,?,?)")
    .run("physical", "native", "base", null, 0, 3, "base-gen", "json", text)
  const middle = await encoded([new AIMessage("middle discarded")])
  f.database.prepare("INSERT INTO checkpoint_message_snapshots VALUES (?,?,?,?,?,?,?,?,?)")
    .run("physical", "native", "middle", "base", 2, 3, "middle-gen", middle.type, middle.bytes)
  const final = new AIMessage("final")
  const source: PreparedNativeDataSource = { ...f.source, messages: { ...(await encoded([final])),
    parentCheckpointId: "middle", prefixLength: 1, messageCount: 2, expectedParentCount: 3,
    expectedParentGeneration: "middle-gen" } }
  const originalPrepare = DatabaseSync.prototype.prepare, sql: string[] = []
  const observe = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync, statement: string
  ) { sql.push(statement); return Reflect.apply(originalPrepare, this, [statement]) })
  let facts: Awaited<ReturnType<typeof readPreparedNativeDataFacts>>
  try { facts = await readPreparedNativeDataFacts(f.request, source) } finally { observe.mockRestore() }
  expect(facts.nativeSnapshotDigest).toBe(originalNativeDigest([f.messages[0], final]))
  expect(facts.stamped.map(value => value.ordinal)).toEqual([0])
  expect(facts.chainSeal.map(value => value.checkpointId)).toEqual(["middle", "base"])
  expect(facts.chainSeal[0].rawDigest).toBe(preparedNativeSnapshotRowDigest({ checkpointId: "middle",
    parentCheckpointId: "base", prefixLength: 2, messageCount: 3, generation: "middle-gen",
    type: middle.type, bytes: middle.bytes }))
  expect(facts.chainSeal[1].rawDigest).toBe(preparedNativeSnapshotRowDigest({ checkpointId: "base",
    parentCheckpointId: null, prefixLength: 0, messageCount: 3, generation: "base-gen", type: "json", bytes: text }))
  const headerReads = sql.filter(value => value.includes("generation,type FROM main.checkpoint_message_snapshots"))
  expect(headerReads).toHaveLength(2)
  expect(headerReads.every(value => !value.includes("suffix"))).toBe(true)
  expect(sql.findIndex(value => value.includes("generation,type,suffix FROM main.checkpoint_message_snapshots")))
    .toBeGreaterThan(sql.lastIndexOf(headerReads[1]))
})

it("still rejects an unsafe constructor in a discarded historical suffix before invoking it", async () => {
  const f = await fixture(), first = await encoded([f.messages[0]])
  const text = (typeof first.bytes === "string" ? first.bytes : new TextDecoder().decode(first.bytes))
    .replace(/]$/, ',{"lc":1,"type":"constructor","id":["unsafe","Constructor"],"kwargs":{}}]')
  f.database.prepare("INSERT INTO checkpoint_message_snapshots VALUES (?,?,?,?,?,?,?,?,?)")
    .run("physical", "native", "base", null, 0, 2, "base-gen", "json", text)
  const source: PreparedNativeDataSource = { ...f.source, messages: { ...(await encoded([f.messages[1]])),
    parentCheckpointId: "base", prefixLength: 1, messageCount: 2, expectedParentCount: 2,
    expectedParentGeneration: "base-gen" } }
  const prototype = Object.getPrototypeOf(serde) as typeof serde, original = prototype.loadsTyped
  let unsafeCalls = 0
  const observe = vi.spyOn(prototype, "loadsTyped").mockImplementation(function (
    this: typeof serde, ...args: Parameters<typeof serde.loadsTyped>
  ) {
    if (typeof args[1] === "string" && args[1].includes('"unsafe"')) unsafeCalls++
    return Reflect.apply(original, this, args)
  })
  try { await expect(readPreparedNativeDataFacts(f.request, source)).rejects.toThrow("PREPARED_NATIVE_CODEC_UNSUPPORTED") }
  finally { observe.mockRestore() }
  expect(unsafeCalls).toBe(0)
})

it.each([null, true, 42, "scalar", []].map(value => ({ value })))("rejects selected non-Message item %j without silently filtering it", async ({ value }) => {
  const f = await fixture(), source = await preparedSourceWithBody(f, JSON.stringify([value]), 1)
  await expect(readPreparedNativeDataFacts(f.request, source)).rejects.toThrow("PREPARED_NATIVE_CODEC_UNSUPPORTED")
})

it.each(['[{unquoted:Infinity}]', '[{"x":1}] trailing'])("rejects non-strict JSON %s", async text => {
  const f = await fixture(), source = await preparedSourceWithBody(f, text, 1)
  await expect(readPreparedNativeDataFacts(f.request, source)).rejects.toThrow("PREPARED_NATIVE_CODEC_UNSUPPORTED")
})

it.each(["{}", "[]"])("rejects a false array root or suffix count %s", async text => {
  const f = await fixture(), source = await preparedSourceWithBody(f, text, 1)
  await expect(readPreparedNativeDataFacts(f.request, source)).rejects.toThrow("PREPARED_NATIVE_SOURCE_CHANGED")
})

it("rejects literal ill-formed raw UTF16 while keeping original UTF8 replacement semantics", async () => {
  const f = await fixture(), raw = '[{"lc":1,"type":"constructor","id":["langchain_core","messages","HumanMessage"],"kwargs":{"content":"x"}}]'
  const invalid = raw.replace('"x"', '"\ud800"')
  await expect(readPreparedNativeDataFacts(f.request, await preparedSourceWithBody(f, invalid, 1)))
    .rejects.toThrow("PREPARED_NATIVE_CODEC_UNSUPPORTED")
  const bytes = new TextEncoder().encode(raw)
  bytes[raw.indexOf('"x"') + 1] = 255
  const oracle = await serde.loadsTyped("json", bytes) as BaseMessage[]
  const facts = await readPreparedNativeDataFacts(f.request, await preparedSourceWithBody(f, bytes, 1))
  expect(facts.nativeSnapshotDigest).toBe(originalNativeDigest(oracle))
})

it.each(["main", "temp"] as const)("rejects main shadow and isolates temp json_each: %s", async schema => {
  const f = await fixture()
  if (schema === "main") {
    f.database.exec("CREATE TABLE JSON_EACH(key,type,value)")
    await expect(readPreparedNativeDataFacts(f.request, f.source)).rejects.toThrow("PREPARED_NATIVE_CODEC_UNSUPPORTED")
    return
  }
  const original = DatabaseSync.prototype.prepare
  let created = false
  const observe = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync, sql: string
  ) {
    if (!created && sql.includes("FROM main.json_each")) {
      this.exec("CREATE TEMP TABLE json_each(key,type,value)")
      created = true
    }
    return Reflect.apply(original, this, [sql])
  })
  try {
    expect((await readPreparedNativeDataFacts(f.request, f.source)).nativeSnapshotDigest)
      .toBe(originalNativeDigest(f.messages))
  } finally { observe.mockRestore() }
  expect(created).toBe(true)
})

it("cancels after the original item decoder and closes the actual readonly connection", async () => {
  const f = await fixture(), prototype = Object.getPrototypeOf(serde) as typeof serde,
    original = prototype.loadsTyped, close = DatabaseSync.prototype.close
  let itemCalls = 0, closes = 0
  const observe = vi.spyOn(prototype, "loadsTyped").mockImplementation(async function (
    this: typeof serde, ...args: Parameters<typeof serde.loadsTyped>
  ) {
    const result = await Reflect.apply(original, this, args)
    if (typeof args[1] === "string" && args[1].includes('"HumanMessage"')) {
      itemCalls++
      Atomics.store(new Int32Array(f.request.cancellationBuffer), 0, 1)
    }
    return result
  })
  const closed = vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function (this: DatabaseSync) {
    closes++
    return Reflect.apply(close, this, [])
  })
  try { await expect(readPreparedNativeDataFacts(f.request, f.source)).rejects.toMatchObject({
    name: CHECKPOINT_RUNTIME_PROJECTION_CANCELLED,
    message: "Checkpoint runtime projection request was superseded"
  }) }
  finally { observe.mockRestore(); closed.mockRestore() }
  expect(itemCalls).toBe(1)
  expect(closes).toBe(1)
})

it("keeps the original codec failure when cursor clearing also fails", async () => {
  const f = await fixture(), prototype = Object.getPrototypeOf(serde) as typeof serde,
    original = prototype.loadsTyped, get = StatementSync.prototype.get
  let armed = false, cleanupFailures = 0
  const observe = vi.spyOn(prototype, "loadsTyped").mockImplementation(function (
    this: typeof serde, ...args: Parameters<typeof serde.loadsTyped>
  ) {
    if (typeof args[1] === "string" && args[1].includes('"HumanMessage"')) {
      armed = true
      throw Error("ORIGINAL_ITEM_FAILURE")
    }
    return Reflect.apply(original, this, args)
  })
  const cleanup = vi.spyOn(StatementSync.prototype, "get").mockImplementation(function (
    this: StatementSync, ...args: Parameters<StatementSync["get"]>
  ) {
    if (armed && (args[0] as unknown) === "[]") { cleanupFailures++; throw Error("SECONDARY_CLEAR_FAILURE") }
    return Reflect.apply(get, this, args)
  })
  try { await expect(readPreparedNativeDataFacts(f.request, f.source)).rejects.toThrow("ORIGINAL_ITEM_FAILURE") }
  finally { observe.mockRestore(); cleanup.mockRestore() }
  expect(cleanupFailures).toBe(1)
})
