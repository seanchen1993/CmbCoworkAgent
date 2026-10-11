import assert from "node:assert/strict"
import { fork } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { NativeSqliteAdapter } from "../../src/main/db/native-sqlite-adapter"
import { insertThreadRecord } from "../../src/main/db/thread-record"
import { THREAD_INCARNATION_METADATA_KEY } from "../../src/main/services/thread-incarnation"
import {
  PartnerTaskThreadFault,
  PartnerTaskThreadStore,
  type PartnerTaskThreadContext
} from "../../src/main/services/bot/task-thread-store"

const input: PartnerTaskThreadContext = {
  spaceId: "space",
  taskId: "task",
  stageId: "requirement-stage",
  runtimeNodeId: "node",
  groupId: "group",
  ownerPrincipalId: "owner",
  workspaceRef: "view",
  workspacePath: "/explicit-workspace"
}
function open(path: string) {
  return new NativeSqliteAdapter(new DatabaseSync(path, { timeout: 2000 }))
}
async function fixture(work: (db: NativeSqliteAdapter, path: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "devclaw-bot-thread-test-")),
    path = join(dir, "threads.sqlite"),
    db = open(path)
  try {
    db.run("PRAGMA journal_mode=WAL")
    // Exact original Thread columns; use production insertThreadRecord below.
    db.run(`CREATE TABLE threads (thread_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, metadata TEXT, status TEXT DEFAULT 'idle', thread_values TEXT, title TEXT)`)
    return await work(db, path)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}
function rows(db: NativeSqliteAdapter, table = "threads") {
  assert.ok(["threads", "bot_task_threads"].includes(table))
  return db.exec(`SELECT COUNT(*) FROM ${table}`)[0].values[0][0]
}
function fault(code: PartnerTaskThreadFault["code"], action: () => unknown) {
  assert.throws(
    action,
    (error: unknown) =>
      error instanceof PartnerTaskThreadFault &&
      error.code === code &&
      error.message === code &&
      !error.cause
  )
}

test("dedicated binding survives reopen and is a frozen path-free contract", () =>
  fixture((db, path) => {
    const personal = insertThreadRecord(db, "personal", {
      workspacePath: "/personal",
      memoryEnabled: true,
      model: "personal-model"
    })
    const before = db.exec("SELECT * FROM threads WHERE thread_id='personal'")
    const store = new PartnerTaskThreadStore(db),
      binding = store.ensure(input)
    assert.notEqual(binding.localThreadId, personal.thread_id)
    assert.ok(Object.isFrozen(binding))
    assert.equal(Object.keys(binding).length, 6)
    assert.ok(!JSON.stringify(binding).includes(input.workspacePath))
    assert.deepEqual(store.ensure(input), binding)
    assert.equal(rows(db), 2)
    assert.equal(rows(db, "bot_task_threads"), 1)
    const other = open(path)
    try {
      assert.deepEqual(new PartnerTaskThreadStore(other).ensure(input), binding)
    } finally {
      other.close()
    }
    assert.deepEqual(db.exec("SELECT * FROM threads WHERE thread_id='personal'"), before)
    assert.deepEqual(db.exec("PRAGMA foreign_key_list(bot_task_threads)")[0]?.values ?? [], [])
    db.close()
    const reopened = open(path)
    try {
      assert.deepEqual(new PartnerTaskThreadStore(reopened).ensure(input), binding)
      assert.equal(rows(reopened), 2)
    } finally {
      reopened.close()
    }
  }))

test("space/task/stage/node define independent histories", () =>
  fixture((db) => {
    const store = new PartnerTaskThreadStore(db),
      ids = new Set([store.ensure(input).localThreadId])
    for (const key of ["spaceId", "taskId", "stageId", "runtimeNodeId"] as const)
      ids.add(store.ensure({ ...input, [key]: "other" }).localThreadId)
    assert.equal(ids.size, 5)
    assert.equal(rows(db), 5)
  }))

test("owner/group/workspace reference drift never creates or reuses a Thread", () =>
  fixture((db) => {
    const store = new PartnerTaskThreadStore(db)
    store.ensure(input)
    for (const key of ["ownerPrincipalId", "groupId", "workspaceRef"] as const)
      fault("PARTNER_THREAD_BINDING_CHANGED", () => store.ensure({ ...input, [key]: "other" }))
    fault("PARTNER_THREAD_CONTEXT_CHANGED", () =>
      store.ensure({ ...input, workspacePath: "/different" })
    )
    assert.equal(rows(db), 1)
    assert.equal(rows(db, "bot_task_threads"), 1)
  }))

