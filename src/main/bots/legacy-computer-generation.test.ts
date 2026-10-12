import { afterEach, expect, it, vi } from "vitest"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"
import { BotStore } from "./store"
import { BOT_SCHEMA_VERSION } from "./schema"
import { assertCurrentSchemaAdditions } from "./migration-current-additions.test-fixture"
import { BotHost } from "./host"
import { BotHostLock } from "./host-lock"
import { BotRpcServer } from "./rpc"
import { BotTransportClient } from "./transport-client"
import { BotBackupScheduler } from "./backup-scheduler"
import { BotMaintenanceReceipts } from "./maintenance-receipts"
import { recoverBotRestore } from "./backups"
import { recoverBotComputerCheckpoint } from "./computer-checkpoint-service"
import { executeBotComputerCheckpoint } from "./computer-checkpoint-service"
import absent from "./fixtures/computer-legacy-all-absent.json"
import prior57 from "./fixtures/routine-readiness-v57.json"

const roots: string[] = []
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
    rmSync(`${root}.workspace`, { recursive: true, force: true })
  }
})
function root() {
  const value = realpathSync(mkdtempSync(join(tmpdir(), "cmb-legacy-absent-")))
  roots.push(value)
  return value
}
function fixture() {
  const value = root()
  expect(absent.provenance.noSyntheticVersionOrEvents).toBe(true)
  expect(absent.generation.provenance.noBotStoreOpened).toBe(true)
  for (const dir of absent.directories)
    mkdirSync(dir.replace(/^host(?=\/|\.workspace)/, value), { recursive: true, mode: 0o700 })
  for (const file of absent.files) {
    const bytes = Buffer.from(file.base64, "base64")
    expect(bytes.length).toBe(file.bytes)
    expect(sha(bytes)).toBe(file.sha256)
    writeFileSync(file.path.replace(/^host(?=\/|\.workspace)/, value), bytes, {
      flag: "wx",
      mode: 0o600
    })
  }
  expect(existsSync(join(value, "bots.sqlite"))).toBe(false)
  return value
}
type RepairOwner = Pick<BotHostLock, "assertCurrent" | "recoveryOwnershipIdentity">
// Baseline has no compatibility stage. Follow its original two recovery calls;
// the candidate imports and runs its actual new stage, never a mocked body.
async function repair(directory: string, owner: RepairOwner) {
  const target = fileURLToPath(new URL("./legacy-computer-generation.ts", import.meta.url))
  if (existsSync(target)) {
    const module = (await import(/* @vite-ignore */ target)) as {
      repairLegacyComputerGeneration(directory: string, owner: RepairOwner): void
    }
    module.repairLegacyComputerGeneration(directory, owner)
  }
}
function markers(store: BotStore) {
  return (
    store.db.exec(
      "SELECT kind,entity_id,payload FROM bot_events WHERE kind IN ('workspace.restored','computer.restored') ORDER BY cursor"
    )[0]?.values ?? []
  )
}
function snapshots(directory: string) {
  const path = join(directory, "backups")
  return existsSync(path) ? readdirSync(path).filter((name) => name.endsWith(".sqlite")) : []
}
async function client(directory: string) {
  const lock = BotHostLock.acquire(directory)!
  let store: BotStore | undefined,
    host: BotHost | undefined,
    rpc: BotRpcServer | undefined,
    transport: BotTransportClient | undefined
  try {
    await recoverBotComputerCheckpoint(directory, lock)
    await recoverBotRestore(directory, undefined, () => lock.assertCurrent())
    await repair(directory, lock)
    store = new BotStore(join(directory, "bots.sqlite"))
    host = new BotHost(store)
    host.bindOwnership(lock)
    host.backups = new BotBackupScheduler(store.backupSchedule, directory, host.id, undefined, () =>
      lock.assertCurrent()
    )
    const token = randomBytes(32).toString("hex"),
      socketPath =
        process.platform === "win32"
          ? `\\\\.\\pipe\\cmb-legacy-${randomBytes(12).toString("hex")}`
          : join(directory, "rpc.sock")
    rpc = new BotRpcServer(host, token)
    await rpc.listen(socketPath)
    transport = new BotTransportClient({
      version: 1,
      pid: process.pid,
      hostId: host.id,
      socketPath,
      token
    })
    const active = { store, transport }
    return {
      ...active,
      close: async () => {
        await transport?.closeAndWait()
        await rpc?.close()
        await host?.backups?.close()
        await host?.stop()
        store?.close()
        lock.release()
      }
    }
  } catch (error) {
    await transport?.closeAndWait()
    await rpc?.close()
    await host?.backups?.close()
    await host?.stop()
    store?.close()
    lock.release()
    throw error
  }
}

