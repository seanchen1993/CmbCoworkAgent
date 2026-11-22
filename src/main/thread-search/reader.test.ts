import { ThreadSearchSession } from "./session"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { once } from "node:events"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import { build } from "esbuild"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { iterateChatSearchLocations, projectChatSearchPlan } from "../../shared/chat-search-index"
import { matchesOrdinaryThreadScope } from "../../shared/thread-search-scope"
import { createThreadSearchMessagePlan } from "../../shared/thread-search-projection"
import { THREAD_SEARCH_GOAL_EVENT_SQL } from "./goal-event"
import * as threadDb from "../db"
import { sqliteRecoveryFamilyKey } from "../db/sqlite-recovery-family"
import { threadIncarnationKey } from "../../shared/thread-incarnation"
import { REMOTE_INBOX_WORKSPACE_NAME } from "../../shared/remote-inbox-workspace"
import type { SearchBackfillCandidate, SearchCommand, SearchReply } from "./protocol"
import {
  createThreadSearchReader,
  THREAD_SEARCH_BACKFILL_SQL,
  THREAD_SEARCH_IDENTITY_SQL
} from "./reader"

vi.mock("../storage", () => ({
  getDbPath: () => ":memory:",
  getMemorySessionOptInMigrationState: () => ({
    migrated: true,
    legacyMemoryEnabled: false,
    legacyDreamEnabled: false
  })
}))

let sqlite: DatabaseSync
let flag: Int32Array

beforeEach(async () => {
  const db = await threadDb.initializeDatabase()
  // Use the database's real schema and indexes in a separate native reader fixture.
  sqlite = new DatabaseSync(":memory:")
  const schema = db.exec(
    `SELECT sql FROM sqlite_master
     WHERE sql IS NOT NULL AND (type IN ('table', 'index') OR (type = 'trigger' AND name LIKE 'search_%'))
       AND tbl_name IN ('threads', 'thread_messages', 'thread_message_fragments', 'thread_message_fragment_states',
         'thread_goal_events', 'thread_search_structure_versions', 'thread_search_message_versions',
         'thread_search_occurrence_versions', 'thread_search_coverage', 'legacy_checkpoint_transcript_migrations',
         'legacy_checkpoint_transcript_parents', 'legacy_checkpoint_search_overlaps')
     ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END`
  )
  for (const [sql] of schema[0].values) {
    if (typeof sql === "string") sqlite.exec(sql)
  }
  flag = new Int32Array(new SharedArrayBuffer(4))
})

afterEach(async () => {
  sqlite.close()
  await threadDb.closeDatabase()
})

function insertThread(threadId: string) {
  sqlite
    .prepare("INSERT INTO threads(thread_id, created_at, updated_at) VALUES (?, 1, 1)")
    .run(threadId)
  return { threadId, incarnation: { token: null, legacyCreatedAt: 1 } }
}

