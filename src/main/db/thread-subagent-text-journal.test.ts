import { mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const storageState = vi.hoisted(() => ({ databasePath: "", contentDirectory: "" }))

vi.mock("../storage", () => ({
  getDbPath: () => storageState.databasePath,
  getSubagentTranscriptContentDir: () => storageState.contentDirectory,
  getMemorySessionOptInMigrationState: () => ({
    migrated: true,
    legacyMemoryEnabled: false,
    legacyDreamEnabled: false
  }),
  markMemorySessionOptInMigrated: vi.fn()
}))

import * as threadDb from "./index"
import {
  compactSubagentTranscriptManifests,
  exportSubagentTranscriptBlobValue,
  exportSubagentTranscriptTextWithJournal,
  hydrateSubagentTranscriptManifests,
  sliceSubagentTranscriptManifestPage
} from "../services/subagent-transcript-content-store"
import {
  getSubagentTranscriptBlobReferenceHashKey,
  isSubagentTranscriptBlobRef
} from "../../shared/subagent-transcript-storage"

const SOURCE_THREAD_ID = "subagent-journal-source"
const TARGET_THREAD_ID = "subagent-journal-target"
const SUBAGENT_ID = "worker"
const MESSAGE_ID = "assistant-live"

let temporaryDirectory = ""

function scalarCount(sql: string, bindings: Array<string | number> = []): number {
  const statement = threadDb.getDb().prepare(sql)
  statement.bind(bindings)
  try {
    if (!statement.step()) return 0
    return Number((statement.getAsObject() as { count?: unknown }).count) || 0
  } finally {
    statement.free()
  }
}

beforeAll(async () => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "cmb-subagent-journal-"))
  storageState.databasePath = join(temporaryDirectory, "threads.sqlite")
  storageState.contentDirectory = join(temporaryDirectory, "content")
  await threadDb.initializeDatabase()
})

afterAll(async () => {
  await threadDb.closeDatabase()
  rmSync(temporaryDirectory, { recursive: true, force: true })
})

