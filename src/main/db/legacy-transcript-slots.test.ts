import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildMessageSameRoleDuplicateId,
  MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY,
  MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY
} from "../../shared/message-role-collision"
import { GOAL_CONTINUATION_BOUNDARY_METADATA_KEY } from "../agent/goals/internal-prompt"
import { CHECKPOINT_RUNTIME_PROJECTION_CANCELLED } from "../checkpointer/runtime-projection-protocol"
import { bootstrapLegacyCheckpointTranscript } from "../checkpointer/runtime-projection-store"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import {
  closeDatabase,
  createThread,
  getThreadMessageProviderOccurrencesBeforeUser,
  getThreadMessages,
  getThreadTranscriptBoundaryOrdinal,
  hasUnresolvedLegacyTranscriptSlots,
  initializeDatabase,
  moveThreadMessagesAfterAnchor,
  reserveThreadGraphTranscriptBoundary,
  upsertThreadMessages,
  withThreadMessageIdentitySnapshot
} from "."
import { NativeSqliteAdapter } from "./native-sqlite-adapter"

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

async function checkpoint(messages: BaseMessage[], id = checkpointId): Promise<void> {
  const saver = new SqlJsSaver(checkpointPath, undefined, { maxRootCheckpoints: 3 })
  try {
    await saver.put(
      { configurable: { thread_id: threadId, checkpoint_ns: "" } },
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
  return bootstrapLegacyCheckpointTranscript(
    checkpointPath,
    storage.databasePath,
    threadId,
    "",
    cancellation
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