function pending(directory: string) {
  const store = new BotStore(join(directory, "bots.sqlite"))
  try {
    const bot = store.createBot({ nonce: "post-old-restore-bot", name: "Retained normal Bot" }),
      sent = store.send({
        nonce: "post-old-restore-task",
        conversationId: bot.conversationId,
        text: "Check the retained evidence"
      }),
      lease = store.claim("legacy-owner")!.lease,
      approval = store.requestInteraction(lease, {
        kind: "approval",
        prompt: "Review the retained operation",
        action: { operation: "retained-review" }
      })
    expect(store.dataEpoch()).toBe("initial")
    return { bot, sent, approval, lease }
  } finally {
    store.close()
  }
}
async function lockedRepair(directory: string) {
  const lock = BotHostLock.acquire(directory)!
  try {
    await repair(directory, lock)
  } finally {
    lock.release()
  }
}

it("rejects old initial public create/settings after a genuine old57 all-absent completion", async () => {
  const directory = fixture(),
    sealed = absent.files.filter((file) => file.path.endsWith(".json")),
    active = await client(directory)
  try {
    const create = await active.transport
        .call("create", absent.generation.beforeRequests.create)
        .catch((error: unknown) => error),
      backup = await active.transport
        .call("changeBackupSchedule", absent.generation.beforeRequests.backup)
        .catch((error: unknown) => error)
    expect({ create, backup }).toMatchObject({
      create: { code: "data_epoch" },
      backup: { code: "data_epoch" }
    })
    const epoch = active.store.dataEpoch()
    expect(epoch).not.toBe("initial")
    expect(epoch).not.toBe(absent.generation.restore.nonce)
    expect(active.store.backupSchedule.epoch()).toBe(epoch)
    expect(active.store.snapshot().bots).toHaveLength(0)
    expect(active.store.backupSchedule.read().revision).toBe(0)
    expect(markers(active.store)).toEqual([["workspace.restored", epoch, expect.any(String)]])
    expect(JSON.parse(String(markers(active.store)[0][2])).message).toContain("旧版电脑恢复")
    expect(snapshots(directory)).toHaveLength(0)
    await expect(
      active.transport.call("create", {
        nonce: "fresh-after-compat",
        name: "Current assignment",
        expectedDataEpoch: epoch
      })
    ).resolves.toMatchObject({ bot: { name: "Current assignment" } })
  } finally {
    await active.close()
  }
  for (const file of sealed)
    expect(sha(readFileSync(file.path.replace(/^host(?=\/|\.workspace)/, directory)))).toBe(
      file.sha256
    )
})

it("retains current-schema normal data and its exact pre-fence backup while safely settling pending work once", async () => {
  const directory = fixture(),
    before = pending(directory)
  await lockedRepair(directory)
  const store = new BotStore(join(directory, "bots.sqlite"))
  let epoch: string
  try {
    epoch = store.dataEpoch()
    expect(store.getBot(before.bot.bot.id).name).toBe("Retained normal Bot")
    expect(store.getRun(before.sent.runIds[0])).toMatchObject({
      status: "cancelled",
      error: expect.stringContaining("旧版电脑恢复"),
      leaseOwner: null
    })
    expect(store.getInteraction(before.approval.id).status).toBe("expired")
    expect(
      store
        .messages(before.bot.conversationId)
        .some((message) => message.text.includes("Check the retained evidence"))
    ).toBe(true)
    expect(markers(store)).toHaveLength(1)
  } finally {
    store.close()
  }
  const backups = snapshots(directory)
  expect(backups).toHaveLength(1)
  const saved = new DatabaseSync(join(directory, "backups", backups[0]), { readOnly: true })
  try {
    expect(saved.prepare("SELECT version FROM bot_schema").get()?.version).toBe(BOT_SCHEMA_VERSION)
    assertCurrentSchemaAdditions(saved)
    expect(
      saved.prepare("SELECT status FROM bot_runs WHERE id=?").get(before.sent.runIds[0])?.status
    ).toBe("waiting_input")
    expect(
      saved.prepare("SELECT status FROM bot_interactions WHERE id=?").get(before.approval.id)
        ?.status
    ).toBe("pending")
    expect(
      saved.prepare("SELECT 1 FROM bot_events WHERE kind='workspace.restored'").get()
    ).toBeUndefined()
  } finally {
    saved.close()
  }
  const ledgerRead = vi.spyOn(BotMaintenanceReceipts, "readOnly").mockImplementation(() => {
    throw new Error("A committed generation must not read the ledger again")
  })
  await lockedRepair(directory)
  expect(ledgerRead).not.toHaveBeenCalled()
  ledgerRead.mockRestore()
  const reopened = new BotStore(join(directory, "bots.sqlite"))
  try {
    expect(reopened.dataEpoch()).toBe(epoch!)
    expect(markers(reopened)).toHaveLength(1)
  } finally {
    reopened.close()
  }
  expect(snapshots(directory)).toEqual(backups)
  expect(await executeBotComputerCheckpoint(directory, absent.generation.restore)).toEqual(
    absent.generation.result
  )
})