describe("subagent live text journal", () => {
  it("does not step fragment rows for a focused message beyond the journal budget", () => {
    const threadId = "subagent-journal-budget"
    const messageId = "oversized-live"
    threadDb.createThread(threadId)
    const ref = { v: 1, sha256: "e".repeat(64), bytes: 2, kind: "content" }
    threadDb.upsertThreadSubagentManifestMessages(threadId, SUBAGENT_ID, [
      {
        id: messageId,
        role: "assistant",
        content: "",
        content_ref: ref,
        content_is_projection: true,
        content_full_length: 1
      }
    ])
    const database = threadDb.getDb()
    database.run(
      `INSERT INTO thread_subagent_text_fragment_states (
         thread_id, subagent_id, message_id, field, base_ref_sha256,
         base_length, total_length, last_base_length, last_target_length,
         last_delta_sha256, updated_at
       ) VALUES (?, ?, ?, 'content', ?, 1, ?, 1, ?, ?, ?)`,
      [threadId, SUBAGENT_ID, messageId, ref.sha256, 9 * 1024 * 1024, 9 * 1024 * 1024, "f".repeat(64), Date.now()]
    )
    database.run(
      `INSERT INTO thread_subagent_text_fragments (
         thread_id, subagent_id, message_id, field, content_text, created_at
       ) VALUES (?, ?, ?, 'content', 'POISON_FRAGMENT_STEP', ?)`,
      [threadId, SUBAGENT_ID, messageId, Date.now()]
    )
    const originalPrepare = database.prepare
    database.prepare = ((sql, bindings) => {
      const normalized = sql.replace(/\s+/g, " ").toLowerCase()
      if (
        normalized.includes("select message_id, field, content_text") &&
        normalized.includes("thread_subagent_text_fragments")
      ) {
        throw new Error("oversized focused page attempted to materialize journal fragments")
      }
      return originalPrepare.call(database, sql, bindings)
    }) as typeof database.prepare
    try {
      const page = threadDb.getThreadSubagentManifestPage(threadId, SUBAGENT_ID, undefined, 1)
      const message = page.messages[0] as Record<string, unknown>
      expect(message.subagent_content_delta_journal).toBeUndefined()
      expect(Number(message.subagent_content_delta_journal_length)).toBeGreaterThan(
        8 * 1024 * 1024
      )
      expect(message.subagent_content_delta_journal_omitted).toBe(true)
      const selected = sliceSubagentTranscriptManifestPage(page.messages)
      expect(selected.deferredHydration).toBe(true)
      expect(selected.hydrateIndexes).toEqual([])
    } finally {
      database.prepare = originalPrepare
    }
  })

  it("writes only suffix bytes, survives restart/fork, and compacts for export", async () => {
    threadDb.createThread(SOURCE_THREAD_ID)
    threadDb.createThread(TARGET_THREAD_ID)
    const baseContent = "bootstrap-"
    const compacted = await compactSubagentTranscriptManifests({
      [SUBAGENT_ID]: [
        {
          id: MESSAGE_ID,
          role: "assistant",
          content: baseContent,
          reasoning: "",
          created_at: "2026-08-21T00:00:00.000Z",
          subagent_live_text_bootstrap: true
        }
      ]
    })
    const baseMessage = (compacted.manifests[SUBAGENT_ID] as unknown[])[0] as Record<
      string,
      unknown
    >
    expect(isSubagentTranscriptBlobRef(baseMessage.content_ref, "content")).toBe(true)
    expect(isSubagentTranscriptBlobRef(baseMessage.reasoning_ref, "reasoning")).toBe(true)
    const initialReferenceHashKey = getSubagentTranscriptBlobReferenceHashKey(baseMessage)
    threadDb.upsertThreadSubagentManifestMessages(SOURCE_THREAD_ID, SUBAGENT_ID, [
      baseMessage
    ])

    const database = threadDb.getDb()
    const originalRun = database.run
    let fragmentPayloadChars = 0
    let largestManifestWrite = 0
    database.run = ((sql, bindings) => {
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase()
      if (normalized.startsWith("insert into thread_subagent_text_fragments")) {
        const value = Array.isArray(bindings) ? bindings[4] : undefined
        if (typeof value === "string") fragmentPayloadChars += value.length
      }
      if (normalized.startsWith("update thread_subagent_messages")) {
        const value = Array.isArray(bindings) ? bindings[0] : undefined
        if (typeof value === "string") largestManifestWrite = Math.max(largestManifestWrite, value.length)
      }
      return originalRun.call(database, sql, bindings)
    }) as typeof database.run

    const deltas = Array.from({ length: 2_000 }, (_, index) =>
      index === 1_000 ? `${"e".repeat(4_095)}😀z` : `d${index}|`
    )
    let persistedLength = baseContent.length
    try {
      for (const delta of deltas) {
        const targetLength = persistedLength + delta.length
        const appended = threadDb.appendThreadSubagentManifestTextDeltas(
          SOURCE_THREAD_ID,
          SUBAGENT_ID,
          {
            ...baseMessage,
            content: `tail-${targetLength}`,
            content_full_length: targetLength,
            subagent_text_deltas: {
              content: {
                v: 1,
                baseRefSha256: (baseMessage.content_ref as { sha256: string }).sha256,
                baseLength: persistedLength,
                targetLength,
                delta
              }
            }
          }
        )
        expect(appended).toBeDefined()
        persistedLength = targetLength
      }
    } finally {
      database.run = originalRun
    }

    const expectedSuffix = deltas.join("")
    let expectedContent = `${baseContent}${expectedSuffix}`
    expect(fragmentPayloadChars).toBe(expectedSuffix.length)
    expect(largestManifestWrite).toBeLessThan(2_000)
    expect(
      getSubagentTranscriptBlobReferenceHashKey(
        threadDb.getThreadSubagentManifestPage(
          SOURCE_THREAD_ID,
          SUBAGENT_ID,
          undefined,
          1
        ).messages[0]
      )
    ).toBe(initialReferenceHashKey)

    // Same range/length but different bytes must never be acknowledged as a retry.
    expect(
      threadDb.appendThreadSubagentManifestTextDeltas(SOURCE_THREAD_ID, SUBAGENT_ID, {
        ...baseMessage,
        content_full_length: persistedLength,
        subagent_text_deltas: {
          content: {
            v: 1,
            baseRefSha256: (baseMessage.content_ref as { sha256: string }).sha256,
            baseLength: persistedLength - deltas.at(-1)!.length,
            targetLength: persistedLength,
            delta: "x".repeat(deltas.at(-1)!.length)
          }
        }
      })
    ).toBeUndefined()

    // A tool/status boundary may arrive in the same frame as the next suffix.
    // Compact only the structural field and atomically retain the text journal.
    const structuralSuffix = "|tool-boundary|"
    const structuralTargetLength = persistedLength + structuralSuffix.length
    const structuralCompacted = await compactSubagentTranscriptManifests({
      [SUBAGENT_ID]: [
        {
          ...baseMessage,
          content: `tail-${structuralTargetLength}`,
          content_is_projection: true,
          content_full_length: structuralTargetLength,
          status: "streaming",
          tool_calls: [{ id: "call-1", name: "lookup", args: { query: "journal" } }],
          subagent_text_deltas: {
            content: {
              v: 1,
              baseRefSha256: (baseMessage.content_ref as { sha256: string }).sha256,
              baseLength: persistedLength,
              targetLength: structuralTargetLength,
              delta: structuralSuffix
            }
          },
          subagent_preserve_text_journal: true
        }
      ]
    })
    const structuralMessage = (
      structuralCompacted.manifests[SUBAGENT_ID] as unknown[]
    )[0]
    expect(
      threadDb.appendThreadSubagentManifestTextDeltas(
        SOURCE_THREAD_ID,
        SUBAGENT_ID,
        structuralMessage
      )
    ).toBeDefined()
    persistedLength = structuralTargetLength
    expectedContent += structuralSuffix

    const fragmentsBeforeMetadataPatch = scalarCount(
      "SELECT COUNT(*) AS count FROM thread_subagent_text_fragments WHERE thread_id = ?",
      [SOURCE_THREAD_ID]
    )
    const metadataCompacted = await compactSubagentTranscriptManifests({
      [SUBAGENT_ID]: [
        {
          ...baseMessage,
          content: `tail-${persistedLength}`,
          content_is_projection: true,
          content_full_length: persistedLength,
          status: "complete",
          subagent_description: "completed after tool boundary",
          tool_calls: [{ id: "call-1", name: "lookup", args: { query: "journal" } }],
          subagent_preserve_text_journal: true
        }
      ]
    })
    const metadataMessage = (metadataCompacted.manifests[SUBAGENT_ID] as unknown[])[0]
    expect(
      threadDb.patchThreadSubagentManifestPreservingTextJournal(
        SOURCE_THREAD_ID,
        SUBAGENT_ID,
        metadataMessage
      )
    ).toBeDefined()
    expect(
      scalarCount(
        "SELECT COUNT(*) AS count FROM thread_subagent_text_fragments WHERE thread_id = ?",
        [SOURCE_THREAD_ID]
      )
    ).toBe(fragmentsBeforeMetadataPatch)
    const structurallyHydrated = await hydrateSubagentTranscriptManifests({
      [SUBAGENT_ID]: [
        threadDb.getThreadSubagentManifestPage(
          SOURCE_THREAD_ID,
          SUBAGENT_ID,
          undefined,
          10
        ).messages[0]
      ]
    })
    const structurallyHydratedMessage = (
      structurallyHydrated[SUBAGENT_ID] as Array<Record<string, unknown>>
    )[0]
    expect(structurallyHydratedMessage.content).toBe(expectedContent)
    expect(structurallyHydratedMessage.status).toBe("complete")
    expect(structurallyHydratedMessage.tool_calls).toEqual([
      { id: "call-1", name: "lookup", args: { query: "journal" } }
    ])
    expect(getSubagentTranscriptBlobReferenceHashKey(structurallyHydratedMessage)).toBe(
      initialReferenceHashKey
    )

    const rebasedSuffix = "|after-ack|"
    const rebasedTargetLength = persistedLength + rebasedSuffix.length
    const prepareBeforeRebasedAppend = database.prepare
    database.prepare = ((sql, bindings) => {
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase()
      if (
        normalized.startsWith("select content_text from thread_subagent_text_fragments")
      ) {
        throw new Error("rebased next delta attempted to scan the full journal")
      }
      return prepareBeforeRebasedAppend.call(database, sql, bindings)
    }) as typeof database.prepare
    try {
      expect(
        threadDb.appendThreadSubagentManifestTextDeltas(
          SOURCE_THREAD_ID,
          SUBAGENT_ID,
          {
            ...baseMessage,
            content: `tail-${rebasedTargetLength}`,
            content_is_projection: true,
            content_full_length: rebasedTargetLength,
            subagent_text_deltas: {
              content: {
                v: 1,
                baseRefSha256: (baseMessage.content_ref as { sha256: string }).sha256,
                baseLength: persistedLength,
                targetLength: rebasedTargetLength,
                delta: rebasedSuffix
              }
            }
          }
        )
      ).toBeDefined()
    } finally {
      database.prepare = prepareBeforeRebasedAppend
    }
    persistedLength = rebasedTargetLength
    expectedContent += rebasedSuffix

    await threadDb.flushStrict()
    await threadDb.closeDatabase()
    await threadDb.initializeDatabase()
    const restarted = threadDb.getThreadSubagentManifestPage(
      SOURCE_THREAD_ID,
      SUBAGENT_ID,
      undefined,
      10
    ).messages[0]
    const hydrated = await hydrateSubagentTranscriptManifests({
      [SUBAGENT_ID]: [restarted]
    })
    expect(
      ((hydrated[SUBAGENT_ID] as unknown[])[0] as Record<string, unknown>).content
    ).toBe(expectedContent)

    const copied = threadDb.copyThreadSubagentManifestRowsPage({
      sourceThreadId: SOURCE_THREAD_ID,
      targetThreadId: TARGET_THREAD_ID,
      subagentId: SUBAGENT_ID,
      limit: 10
    })
    expect(copied.copied).toBe(1)
    const copiedHydrated = await hydrateSubagentTranscriptManifests({
      [SUBAGENT_ID]: [
        threadDb.getThreadSubagentManifestPage(
          TARGET_THREAD_ID,
          SUBAGENT_ID,
          undefined,
          10
        ).messages[0]
      ]
    })
    expect(
      ((copiedHydrated[SUBAGENT_ID] as unknown[])[0] as Record<string, unknown>).content
    ).toBe(expectedContent)

    const streamedExportPath = join(temporaryDirectory, "streamed-export.json")
    const baseRef = baseMessage.content_ref
    if (!isSubagentTranscriptBlobRef(baseRef, "content")) throw new Error("missing base ref")
    await exportSubagentTranscriptTextWithJournal(
      baseRef,
      streamedExportPath,
      (afterFragmentId) =>
        threadDb.getThreadSubagentTextJournalChunkPage(
          SOURCE_THREAD_ID,
          SUBAGENT_ID,
          MESSAGE_ID,
          "content",
          afterFragmentId,
          16
        )
    )
    expect(JSON.parse(readFileSync(streamedExportPath, "utf8"))).toBe(expectedContent)

    const terminal = await compactSubagentTranscriptManifests(hydrated)
    const terminalMessage = (terminal.manifests[SUBAGENT_ID] as unknown[])[0] as Record<
      string,
      unknown
    >
    threadDb.upsertThreadSubagentManifestMessages(SOURCE_THREAD_ID, SUBAGENT_ID, [
      terminalMessage
    ])
    expect(
      scalarCount(
        "SELECT COUNT(*) AS count FROM thread_subagent_text_fragments WHERE thread_id = ?",
        [SOURCE_THREAD_ID]
      )
    ).toBe(0)
    const exportRef = terminalMessage.content_ref
    expect(isSubagentTranscriptBlobRef(exportRef, "content")).toBe(true)
    if (!isSubagentTranscriptBlobRef(exportRef, "content")) throw new Error("missing ref")
    const exportPath = join(temporaryDirectory, "export.json")
    await exportSubagentTranscriptBlobValue(exportRef, exportPath)
    expect(JSON.parse(readFileSync(exportPath, "utf8"))).toBe(expectedContent)

    threadDb.deleteThread(TARGET_THREAD_ID)
    expect(
      scalarCount(
        "SELECT COUNT(*) AS count FROM thread_subagent_text_fragments WHERE thread_id = ?",
        [TARGET_THREAD_ID]
      )
    ).toBe(0)
  }, 120_000)
})