test("deleted or recreated same-id Thread is never silently adopted", () =>
  fixture((db) => {
    const store = new PartnerTaskThreadStore(db),
      binding = store.ensure(input)
    const old = JSON.parse(
      String(
        db.exec("SELECT metadata FROM threads WHERE thread_id=?", [binding.localThreadId])[0]
          .values[0][0]
      )
    )
    db.run("DELETE FROM threads WHERE thread_id=?", [binding.localThreadId])
    fault("PARTNER_THREAD_MISSING", () => store.ensure(input))
    assert.equal(rows(db), 0)
    const replacement = insertThreadRecord(db, binding.localThreadId, old)
    assert.notEqual(
      JSON.parse(replacement.metadata)[THREAD_INCARNATION_METADATA_KEY],
      old[THREAD_INCARNATION_METADATA_KEY]
    )
    fault("PARTNER_THREAD_CONTEXT_CHANGED", () => store.ensure(input))
    assert.equal(rows(db), 1)
  }))

test("privacy, mode, workspace and marker edits fail closed", () =>
  fixture((db) => {
    const store = new PartnerTaskThreadStore(db),
      binding = store.ensure(input)
    const metadata = String(
      db.exec("SELECT metadata FROM threads WHERE thread_id=?", [binding.localThreadId])[0]
        .values[0][0]
    )
    for (const mutate of [
      (m: Record<string, unknown>) => {
        m.memoryEnabled = true
      },
      (m: Record<string, unknown>) => {
        m.subagentsEnabled = true
      },
      (m: Record<string, unknown>) => {
        m.agentMode = "coordinator"
      },
      (m: Record<string, unknown>) => {
        m.workspacePath = "/personal"
      },
      (m: Record<string, unknown>) => {
        m.model = "personal"
      },
      (m: Record<string, unknown>) => {
        m.harnessFeature = { slug: "personal" }
      },
      (m: Record<string, unknown>) => {
        m[THREAD_INCARNATION_METADATA_KEY] = "forged"
      },
      (m: Record<string, unknown>) => {
        ;(m.cmb_devclaw_partner_task as Record<string, unknown>).taskId = "other"
      }
    ]) {
      const m = JSON.parse(metadata)
      mutate(m)
      db.run("UPDATE threads SET metadata=? WHERE thread_id=?", [
        JSON.stringify(m),
        binding.localThreadId
      ])
      fault("PARTNER_THREAD_CONTEXT_CHANGED", () => store.ensure(input))
    }
    for (const value of [
      "{not-json",
      "[]",
      "null",
      '"value"',
      JSON.stringify({ large: "x".repeat(20_000) })
    ]) {
      db.run("UPDATE threads SET metadata=? WHERE thread_id=?", [value, binding.localThreadId])
      fault("PARTNER_THREAD_CONTEXT_CHANGED", () => store.ensure(input))
    }
    db.run("UPDATE threads SET metadata=? WHERE thread_id=?", [metadata, binding.localThreadId])
    assert.deepEqual(store.ensure(input), binding)
    assert.equal(rows(db), 1)
  }))

test("binding insert failure rolls back Thread creation and never echoes SQL details", () =>
  fixture((db) => {
    const store = new PartnerTaskThreadStore(db)
    db.run(
      "CREATE TRIGGER fail_binding BEFORE INSERT ON bot_task_threads BEGIN SELECT RAISE(ABORT, 'PRIVATE_SQL_DETAIL'); END"
    )
    fault("PARTNER_THREAD_STORE_UNAVAILABLE", () => store.ensure(input))
    assert.equal(rows(db), 0)
    assert.equal(rows(db, "bot_task_threads"), 0)
    db.run("DROP TRIGGER fail_binding")
    store.ensure(input)
    assert.equal(rows(db), 1)
  }))

