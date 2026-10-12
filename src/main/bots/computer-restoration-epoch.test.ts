import { afterEach, expect, it, vi } from "vitest"
import { randomBytes, randomUUID } from "node:crypto"
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BotStore } from "./store"
import { BotHost } from "./host"
import { BotHostLock } from "./host-lock"
import { BotRpcServer } from "./rpc"
import { BotTransportClient } from "./transport-client"
import { BotBackupScheduler } from "./backup-scheduler"
import { ComputerNativeSQLite } from "./computer-checkpoint-native"
import { BotDeletionLedger } from "./deletion-ledger"
import { checkedBotCheckpointDatabase, fenceBotCheckpointDatabase } from "./checkpoint-data"
import {
  deleteBotComputerRecoveryCopy,
  executeBotComputerCheckpoint,
  listBotComputerRecoveryCopies,
  recoverBotComputerCheckpoint
} from "./computer-checkpoint-service"
import { readPrivateJson } from "./backup-io"
import { computerPrepared, computerJournal, validatePrepared } from "./computer-checkpoint-manifest"

const roots: string[] = []
const options = {
  nativeEntry: resolve("src/main/bots/computer-checkpoint-native-entry.ts"),
  nativeExecArgv: ["--import", "tsx"]
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
    await rm(`${root}.workspace`, { recursive: true, force: true })
  }
})
async function root() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cmb-computer-epoch-")))
  roots.push(directory)
  return directory
}
async function client(directory: string) {
  const lock = BotHostLock.acquire(directory)
  if (!lock) throw new Error("Lock occupied")
  const store = new BotStore(join(directory, "bots.sqlite")),
    host = new BotHost(store)
  host.bindOwnership(lock)
  host.backups = new BotBackupScheduler(store.backupSchedule, directory, host.id, undefined, () =>
    lock.assertCurrent()
  )
  const socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\cmb-epoch-${randomBytes(12).toString("hex")}`
        : join(directory, "rpc.sock"),
    token = randomBytes(32).toString("hex"),
    rpc = new BotRpcServer(host, token)
  await rpc.listen(socketPath)
  const transport = new BotTransportClient({
    version: 1,
    pid: process.pid,
    hostId: host.id,
    socketPath,
    token
  })
  return {
    store,
    transport,
    async close() {
      await transport.closeAndWait()
      await rpc.close()
      await host.backups!.close()
      await host.stop()
      store.close()
      lock.release()
    }
  }
}
async function point(directory: string) {
  const result = await executeBotComputerCheckpoint(
    directory,
    { action: "create", nonce: randomUUID() },
    options
  )
  if (result.action !== "create") throw new Error("Expected create")
  return result.checkpoint
}
function restore(checkpoint: { id: string; sha256: string }) {
  return { action: "restore", nonce: randomUUID(), checkpoint } as const
}
function restoreEvents(store: BotStore) {
  return (
    store.db.exec(
      "SELECT kind,entity_id FROM bot_events WHERE kind IN ('workspace.restored','computer.restored') ORDER BY cursor"
    )[0]?.values ?? []
  )
}
function expectEpoch(store: BotStore, nonce: string) {
  expect(store.dataEpoch()).toBe(nonce)
  expect(store.backupSchedule.epoch()).toBe(nonce)
  expect(restoreEvents(store)).toEqual([
    ["workspace.restored", nonce],
    ["computer.restored", nonce]
  ])
}

it("advances public mutation and backup epochs when the actual native worker restores an established database", async () => {
  const directory = await root(),
    original = await client(directory),
    input = { nonce: randomUUID(), name: "Original", expectedDataEpoch: "initial" },
    saved = await original.transport.call("create", input)
  await original.close()
  const captured = await point(directory)
  expect(captured).toMatchObject({ data: "established", shared: "absent", browser: "absent" })
  const request = restore({ id: captured.id, sha256: captured.sha256 })
  await executeBotComputerCheckpoint(directory, request, options)
  const current = await client(directory)
  try {
    expect(current.store.getBot(saved.bot.id).name).toBe("Original")
    expectEpoch(current.store, request.nonce)
    expect(await current.transport.call("status")).toMatchObject({ dataEpoch: request.nonce })
    await expect(current.transport.call("create", input)).rejects.toMatchObject({
      code: "data_epoch"
    })
  } finally {
    await current.close()
  }
  expect(await executeBotComputerCheckpoint(directory, request, options)).toMatchObject({
    recoveryCopy: request.nonce
  })
  const copies = await listBotComputerRecoveryCopies(directory)
  expect(copies).toHaveLength(1)
  await deleteBotComputerRecoveryCopy(
    directory,
    { id: copies[0].id, sha256: copies[0].sha256 },
    options
  )
  const reopened = new BotStore(join(directory, "bots.sqlite"))
  try {
    expectEpoch(reopened, request.nonce)
  } finally {
    reopened.close()
  }
}, 20_000)

it.each([false, true])(
  "prepares an empty epoch-bearing control database for an absent point (prior Host: %s)",
  async (priorHost) => {
    const directory = await root(),
      captured = await point(directory)
    expect(captured).toMatchObject({
      data: "absent",
      shared: "absent",
      browser: "absent",
      bytes: 0,
      files: 0
    })
    for (const file of ["bots.sqlite", "workspace.private.json", "browser-profile"])
      await expect(stat(join(directory, file))).rejects.toMatchObject({ code: "ENOENT" })
    const input = { nonce: randomUUID(), name: "Stale request", expectedDataEpoch: "initial" },
      settings = {
        nonce: randomUUID(),
        dataEpoch: "initial",
        revision: 0,
        enabled: false,
        intervalHours: 48
      }
    if (priorHost) {
      const previous = await client(directory)
      try {
        await previous.transport.call("create", input)
        await previous.transport.call("changeBackupSchedule", settings)
      } finally {
        await previous.close()
      }
    }
    const request = restore({ id: captured.id, sha256: captured.sha256 })
    await executeBotComputerCheckpoint(directory, request, options)
    const controlDatabase = await stat(join(directory, "bots.sqlite")).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      }
    )
    const current = await client(directory)
    try {
      const staleCreate = await current.transport
          .call("create", input)
          .catch((error: unknown) => error),
        staleSettings = await current.transport
          .call("changeBackupSchedule", settings)
          .catch((error: unknown) => error)
      expect({ staleCreate, staleSettings }).toMatchObject({
        staleCreate: { code: "data_epoch" },
        staleSettings: { code: "data_epoch" }
      })
      expect(controlDatabase?.size).toBeGreaterThan(0)
      expectEpoch(current.store, request.nonce)
      expect(current.store.snapshot().bots).toEqual([])
      for (const table of [
        "bot_messages",
        "bot_runs",
        "bot_interactions",
        "bot_receipts",
        "bot_local_tool_policy",
        "bot_local_tool_requests",
        "bot_approval_rules"
      ])
        expect(current.store.db.exec(`SELECT COUNT(*) FROM ${table}`)[0].values[0][0]).toBe(0)
      expect(current.store.backupSchedule.read()).toMatchObject({ enabled: false, nextAt: null })
      const fresh = await current.transport.call("create", {
        nonce: randomUUID(),
        name: "Fresh request",
        expectedDataEpoch: request.nonce
      })
      expect(fresh.bot.name).toBe("Fresh request")
    } finally {
      await current.close()
    }
    for (const file of ["workspace.private.json", "browser-profile"])
      await expect(stat(join(directory, file))).rejects.toMatchObject({ code: "ENOENT" })
  },
  20_000
)

it.each(["journal.published", "slot.next:database"])(
  "resumes the original checksum journal for an empty source after interruption at %s",
  async (step) => {
    const directory = await root(),
      captured = await point(directory),
      previous = await client(directory)
    await previous.transport.call("create", { nonce: randomUUID(), name: "Displaced original" })
    await previous.close()
    const request = restore({ id: captured.id, sha256: captured.sha256 })
    await expect(
      executeBotComputerCheckpoint(directory, request, {
        ...options,
        afterStep(current) {
          if (current === step) throw new Error("Controlled interrupted coordinator")
        }
      })
    ).rejects.toMatchObject({ code: "computer_checkpoint_incomplete" })
    const pending = computerJournal.parse(
        (await readPrivateJson(join(directory, "computer-recovery"), "pending.json")).value
      ),
      prepared = validatePrepared(
        (
          await readPrivateJson(
            join(directory, "computer-recovery", `.restore-${request.nonce}`),
            "prepared.json"
          )
        ).value
      )
    expect(pending.nonce).toBe(request.nonce)
    expect(computerPrepared.parse(prepared).components.data.state).toBe("established")
    expect(prepared.slots.find((slot) => slot.name === "database")?.replacement.state).toBe(
      "established"
    )
    const lock = BotHostLock.acquire(directory)
    if (!lock) throw new Error("Released coordinator left a lock owner")
    try {
      await recoverBotComputerCheckpoint(directory, lock, options)
    } finally {
      lock.release()
    }
    expect(await executeBotComputerCheckpoint(directory, request, options)).toMatchObject({
      recoveryCopy: request.nonce
    })
    const reopened = new BotStore(join(directory, "bots.sqlite"))
    try {
      expectEpoch(reopened, request.nonce)
      expect(reopened.snapshot().bots).toEqual([])
    } finally {
      reopened.close()
    }
    expect(await listBotComputerRecoveryCopies(directory)).toHaveLength(1)
  },
  20_000
)

it("keeps the original database and releases an unsealed empty preparation after cancellation", async () => {
  const directory = await root(),
    captured = await point(directory),
    previous = await client(directory)
  const saved = await previous.transport.call("create", {
    nonce: randomUUID(),
    name: "Retain original"
  })
  await previous.close()
  const controller = new AbortController(),
    request = restore({ id: captured.id, sha256: captured.sha256 })
  await expect(
    executeBotComputerCheckpoint(directory, request, {
      ...options,
      signal: controller.signal,
      afterStep(step) {
        if (step === "prepare.started")
          controller.abort(new Error("Cancelled before native preparation"))
      }
    })
  ).rejects.toMatchObject({ code: "computer_checkpoint_rejected" })
  for (const file of ["pending.json", `.restore-${request.nonce}`])
    await expect(stat(join(directory, "computer-recovery", file))).rejects.toMatchObject({
      code: "ENOENT"
    })
  const reopened = new BotStore(join(directory, "bots.sqlite"))
  try {
    expect(reopened.getBot(saved.bot.id).name).toBe("Retain original")
    expect(reopened.dataEpoch()).toBe("initial")
    expect(restoreEvents(reopened)).toEqual([])
  } finally {
    reopened.close()
  }
  await executeBotComputerCheckpoint(directory, request, options)
  const restored = new BotStore(join(directory, "bots.sqlite"))
  try {
    expectEpoch(restored, request.nonce)
    expect(restored.snapshot().bots).toEqual([])
  } finally {
    restored.close()
  }
}, 20_000)

it("discards a cancelled empty control database before its journal can publish", async () => {
  const directory = await root(),
    captured = await point(directory),
    previous = await client(directory)
  const saved = await previous.transport.call("create", {
    nonce: randomUUID(),
    name: "Keep original"
  })
  await previous.close()
  const controller = new AbortController(),
    request = restore({ id: captured.id, sha256: captured.sha256 }),
    fence = ComputerNativeSQLite.prototype.fence
  let prepared = false
  const spy = vi.spyOn(ComputerNativeSQLite.prototype, "fence").mockImplementation(async function (
    this: ComputerNativeSQLite,
    ...args
  ) {
    const result = await fence.apply(this, args)
    const path = join(
      directory,
      "computer-recovery",
      `.restore-${request.nonce}`,
      "next",
      "bots.sqlite"
    )
    const db = checkedBotCheckpointDatabase(path)
    try {
      expect(
        db.prepare("SELECT entity_id FROM bot_events WHERE kind='workspace.restored'").get()
          ?.entity_id
      ).toBe(request.nonce)
      expect(db.prepare("SELECT COUNT(*) AS count FROM bots").get()?.count).toBe(0)
      prepared = true
    } finally {
      db.close()
    }
    controller.abort(new Error("Cancelled after native preparation"))
    return result
  })
  try {
    await expect(
      executeBotComputerCheckpoint(directory, request, { ...options, signal: controller.signal })
    ).rejects.toMatchObject({ code: "computer_checkpoint_rejected" })
  } finally {
    spy.mockRestore()
  }
  expect(prepared).toBe(true)
  for (const file of ["pending.json", `.restore-${request.nonce}`])
    await expect(stat(join(directory, "computer-recovery", file))).rejects.toMatchObject({
      code: "ENOENT"
    })
  const retained = new BotStore(join(directory, "bots.sqlite"))
  try {
    expect(retained.getBot(saved.bot.id).name).toBe("Keep original")
    expect(retained.dataEpoch()).toBe("initial")
    expect(restoreEvents(retained)).toEqual([])
  } finally {
    retained.close()
  }
}, 20_000)

it.each([undefined, "computer.restored" as const])(
  "rolls the generic and audit events back with the original task fence (%s)",
  async (event) => {
    const directory = await root(),
      path = join(directory, "bots.sqlite"),
      store = new BotStore(path),
      bot = store.createBot({ nonce: "bot", name: "Original" })
    const sent = store.send({
      nonce: "task",
      conversationId: bot.conversationId,
      text: "Retain queued task"
    })
    store.close()
    const ledger = new BotDeletionLedger(path)
    let guards = 0
    try {
      expect(() =>
        fenceBotCheckpointDatabase(
          path,
          randomUUID(),
          ledger,
          event ? { event, reason: "Controlled restore" } : undefined,
          () => {
            if (++guards === 3) throw new Error("Lost owner before commit")
          }
        )
      ).toThrow("Lost owner before commit")
    } finally {
      ledger.close()
    }
    const reopened = new BotStore(path)
    try {
      expect(reopened.getRun(sent.runIds[0]).status).toBe("queued")
      expect(reopened.dataEpoch()).toBe("initial")
      expect(restoreEvents(reopened)).toEqual([])
    } finally {
      reopened.close()
    }
    const nextLedger = new BotDeletionLedger(path),
      nonce = randomUUID()
    try {
      fenceBotCheckpointDatabase(path, nonce, nextLedger)
    } finally {
      nextLedger.close()
    }
    const db = checkedBotCheckpointDatabase(path)
    try {
      expect(
        db
          .prepare(
            "SELECT kind,entity_id FROM bot_events WHERE kind IN ('workspace.restored','computer.restored') ORDER BY cursor"
          )
          .all()
      ).toEqual([{ kind: "workspace.restored", entity_id: nonce }])
    } finally {
      db.close()
    }
    expect((await readFile(path)).length).toBeGreaterThan(0)
  }
)