it("uses the original real57 migration snapshot before fencing the controlled legacy-data composition", async () => {
  const directory = fixture(),
    path = join(directory, "bots.sqlite"),
    bytes = gunzipSync(Buffer.from(prior57.bytes, "base64"))
  expect(sha(bytes)).toBe(prior57.sha256)
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 })
  await lockedRepair(directory)
  const backups = snapshots(directory)
  expect(backups).toHaveLength(1)
  const previous = new DatabaseSync(join(directory, "backups", backups[0]), { readOnly: true })
  try {
    expect(previous.prepare("SELECT version FROM bot_schema").get()?.version).toBe(57)
    expect(
      previous.prepare("SELECT enabled FROM bot_routines WHERE id=?").get(prior57.enabled.id)
        ?.enabled
    ).toBe(1)
  } finally {
    previous.close()
  }
  const store = new BotStore(path)
  try {
    expect(store.dataEpoch()).not.toBe("initial")
    expect(
      store.routines(prior57.request.botId).find((row) => row.id === prior57.enabled.id)
    ).toMatchObject({
      enabled: false,
      desiredEnabled: true,
      activationRequired: true
    })
  } finally {
    store.close()
  }
})

it.each(["no file", "zero-table SQLite", "initialized empty schema"])(
  "finishes an interrupted empty initialization (%s) without an unnecessary backup",
  async (kind) => {
    const directory = fixture(),
      path = join(directory, "bots.sqlite")
    if (kind === "zero-table SQLite") {
      const db = new DatabaseSync(path)
      db.close()
    } else if (kind === "initialized empty schema") {
      new BotStore(path).close()
      const empty = new DatabaseSync(path, { readOnly: true })
      try {
        assertCurrentSchemaAdditions(empty)
      } finally {
        empty.close()
      }
    }
    await lockedRepair(directory)
    const store = new BotStore(path)
    try {
      expect(store.dataEpoch()).not.toBe("initial")
      expect(markers(store)).toHaveLength(1)
      expect(store.snapshot().bots).toHaveLength(0)
    } finally {
      store.close()
    }
    expect(snapshots(directory)).toHaveLength(0)
  }
)

it("does not invent a generation for a fresh user or a create-only ledger", async () => {
  const directory = root(),
    receipts = new BotMaintenanceReceipts(directory)
  try {
    receipts.reserve("computer", randomUUID(), "manual")
  } finally {
    receipts.close()
  }
  await lockedRepair(directory)
  expect(existsSync(join(directory, "bots.sqlite"))).toBe(false)
  const store = new BotStore(join(directory, "bots.sqlite"))
  try {
    store.createBot({ nonce: "new-user", name: "Fresh user" })
    expect(store.dataEpoch()).toBe("initial")
  } finally {
    store.close()
  }
  await lockedRepair(directory)
  const reopened = new BotStore(join(directory, "bots.sqlite"))
  try {
    expect(reopened.dataEpoch()).toBe("initial")
    expect(markers(reopened)).toEqual([])
  } finally {
    reopened.close()
  }
})