test("invalid scope or implicit/unnormalized workspace is refused without writes", () =>
  fixture((db) => {
    const store = new PartnerTaskThreadStore(db)
    for (const key of [
      "spaceId",
      "taskId",
      "stageId",
      "runtimeNodeId",
      "groupId",
      "ownerPrincipalId",
      "workspaceRef"
    ] as const)
      for (const value of ["", "a\n", "/private", "x".repeat(129)])
        fault("PARTNER_THREAD_INPUT_INVALID", () => store.ensure({ ...input, [key]: value }))
    for (const value of ["", "relative", "/tmp/../personal", "/tmp/a\0b", "/" + "x".repeat(4097)])
      fault("PARTNER_THREAD_INPUT_INVALID", () => store.ensure({ ...input, workspacePath: value }))
    assert.equal(rows(db), 0)
  }))

test("existing caller transaction is not rolled back or joined", () =>
  fixture((db) => {
    const store = new PartnerTaskThreadStore(db)
    db.run("BEGIN")
    insertThreadRecord(db, "caller-owned", { title: "keep pending" })
    fault("PARTNER_THREAD_STORE_UNAVAILABLE", () => store.ensure(input))
    assert.equal(rows(db), 1)
    db.run("ROLLBACK")
    assert.equal(rows(db), 0)
  }))

test("lost local commit result recovers the persisted binding without replacement", () =>
  fixture((db, path) => {
    const store = new PartnerTaskThreadStore(db),
      run = db.run.bind(db)
    // Fault only after the real SQLite COMMIT. Not a simulated in-memory receipt.
    db.run = (sql, values) => {
      const result = run(sql, values)
      if (sql === "COMMIT") throw Error("PRIVATE_LOST_RESULT")
      return result
    }
    try {
      fault("PARTNER_THREAD_STORE_UNAVAILABLE", () => store.ensure(input))
    } finally {
      db.run = run
    }
    const persisted = db.exec("SELECT thread_id FROM bot_task_threads")[0].values[0][0]
    assert.equal(rows(db), 1)
    db.close()
    const reopened = open(path)
    try {
      assert.equal(new PartnerTaskThreadStore(reopened).ensure(input).localThreadId, persisted)
      assert.equal(rows(reopened), 1)
    } finally {
      reopened.close()
    }
  }))

test("two independent App processes allocate one durable Thread", () =>
  fixture(async (db, path) => {
    new PartnerTaskThreadStore(db)
    const children = [0, 1].map(() =>
      fork(resolve(__dirname, "task-thread-worker.ts"), [path], {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "pipe", "pipe", "ipc"]
      })
    )
    try {
      const ready = children.map(
        (child) =>
          new Promise<void>((ok, fail) => {
            child.once("error", fail)
            child.once("message", (value) =>
              value === "ready" ? ok() : fail(Error("THREAD_PROBE_READY"))
            )
            child.once("exit", () => fail(Error("THREAD_PROBE_EARLY_EXIT")))
          })
      )
      const done = children.map(
        (child) =>
          new Promise<string>((ok, fail) => {
            let binding: string | undefined,
              output = ""
            child.stdout?.on("data", (data) => {
              output += data
              if (output.length > 8192) child.kill()
            })
            child.stderr?.on("data", (data) => {
              output += data
              if (output.length > 8192) child.kill()
            })
            child.on("message", (value) => {
              if (typeof value === "object" && value && "binding" in value)
                binding = JSON.stringify(value.binding)
            })
            child.once("exit", (code) =>
              code === 0 && binding ? ok(binding) : fail(Error("THREAD_PROBE_EXIT"))
            )
            child.once("error", fail)
          })
      )
      // Results may reject while waiting for both ready signals; own them now so
      // a failed worker cannot become an unhandled rejection before cleanup.
      done.forEach((result) => void result.catch(() => {}))
      const timer = setTimeout(() => children.forEach((child) => child.kill()), 15_000)
      try {
        await Promise.all(ready)
        children.forEach((child) => child.send("ensure"))
        const results = await Promise.all(done)
        assert.equal(results[0], results[1])
        assert.equal(rows(db), 1)
        assert.equal(rows(db, "bot_task_threads"), 1)
        assert.equal(JSON.stringify(new PartnerTaskThreadStore(db).ensure(input)), results[0])
      } finally {
        clearTimeout(timer)
      }
    } finally {
      await Promise.all(
        children.map(
          (child) =>
            new Promise<void>((ok) => {
              if (child.exitCode !== null || child.signalCode !== null) return ok()
              child.once("exit", () => ok())
              child.kill("SIGKILL")
            })
        )
      )
    }
  }))
