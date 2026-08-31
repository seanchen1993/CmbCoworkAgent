import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFile } from "node:fs/promises"

async function main(): Promise<void> {
  const previousHome = process.env.HOME
  const previousUserProfile = process.env.USERPROFILE
  const testHome = await mkdtemp(join(tmpdir(), "cmb-subagent-row-db-"))
  process.env.HOME = testHome
  process.env.USERPROFILE = testHome

  try {
    const db = await import("../src/main/db/index.ts")
    await db.initializeDatabase()
    const threadId = "subagent-row-performance"
    const subagentId = "worker-20k"
    const manyBucketsThreadId = "subagent-many-buckets"
    db.createThread(threadId)
    db.createThread(manyBucketsThreadId)

    let database = db.getDb()
    database.run("BEGIN")
    try {
      for (let index = 0; index < 20_000; index += 1) {
        database.run(
          `INSERT INTO thread_subagent_messages (
             thread_id, subagent_id, message_id, manifest_json, ordinal, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            threadId,
            subagentId,
            `m-${index}`,
            JSON.stringify({
              id: `m-${index}`,
              role: "assistant",
              content:
                index > 0 && index < 19_900
                  ? `PERSIST_PREFIX_POISON_${index}`
                  : `tail-${index}`
            }),
            index,
            Date.now()
          ]
        )
      }
      database.run(
        `INSERT INTO thread_subagent_buckets (
           thread_id, subagent_id, message_count, next_ordinal, updated_at
         ) VALUES (?, ?, ?, ?, ?)`,
        [threadId, subagentId, 20_000, 20_000, Date.now()]
      )
      database.run("COMMIT")
    } catch (error) {
      database.run("ROLLBACK")
      throw error
    }

    database.run("BEGIN")
    try {
      for (let index = 0; index < 2_000; index += 1) {
        const bucketId = `worker-bucket-${String(index).padStart(4, "0")}`
        for (let ordinal = 0; ordinal < 2; ordinal += 1) {
          const messageId = ordinal === 0 ? `subagent-prompt-${bucketId}` : `subagent-final-${bucketId}`
          database.run(
            `INSERT INTO thread_subagent_messages (
               thread_id, subagent_id, message_id, manifest_json, ordinal, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
            [
              manyBucketsThreadId,
              bucketId,
              messageId,
              JSON.stringify({
                id: messageId,
                role: ordinal === 0 ? "user" : "assistant",
                content: `${bucketId}:${ordinal}`,
                ...(ordinal === 1 ? { content_priority: 1, status: "completed" } : {})
              }),
              ordinal,
              index
            ]
          )
        }
        database.run(
          `INSERT INTO thread_subagent_buckets (
             thread_id, subagent_id, message_count, next_ordinal, updated_at
           ) VALUES (?, ?, ?, ?, ?)`,
          [manyBucketsThreadId, bucketId, 2, 2, index]
        )
      }
      database.run("COMMIT")
    } catch (error) {
      database.run("ROLLBACK")
      throw error
    }

    // Simulate a crash after CREATE TABLE but before the old non-transactional
    // summary backfill. Reopen must repair the preexisting empty table exactly once.
    database.run("DELETE FROM thread_subagent_buckets")
    database.run(
      "DELETE FROM db_schema_migrations WHERE migration_id = 'thread-subagent-buckets-v1'"
    )
    await db.closeDatabase()
    await db.initializeDatabase()
    database = db.getDb()
    assert.equal(
      Number(
        database.exec(
          "SELECT message_count FROM thread_subagent_buckets WHERE thread_id = ? AND subagent_id = ?",
          [threadId, subagentId]
        )[0]?.values[0]?.[0]
      ),
      20_000,
      "reopen should repair a preexisting-but-empty summary table"
    )

    const originalPrepare = database.prepare.bind(database)
    const originalRun = database.run.bind(database)
    const originalJsonParse = JSON.parse
    let mutationStatements = 0
    let subagentStatementSteps = 0
    let startupStatementPrepares = 0
    let startupQueryPlan: string[] = []
    database.prepare = ((sql: string, params?: unknown[]) => {
      const normalized = sql.replace(/\s+/g, " ").trim()
      if (/^WITH recent_buckets AS/i.test(normalized)) {
        startupStatementPrepares += 1
        startupQueryPlan = database
          .exec(`EXPLAIN QUERY PLAN ${sql}`, [manyBucketsThreadId, 200])
          .flatMap((result) => result.values.map((row) => String(row[3] ?? "")))
      }
      if (
        normalized.includes("thread_subagent_messages") &&
        (/\bCOUNT\s*\(/i.test(normalized) || /\bOFFSET\b/i.test(normalized))
      ) {
        throw new Error(`subagent hot path used a scanning query: ${normalized}`)
      }
      if (
        normalized.includes("manifest_json") &&
        normalized.includes("FROM thread_subagent_messages") &&
        !normalized.includes("message_id IN") &&
        !/\bLIMIT\s+(?:\?|1)(?:\s|$)/i.test(normalized)
      ) {
        throw new Error("dirty-row persistence queried the complete subagent bucket")
      }
      const statement = originalPrepare(sql, params)
      if (normalized.includes("thread_subagent_")) {
        const originalStep = statement.step.bind(statement)
        statement.step = () => {
          subagentStatementSteps += 1
          return originalStep()
        }
      }
      return statement
    }) as typeof database.prepare
    database.run = ((sql: string, params?: unknown[]) => {
      mutationStatements += 1
      return originalRun(sql, params)
    }) as typeof database.run
    JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
      if (text.includes("PERSIST_PREFIX_POISON")) {
        throw new Error("dirty-row persistence parsed the stable 20k prefix")
      }
      return originalJsonParse(text, reviver)
    }) as typeof JSON.parse

    let persisted: unknown[]
    try {
      const startupStepStart = subagentStatementSteps
      const startup = db.getThreadSubagentStartupManifests(threadId)
      assert.deepEqual(
        (startup[subagentId] as Array<{ id?: unknown }>).map((message) => message.id),
        ["m-0", "m-19999"]
      )
      assert.ok(
        subagentStatementSteps - startupStepStart <= 8,
        `startup should step only bucket metadata and two edge rows, got ${
          subagentStatementSteps - startupStepStart
        } steps`
      )

      const manyBucketStepStart = subagentStatementSteps
      const manyBucketPrepareStart = startupStatementPrepares
      const manyBucketStartup = db.getThreadSubagentStartupManifests(manyBucketsThreadId)
      assert.equal(
        Object.keys(manyBucketStartup).length,
        200,
        "startup IPC must cap a 2k-bucket task at the newest 200 buckets"
      )
      assert.equal(
        Object.keys(manyBucketStartup)[0],
        "worker-bucket-1999",
        "startup projection should select the most recently touched bucket first"
      )
      assert.equal(
        startupStatementPrepares - manyBucketPrepareStart,
        1,
        "startup should use one edge-join statement rather than 2B prepared queries"
      )
      assert.ok(
        startupQueryPlan.some((detail) => detail.includes("idx_thread_subagent_buckets_recent")),
        `startup must seek newest buckets through the recent index: ${startupQueryPlan.join(" | ")}`
      )
      assert.ok(
        startupQueryPlan.some((detail) =>
          detail.includes("idx_thread_subagent_messages_keyset_order")
        ),
        `startup edge lookups must seek the message keyset index: ${startupQueryPlan.join(" | ")}`
      )
      assert.ok(
        subagentStatementSteps - manyBucketStepStart <= 201,
        `2k-bucket startup should step at most 200 bounded result rows, got ${
          subagentStatementSteps - manyBucketStepStart
        }`
      )

      const store = await import("../src/main/services/subagent-transcript-content-store.ts")
      const ipcProjection = store.buildSubagentTranscriptStartupManifests(manyBucketStartup)
      assert.equal(Object.keys(ipcProjection).length, 200)
      assert.ok(
        Buffer.byteLength(JSON.stringify(ipcProjection), "utf8") < 512 * 1024,
        "bounded startup card metadata should stay below 512 KiB for 200 tiny buckets"
      )

      const latest = db.getThreadSubagentManifestPage(threadId, subagentId, undefined, 100)
      assert.equal(latest.messages.length, 100)
      assert.equal(latest.total, 20_000)
      assert.equal(latest.nextBefore, 19_900)

      persisted = db.upsertThreadSubagentManifestMessages(threadId, subagentId, [
        { id: "m-19999", role: "assistant", content: "completed tail" }
      ])
    } finally {
      database.prepare = originalPrepare
      database.run = originalRun
      JSON.parse = originalJsonParse
    }

    assert.equal(persisted.length, 1)
    assert.ok(
      mutationStatements <= 7,
      `one dirty row should use a constant-size transaction, got ${mutationStatements} statements`
    )
    const latest = db.getThreadSubagentManifestPage(threadId, subagentId, undefined, 100)
    assert.equal(latest.messages.length, 100)
    assert.equal(latest.total, 20_000)
    assert.equal((latest.messages.at(-1) as { content?: unknown }).content, "completed tail")

    const ipcSource = await readFile(
      join(process.cwd(), "src/main/ipc/threads.ts"),
      "utf8"
    )
    const persistStart = ipcSource.indexOf('"threads:persistSubagentTranscripts"')
    const persistEnd = ipcSource.indexOf("// Delete a thread", persistStart)
    const persistBody = ipcSource.slice(persistStart, persistEnd)
    assert.match(persistBody, /upsertThreadSubagentManifestMessages/)
    assert.doesNotMatch(persistBody, /dbMergeThreadValues|currentRecord|mergedManifests/)

    db.deleteThread(threadId)
    db.deleteThread(manyBucketsThreadId)
    await db.closeDatabase()
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousUserProfile
    await removeTestHome(testHome)
  }
}

async function removeTestHome(testHome: string): Promise<void> {
  try {
    await rm(testHome, { recursive: true, force: true, maxRetries: 1, retryDelay: 50 })
  } catch (error) {
    // node:sqlite can release the Windows WAL/SHM handles just after close.
    // A stale OS temp directory must not hide the performance assertions.
    if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error
  }
}

main()
  .then(() => console.log("subagent transcript row persistence contracts passed"))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