describe("isolated thread search read path", () => {
  it("uses a physical boundary through sparse projects without including unverified features", () => {
    const insert = sqlite.prepare(
      "INSERT INTO threads(thread_id, created_at, updated_at, metadata, title) VALUES (?, 1, ?, ?, ?)"
    )
    const project = (projectId: string) => ({ harnessProjectSession: { projectId, kind: "planning" } })
    const feature = (projectId: string, slug: string) => ({ harnessFeature: { projectId, slug } })
    for (let i = 0; i < 150; i++) insert.run("noise-" + i, 1000 + i, JSON.stringify(project("other")), "Noise")
    insert.run("project", 2, JSON.stringify(project(" target ")), "Project")
    insert.run("verified", 3, JSON.stringify(feature("target", "known")), "Feature")
    insert.run("unknown", 4, JSON.stringify(feature("uncertain", "unknown")), "Unconfirmed")
    insert.run("removed", 5, JSON.stringify(feature("target", "removed")), "Removed")
    insert.run("ambiguous", 6, JSON.stringify({ ...project("target"), ...feature("target", "known") }), "Ambiguous")
    insert.run("ordinary", 7, "{}", "Ordinary")
    const catalog = {
      generation: "current",
      projects: new Map([
        ["target", { label: "Project", features: new Set(["known"]) }],
        ["uncertain", { label: "Another project" }]
      ])
    }
    const reader = createThreadSearchReader(sqlite)
    const selected = reader.captureCandidates(undefined, flag, { kind: "project", projectId: "target" }, catalog)
    expect(selected.limited).toBe(false)
    expect(selected.candidates).toMatchObject([
      { threadId: "verified", route: { kind: "featureSession", projectId: "target", slug: "known" } },
      { threadId: "project", route: { kind: "projectSession", projectId: "target" } }
    ])
    const all = reader.captureCandidates(undefined, flag, { kind: "all" }, catalog)
    expect(all.routeUnavailable).toBe(true)
    expect(all.candidates.map(({ threadId }) => threadId)).toEqual(["ordinary", "verified", "project"])
    const unavailable = reader.captureCandidates(undefined, flag, { kind: "all" })
    expect(unavailable.catalogUnavailable).toBe(true)
    expect(unavailable.candidates.map(({ threadId }) => threadId)).toEqual(["ordinary"])
  })

  it("keeps valid project hits beside invalid JSON and reports oversized project metadata", () => {
    const insert = sqlite.prepare(
      "INSERT INTO threads(thread_id, created_at, updated_at, metadata) VALUES (?, 1, ?, ?)"
    )
    const owned = { harnessProjectSession: { projectId: "project", kind: "chat" } }
    insert.run("valid", 1, JSON.stringify(owned))
    insert.run("invalid-json", 2, "{")
    insert.run("oversized", 3, JSON.stringify({ ...owned, padding: "x".repeat(256 * 1024) }))
    const reader = createThreadSearchReader(sqlite)
    const catalog = { generation: "current", projects: new Map([["project", { label: "Project" }]]) }
    const scoped = reader.captureCandidates(undefined, flag, { kind: "project", projectId: "project" }, catalog)
    expect(scoped.routeUnavailable).toBe(true)
    expect(scoped.candidates.map(({ threadId }) => threadId)).toEqual(["valid"])
    const all = reader.captureCandidates(undefined, flag, { kind: "all" }, catalog)
    expect(all.routeUnavailable).toBe(true)
    expect(all.candidates.map(({ threadId }) => threadId)).toEqual(["invalid-json", "valid"])
  })

  it("does not return a project title whose route changed after directory capture", () => {
    insertThread("moved")
    sqlite.prepare("UPDATE threads SET title = ?, metadata = ? WHERE thread_id = ?")
      .run("unique title", JSON.stringify({ harnessProjectSession: { projectId: "source", kind: "chat" } }), "moved")
    const reader = createThreadSearchReader(sqlite)
    const session = new ThreadSearchSession(
      "test",
      { query: "unique", scope: { kind: "projects" } },
      reader,
      flag.buffer as SharedArrayBuffer,
      () => "verified",
      { generation: "current", projects: new Map([["source", { label: "Source" }]]) }
    )
    sqlite.prepare("UPDATE threads SET metadata = ? WHERE thread_id = ?").run(
      JSON.stringify({ harnessProjectSession: { projectId: "destination", kind: "chat" } }), "moved"
    )
    expect(session.page(null)).toMatchObject({
      results: [],
      coverage: { completeness: "partial", reasons: ["project-catalog-changed"] }
    })
  })
  it("rechecks foreground-required coverage after the reply occurrence evidence changes", () => {
    const { incarnation } = insertThread("changed")
    sqlite.exec(`INSERT INTO thread_messages (thread_id, message_id, role, content_json, ordinal, created_at)
      VALUES ('changed', 'anchor', 'assistant', '"ambiguous content"', 0, 1)`)
    sqlite.prepare(`INSERT INTO thread_search_coverage
      (thread_id, incarnation, source, epoch, status, checked_at, occurrence_version)
      SELECT 'changed', ?, 'snapshot', 0, 'foreground-required', ?, version
      FROM thread_search_occurrence_versions WHERE thread_id = 'changed'`)
      .run(threadIncarnationKey(incarnation), Date.now())
    const reader = createThreadSearchReader(sqlite)
    const coverage = () => reader.checkpointCoverage("changed", incarnation, "snapshot", 0)
    expect(coverage()?.status).toBe("foreground-required")
    sqlite.exec(`INSERT INTO legacy_checkpoint_transcript_migrations
      (thread_id, checkpoint_id, total_messages, next_index, status, source_key,
        updated_at, search_projection_state, occurrence_unverified_version)
      SELECT 'changed', 'selected', 1, 1, 'complete', 'snapshot', 1, 'unverified', version
      FROM thread_search_occurrence_versions WHERE thread_id = 'changed'`)
    expect(reader.checkpointMigration("changed")?.occurrence_evidence_changed).toBe(0)

    sqlite.exec(`UPDATE thread_messages SET content_json = '"unique content"' WHERE thread_id = 'changed'`)
    expect(reader.structureEpoch("changed")).toBe(0)
    expect(coverage()).toBeUndefined()
    expect(reader.checkpointMigration("changed")?.occurrence_evidence_changed).toBe(1)

    sqlite.exec(`UPDATE legacy_checkpoint_transcript_migrations SET occurrence_unverified_version =
      (SELECT version FROM thread_search_occurrence_versions WHERE thread_id = 'changed')`)
    expect(reader.checkpointMigration("changed")?.occurrence_evidence_changed).toBe(0)
    sqlite.exec("UPDATE thread_messages SET ordinal = 1 WHERE thread_id = 'changed'")
    expect(reader.checkpointMigration("changed")?.occurrence_evidence_changed).toBe(1)

    sqlite.exec("UPDATE thread_search_coverage SET status = 'verified' WHERE thread_id = 'changed'")
    expect(coverage()?.status).toBe("verified")
  })

  it("invalidates an overlap when stream rollback restores the message at the same payload version", () => {
    insertThread("restored")
    const insert = sqlite.prepare(`INSERT INTO thread_messages
      (thread_id, message_id, role, content_json, ordinal, created_at)
      VALUES ('restored', 'reply', 'assistant', ?, 0, 1)`)
    insert.run(JSON.stringify("saved prefix"))
    sqlite.exec(`INSERT INTO legacy_checkpoint_search_overlaps(thread_id, message_id, message_version)
      VALUES ('restored', 'reply', 0)`)
    const reader = createThreadSearchReader(sqlite)
    expect(reader.checkpointOverlapChanged("restored")).toBe(false)
    sqlite.exec("BEGIN")
    sqlite.exec("DELETE FROM thread_messages WHERE thread_id = 'restored' AND message_id = 'reply'")
    insert.run(JSON.stringify("saved prefix and ending"))
    sqlite.exec("COMMIT")
    expect(sqlite.prepare("SELECT version FROM thread_search_message_versions WHERE thread_id = 'restored'").get())
      .toBeUndefined()
    expect(reader.checkpointOverlapChanged("restored")).toBe(true)
  })

  it("rechecks a newly written checkpoint WAL between Worker pages", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cmb-search-wal-audit-"))
    const databasePath = join(directory, "messages.db")
    const checkpointPath = join(directory, "record.sqlite")
    const workerPath = join(directory, "search.cjs")
    const durable = new DatabaseSync(databasePath)
    const checkpoint = new DatabaseSync(checkpointPath)
    let checkpointClosed = false
    let worker: Worker | undefined
    try {
      for (const row of sqlite.prepare(`SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
        ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END`).iterate()) {
        if (typeof row.sql === "string") durable.exec(row.sql)
      }
      checkpoint.exec(`CREATE TABLE checkpoints (checkpoint_id TEXT PRIMARY KEY);
        INSERT INTO checkpoints VALUES ('first');
        PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;`)
      const sourceKey = sqliteRecoveryFamilyKey(checkpointPath)
      durable.exec(`INSERT INTO threads(thread_id, created_at, updated_at) VALUES ('record', 1, 1)`)
      durable.prepare(`INSERT INTO legacy_checkpoint_transcript_migrations
        (thread_id, checkpoint_id, total_messages, next_index, status, updated_at, source_key)
        VALUES ('record', 'first', 0, 0, 'complete', 1, ?)`).run(sourceKey)
      await build({
        entryPoints: [fileURLToPath(new URL("./thread-search-worker.ts", import.meta.url))],
        outfile: workerPath,
        bundle: true,
        platform: "node",
        format: "cjs"
      })
      worker = new Worker(workerPath, { workerData: { databasePath, checkpointDirectory: directory } })
      const backfill: SearchBackfillCandidate[] = []
      const failed = once(worker, "error").then(([error]) => { throw error })
      const request = async (command: SearchCommand) => {
        const response = new Promise<SearchReply>((resolve) => {
          const listener = (event: { reply?: SearchReply; backfill?: SearchBackfillCandidate }) => {
            if (event.backfill) backfill.push(event.backfill)
            if (!event.reply) return
            worker!.off("message", listener)
            resolve(event.reply)
          }
          worker!.on("message", listener)
        })
        worker!.postMessage(command)
        return Promise.race([response, failed])
      }
      let reply = await request({
        type: "start", id: "check", request: { query: "checkpoint-only" },
        cancellation: new SharedArrayBuffer(4)
      })
      expect(reply).toMatchObject({ scanStatus: "running" })
      checkpoint.exec(`INSERT INTO checkpoints VALUES ('changed')`)
      const changedKey = sqliteRecoveryFamilyKey(checkpointPath)
      expect(changedKey).not.toBe(sourceKey)
      while ("nextCursor" in reply && reply.nextCursor) {
        reply = await request({ type: "continue", id: "check", cursor: reply.nextCursor })
      }
      expect(reply).toMatchObject({
        scanStatus: "complete", coverage: { completeness: "partial", reasons: ["legacy-pending"] }
      })
      expect(backfill).toMatchObject([{ threadId: "record", sourceKey: changedKey }])

      checkpoint.close()
      checkpointClosed = true
      rmSync(checkpointPath)
      durable.exec("UPDATE legacy_checkpoint_transcript_migrations SET status = 'migrating' WHERE thread_id = 'record'")
      reply = await request({ type: "start", id: "interrupted", request: { query: "checkpoint-only" },
        cancellation: new SharedArrayBuffer(4) })
      while ("nextCursor" in reply && reply.nextCursor) {
        reply = await request({ type: "continue", id: "interrupted", cursor: reply.nextCursor })
      }
      expect(reply).toMatchObject({ scanStatus: "complete", coverage: {
        completeness: "partial", reasons: ["unavailable-source"], failedThreads: 1
      } })
      expect(backfill).toHaveLength(1)

      const childOnly = new DatabaseSync(checkpointPath)
      try {
        childOnly.exec(`CREATE TABLE checkpoints (checkpoint_ns TEXT);
          INSERT INTO checkpoints VALUES ('child');`)
      } finally { childOnly.close() }
      durable.prepare(`INSERT INTO thread_search_coverage (thread_id, incarnation, source, epoch, status, checked_at)
        VALUES ('record', ?, ?, 0, 'notApplicable', ?)`)
        .run(threadIncarnationKey({ token: null, legacyCreatedAt: 1 }), sqliteRecoveryFamilyKey(checkpointPath), Date.now())
      reply = await request({ type: "start", id: "empty-root", request: { query: "checkpoint-only" },
        cancellation: new SharedArrayBuffer(4) })
      while ("nextCursor" in reply && reply.nextCursor) {
        reply = await request({ type: "continue", id: "empty-root", cursor: reply.nextCursor })
      }
      expect(reply).toMatchObject({ scanStatus: "complete", coverage: {
        completeness: "partial", reasons: ["unavailable-source"], failedThreads: 1
      } })

      durable.prepare(`UPDATE legacy_checkpoint_transcript_migrations
        SET status = 'complete', source_key = ?, search_projection_state = 'truncated'
        WHERE thread_id = 'record'`).run(sqliteRecoveryFamilyKey(checkpointPath))
      reply = await request({ type: "start", id: "lossy-audited", request: { query: "checkpoint-only" },
        cancellation: new SharedArrayBuffer(4) })
      while ("nextCursor" in reply && reply.nextCursor) {
        reply = await request({ type: "continue", id: "lossy-audited", cursor: reply.nextCursor })
      }
      expect(reply).toMatchObject({ scanStatus: "complete", coverage: {
        completeness: "partial", reasons: ["projection-truncated"], pendingThreads: 0, failedThreads: 0
      } })
      expect(backfill).toHaveLength(1)

      durable.exec(`INSERT INTO thread_messages (thread_id, message_id, role, content_json, created_at, ordinal)
        VALUES ('record', 'reply', 'assistant', '"published"', 1, 0);
        INSERT INTO legacy_checkpoint_search_overlaps(thread_id, message_id, message_version)
        VALUES ('record', 'reply', 0);
        UPDATE legacy_checkpoint_transcript_migrations SET search_projection_state = 'overlap-unverified';`)
      const scan = async (id: string) => {
        let page = await request({ type: "start", id, request: { query: "checkpoint-only" },
          cancellation: new SharedArrayBuffer(4) })
        while ("nextCursor" in page && page.nextCursor) {
          page = await request({ type: "continue", id, cursor: page.nextCursor })
        }
        return page
      }
      expect(await scan("overlap-current")).toMatchObject({
        coverage: { completeness: "partial", reasons: ["legacy-unverified"] }
      })
      expect(backfill).toHaveLength(1)
      durable.exec(`UPDATE thread_messages SET content_json = '"published in full"' WHERE message_id = 'reply'`)
      expect(await scan("overlap-changed")).toMatchObject({
        coverage: { completeness: "partial", reasons: ["legacy-pending"] }
      })
      expect(backfill).toHaveLength(2)
      durable.exec(`DELETE FROM legacy_checkpoint_search_overlaps;
        UPDATE legacy_checkpoint_transcript_migrations SET search_projection_state = 'complete';`)
      expect(await scan("overlap-rechecked")).toMatchObject({ coverage: { completeness: "complete", reasons: [] } })
      durable.exec(`INSERT INTO legacy_checkpoint_search_overlaps (thread_id, message_id, message_version)
        SELECT thread_id, message_id, version FROM thread_search_message_versions WHERE message_id = 'reply';
        UPDATE legacy_checkpoint_transcript_migrations SET search_projection_state = 'overlap-unverified';
        UPDATE thread_messages SET provider_source_id = 'original-reply', provider_occurrence = 1
          WHERE message_id = 'reply';`)
      expect(await scan("overlap-provider-changed")).toMatchObject({
        coverage: { completeness: "partial", reasons: ["legacy-pending"] }
      })
      expect(backfill).toHaveLength(3)

      rmSync(checkpointPath)
      durable.exec("UPDATE legacy_checkpoint_transcript_migrations SET search_projection_state = NULL")
      reply = await request({ type: "start", id: "legacy-offline", request: { query: "checkpoint-only" },
        cancellation: new SharedArrayBuffer(4) })
      while ("nextCursor" in reply && reply.nextCursor) {
        reply = await request({ type: "continue", id: "legacy-offline", cursor: reply.nextCursor })
      }
      expect(reply).toMatchObject({ scanStatus: "complete", coverage: {
        completeness: "partial", reasons: ["legacy-unverified"], pendingThreads: 0, failedThreads: 0
      } })
      expect(backfill).toHaveLength(3)
    } finally {
      await worker?.terminate()
      if (!checkpointClosed) checkpoint.close()
      durable.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 30_000)

  it.each([
    ["Your plan is *ready* to send.", "plan is ready to send"],
    ["Your plan is _ready_ to send.", "plan is ready to send"],
    [String.raw`Open C:\ai\CmbCoworkAgent now.`, String.raw`C:\ai\CmbCoworkAgent`],
    ["```txt\nEntity &lt;ready&gt; verbatim\n```", "&lt;ready&gt;"],
    ["The value `&lt;ready&gt;` stays literal.", "&lt;ready&gt;"],
    ["Release is **very *ready*** for rollout.", "very ready for rollout"],
    ["Inline code is ` line\nbreak ` today.", "line break"],
    ["Build &copy; 2026 after review.", "Build © 2026"],
    ["Before [missing book][REF_ID] after.", "[REF_ID]"],
    ["Answer &#113;ux", "qux"],
    ["Check the Kelvin scale", "kelvin"]
  ])("finds visibly rendered text in %s", (source, query) => {
    const { threadId } = insertThread("markdown-projection")
    sqlite.prepare(`INSERT INTO thread_messages(thread_id,message_id,role,content_json,created_at,ordinal)
      VALUES (?, 'answer', 'assistant', ?, 1, 0)`).run(threadId, JSON.stringify(source))
    const session = new ThreadSearchSession(
      "markdown", { query }, createThreadSearchReader(sqlite), flag.buffer as SharedArrayBuffer,
      () => "verified"
    )
    let page = session.page(null)!
    const results = [...page.results]
    while (page.nextCursor) {
      page = session.page(page.nextCursor)!
      results.push(...page.results)
    }
    expect(results).toMatchObject([{ threadId, navigation: "exact", target: { messageId: "answer" } }])
  })

  it("paginates across title, durable message and Goal sources without repeating hits", () => {
    for (const id of ["title", "message", "goal", "pending"]) insertThread(id)
    sqlite.exec(`UPDATE threads SET title = 'Needle title' WHERE thread_id = 'title';
      INSERT INTO thread_messages(thread_id,message_id,role,content_json,created_at,ordinal,goal_id)
      VALUES ('message','durable','assistant','"the NEEDLE answer"',1,0,NULL),
             ('goal','anchor','user',json_quote('[Starting active goal] <untrusted_objective>seed</untrusted_objective>'),2,0,'goal-id');
      INSERT INTO thread_goal_events(thread_id,goal_id,message,created_at,transcript_message_id)
      VALUES ('goal','goal-id','__cmb_goal_user_message__:/goal Needle objective',1,'anchor'),
             ('goal','goal-id','__cmb_goal_user_message__:/goal status',1,NULL);`)
    const session = new ThreadSearchSession(
      "id",
      { query: "needle", limit: 1 },
      createThreadSearchReader(sqlite),
      flag.buffer as SharedArrayBuffer,
      (id) =>
        id === "title" ? "failed" : id === "pending" || id === "message" ? "pending" : "verified"
    )
    const first = session.page(null)!
    expect(first.results).toMatchObject([{ threadId: "title", matchedBy: "title" }])
    expect(session.page("id.900")).toBeNull()
    const results = [...first.results]
    let page = first
    for (let i = 0; page.nextCursor && i < 20; i += 1) {
      const cursor = page.nextCursor
      page = session.page(cursor)!
      expect(session.page(cursor)).toBe(page)
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(128 * 1024)
      results.push(...page.results)
    }
    expect(results.map((result) => result.threadId)).toEqual(["title", "message", "goal"])
    expect(results[2]).toMatchObject({
      navigation: "exact",
      target: { kind: "goalEvent", anchorMessageId: "anchor" }
    })
    expect(page).toMatchObject({
      scanStatus: "complete",
      coverage: { completeness: "partial", pendingThreads: 2, failedThreads: 1 }
    })
  })

  it("reports incomplete coverage when the visible Goal representation cannot be verified", () => {
    const { threadId } = insertThread("large-goal-anchor-window")
    const insert = sqlite.prepare(`INSERT INTO thread_messages
      (thread_id, message_id, role, content_json, created_at, ordinal, goal_id, active_window_id)
      VALUES (?, ?, 'user', ?, ?, ?, ?, ?)`)
    insert.run(threadId, "older-1", JSON.stringify("/goal " + "甲".repeat(23_000)), 1000, 0, null, null)
    insert.run(threadId, "older-2", JSON.stringify("/goal " + "乙".repeat(23_000)), 2000, 1, null, null)
    insert.run(threadId, "anchor", JSON.stringify("[Starting active goal]\n<untrusted_objective>unique objective</untrusted_objective>"),
      5010, 2, "goal", "window")
    sqlite.prepare(`INSERT INTO thread_goal_events (thread_id, goal_id, active_window_id, message, created_at)
      VALUES (?, 'goal', 'window', '__cmb_goal_user_message__:/goal unique objective', 5000)`).run(threadId)
    const session = new ThreadSearchSession(
      "goal-window", { query: "unique objective" }, createThreadSearchReader(sqlite),
      flag.buffer as SharedArrayBuffer, () => "verified"
    )
    let page = session.page(null)!
    const results = [...page.results]
    while (page.nextCursor) {
      page = session.page(page.nextCursor)!
      results.push(...page.results)
    }
    expect(results).toEqual([])
    expect(page.coverage).toMatchObject({ completeness: "partial", reasons: ["legacy-unverified"] })
  })

  it.each([
    { anchored: true, storage: "inline" },
    { anchored: false, storage: "inline" },
    { anchored: true, storage: "fragmented" },
    { anchored: false, storage: "structured" }
  ])("does not spend Goal proof bytes on an unrelated $storage paste (anchored=$anchored)", ({
    anchored, storage
  }) => {
    const { threadId } = insertThread("goal-after-paste")
    const insert = sqlite.prepare(`INSERT INTO thread_messages
      (thread_id, message_id, role, content_json, created_at, ordinal)
      VALUES (?, ?, 'user', ?, ?, ?)`)
    const paste = "\t\r\n以下是我需要检查的资料\n" + "甲".repeat(52_000)
    insert.run(threadId, "paste", JSON.stringify(
      storage === "fragmented" ? "" : storage === "structured" ? [{ type: "text", text: paste }] : paste
    ), 4999, 0)
    if (storage === "fragmented") {
      const fragment = sqlite.prepare(`INSERT INTO thread_message_fragments
        (thread_id, message_id, content_text, created_at) VALUES (?, 'paste', ?, 4999)`)
      for (const part of paste.match(/.{1,16384}/gs)!) fragment.run(threadId, part)
      sqlite.prepare(`INSERT INTO thread_message_fragment_states
        (thread_id, message_id, total_chars, updated_at) VALUES (?, 'paste', ?, 4999)`).run(threadId, paste.length)
    }
    if (anchored) insert.run(threadId, "hidden", JSON.stringify(
      "[Starting active goal]\n<untrusted_objective>model-only prompt</untrusted_objective>"), 5001, 1)
    sqlite.prepare(`INSERT INTO thread_goal_events (thread_id, message, created_at, transcript_message_id)
      VALUES (?, '__cmb_goal_user_message__:/goal unique objective', 5000, ?)`)
      .run(threadId, anchored ? "hidden" : null)
    const session = new ThreadSearchSession("id", { query: "unique objective" },
      createThreadSearchReader(sqlite), flag.buffer as SharedArrayBuffer, () => "verified")
    let page = session.page(null)!
    const results = [...page.results]
    while (page.nextCursor) {
      page = session.page(page.nextCursor)!
      results.push(...page.results)
    }
    expect(results).toMatchObject([{
      threadId, navigation: anchored ? "exact" : "threadOnly", target: { kind: "goalEvent" }
    }])
    expect(page.coverage.completeness).toBe("complete")
  })

  it("reports truncation caused by projection even when the raw blocks fit", () => {
    insertThread("long")
    const content = [
      "/goal " + "a".repeat(59_994),
      "b".repeat(60_000),
      "b".repeat(60_000),
      "b".repeat(60_000),
      "c".repeat(22_134) + "needle"
    ].map((text) => ({ type: "text", text }))
    sqlite
      .prepare(
        `
      INSERT INTO thread_messages(thread_id, message_id, role, content_json, created_at, ordinal)
      VALUES ('long', 'goal', 'user', ?, 1, 0)
    `
      )
      .run(JSON.stringify(content))
    const session = new ThreadSearchSession(
      "id",
      { query: "needle" },
      createThreadSearchReader(sqlite),
      flag.buffer as SharedArrayBuffer,
      () => "verified"
    )
    let page = session.page(null)!
    while (page.nextCursor) page = session.page(page.nextCursor)!
    expect(page).toMatchObject({
      results: [],
      coverage: { completeness: "partial", reasons: ["projection-truncated"] }
    })
  })

  it.each([true, false])("protects a large attachment payload when closed=%s", (closed) => {
    const body =
      'Saved question\n<attachment filename="report.txt">PRIVATE_TRANSPORT ' +
      "a".repeat(125_000) +
      (closed ? "</attachment>\nVisible follow-up" : "")
    const plan = createThreadSearchMessagePlan("user", body, [], null)!
    const projection = projectChatSearchPlan(plan)
    const find = (query: string) => iterateChatSearchLocations(projection, query, 1).next().value
    expect(find("PRIVATE_TRANSPORT")).toBeUndefined()
    expect(find("report.txt")).toBeDefined()
    expect(find("Saved question")).toBeDefined()
    expect(find("Visible follow-up")).toBeUndefined()
    expect(plan.truncated).toBe(true)
  })

  it("preserves visible suffixes around mixed self-closing and paired attachment wrappers", () => {
    const plan = createThreadSearchMessagePlan(
      "user",
      'Before <attachment filename="note.txt" /> visible suffix ' +
        '<attachment filename="full.txt">PRIVATE_PAYLOAD</attachment> after both',
      [],
      null
    )!
    const projected = projectChatSearchPlan(plan)
    for (const query of ["note.txt", "full.txt", "visible suffix", "after both"]) {
      expect(iterateChatSearchLocations(projected, query, 1).next().value).toBeDefined()
    }
    expect(iterateChatSearchLocations(projected, "PRIVATE_PAYLOAD", 1).next().value).toBeUndefined()
  })

  it.each([" ".repeat(600), "\n\t".repeat(300), "\u3000\u202f".repeat(300), `<think>${" ".repeat(600)}</think>`])(
    "matches visible body positions when long persisted reasoning is effectively empty",
    (reasoning) => {
    const thread = insertThread("reasoning")
    sqlite
      .prepare(
        `
      INSERT INTO thread_messages(thread_id,message_id,role,content_json,reasoning,created_at,ordinal)
      VALUES ('reasoning','target','assistant',?,?,1,0)
    `
      )
      .run(JSON.stringify("<think>inline</think>\nordinary needle"), reasoning)
    const row = createThreadSearchReader(sqlite).readMessages(thread, null, flag).rows[0]
    expect(row.reasoningOmitted).toBe(false)
    const plan = createThreadSearchMessagePlan(
      row.role,
      row.content,
      row.fragments,
      row.toolCallsJson,
      row.reasoningSample,
      row.reasoningOmitted
    )!
    expect(
      iterateChatSearchLocations(projectChatSearchPlan(plan), "ordinary needle", 1).next().value
    ).toMatchObject({ context: "<think>inline</think>\nordinary needle" })
    }
  )

  it("finds visible Goal commands without indexing hidden prompts alongside unrelated events", () => {
    insertThread("fallback")
    insertThread("sidecar")
    insertThread("unanchored")
    insertThread("anchored")
    insertThread("duplicate-command")
    insertThread("superseded-fallback")
    const insert = sqlite.prepare(`
      INSERT INTO thread_messages(thread_id,message_id,role,content_json,created_at,ordinal,goal_id)
      VALUES (?, 'goal', 'user', ?, 1, 0, ?)
    `)
    insert.run(
      "fallback",
      JSON.stringify(
        "[Starting active goal]\n<untrusted_objective>Public &amp; safe</untrusted_objective>\n" +
          "<untrusted_completion_condition>Hidden control text</untrusted_completion_condition>"
      ),
      null
    )
    insert.run("sidecar", JSON.stringify("/goal original"), "shared-goal")
    sqlite.exec(`
      INSERT INTO thread_messages(thread_id,message_id,role,content_json,created_at,ordinal,goal_id)
      VALUES ('sidecar','sidecar-anchor','user',
        json_quote('[Continuing active goal] <untrusted_objective>seed</untrusted_objective>'),2,1,'shared-goal')
    `)
    insert.run(
      "anchored",
      JSON.stringify(
        "[Starting active goal]\n<untrusted_objective>Preferred exact match</untrusted_objective>"
      ),
      "anchored-goal"
    )
    insert.run("duplicate-command", JSON.stringify("/goal review\n启动附件：durable.md"), null)
    insert.run("superseded-fallback", JSON.stringify(
      "[Starting active goal]\n<untrusted_objective>review task\n启动附件：old-file-name.md</untrusted_objective>"
    ), "replaced")
    sqlite.prepare(`INSERT INTO thread_messages
      (thread_id, message_id, role, content_json, created_at, ordinal, goal_id)
      VALUES ('duplicate-command', 'anchor', 'user', ?, 2, 1, 'duplicated-goal')`).run(
      JSON.stringify("[Starting active goal]\n<untrusted_objective>review</untrusted_objective>")
    )
    sqlite.exec(`
      INSERT INTO thread_goal_events(thread_id,goal_id,message,created_at,transcript_message_id)
      VALUES ('sidecar','shared-goal','__cmb_goal_user_message__:/goal resume',1,'sidecar-anchor'),
             ('unanchored',NULL,'__cmb_goal_user_message__:/goal resume',1,NULL),
             ('fallback',NULL,'Goal is paused',2,NULL),
             ('anchored','anchored-goal','__cmb_goal_user_message__:/goal Preferred exact match',3,'goal'),
             ('duplicate-command','duplicated-goal','__cmb_goal_user_message__:/goal review'
              || char(10) || '启动附件：sidecar.md',2,'anchor'),
             ('superseded-fallback','replaced','__cmb_goal_user_message__:/goal review task'
              || char(10) || '启动附件：new-file-name.md',2,'goal');
    `)
    const search = (query: string) => {
      const session = new ThreadSearchSession(
        "id",
        { query },
        createThreadSearchReader(sqlite),
        flag.buffer as SharedArrayBuffer,
        () => "verified"
      )
      let page = session.page(null)!
      const results = [...page.results]
      while (page.nextCursor) {
        page = session.page(page.nextCursor)!
        results.push(...page.results)
      }
      return results
    }
    expect(search("public & safe")).toEqual([])
    expect(search("Hidden control text")).toEqual([])
    expect(search("继续推进目标")).toEqual(expect.arrayContaining([
      expect.objectContaining({ threadId: "sidecar", navigation: "exact" }),
      expect.objectContaining({ threadId: "unanchored", navigation: "threadOnly" })
    ]))
    expect(search("original")).toMatchObject([{ threadId: "sidecar", navigation: "exact" }])
    expect(search("sidecar.md")).toEqual([])
    expect(search("old-file-name.md")).toEqual([])
    expect(search("new-file-name.md")).toMatchObject([
      { threadId: "superseded-fallback", target: { kind: "goalEvent" } }
    ])
    expect(search("Preferred exact match")).toMatchObject([
      { threadId: "anchored", navigation: "exact", target: { kind: "goalEvent" } }
    ])
  })

  it("matches the ordinary sidebar for linked Bot tasks and private or group-only conversations", () => {
    const work = { botId: "bot", botHostId: "local", botWorkId: "work" }
    const rows = [
      { id: "ordinary", metadata: {} },
      { id: "private", metadata: { botId: "bot" } },
      { id: "group", metadata: { ...work, botAudienceKey: "desktop", botGroupId: "group" } },
      { id: "desktop-work", metadata: { ...work, botAudienceKey: "desktop" } },
      { id: "im-work", metadata: { ...work, botMockBindingId: "binding", botMockTransport: "im" } },
      { id: "legacy-im-work", metadata: { ...work, botMockBindingId: "binding", botAudienceKey: "im:group" } },
      { id: "mock-work", metadata: { ...work, botMockBindingId: "binding", botMockTransport: "mock" } }
    ]
    const update = sqlite.prepare("UPDATE threads SET metadata = ? WHERE thread_id = ?")
    for (const row of rows) {
      insertThread(row.id)
      update.run(JSON.stringify(row.metadata), row.id)
    }
    const expected = ["desktop-work", "im-work", "legacy-im-work", "ordinary"]
    expect(rows.filter((row) => matchesOrdinaryThreadScope(row)).map((row) => row.id).sort()).toEqual(expected)
    const reader = createThreadSearchReader(sqlite)
    expect(reader.captureCandidates(undefined, flag).candidates.map((row) => row.threadId).sort()).toEqual(expected)
  })

  it("keeps remote inbox rows in their actual scope while hiding the disk path in results", () => {
    insertThread("remote")
    const privatePath = "C:/profiles/remote-inbox"
    sqlite.prepare("UPDATE threads SET title = '远程收件箱', metadata = ? WHERE thread_id = 'remote'").run(JSON.stringify({
      workspacePath: privatePath, targetKind: "inbox", imDeliveryContext: {}
    }))
    const reader = createThreadSearchReader(sqlite)
    expect(reader.captureCandidates(privatePath, flag).candidates).toMatchObject([
      { threadId: "remote", title: REMOTE_INBOX_WORKSPACE_NAME, workspacePath: null, remoteInbox: true }
    ])
    expect(reader.captureCandidates(null, flag).candidates).toEqual([])
  })

  it("ignores hidden legacy remote receipts and still selects the actual saved answer", () => {
    insertThread("remote-answer")
    const insert = sqlite.prepare(`INSERT INTO thread_messages
      (thread_id,message_id,role,content_json,created_at,ordinal) VALUES ('remote-answer',?,?,?,?,?)`)
    insert.run("actual-answer", "assistant", JSON.stringify("真实的补充问题在此"), 1, 0)
    insert.run("im-remote-approval:approved", "system", JSON.stringify("补充问题已审批"), 2, 1)
    insert.run("im-remote-user-input:answer", "system", JSON.stringify("已从招乎回答 Agent 的补充问题。"), 3, 2)
    const session = new ThreadSearchSession("id", { query: "补充问题" },
      createThreadSearchReader(sqlite), flag.buffer as SharedArrayBuffer, () => "verified")
    const start = session.page(null)!
    expect(session.page(start.nextCursor!)!.results).toMatchObject([
      { threadId: "remote-answer", target: { messageId: "actual-answer" } }
    ])
  })

  it("cancels a continuation without reporting the history as complete", () => {
    insertThread("candidate")
    const session = new ThreadSearchSession(
      "id",
      { query: "missing" },
      createThreadSearchReader(sqlite),
      flag.buffer as SharedArrayBuffer,
      () => "verified"
    )
    const first = session.page(null)!
    Atomics.store(flag, 0, 1)
    expect(session.page(first.nextCursor!)).toMatchObject({
      scanStatus: "cancelled",
      nextCursor: null
    })
  })

  it("keeps an overlong message ID out of results and continues past it in ordinal order", () => {
    const thread = insertThread("long-id")
    const insert = sqlite.prepare(
      `INSERT INTO thread_messages (thread_id,message_id,role,content_json,created_at,ordinal)
       VALUES ('long-id',?,'user',?,?,?)`
    )
    insert.run("oldest", JSON.stringify("oldest target"), 0, 0)
    insert.run("长".repeat(4000), JSON.stringify("long identifier target"), 1, 1)
    for (let ordinal = 2; ordinal <= 32; ordinal += 1) {
      insert.run(String(ordinal), JSON.stringify("newer"), ordinal, ordinal)
    }
    const reader = createThreadSearchReader(sqlite)
    const first = reader.readMessages(thread, null, flag)
    expect(first.rows.at(-1)).toMatchObject({ messageId: null, ordinal: 1 })
    expect(reader.readMessages(thread, first.next, flag).rows).toMatchObject([
      { messageId: "oldest", ordinal: 0 }
    ])
    const session = new ThreadSearchSession(
      "id", { query: "long identifier target" }, reader,
      flag.buffer as SharedArrayBuffer, () => "verified"
    )
    const start = session.page(null)!
    expect(session.page(start.nextCursor)!.results).toMatchObject([
      { threadId: "long-id", navigation: "threadOnly", target: null }
    ])
  })

  it("carries a result to the next page when the serialized response reaches its limit", () => {
    const count = 12
    const insert = sqlite.prepare(
      "INSERT INTO threads(thread_id, created_at, updated_at, title, metadata) VALUES (?, 1, ?, ?, ?)"
    )
    const title = "needle " + "t".repeat(8000)
    const metadata = JSON.stringify({ workspacePath: "w".repeat(30_000) })
    for (let index = 0; index < count; index += 1) {
      insert.run(String(index), index, title, metadata)
    }
    const session = new ThreadSearchSession(
      "id",
      { query: "needle", limit: 50 },
      createThreadSearchReader(sqlite),
      flag.buffer as SharedArrayBuffer,
      () => "verified"
    )
    const hits: string[] = []
    let cursor: string | null = null
    for (let index = 0; index < count; index += 1) {
      const page = session.page(cursor)!
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(128 * 1024)
      hits.push(...page.results.map((result) => result.threadId))
      cursor = page.nextCursor
      if (!cursor) break
    }
    expect(cursor).toBeNull()
    expect(hits).toEqual(Array.from({ length: count }, (_, index) => String(count - index - 1)))
  })

  it("reports incomplete coverage when an oversized Goal event has to be skipped", () => {
    insertThread("goal")
    sqlite
      .prepare(
        "INSERT INTO thread_goal_events(thread_id, goal_id, message, created_at) VALUES (?, ?, ?, 1)"
      )
      .run("goal", "goal-id", "__cmb_goal_user_message__:/goal " + "x".repeat(70_000) + " needle")
    const session = new ThreadSearchSession(
      "id",
      { query: "needle" },
      createThreadSearchReader(sqlite),
      flag.buffer as SharedArrayBuffer,
      () => "verified"
    )
    let page = session.page(null)!
    while (page.nextCursor) {
      expect(page.results).toEqual([])
      page = session.page(page.nextCursor)!
    }
    expect(page).toMatchObject({
      results: [],
      scanStatus: "complete",
      coverage: { completeness: "partial", reasons: ["oversized-row"], skippedRows: 1 }
    })
  })

  it("does not read replacement rows after the frozen thread identity is invalidated", () => {
    const original = insertThread("reused")
    sqlite.exec(`DELETE FROM threads WHERE thread_id = 'reused';
      INSERT INTO threads(thread_id,created_at,updated_at,metadata)
        VALUES ('reused', 1, 1, '{"cmb_thread_incarnation":"replacement"}');
      INSERT INTO thread_messages(thread_id,message_id,role,content_json,created_at,ordinal)
        VALUES ('reused','new','user','"replacement content"',1,0);`)
    const reader = createThreadSearchReader(sqlite)
    const stale = reader.readMessages(original, null, flag)
    expect(stale).toEqual({ staleIdentity: true, rows: [], next: null, skippedRows: 0 })
    const [replacement] = reader.captureCandidates(undefined, flag).candidates
    expect(reader.readMessages(replacement, null, flag).rows.map((row) => row.messageId)).toEqual([
      "new"
    ])
  })

  it("changes the structure epoch for backfilled history and anchor changes only", () => {
    const { threadId } = insertThread("reordered")
    const reader = createThreadSearchReader(sqlite)
    sqlite.exec(`
      INSERT INTO thread_messages(thread_id, message_id, role, content_json, created_at, ordinal)
      VALUES ('reordered','latest','user','"first"',1,2);
      UPDATE thread_messages SET content_json = '"stream delta"' WHERE message_id = 'latest';
    `)
    expect(reader.structureEpoch(threadId)).toBe(0)
    sqlite.exec(`
      INSERT INTO thread_messages(thread_id, message_id, role, content_json, created_at, ordinal)
      VALUES ('reordered','earlier','user','"backfill"',1,1);
    `)
    expect(reader.structureEpoch(threadId)).toBe(1)
    sqlite.exec("UPDATE thread_messages SET goal_id = 'new-goal' WHERE message_id = 'latest'")
    expect(reader.structureEpoch(threadId)).toBe(2)
    sqlite.exec("DELETE FROM thread_messages WHERE message_id = 'earlier'")
    expect(reader.structureEpoch(threadId)).toBe(3)
  })

  it("restarts an unfinished conversation when a later snapshot has a different epoch", () => {
    insertThread("changing")
    const insert = sqlite.prepare(
      `INSERT INTO thread_messages(thread_id, message_id, role, content_json, created_at, ordinal)
       VALUES ('changing', ?, 'user', ?, 1, ?)`
    )
    for (let index = 0; index < 40; index += 1) {
      insert.run(String(index), JSON.stringify(index === 0 ? "needle" : "saved text"), index)
    }
    const reader = createThreadSearchReader(sqlite)
    const readMessages = reader.readMessages
    let time = 0
    const clock = vi.spyOn(performance, "now").mockImplementation(() => time)
    const read = vi.spyOn(reader, "readMessages").mockImplementation((...args) => {
      const result = readMessages(...args)
      time += 51
      return result
    })
    try {
      const session = new ThreadSearchSession(
        "id",
        { query: "needle" },
        reader,
        flag.buffer as SharedArrayBuffer,
        () => "verified"
      )
      const title = session.page(null)!
      const first = session.page(title.nextCursor!)!
      expect(first.results).toEqual([])
      sqlite.exec("UPDATE thread_messages SET ordinal = 99 WHERE message_id = '0'")
      expect(session.page(first.nextCursor!)!.results).toMatchObject([
        { threadId: "changing", target: { messageId: "0", ordinalHint: 99, structureEpoch: 1 } }
      ])
    } finally {
      clock.mockRestore()
      read.mockRestore()
    }
  })

  it("captures ordinary summaries in descending timestamp/ID order and filters by workspace", () => {
    const insert = sqlite.prepare(
      "INSERT INTO threads(thread_id, created_at, updated_at, metadata, title) VALUES (?, 5, ?, ?, ?)"
    )
    insert.run("a", 9, JSON.stringify({ workspacePath: "C:/Repo", targetKind: "inbox" }), null)
    insert.run("b", 9, JSON.stringify({ workspacePath: "\t\u202f" }), "[定时] 汇总")
    insert.run("c", 10, JSON.stringify({ harnessFeature: { projectId: "x", slug: "s" } }), "Hidden")
    insert.run("d", 3, "broken legacy metadata", null)
    insert.run("oversized", 12, JSON.stringify({ workspacePath: "C:/Other" }), "x".repeat(8300))
    const reader = createThreadSearchReader(sqlite)
    expect(reader.captureCandidates(undefined, flag).candidates.map((row) => row.threadId)).toEqual(
      ["b", "a", "d"]
    )
    expect(reader.captureCandidates(null, flag).candidates.map((row) => row.title)).toEqual([
      "汇总",
      "d"
    ])
    expect(reader.captureCandidates("C:/Repo", flag).candidates[0].incarnation).toEqual({
      token: null,
      legacyCreatedAt: 5
    })
    expect(reader.captureCandidates("C:/Repo", flag).limited).toBe(false)
    expect(reader.captureCandidates(null, flag).limited).toBe(false)
    expect(reader.captureCandidates(undefined, flag).limited).toBe(true)
    expect(reader.captureCandidates("c:/repo", flag).candidates).toEqual([])
  })

  it("preserves directory behavior for a search hit with large custom metadata", () => {
    insertThread("large")
    sqlite.prepare("UPDATE threads SET metadata = ? WHERE thread_id = 'large'").run(
      JSON.stringify({
        largeCustomField: "x".repeat(100_000),
        llmFileHistory: ["y".repeat(100_000)],
        agentMode: "coordinator",
        workspacePath: "C:/Repo",
        remoteReadOnly: true,
        scheduledTaskId: "schedule"
      })
    )
    const summary = sqlite.prepare(THREAD_SEARCH_IDENTITY_SQL).get("large")
    expect(JSON.parse(String(summary?.summary_metadata))).toMatchObject({
      agentMode: "coordinator",
      workspacePath: "C:/Repo",
      remoteReadOnly: true
    })
    expect(String(summary?.summary_metadata)).not.toContain("largeCustomField")
    const backfill = sqlite.prepare(THREAD_SEARCH_BACKFILL_SQL).get("large")
    expect(backfill).toMatchObject({ scheduled_task_id: "schedule", migration_source_key: null })
    expect(JSON.stringify(backfill).length).toBeLessThan(512)
  })

  it("bounds background metadata admission before projecting arbitrary legacy fields", () => {
    const { threadId } = insertThread("oversized-metadata")
    sqlite
      .prepare("UPDATE threads SET metadata = ? WHERE thread_id = ?")
      .run(
        JSON.stringify({ largeCustomField: "x".repeat(300_000), scheduledTaskId: "active" }),
        threadId
      )
    expect(createThreadSearchReader(sqlite).hasOversizedBackfillMetadata(threadId)).toBe(true)
    expect(sqlite.prepare(THREAD_SEARCH_BACKFILL_SQL).get(threadId)).toBeUndefined()
  })

  it("uses index order for both Goal anchor lookups", () => {
    const plan = sqlite
      .prepare(`EXPLAIN QUERY PLAN ${THREAD_SEARCH_GOAL_EVENT_SQL}`)
      .all("thread", 1)
      .map((row) => String(row.detail))
      .join("\n")
    expect(plan).toContain("idx_thread_messages_goal_legacy_anchor")
    expect(plan).toContain("sqlite_autoindex_thread_messages_1")
    expect(plan).not.toContain("TEMP B-TREE")
  })

  it("uses the recorded Goal user across windows and rejects stale or ambiguous anchors", () => {
    const { threadId } = insertThread("goal-resume")
    const message = sqlite.prepare(`INSERT INTO thread_messages
      (thread_id, message_id, role, active_window_id, goal_id, ordinal, created_at, content_json)
      VALUES (?, ?, ?, ?, 'same-goal', ?, ?, json_quote(?))`)
    message.run(threadId, "older-user", "user", "older", 1, 1, "visible older user")
    message.run(threadId, "current-assistant", "assistant", "current", 2, 9999, "current reply")
    message.run(threadId, "current-user", "user", "current", 3, 10000,
      "[Starting active goal] <untrusted_objective>hidden transport</untrusted_objective>")
    const event = sqlite.prepare(`INSERT INTO thread_goal_events
      (thread_id, active_window_id, goal_id, created_at, message, transcript_message_id)
      VALUES (?, 'current', 'same-goal', 10000, ?, ?)`)
    event.run(threadId, "__cmb_goal_user_message__:/goal recorded anchor", "current-user")
    event.run(threadId, "__cmb_goal_user_message__:/goal stale anchor", "removed-user")
    event.run(threadId, "__cmb_goal_user_message__:/goal legacy anchor", null)
    const reader = createThreadSearchReader(sqlite)
    expect(reader.readGoalAnchor(threadId, 1)?.transcript_message_id).toBe("current-user")
    expect(reader.readGoalAnchor(threadId, 2)?.transcript_message_id).toBeNull()
    expect(reader.readGoalAnchor(threadId, 3)?.transcript_message_id).toBe("current-user")
    message.run(threadId, "another-current-user", "user", "current", 4, 10001, "another request")
    expect(reader.readGoalAnchor(threadId, 3)?.transcript_message_id).toBeNull()
    expect(reader.goalCommandHasDurableCopy(threadId, "another-current-user", "mismatched sidecar",
      { goalId: "same-goal", activeWindowId: "current", time: 10001 }, flag)).toBe(true)
  })

  it.each([
    { scope: "window", anchor: true, ordinal: 2 },
    { scope: "goal", anchor: true, ordinal: 0 },
    { scope: "time", anchor: true, ordinal: 2 },
    { scope: "time", anchor: false, ordinal: 0 },
    { scope: "unrelated", anchor: true, ordinal: 2 },
    { scope: "unrelated", anchor: false, ordinal: 2 }
  ])("compares visible Goal commands using $scope scope with an anchor=$anchor",
    ({ scope, anchor, ordinal }) => {
      const mode = scope
      const { threadId } = insertThread(mode)
      const windowId = mode === "window" || mode === "unrelated" ? "same-window" : null
      const goalId = mode === "time" ? null : "same-goal"
      const message = sqlite.prepare(`INSERT INTO thread_messages
        (thread_id, message_id, role, active_window_id, goal_id, ordinal, created_at, content_json)
        VALUES (?, ?, 'user', ?, ?, ?, ?, json_quote(?))`)
      if (anchor) {
        message.run(threadId, "hidden", windowId, goalId, 1, 1000,
          "[Starting active goal] <untrusted_objective>Fixture</untrusted_objective>")
      }
      message.run(threadId, "visible", mode === "unrelated" ? "other-window" : windowId, goalId, ordinal, 1001,
        "/goal Fixture\n启动附件：new-only.md")
      sqlite.prepare(`INSERT INTO thread_goal_events
        (thread_id, active_window_id, goal_id, created_at, message, transcript_message_id)
        VALUES (?, ?, ?, 1000, ?, ?)`)
        .run(threadId, windowId, goalId, "__cmb_goal_user_message__:/goal Fixture\n启动附件：old-only.md",
          anchor ? "hidden" : null)
      const session = new ThreadSearchSession(mode, { query: "old-only.md" }, createThreadSearchReader(sqlite),
        flag.buffer as SharedArrayBuffer, () => "verified")
      let page = session.page(null)!
      const matches = [...page.results]
      while (page.nextCursor) {
        page = session.page(page.nextCursor)!
        matches.push(...page.results)
      }
      expect(matches).toMatchObject(mode === "unrelated" ? [
        { threadId, navigation: anchor ? "exact" : "threadOnly",
          target: { kind: "goalEvent", anchorMessageId: anchor ? "hidden" : null } }
      ] : [])
    }
  )

  it("admits streamed payload bytes without double-counting its durable character total", () => {
    const thread = insertThread("streamed")
    const base = "needle" + "x".repeat(59_994)
    sqlite
      .prepare(
        `
      INSERT INTO thread_messages(thread_id,message_id,role,content_json,created_at,ordinal)
      VALUES ('streamed','message','assistant',?,1,0)
    `
      )
      .run(JSON.stringify(base))
    sqlite
      .prepare(
        `
      INSERT INTO thread_message_fragments(thread_id,message_id,content_text,created_at)
      VALUES ('streamed','message',?,1)
    `
      )
      .run("y".repeat(60_000))
    sqlite.exec(`
      INSERT INTO thread_message_fragment_states(thread_id, message_id, total_chars, updated_at)
      VALUES ('streamed','message',120000,1);
    `)
    const batch = createThreadSearchReader(sqlite).readMessages(thread, null, flag)
    expect(batch.skippedRows).toBe(0)
    expect(batch.rows).toHaveLength(1)
    expect(batch.rows[0].content).toBe(base)
    expect(batch.rows[0].fragments[0]).toHaveLength(60_000)
    sqlite.exec("UPDATE thread_messages SET message_id = 'renamed' WHERE thread_id = 'streamed'")
    expect(
      sqlite
        .prepare("SELECT 1 FROM thread_search_message_versions WHERE message_id = 'message'")
        .get()
    ).toBeUndefined()
  })

  it("advances a compound cursor past oversized rows and reconstructs legacy fragments", () => {
    const insert = sqlite.prepare(
      `INSERT INTO thread_messages(thread_id,message_id,role,content_json,created_at,ordinal)
      VALUES ('thread', ?, ?, ?, 0, ?)`
    )
    insert.run("big", "assistant", JSON.stringify("x".repeat(550_000)), 40)
    for (let index = 0; index < 34; index += 1) {
      insert.run(String(index).padStart(2, "0"), "assistant", JSON.stringify("ordinary"), 3)
    }
    insert.run("fragmented", "assistant", JSON.stringify("before 😀 MiX"), 1)
    sqlite
      .prepare(
        `INSERT INTO thread_message_fragments(thread_id,message_id,content_text,created_at)
      VALUES ('thread', 'fragmented', 'ed 中文', 0)`
      )
      .run()
    const reader = createThreadSearchReader(sqlite)
    const thread = insertThread("thread")
    const first = reader.readMessages(thread, null, flag)
    expect(first.skippedRows).toBe(1)
    expect(first.rows).toHaveLength(31)
    expect(first.next).toMatchObject({ ordinal: 3, rowId: expect.any(String) })
    const second = reader.readMessages(thread, first.next, flag)
    expect(second.rows.map((row) => row.messageId)).toEqual(["02", "01", "00", "fragmented"])
    expect(second.next).toBeNull()

    const row = second.rows[3]
    const plan = createThreadSearchMessagePlan(
      row.role,
      row.content,
      row.fragments,
      row.toolCallsJson
    )
    expect(plan).not.toBeNull()
    const match = iterateChatSearchLocations(projectChatSearchPlan(plan!), "mixed 中文", 1).next()
      .value
    expect(match).toMatchObject({ start: 10, end: 18, context: "before 😀 MiXed 中文" })

    Atomics.store(flag, 0, 1)
    expect(reader.readMessages(thread, null, flag).rows).toEqual([])
    expect(reader.captureCandidates(undefined, flag).candidates).toEqual([])
  })

  it("defers a legacy fragment row to a fresh budget and skips only an oversized row", () => {
    const insert = sqlite.prepare(
      `INSERT INTO thread_messages(thread_id, message_id, role, content_json, created_at, ordinal)
       VALUES ('budget', ?, 'assistant', ?, 0, ?)`
    )
    const fragment = sqlite.prepare(
      `INSERT INTO thread_message_fragments(thread_id, message_id, content_text, created_at)
       VALUES ('budget', ?, ?, 0)`
    )
    insert.run("newest", JSON.stringify("x".repeat(70_000)), 4)
    insert.run("legacy", JSON.stringify("begin"), 3)
    fragment.run("legacy", "y".repeat(475_000))
    insert.run("oversized-legacy", JSON.stringify("begin"), 2)
    fragment.run("oversized-legacy", "z".repeat(525_000))
    insert.run("oldest", JSON.stringify("final"), 1)

    const reader = createThreadSearchReader(sqlite)
    const thread = insertThread("budget")
    const first = reader.readMessages(thread, null, flag)
    expect(first.rows.map((row) => row.messageId)).toEqual(["newest"])
    expect(first.skippedRows).toBe(0)
    expect(first.next).toMatchObject({ ordinal: 4, rowId: expect.any(String) })

    const second = reader.readMessages(thread, first.next, flag)
    expect(second.rows[0].fragments[0]).toHaveLength(475_000)
    expect(second.skippedRows).toBe(0)
    expect(second.next).toMatchObject({ ordinal: 3, rowId: expect.any(String) })

    const third = reader.readMessages(thread, second.next, flag)
    expect(third.rows).toEqual([])
    expect(third.skippedRows).toBe(1)
    expect(third.next).toMatchObject({ ordinal: 2, rowId: expect.any(String) })

    const last = reader.readMessages(thread, third.next, flag)
    expect(last.rows.map((row) => row.messageId)).toEqual(["oldest"])
    expect(last.next).toBeNull()
  })
})