it.each([
  "empty unknown table",
  "unknown view",
  "missing ledger with retained recovery",
  "bad receipt hash",
  "pending journal"
])("preserves evidence and refuses ambiguous or damaged input: %s", async (kind) => {
  const directory = fixture(),
    path = join(directory, "bots.sqlite"),
    ledger = join(directory, "maintenance-receipts.sqlite")
  if (kind === "empty unknown table" || kind === "unknown view") {
    const db = new DatabaseSync(path)
    db.exec(
      kind === "unknown view"
        ? "CREATE VIEW unknown_view AS SELECT 1 AS x"
        : "CREATE TABLE unknown_empty(x)"
    )
    db.close()
  } else if (kind === "missing ledger with retained recovery") rmSync(ledger)
  else if (kind === "bad receipt hash") {
    const db = new DatabaseSync(ledger)
    db.prepare(
      "UPDATE operations SET request_sha256=? WHERE scope='computer' AND action='restore'"
    ).run("a".repeat(64))
    db.close()
  } else
    writeFileSync(join(directory, "computer-recovery", "pending.json"), "preserve pending bytes")
  const before = existsSync(path) ? sha(readFileSync(path)) : null
  await expect(lockedRepair(directory)).rejects.toThrow()
  expect(existsSync(path) ? sha(readFileSync(path)) : null).toBe(before)
  expect(snapshots(directory)).toHaveLength(0)
})

it.each(["before commit", "after commit"])(
  "does not expose incomplete work and restarts correctly after a controlled failure %s",
  async (phase) => {
    const directory = fixture(),
      before = pending(directory),
      exec = DatabaseSync.prototype.exec
    let failed = false
    const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql
    ) {
      const fenceCommit =
        sql === "COMMIT" &&
        this.prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_events'"
        ).get() &&
        this.prepare("SELECT 1 FROM bot_events WHERE kind='workspace.restored'").get()
      if (fenceCommit && !failed) {
        failed = true
        if (phase === "after commit") exec.call(this, sql)
        throw new Error(`Controlled compatibility ${phase}`)
      }
      return exec.call(this, sql)
    })
    await expect(lockedRepair(directory)).rejects.toThrow(`Controlled compatibility ${phase}`)
    spy.mockRestore()
    expect(failed).toBe(true)
    const first = new BotStore(join(directory, "bots.sqlite"))
    let epoch: string
    try {
      epoch = first.dataEpoch()
      expect(first.getRun(before.sent.runIds[0]).status).toBe(
        phase === "before commit" ? "waiting_input" : "cancelled"
      )
      expect(markers(first)).toHaveLength(phase === "before commit" ? 0 : 1)
    } finally {
      first.close()
    }
    const read = vi.spyOn(BotMaintenanceReceipts, "readOnly")
    await lockedRepair(directory)
    expect(read).toHaveBeenCalledTimes(phase === "before commit" ? 1 : 0)
    read.mockRestore()
    const second = new BotStore(join(directory, "bots.sqlite"))
    try {
      expect(second.getRun(before.sent.runIds[0]).status).toBe("cancelled")
      expect(markers(second)).toHaveLength(1)
      if (phase === "after commit") expect(second.dataEpoch()).toBe(epoch!)
    } finally {
      second.close()
    }
    expect(snapshots(directory)).toHaveLength(phase === "before commit" ? 2 : 1)
  }
)

it("preserves a modified primary singleton as domain data with an exact pre-fence backup", async () => {
  const directory = fixture(),
    path = join(directory, "bots.sqlite")
  new BotStore(path).close()
  const rows = (db: DatabaseSync) =>
    Object.fromEntries(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        .all()
        .map(({ name }) => [
          String(name),
          db
            .prepare(`SELECT * FROM "${String(name)}"`)
            .all()
            .map((row) =>
              JSON.stringify(row, (_, value) => (value instanceof Uint8Array ? [...value] : value))
            )
            .sort()
        ])
    )
  const edit = new DatabaseSync(path)
  let before: ReturnType<typeof rows>
  try {
    assertCurrentSchemaAdditions(edit)
    edit.prepare("UPDATE bot_primary SET revision=1 WHERE id=1").run()
    before = rows(edit)
    expect(edit.prepare("SELECT * FROM bot_primary").all()).toEqual([
      { id: 1, revision: 1, bot_id: null, default_bot_id: null }
    ])
  } finally {
    edit.close()
  }
  await lockedRepair(directory)
  const backups = snapshots(directory)
  expect(backups).toHaveLength(1)
  const saved = new DatabaseSync(join(directory, "backups", backups[0]), { readOnly: true })
  try {
    expect(rows(saved)).toEqual(before!)
  } finally {
    saved.close()
  }
  const current = new BotStore(path)
  try {
    expect(current.dataEpoch()).not.toBe("initial")
    expect(
      current.db.exec("SELECT id,revision,bot_id,default_bot_id FROM bot_primary")[0].values
    ).toEqual([[1, 1, null, null]])
  } finally {
    current.close()
  }
})
