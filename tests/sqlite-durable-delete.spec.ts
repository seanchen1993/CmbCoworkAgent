/**
 * Regression tests for durable-sqlite deletion (workflow-resume thread-collision bug).
 *
 * dcafb3d1 introduced `.bak` sidecars + recovery for thread checkpoints, which
 * silently broke every caller that assumed "unlink <threadId>.sqlite = thread
 * gone": on workflow resume the reused threadId's cleanup deleted only the live
 * file, openRecoveredSqliteDatabase resurrected the dead transcript from `.bak`,
 * and the new agent continued on a poisoned conversation.
 *
 * Verifies:
 *   1. deleteSqliteDurableFileSync purges live + ALL sidecars → no resurrection.
 *   2. Control: old behaviour (unlink live only) DOES resurrect — proving the
 *      test actually covers the bug.
 *   3. sqliteDurableVariantBase recognises every variant (longest-suffix-first)
 *      and rejects non-variants (corrupt archives, unrelated files).
 *   4. Deletion tolerates missing variants (ENOENT race with self-clean).
 *
 * Run:
 *   npx tsx tests/sqlite-durable-delete.spec.ts
 */

import { mkdtemp, rm, writeFile, unlink, readdir } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import assert from "assert"
import initSqlJs from "sql.js"
import {
  deleteSqliteDurableFileSync,
  openRecoveredSqliteDatabase,
  persistSqliteSnapshot,
  sqliteDurableVariantBase,
  sqliteQuarantineVariantBase
} from "../src/main/utils/sqlite-durable-file"

async function main(): Promise<void> {
  const SQL = await initSqlJs()
  const dir = await mkdtemp(join(tmpdir(), "durable-delete-"))

  try {
    // ---- 1. delete purges all variants → recovery finds nothing ----
    {
      const dbPath = join(dir, "thread-a.sqlite")
      const db = new SQL.Database()
      db.run("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('old-transcript')")
      const snapshot = Buffer.from(db.export())
      db.close()
      await persistSqliteSnapshot(dbPath, snapshot, "test")

      const removedLive = deleteSqliteDurableFileSync(dbPath)
      assert.strictEqual(removedLive, true, "live file should have been removed")

      const leftovers = (await readdir(dir)).filter((f) => f.startsWith("thread-a.sqlite"))
      assert.deepStrictEqual(leftovers, [], `no variants may survive deletion, got: ${leftovers}`)

      const recovered = await openRecoveredSqliteDatabase(SQL, dbPath, "test")
      assert.strictEqual(recovered.database, null, "deleted checkpoint must NOT resurrect")
      console.log("PASS: delete purges live + sidecars, no resurrection")
    }

    // ---- 2. control: old behaviour (unlink live only) resurrects from .bak ----
    {
      const dbPath = join(dir, "thread-b.sqlite")
      const db = new SQL.Database()
      db.run("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('zombie')")
      const snapshot = Buffer.from(db.export())
      db.close()
      await persistSqliteSnapshot(dbPath, snapshot, "test")

      await unlink(dbPath) // the pre-fix deleteThreadCheckpoint behaviour

      const recovered = await openRecoveredSqliteDatabase(SQL, dbPath, "test")
      assert.notStrictEqual(recovered.database, null, "control: .bak should resurrect")
      assert.strictEqual(recovered.recovered, true)
      const rows = recovered.database!.exec("SELECT v FROM t")
      assert.strictEqual(rows[0]?.values[0]?.[0], "zombie")
      recovered.database!.close()
      console.log("PASS: control confirms live-only unlink resurrects (the original bug)")
      deleteSqliteDurableFileSync(dbPath)
    }

    // ---- 3. variant recognition ----
    {
      assert.strictEqual(sqliteDurableVariantBase("x.sqlite"), "x")
      assert.strictEqual(sqliteDurableVariantBase("x.sqlite.bak"), "x")
      assert.strictEqual(sqliteDurableVariantBase("x.sqlite.tmp"), "x")
      assert.strictEqual(sqliteDurableVariantBase("x.sqlite.bak.tmp"), "x", "longest suffix wins")
      assert.strictEqual(sqliteDurableVariantBase("x.sqlite.flush.tmp"), "x")
      assert.strictEqual(sqliteDurableVariantBase("x.sqlite.recovery.tmp"), "x")
      assert.strictEqual(sqliteDurableVariantBase("x.sqlite.corrupt.123"), null, "forensic archive")
      assert.strictEqual(sqliteDurableVariantBase("x.sqlite.bak.123"), null, "quarantined bak")
      assert.strictEqual(sqliteDurableVariantBase("x.txt"), null)
      assert.strictEqual(sqliteDurableVariantBase(".sqlite"), null, "empty base rejected")
      // 隔离/取证文件识别器:线程删除时要连它们一起清(隐私残留)
      assert.strictEqual(sqliteQuarantineVariantBase("x.sqlite.corrupt.1719999999"), "x")
      assert.strictEqual(sqliteQuarantineVariantBase("x.sqlite.bak.1719999999"), "x")
      assert.strictEqual(
        sqliteQuarantineVariantBase("x.sqlite.bak"),
        null,
        "recovery sidecar 不归它管"
      )
      assert.strictEqual(sqliteQuarantineVariantBase("x.sqlite"), null)
      assert.strictEqual(
        sqliteQuarantineVariantBase(".sqlite.corrupt.123"),
        null,
        "empty base rejected"
      )
      console.log("PASS: variant recognition")
    }

    // ---- 4. bak-only leftover + ENOENT tolerance ----
    {
      const dbPath = join(dir, "thread-c.sqlite")
      await writeFile(`${dbPath}.bak`, "leftover")
      const removedLive = deleteSqliteDurableFileSync(dbPath)
      assert.strictEqual(removedLive, false, "no live file existed")
      const leftovers = (await readdir(dir)).filter((f) => f.startsWith("thread-c.sqlite"))
      assert.deepStrictEqual(leftovers, [], "bak-only leftover must be removed")
      // Deleting again (nothing on disk) must not throw.
      deleteSqliteDurableFileSync(dbPath)
      console.log("PASS: bak-only leftover removed, ENOENT tolerated")
    }

    console.log("\nAll sqlite-durable-delete tests passed.")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error("FAIL:", error)
  process.exit(1)
})
