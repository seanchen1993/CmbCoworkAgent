import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildMessageRoleCollisionId,
  buildMessageSameRoleDuplicateId,
  MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY,
  MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY
} from "../../shared/message-role-collision"
import { GOAL_CONTINUATION_BOUNDARY_METADATA_KEY } from "../agent/goals/internal-prompt"
import { CHECKPOINT_RUNTIME_PROJECTION_CANCELLED } from "../checkpointer/runtime-projection-protocol"
import { bootstrapStockLegacyCheckpointTranscript } from "../checkpointer/legacy-stock-transcript-store"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { readThreadMessagesPage } from "../thread-message-hydration/page-reader"
import {
  closeDatabase,
  createThread,
  getDb,
  getOpenDatabaseFile,
  getThreadCore,
  getThreadMessageProviderOccurrencesBeforeUser,
  getThreadMessages,
  getThreadTranscriptBoundaryOrdinal,
  hasUnresolvedLegacyTranscriptSlots,
  initializeDatabase,
  moveThreadMessagesAfterAnchor,
  replaceThreadMessageId,
  reserveThreadGraphTranscriptBoundary,
  ThreadMessageStreamAttempt,
  upsertThreadMessages,
  withThreadMessageIdentitySnapshot
} from "."
import { NativeSqliteAdapter } from "./native-sqlite-adapter"
import { ensureLegacyTranscriptSlots } from "./legacy-transcript-slots"
import { sqliteRecoveryFamilyKey } from "./sqlite-recovery-family"

const storage = vi.hoisted(() => ({ databasePath: "" }))
vi.mock("../storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../storage")>()),
  getDbPath: () => storage.databasePath,
  getMemorySessionOptInMigrationState: () => ({ migrated: true })
}))

const threadId = "legacy-ordinal-thread"
const checkpointId = "legacy-ordinal-checkpoint"
let directory: string
let checkpointPath: string
let observer: DatabaseSync

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-legacy-transcript-slots-"))
  storage.databasePath = join(directory, "transcript.sqlite")
  checkpointPath = join(directory, "checkpoint.sqlite")
  await initializeDatabase()
  createThread(threadId)
  observer = new DatabaseSync(storage.databasePath)
})

afterEach(async () => {
  vi.restoreAllMocks()
  observer?.close()
  await closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

async function checkpoint(messages: BaseMessage[], id = checkpointId, parent?: string): Promise<void> {
  const saver = new SqlJsSaver(checkpointPath, undefined, { maxRootCheckpoints: 3 })
  try {
    await saver.put(
      { configurable: { thread_id: threadId, checkpoint_ns: "", ...(parent ? { checkpoint_id: parent } : {}) } },
      {
        v: 1,
        id,
        ts: new Date().toISOString(),
        channel_values: { messages },
        channel_versions: { messages: 1 },
        versions_seen: {}
      },
      { source: "loop", step: 1, parents: {} }
    )
  } finally {
    await saver.close()
  }
}

const visibleUser = (id: string) => new HumanMessage({ id, content: id })
const assistant = (id: string, content = id) => new AIMessage({ id, content })
const hiddenGoalInput = () =>
  new HumanMessage({
    id: "hidden",
    content: "[Continuing active goal] Continue",
    additional_kwargs: { [GOAL_CONTINUATION_BOUNDARY_METADATA_KEY]: true }
  })

function persist(nodes: Array<HumanMessage | AIMessage>): void {
  upsertThreadMessages(
    threadId,
    nodes.map((node) => ({
      id: node.id!,
      role: HumanMessage.isInstance(node) ? "user" : "assistant",
      content: String(node.content),
      created_at: new Date()
    })),
    { preserveExistingOrder: true }
  )
}

function bootstrap(cancellation = new SharedArrayBuffer(4)) {
  const row = getThreadCore(threadId)
  const messageDatabaseFile = getOpenDatabaseFile(getDb())
  if (!row || !messageDatabaseFile) throw Error("Missing ordinary legacy fixture identity")
  return bootstrapStockLegacyCheckpointTranscript(
    checkpointPath,
    storage.databasePath,
    threadId,
    "",
    cancellation,
    {
      messageDatabaseFile,
      checkpointFamilyKey: sqliteRecoveryFamilyKey(checkpointPath),
      incarnation: captureThreadIncarnation(row),
      workspace: ""
    }
  )
}

function migrationState() {
  return observer
    .prepare(
      `SELECT status, next_index, current_fragment_index, scoped_order
       FROM legacy_checkpoint_transcript_migrations WHERE thread_id = ?`
    )
    .get(threadId)
}

function pauseAtCommittedBatch(shouldPause: () => boolean): void {
  const cancellation = new SharedArrayBuffer(4)
  const flag = new Int32Array(cancellation)
  const load = Atomics.load
  const spy = vi.spyOn(Atomics, "load").mockImplementation((target, index) => {
    if (target.buffer === cancellation && shouldPause()) Atomics.store(flag, 0, 1)
    return load(target, index)
  })
  try {
    expect(() => bootstrap(cancellation)).toThrow(
      expect.objectContaining({ name: CHECKPOINT_RUNTIME_PROJECTION_CANCELLED })
    )
  } finally {
    spy.mockRestore()
  }
}

const durableOrder = () => getThreadMessages(threadId).map(({ id, ordinal }) => [id, ordinal])
const slots = () =>
  observer
    .prepare(
      `SELECT message_index, ordinal FROM legacy_checkpoint_transcript_slots
       WHERE thread_id = ? ORDER BY message_index`
    )
    .all(threadId)

describe("legacy checkpoint transcript slots", () => {
  it("converts only the authorized thread inside the existing write transaction", () => {
    const otherThread = "unrelated-legacy-thread"
    createThread(otherThread)
    const insert = observer.prepare(`INSERT INTO legacy_checkpoint_transcript_migrations
      (thread_id, checkpoint_id, total_messages, next_index, reserved_ordinals_json, status, updated_at)
      VALUES (?, ?, 2, 1, ?, 'migrating', 0)`)
    insert.run(threadId, checkpointId, "[null,7]")
    insert.run(otherThread, checkpointId, "[null,9]")

    const database = new NativeSqliteAdapter(observer)
    database.withImmediateWriteTransaction(() => ensureLegacyTranscriptSlots(database, threadId))

    expect(slots()).toEqual([{ message_index: 1, ordinal: 7 }])
    const unaffected = observer.prepare(`SELECT scoped_order, reserved_ordinals_json
      FROM legacy_checkpoint_transcript_migrations WHERE thread_id=?`).get(otherThread)
    expect(unaffected).toEqual({ scoped_order: null, reserved_ordinals_json: "[null,9]" })
    expect(observer.prepare(`SELECT ordinal FROM legacy_checkpoint_transcript_slots
      WHERE thread_id=?`).all(otherThread)).toEqual([])
  })

  it.each([false, true])("preserves checkpoint fragment ownership across a stream rollback (descendant=%s)", async (descendant) => {
    const root = visibleUser("root")
    const large = assistant("wide", "prior ".repeat(360_000))
    await checkpoint([root, large])
    pauseAtCommittedBatch(() => Number(migrationState()?.current_fragment_index) > 0)
    const attempt = new ThreadMessageStreamAttempt(threadId)
    upsertThreadMessages(threadId, [{
      id: "wide", role: "assistant", content: "provisional replacement", content_mode: "snapshot",
      created_at: new Date()
    }], { preserveExistingOrder: true, streamAttempt: attempt })
    expect(attempt.rollback().restoredMessages.some((message) => message.id === "wide")).toBe(true)
    const restored = observer.prepare(`SELECT active_fragment_revision FROM legacy_checkpoint_transcript_migrations
      WHERE thread_id = ?`).get(threadId)?.active_fragment_revision
    expect(JSON.parse(String(restored))[0]).toBe("wide")

    const nextId = descendant ? "updated-checkpoint" : checkpointId
    await checkpoint([root, assistant("wide", "revised answer"), assistant("following")],
      nextId, descendant ? checkpointId : undefined)
    expect(bootstrap().stats.checkpointId).toBe(nextId)
    expect(getThreadMessages(threadId).map(({ id, content }) => [id, content])).toEqual([
      ["root", "root"], ["wide", "revised answer"], ["following", "following"]
    ])
    expect(migrationState()?.status).toBe("complete")
  })

  it("resumes an old prefix copy at the slot moved by a live steering message", async () => {
    const root = visibleUser("root")
    await checkpoint([root, assistant("recovered")])
    persist([root, visibleUser("guide")])
    observer.prepare(`INSERT INTO legacy_checkpoint_transcript_migrations
      (thread_id, checkpoint_id, total_messages, next_index, scoped_order, status, updated_at)
      VALUES (?, ?, 2, 1, 0, 'migrating', 0)`).run(threadId, checkpointId)
    observer.prepare(`INSERT INTO legacy_checkpoint_transcript_slots
      (thread_id, checkpoint_id, message_index, ordinal) VALUES (?, ?, 1, 2)`).run(threadId, checkpointId)

    expect(bootstrap().stats).toMatchObject({ migratedMessages: 1 })
    expect(durableOrder()).toEqual([["root", 0], ["guide", 1], ["recovered", 2]])
    expect(slots()).toEqual([])
  })

  it("keeps known provider occurrences when an old slot in a later turn has no identity", () => {
    persist([assistant("known"), visibleUser("current")])
    observer.prepare(`INSERT INTO legacy_checkpoint_transcript_migrations
      (thread_id, checkpoint_id, total_messages, next_index, scoped_order, status, updated_at)
      VALUES (?, ?, 3, 2, 0, 'migrating', 0)`).run(threadId, checkpointId)
    observer.prepare(`INSERT INTO legacy_checkpoint_transcript_slots
      (thread_id, checkpoint_id, message_index, ordinal) VALUES (?, ?, 2, 2)`).run(threadId, checkpointId)
    expect(hasUnresolvedLegacyTranscriptSlots(threadId)).toBe(true)
    expect(getThreadMessageProviderOccurrencesBeforeUser(threadId, "current", ["known"])).toEqual([
      { provider_source_id: "known", role: "assistant", provider_occurrence: 1 }
    ])
  })

  it.each([
    { extended: false, intervening: false },
    { extended: true, intervening: false },
    { extended: true, intervening: true }
  ])("finishes a reserved occurrence already persisted live ($extended, $intervening)", async ({ extended, intervening }) => {
    const root = visibleUser("root")
    const reply = assistant("already-written", "one verified reply")
    persist([root])
    reserveThreadGraphTranscriptBoundary(threadId, "hidden")
    await checkpoint([root, hiddenGoalInput(), reply])
    pauseAtCommittedBatch(() => migrationState()?.status === "migrating")
    expect(slots()).toEqual([{ message_index: 1, ordinal: 2 }])
    const native = extended ? assistant(reply.id!, "one verified reply with a live suffix") : reply
    persist(intervening ? [assistant("intervening"), native] : [native])

    expect(bootstrap().stats).toMatchObject({ migratedMessages: 0, searchProjectionState: "complete" })
    expect(durableOrder()).toEqual(intervening
      ? [["root", 0], ["already-written", 2], ["intervening", 3]]
      : [["root", 0], ["already-written", 3]])
    expect(getThreadMessages(threadId).find((message) => message.id === native.id)?.content).toBe(native.content)
    expect(slots()).toEqual([])
    expect(migrationState()?.status).toBe("complete")
  })

  it.each([
    { fragmented: false, occupyingRole: "tool", removed: false, promoted: false },
    { fragmented: false, occupyingRole: "assistant", removed: false, promoted: false },
    { fragmented: true, occupyingRole: "tool", removed: false, promoted: false },
    { fragmented: true, occupyingRole: "tool", removed: true, promoted: false },
    { fragmented: true, occupyingRole: "tool", removed: false, promoted: true }
  ] as const)("preserves a reserved reply when its ID is reused ($fragmented, $occupyingRole, $removed, $promoted)", async ({
    fragmented, occupyingRole, removed, promoted
  }) => {
    const root = visibleUser("root")
    persist([root])
    reserveThreadGraphTranscriptBoundary(threadId, "hidden")
    const reply = fragmented ? "head " + "x".repeat(2 * 1024 * 1024) + " tail" : "older reply"
    await checkpoint([root, hiddenGoalInput(), assistant("reused", reply)])
    pauseAtCommittedBatch(() => migrationState()?.status === "migrating")
    persist([visibleUser("live")])
    upsertThreadMessages(threadId, [{ id: "reused", role: occupyingRole, content: "live occupant",
      ...(occupyingRole === "tool" ? { tool_call_id: "live-tool" } :
        { provider_source_id: "new-provider", provider_occurrence: 1 }),
      created_at: new Date() }], { preserveExistingOrder: true })
    let alias = buildMessageRoleCollisionId("reused", "assistant")
    if (fragmented) {
      pauseAtCommittedBatch(() => Number(migrationState()?.current_fragment_index) > 0)
      if (removed) observer.prepare("DELETE FROM thread_messages WHERE thread_id = ? AND message_id = 'reused'").run(threadId)
      if (promoted) {
        expect(replaceThreadMessageId(threadId, alias, "promoted", "assistant")).toBe(true)
        alias = "promoted"
      }
    }

    expect(bootstrap().stats.searchProjectionState).toBe("complete")
    expect(durableOrder()).toEqual([["root", 0], [alias, 2], ["live", 3], ...(removed ? [] : [["reused", 4]])])
    if (!removed) expect(getThreadMessages(threadId).find((message) => message.id === "reused")?.content).toBe("live occupant")
    if (fragmented) {
      const hash = createHash("sha256")
      for (const row of observer.prepare(`SELECT content_text FROM thread_message_fragments
        WHERE thread_id = ? AND message_id = ? ORDER BY fragment_id`).iterate(threadId, alias))
        hash.update(String(row.content_text))
      expect(hash.digest("hex")).toBe(createHash("sha256").update(reply).digest("hex"))
    } else {
      expect(getThreadMessages(threadId).find((message) => message.id === alias)?.content).toBe(reply)
      const revision = observer.prepare(`SELECT transcript_revision FROM legacy_checkpoint_transcript_sources
        WHERE thread_id = ? AND checkpoint_id = ?`).get(threadId, checkpointId)?.transcript_revision
      const recover = () => readThreadMessagesPage(observer, {
        type: "read-page", requestId: 1, databasePath: storage.databasePath, threadId,
        options: { recoveryCheckpointId: checkpointId,
          ...(typeof revision === "string" ? { recoveryTranscriptRevision: revision } : {}) },
        cancellationBuffer: new SharedArrayBuffer(4)
      }).page
      const expectRecovered = () => {
        const page = recover()
        expect(page.recoveryIntegrity).toBe("verified")
        expect(page.messages.map(({ id, content }) => [id, content])).toEqual([["root", "root"], ["reused", reply]])
      }
      expectRecovered()
      expect(replaceThreadMessageId(threadId, alias, "promoted", "assistant")).toBe(true)
      expectRecovered()
      persist([assistant("official", reply)])
      expect(replaceThreadMessageId(threadId, "promoted", "official", "assistant")).toBe(true)
      expectRecovered()
    }
    expect(slots()).toEqual([])
  })

  it.each([
    { scoped: true, pruned: false, transition: "stage" },
    { scoped: false, pruned: true, transition: "stage" },
    { scoped: true, pruned: true, transition: "rollback" },
    { scoped: true, pruned: true, transition: "native-rename" }
  ])("settles a merged active fragment copy ($scoped, $pruned, $transition)", async ({
    scoped, pruned, transition
  }) => {
    const root = visibleUser("root")
    const text = "original answer " + "x".repeat(2 * 1024 * 1024)
    const active = assistant("wide", text)
    const prefix = [root, ...(scoped ? [hiddenGoalInput()] : []), active]
    persist([root])
    if (scoped) reserveThreadGraphTranscriptBoundary(threadId, "hidden")
    await checkpoint(prefix)
    pauseAtCommittedBatch(() => Number(migrationState()?.current_fragment_index) > 0)
    upsertThreadMessages(threadId, [{
      id: "canonical", role: "assistant", content: text, created_at: new Date()
    }], { preserveExistingOrder: true })
    expect(replaceThreadMessageId(threadId, "wide", "canonical", "assistant")).toBe(true)
    const fragmentState = observer.prepare(`SELECT
      json_extract(active_fragment_revision, '$[7].generation') AS stage,
      json_extract(active_fragment_revision, '$[8]') AS merge_key
      FROM legacy_checkpoint_transcript_migrations WHERE thread_id = ?`)
    expect(fragmentState.get(threadId)?.merge_key).toEqual(expect.any(String))
    const nativeOwner = transition === "native-rename"
    let physicalId = "canonical"
    if (transition === "rollback" || nativeOwner) {
      const attempt = nativeOwner ? undefined : new ThreadMessageStreamAttempt(threadId)
      upsertThreadMessages(threadId, [{
        id: physicalId, role: "assistant",
        content: nativeOwner ? "new authoritative reply" : "provisional reply",
        content_mode: "snapshot", content_priority: 1, created_at: new Date()
      }], { preserveExistingOrder: true, streamAttempt: attempt })
      if (attempt) {
        expect(attempt.rollback().restoredMessages.map(({ id }) => id)).toEqual([physicalId])
      } else {
        expect(replaceThreadMessageId(threadId, physicalId, "final-canonical", "assistant")).toBe(true)
        physicalId = "final-canonical"
      }
      expect(fragmentState.get(threadId)?.merge_key).toEqual(expect.any(String))
    }

    let head = checkpointId
    const tail = [visibleUser("next-user"), assistant("next-reply"), visibleUser("last-user")]
    if (pruned) {
      persist(tail)
      for (let index = 0; index < tail.length; index += 1) {
        const id = `${checkpointId}-${index + 1}`
        await checkpoint([...prefix, ...tail.slice(0, index + 1)], id, head)
        head = id
      }
    }
    if (transition === "stage") {
      pauseAtCommittedBatch(() => typeof fragmentState.get(threadId)?.stage === "string")
      expect(fragmentState.get(threadId)?.merge_key).toEqual(expect.any(String))
    }

    expect(bootstrap().stats).toMatchObject({
      checkpointId: head, searchProjectionState: nativeOwner ? "unverified" : "complete"
    })
    const published = observer.prepare(`SELECT content_json, ordinal,
      (SELECT SUM(LENGTH(content_text)) FROM thread_message_fragments AS f
        WHERE f.thread_id = m.thread_id AND f.message_id = m.message_id
          AND f.generation = m.fragment_generation) AS length
      FROM thread_messages AS m WHERE m.thread_id = ? AND m.message_id = ?`).get(threadId, physicalId)
    expect(published).toMatchObject(nativeOwner
      ? { content_json: JSON.stringify("new authoritative reply"), length: null, ordinal: scoped ? 2 : 1 }
      : { length: text.length, ordinal: scoped ? 2 : 1 })
    expect(durableOrder().map(([id]) => id)).toEqual([
      "root", physicalId, ...(pruned ? tail.map(({ id }) => id) : [])
    ])
    expect(migrationState()).toMatchObject({ status: "complete", current_fragment_index: 0 })
    expect(slots()).toEqual([])
  })

  it.each([false, true])("settles a scoped copy after a native write to the same row (pruned=%s)", async (pruned) => {
    const root = visibleUser("root")
    const original = [root, hiddenGoalInput(), assistant("wide", "legacy body ".repeat(190_000)),
      assistant("following")]
    persist([root])
    reserveThreadGraphTranscriptBoundary(threadId, "hidden")
    await checkpoint(original)
    pauseAtCommittedBatch(() => Number(migrationState()?.current_fragment_index) > 0)
    const native = "new committed reply"
    upsertThreadMessages(threadId, [{
      id: "wide", role: "assistant", content: native, created_at: new Date(), content_priority: 1
    }], { preserveExistingOrder: true })
    const replacement = [root, hiddenGoalInput(), assistant("wide", native), assistant("following")]
    let head = checkpointId
    if (pruned) {
      for (let index = 1; index <= 3; index += 1) {
        const descendant = `${checkpointId}-${index}`
        await checkpoint(replacement, descendant, head)
        head = descendant
      }
    }
    expect(bootstrap().stats).toMatchObject({
      checkpointId: head, searchProjectionState: pruned ? "complete" : "unverified"
    })
    expect(getThreadMessages(threadId).map(({ id, content, ordinal }) => [id, content, ordinal]))
      .toEqual([["root", "root", 0], ["wide", native, 2], ["following", "following", 3]])
    expect(migrationState()).toMatchObject({ status: "complete", current_fragment_index: 0 })
    expect(slots()).toEqual([])
  })

  it.each([
    { compacted: false, revision: "same", append: true },
    { compacted: true, revision: "same", append: true },
    { compacted: false, revision: "extend", append: false },
    { compacted: true, revision: "extend", append: true },
    { compacted: false, revision: "replace", append: true },
    { compacted: true, revision: "replace", append: false }
  ])("continues owned scoped fragments after a same-checkpoint save ($compacted, $revision, $append)", async ({
    compacted, revision, append
  }) => {
    const root = visibleUser("root")
    const reply = "old body " + "x".repeat(2 * 1024 * 1024)
    persist([root])
    reserveThreadGraphTranscriptBoundary(threadId, "hidden")
    const original = [root, hiddenGoalInput(), assistant("old-reply", reply)]
    await checkpoint(original)
    pauseAtCommittedBatch(() => Number(migrationState()?.current_fragment_index) > 0)
    const expectedReply = revision === "replace" ? "corrected reply"
      : revision === "extend" ? reply + " live continuation" : reply
    const active = assistant("old-reply", expectedReply)
    const prefix = compacted ? [root, active] : [root, hiddenGoalInput(), active]
    await checkpoint(append ? [...prefix, assistant("next-reply", "newly appended reply")] : prefix)

    expect(bootstrap().stats).toMatchObject({ totalMessages: append ? 3 : 2, searchProjectionState: "complete" })
    expect(durableOrder()).toEqual([["root", 0], ["old-reply", 2], ...(append ? [["next-reply", 3]] : [])])
    if (append)
      expect(getThreadMessages(threadId).find((message) => message.id === "next-reply")?.content).toBe("newly appended reply")
    const chunks = observer.prepare(`SELECT SUM(LENGTH(content_text)) AS length FROM thread_message_fragments
      WHERE thread_id = ? AND message_id = 'old-reply'`).get(threadId)
    if (revision === "replace") {
      expect(chunks?.length).toBeNull()
      expect(getThreadMessages(threadId).find((message) => message.id === "old-reply")?.content)
        .toBe(expectedReply)
    } else {
      expect(chunks?.length).toBe(expectedReply.length)
    }
    expect(migrationState()?.status).toBe("complete")
    expect(slots()).toEqual([])
  })

  it.each([
    { compacted: false, revision: "same", rollback: false },
    { compacted: true, revision: "extend", rollback: false },
    { compacted: true, revision: "replace", rollback: true }
  ])("recovers a pruned scoped checkpoint from an authenticated descendant ($revision)", async ({
    compacted, revision, rollback
  }) => {
    const root = visibleUser("root")
    const committed = assistant("already-written", "committed reply")
    const reply = "original reply " + "x".repeat(2 * 1024 * 1024)
    persist([root, committed])
    reserveThreadGraphTranscriptBoundary(threadId, "hidden")
    await checkpoint([root, committed, hiddenGoalInput(), assistant("wide", reply)])
    pauseAtCommittedBatch(() => Number(migrationState()?.current_fragment_index) > 0)
    expect(migrationState()).toMatchObject({ status: "migrating", scoped_order: 1, next_index: 2 })
    expect(replaceThreadMessageId(threadId, committed.id!, "canonical-written", "assistant")).toBe(true)
    if (rollback) {
      const attempt = new ThreadMessageStreamAttempt(threadId)
      upsertThreadMessages(threadId, [{
        id: "wide", role: "assistant", content: "provisional reply", content_mode: "snapshot",
        created_at: new Date()
      }], { preserveExistingOrder: true, streamAttempt: attempt })
      expect(attempt.rollback().restoredMessages.map(({ id }) => id)).toEqual(["wide"])
    }
    const expected = revision === "replace" ? "corrected reply"
      : revision === "extend" ? reply + " after resuming" : reply
    const prefix = [root, committed, ...(compacted ? [] : [hiddenGoalInput()]), assistant("wide", expected)]
    const tail = [visibleUser("next-user"), assistant("next-reply"), visibleUser("final-user")]
    persist(tail)
    let parent = checkpointId
    for (let index = 0; index < tail.length; index += 1) {
      const id = `${checkpointId}-${index + 1}`
      await checkpoint([...prefix, ...tail.slice(0, index + 1)], id, parent)
      parent = id
    }
    const checkpoints = new DatabaseSync(checkpointPath, { readOnly: true })
    try {
      expect(checkpoints.prepare("SELECT 1 FROM checkpoints WHERE checkpoint_id = ?").get(checkpointId))
        .toBeUndefined()
    } finally {
      checkpoints.close()
    }
    expect(bootstrap().stats).toMatchObject({
      checkpointId: parent, totalMessages: 6, searchProjectionState: "complete"
    })
    expect(durableOrder()).toEqual([
      ["root", 0], ["canonical-written", 1], ["wide", 3],
      ["next-user", 4], ["next-reply", 5], ["final-user", 6]
    ])
    const stored = observer.prepare(`SELECT m.content_json AS content,
      (SELECT SUM(LENGTH(f.content_text)) FROM thread_message_fragments AS f
        WHERE f.thread_id = m.thread_id AND f.message_id = m.message_id
          AND f.generation = m.fragment_generation) AS length
      FROM thread_messages AS m WHERE m.thread_id = ? AND m.message_id = 'wide'`).get(threadId)
    if (revision === "replace") {
      expect(stored).toMatchObject({ content: JSON.stringify(expected), length: null })
    } else {
      expect(stored).toMatchObject({ length: expected.length })
    }
    expect(migrationState()).toMatchObject({ status: "complete", next_index: 6 })
    expect(slots()).toEqual([])
  })

  it("defers provider identity reads while a committed reservation still moves its Goal boundary", async () => {
    const first = assistant("shared")
    persist([visibleUser("root"), first])
    const olderBoundary = new HumanMessage({ id: "older-hidden", content: "older continuation",
      additional_kwargs: { [GOAL_CONTINUATION_BOUNDARY_METADATA_KEY]: true } })
    reserveThreadGraphTranscriptBoundary(threadId, olderBoundary.id!)
    reserveThreadGraphTranscriptBoundary(threadId, "hidden")
    const reply = new AIMessage({ id: "shared", content: "second reply",
      additional_kwargs: { [MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY]: "shared",
        [MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY]: 2 } })
    await checkpoint([olderBoundary, reply, hiddenGoalInput()])

    pauseAtCommittedBatch(() => migrationState()?.status === "reserving")
    expect(hasUnresolvedLegacyTranscriptSlots(threadId)).toBe(true)
    expect(getThreadMessageProviderOccurrencesBeforeUser(threadId, "hidden", ["shared"])).toBeUndefined()
    expect(bootstrap().stats.migratedMessages).toBe(1)
    expect(getThreadMessageProviderOccurrencesBeforeUser(threadId, "hidden", ["shared"])).toEqual([
      { provider_source_id: "shared", role: "assistant", provider_occurrence: 2 }
    ])
  })

  it("preserves distinct replies with the same declared identity across a hidden Goal turn", async () => {
    const reply = (id: string, content: string) => new AIMessage({ id, content,
      additional_kwargs: { [MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY]: "reused",
        [MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY]: 1 } })
    reserveThreadGraphTranscriptBoundary(threadId, "hidden")
    await checkpoint([visibleUser("root"), reply("first", "first draft"), reply("revision", "first draft complete"),
      hiddenGoalInput(), reply("second", "second reply")])

    expect(bootstrap().stats.migratedMessages).toBe(3)
    expect(getThreadMessages(threadId).map((row) => row.content)).toEqual([
      "root", "first draft complete", "second reply"
    ])
  })

  it.each([false, true])("reserves new history after a completed copy (had a Goal boundary: %s)", async (alreadyScoped) => {
    const root = visibleUser("root")
    persist([root])
    if (alreadyScoped) reserveThreadGraphTranscriptBoundary(threadId, "hidden")
    const earlier = assistant("earlier")
    const prior = alreadyScoped ? [root, hiddenGoalInput(), earlier] : [root, earlier]
    await checkpoint(prior)
    expect(bootstrap().stats.migratedMessages).toBe(1)

    if (!alreadyScoped) reserveThreadGraphTranscriptBoundary(threadId, "hidden")
    const later = alreadyScoped ? prior : [...prior, hiddenGoalInput()]
    await checkpoint([...later, assistant("missing", "new checkpoint-only reply")], "next-checkpoint", checkpointId)
    expect(bootstrap().stats).toMatchObject({ checkpointId: "next-checkpoint", migratedMessages: 1 })
    expect(durableOrder()).toEqual([["root", 0], ["earlier", alreadyScoped ? 2 : 1], ["missing", 3]])
    expect(getThreadTranscriptBoundaryOrdinal(threadId, "hidden")).toBe(alreadyScoped ? 1 : 2)
    expect(slots()).toEqual([])
    expect(bootstrap().stats.migratedMessages).toBe(0)
  })

  it.each([
    { fragmented: false, hasVisibleNeighbor: true },
    { fragmented: true, hasVisibleNeighbor: true },
    { fragmented: false, hasVisibleNeighbor: false }
  ])(
    "moves pending Goal slots through steering and restart ($fragmented, $hasVisibleNeighbor)",
    async ({ fragmented, hasVisibleNeighbor }) => {
      const root = visibleUser("root")
      const answer = assistant("answer")
      const oldTail = hasVisibleNeighbor ? [assistant("old-tail")] : []
      const recoveredBody = fragmented ? "x".repeat(2 * 1024 * 1024) : "missing predecessor"
      const recovered = assistant("recovered", recoveredBody)
      persist([root, answer])
      reserveThreadGraphTranscriptBoundary(threadId, "hidden")
      persist([...oldTail, visibleUser("guide")])
      await checkpoint([root, answer, recovered, hiddenGoalInput(), ...oldTail])

      pauseAtCommittedBatch(() => {
        const state = migrationState()
        return (
          state?.status === "migrating" && (!fragmented || Number(state.current_fragment_index) > 0)
        )
      })
      expect(slots()).toEqual([{ message_index: 2, ordinal: 2 }])
      expect(moveThreadMessagesAfterAnchor(threadId, "answer", ["guide"])).toBe(true)
      expect(slots()).toEqual([{ message_index: 2, ordinal: 3 }])

      bootstrap()
      expect(durableOrder()).toEqual([
        ["root", 0],
        ["answer", 1],
        ["guide", 2],
        ["recovered", 3],
        ...(hasVisibleNeighbor ? [["old-tail", 5]] : [])
      ])
      expect(getThreadTranscriptBoundaryOrdinal(threadId, "hidden")).toBe(4)
      if (fragmented) {
        const contentHash = createHash("sha256")
        for (const row of observer
          .prepare(
            `SELECT content_text FROM thread_message_fragments
           WHERE thread_id = ? AND message_id = 'recovered' ORDER BY fragment_id`
          )
          .iterate(threadId)) {
          contentHash.update(String(row.content_text))
        }
        expect(contentHash.digest("hex")).toBe(
          createHash("sha256").update(recoveredBody).digest("hex")
        )
      } else {
        expect(getThreadMessages(threadId).find((row) => row.id === "recovered")?.content).toBe(
          recoveredBody
        )
      }
      expect(migrationState()).toMatchObject({ status: "complete" })
      expect(slots()).toEqual([])
    }
  )

  it("upgrades unfinished JSON and legacy prefix reservations before the next splice", async () => {
    const legacyThreadId = "ordinary-old-checkpoint"
    createThread(legacyThreadId)
    const old = observer.prepare(
      `INSERT INTO legacy_checkpoint_transcript_migrations (
         thread_id, checkpoint_id, total_messages, next_index, current_fragment_index,
         reserved_ordinals_json, status, updated_at
       ) VALUES (?, ?, 4, 1, 0, ?, 'migrating', 0)`
    )
    old.run(threadId, checkpointId, "[null,5,null,8]")
    old.run(legacyThreadId, checkpointId, null)
    await closeDatabase()
    await initializeDatabase()

    expect(migrationState()).toMatchObject({ scoped_order: 1, next_index: 1 })
    expect(slots()).toEqual([
      { message_index: 1, ordinal: 5 },
      { message_index: 3, ordinal: 8 }
    ])
    expect(
      observer
        .prepare(
          `SELECT message_index, ordinal FROM legacy_checkpoint_transcript_slots
           WHERE thread_id = ? ORDER BY message_index`
        )
        .all(legacyThreadId)
    ).toEqual([
      { message_index: 1, ordinal: 1 },
      { message_index: 2, ordinal: 2 },
      { message_index: 3, ordinal: 3 }
    ])
  })

  it("completes the legacy timing archive when the Goal transcript already covers the checkpoint", async () => {
    const root = visibleUser("root")
    const answer = assistant("answer")
    persist([root])
    reserveThreadGraphTranscriptBoundary(threadId, "hidden")
    persist([answer])
    await checkpoint([root, hiddenGoalInput(), answer])
    observer
      .prepare("UPDATE threads SET thread_values = ? WHERE thread_id = ?")
      .run(
        JSON.stringify({ messageTimes: { answer: { start_at: 1_000, end_at: 2_000 } } }),
        threadId
      )

    expect(bootstrap().stats).toMatchObject({ migratedMessages: 0 })
    expect(durableOrder()).toEqual([
      ["root", 0],
      ["answer", 2]
    ])
    expect(
      observer
        .prepare(
          "SELECT start_at, end_at FROM thread_messages WHERE thread_id = ? AND message_id = ?"
        )
        .get(threadId, "answer")
    ).toEqual({ start_at: 1_000, end_at: 2_000 })
    expect(
      observer
        .prepare(
          "SELECT applied_checkpoint_id FROM thread_legacy_message_times WHERE thread_id = ?"
        )
        .get(threadId)
    ).toEqual({ applied_checkpoint_id: checkpointId })
  })

  it("repairs a missing message bucket beyond an unfilled checkpoint tail slot", async () => {
    const root = visibleUser("root")
    persist([root])
    reserveThreadGraphTranscriptBoundary(threadId, "hidden")
    await checkpoint([root, hiddenGoalInput(), assistant("pending-tail")])
    pauseAtCommittedBatch(() => migrationState()?.status === "migrating")
    expect(slots()).toEqual([{ message_index: 1, ordinal: 2 }])
    observer.prepare("DELETE FROM thread_message_buckets WHERE thread_id = ?").run(threadId)
    persist([visibleUser("next-user")])
    bootstrap()
    expect(durableOrder()).toEqual([
      ["root", 0],
      ["pending-tail", 2],
      ["next-user", 3]
    ])
  })

  it.each([false, true])(
    "recovers a compacted provider occurrence without touching an older call (fragmented=%s)",
    async (fragmented) => {
      const provider = (id: string) => ({
        [MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY]: id,
        [MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY]: 2
      })
      upsertThreadMessages(
        threadId,
        [
          {
            id: "assistant",
            role: "assistant",
            content: "previous",
            tool_calls: [{ id: "old-call", name: "read_file", args: {} }],
            created_at: new Date()
          },
          {
            id: "result",
            role: "tool",
            content: "old evidence",
            tool_call_id: "old-call",
            status: "success",
            created_at: new Date()
          }
        ],
        { preserveExistingOrder: true }
      )
      reserveThreadGraphTranscriptBoundary(threadId, "hidden")
      const recoveredBody = fragmented ? "y".repeat(2 * 1024 * 1024) : "new reply"
      await checkpoint([
        hiddenGoalInput(),
        new AIMessage({
          id: "assistant",
          content: recoveredBody,
          tool_calls: [{ id: "new-call", name: "read_file", args: {} }],
          additional_kwargs: provider("assistant")
        }),
        new ToolMessage({
          id: "result",
          content: "new evidence",
          tool_call_id: "new-call",
          status: "success",
          additional_kwargs: provider("result")
        })
      ])
      if (fragmented) {
        pauseAtCommittedBatch(() => Number(migrationState()?.current_fragment_index) > 0)
      }
      bootstrap()
      const newAssistantId = buildMessageSameRoleDuplicateId("assistant", "assistant", 2)
      const newToolId = buildMessageSameRoleDuplicateId("result", "tool", 2)
      expect(getThreadMessages(threadId)).toMatchObject([
        { id: "assistant", tool_calls: [{ id: "old-call" }], ordinal: 0 },
        { id: "result", tool_call_id: "old-call", content: "old evidence", ordinal: 1 },
        {
          id: newAssistantId,
          provider_occurrence: 2,
          tool_calls: [{ id: "new-call" }],
          ordinal: 3
        },
        {
          id: newToolId,
          provider_occurrence: 2,
          tool_call_id: "new-call",
          content: "new evidence",
          ordinal: 4
        }
      ])
      if (fragmented) {
        const fragments = observer.prepare(
          `SELECT SUM(LENGTH(content_text)) AS length FROM thread_message_fragments
           WHERE thread_id = ? AND message_id = ?`
        )
        expect(fragments.get(threadId, newAssistantId)).toEqual({ length: recoveredBody.length })
        expect(fragments.get(threadId, "assistant")).toEqual({ length: null })
      }
      expect(bootstrap().stats).toMatchObject({ migratedMessages: 0, batches: 0 })
      expect(slots()).toEqual([])
    }
  )

  it.each([false, true])(
    "keeps pending Goal occurrences distinct from a new live turn (upgraded=%s)",
    async (upgraded) => {
      const source = "shared-provider"
      persist([visibleUser("root"), assistant(source, "previous reply")])
      reserveThreadGraphTranscriptBoundary(threadId, "hidden")
      await checkpoint([
        hiddenGoalInput(),
        new AIMessage({
          id: source,
          content: "old pending reply",
          additional_kwargs: {
            [MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY]: source,
            [MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY]: 2
          }
        })
      ])
      pauseAtCommittedBatch(() => migrationState()?.status === "migrating")
      expect(durableOrder()).toEqual([
        ["root", 0],
        [source, 1]
      ])
      expect(slots()).toEqual([{ message_index: 0, ordinal: 3 }])
      expect(hasUnresolvedLegacyTranscriptSlots(threadId)).toBe(false)
      expect(getThreadMessageProviderOccurrencesBeforeUser(threadId, "hidden", [source])).toEqual([
        { provider_source_id: source, role: "assistant", provider_occurrence: 1 }
      ])

      if (upgraded) {
        // An older app reserved only ordinals. Replay the actual checkpoint to
        // restore the tuple while keeping the visible-message import paused.
        observer
          .prepare(
            `UPDATE legacy_checkpoint_transcript_slots
             SET provider_source_id = NULL, role = NULL, provider_occurrence = NULL
             WHERE thread_id = ?`
          )
          .run(threadId)
        expect(hasUnresolvedLegacyTranscriptSlots(threadId)).toBe(true)
        pauseAtCommittedBatch(() => !hasUnresolvedLegacyTranscriptSlots(threadId))
        expect(hasUnresolvedLegacyTranscriptSlots(threadId)).toBe(false)
        expect(durableOrder()).toEqual([
          ["root", 0],
          [source, 1]
        ])
      }

      reserveThreadGraphTranscriptBoundary(threadId, "new-hidden")
      const previous = getThreadMessageProviderOccurrencesBeforeUser(threadId, "new-hidden", [source])
      expect(previous).toEqual([
        { provider_source_id: source, role: "assistant", provider_occurrence: 2 }
      ])
      const occurrence = previous![0].provider_occurrence + 1
      upsertThreadMessages(
        threadId,
        [
          {
            id: buildMessageSameRoleDuplicateId(source, "assistant", occurrence),
            provider_source_id: source,
            provider_occurrence: occurrence,
            role: "assistant",
            content: "new live reply",
            created_at: new Date()
          }
        ],
        { preserveExistingOrder: true }
      )
      expect(bootstrap().stats.migratedMessages).toBe(1)
      expect(getThreadMessages(threadId)).toMatchObject([
        { content: "root", ordinal: 0 },
        { content: "previous reply", ordinal: 1 },
        { content: "old pending reply", provider_occurrence: 2, ordinal: 3 },
        { content: "new live reply", provider_occurrence: 3, ordinal: 5 }
      ])
      expect(getThreadMessageProviderOccurrencesBeforeUser(threadId, "new-hidden", [source])).toEqual(
        previous
      )
      expect(slots()).toEqual([])
    }
  )

  it("recovers the reserved checkpoint even when a newer compacted head omits its reply", async () => {
    const source = "shared-provider"
    const reply = (occurrence: number, content: string) =>
      new AIMessage({
        id: source,
        content,
        additional_kwargs: {
          [MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY]: source,
          [MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY]: occurrence
        }
      })
    persist([visibleUser("root"), assistant(source, "first reply")])
    reserveThreadGraphTranscriptBoundary(threadId, "hidden")
    await checkpoint([hiddenGoalInput(), reply(2, "old pending reply")])
    pauseAtCommittedBatch(() => migrationState()?.status === "migrating")
    expect(slots()).toEqual([{ message_index: 0, ordinal: 3 }])

    reserveThreadGraphTranscriptBoundary(threadId, "new-hidden")
    const newestCheckpointId = `${checkpointId}-newer`
    await checkpoint(
      [
        new HumanMessage({
          id: "new-hidden",
          content: "[Continuing active goal] Continue",
          additional_kwargs: { [GOAL_CONTINUATION_BOUNDARY_METADATA_KEY]: true }
        }),
        reply(3, "new checkpoint reply")
      ],
      newestCheckpointId
    )

    expect(bootstrap().stats.checkpointId).toBe(newestCheckpointId)
    expect(getThreadMessages(threadId)).toMatchObject([
      { content: "root", ordinal: 0 },
      { content: "first reply", ordinal: 1 },
      { content: "old pending reply", provider_occurrence: 2, ordinal: 3 },
      { content: "new checkpoint reply", provider_occurrence: 3, ordinal: 5 }
    ])
    expect(slots()).toEqual([])
  })
})

it("reads the boundary and provider occurrences in a single WAL snapshot", async () => {
  const root = visibleUser("root")
  const prior = assistant("repeated")
  persist([root, prior])
  reserveThreadGraphTranscriptBoundary(threadId, "hidden")
  await checkpoint([assistant("missing-predecessor"), root, prior, hiddenGoalInput()])
  const prepare = NativeSqliteAdapter.prototype.prepare
  let rebased = false
  const spy = vi.spyOn(NativeSqliteAdapter.prototype, "prepare").mockImplementation(function (
    this: NativeSqliteAdapter,
    sql: string
  ) {
    if (!rebased && sql.includes("GROUP BY provider_source_id, role")) {
      rebased = true
      expect(bootstrap().stats.migratedMessages).toBe(1)
    }
    return prepare.call(this, sql)
  })
  try {
    withThreadMessageIdentitySnapshot(() => {
      expect(getThreadTranscriptBoundaryOrdinal(threadId, "hidden")).toBe(2)
      expect(
        getThreadMessageProviderOccurrencesBeforeUser(threadId, "hidden", ["repeated"])
      ).toEqual([{ provider_source_id: "repeated", role: "assistant", provider_occurrence: 1 }])
      expect(getThreadTranscriptBoundaryOrdinal(threadId, "hidden")).toBe(2)
    })
  } finally {
    spy.mockRestore()
  }
  expect(rebased).toBe(true)
  expect(getThreadTranscriptBoundaryOrdinal(threadId, "hidden")).toBe(3)
})

it("ignores malformed, wrong-role and newer legacy provider encodings", () => {
  const source = "旧回复🚀"
  const malformedSource = "malformed"
  const validId = buildMessageSameRoleDuplicateId(source, "assistant", 2)
  const legacyRows = [
    validId,
    `${buildMessageSameRoleDuplicateId(source, "assistant", 99)}tail`,
    buildMessageSameRoleDuplicateId(source, "tool", 100),
    `${buildMessageRoleCollisionId(malformedSource, "assistant")}:tail`,
    `${buildMessageRoleCollisionId(malformedSource, "assistant")}:3tail`,
    buildMessageRoleCollisionId(malformedSource, "tool", 3)
  ]
  // Simulate durable rows from before provider metadata was written.
  const insert = observer.prepare(
    `INSERT INTO thread_messages (thread_id, message_id, role, content_json, created_at, ordinal)
     VALUES (?, ?, 'assistant', '"fixture"', 0, ?)`
  )
  legacyRows.forEach((id, ordinal) => insert.run(threadId, id, ordinal))
  const boundary = reserveThreadGraphTranscriptBoundary(threadId, "hidden")
  insert.run(
    threadId,
    buildMessageSameRoleDuplicateId(source, "assistant", 101),
    boundary + 1
  )
  expect(
    getThreadMessageProviderOccurrencesBeforeUser(threadId, "hidden", [source, malformedSource])
  ).toEqual([{ provider_source_id: source, role: "assistant", provider_occurrence: 2 }])
})
