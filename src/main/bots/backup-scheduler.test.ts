import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, rm, readdir, writeFile, readFile, rename, realpath } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { BotStore } from "./store"
import { BotBackupScheduler } from "./backup-scheduler"
import { BotBackupSnapshotProcess } from "./backup-snapshot-process"
import { BotHostLock } from "./host-lock"
import { BOT_PROTOCOL_VERSION } from "../../shared/bot-types"
import { createScheduledBotSnapshot, executeBotBackup, listBotBackups } from "./backups"
import { createBotAPI } from "./rpc"
import { BotHost } from "./host"

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop()
  vi.restoreAllMocks()
})

it("checks physical ownership before timer startup and claiming a scheduled occurrence", async () => {
  const f = await fixture()
  f.store.backupSchedule.change(f.input())
  f.advance(3_600_000)
  const worker = { create: vi.fn() },
    guard = () => {
      throw new Error("physical lock changed")
    },
    scheduler = new BotBackupScheduler(
      f.store.backupSchedule,
      f.directory,
      randomUUID(),
      worker,
      guard
    )
  cleanup.push(() => scheduler.close())
  vi.spyOn(console, "error").mockImplementation(() => {})
  expect(() => scheduler.start()).toThrow("physical lock changed")
  await scheduler.tick()
  expect(f.store.backupSchedule.read().pendingId).toBeNull()
  expect(worker.create).not.toHaveBeenCalled()
})

it("reports only a committed scheduled backup failure and does not resurrect it on view/pending ticks", async () => {
  const f = await fixture()
  f.store.backupSchedule.change(f.input())
  f.advance(3_600_000)
  const host = new BotHost(f.store)
  cleanup.push(() => host.stop())
  const scheduler = new BotBackupScheduler(f.store.backupSchedule, f.directory, randomUUID(), {
    create: async () => {
      throw new Error("disk rejected; token=PRIVATE_CREDENTIAL")
    }
  })
  cleanup.push(() => scheduler.close())
  scheduler.bindFailureReporter((notice, error) => {
    host.reportFailure(notice, error)
  })
  await scheduler.tick()
  const snapshot = host.getErrorTrays()
  expect(snapshot.items).toHaveLength(1)
  expect(snapshot.items[0]?.source).toBe("backup")
  expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_CREDENTIAL")
  expect(scheduler.view().error).not.toContain("PRIVATE_CREDENTIAL")
  host.clearErrorTrays({
    hostId: snapshot.hostId,
    dataEpoch: snapshot.dataEpoch,
    throughRevision: snapshot.revision
  })
  await scheduler.tick()
  expect(host.getErrorTrays().items).toEqual([])
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cmb-backup-schedule-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  let now = 1_800_000_000_000
  const path = join(directory, "bots.sqlite")
  let store = new BotStore(path, () => now)
  cleanup.push(() => store.close())
  const input = () => ({
    nonce: randomUUID(),
    dataEpoch: store.backupSchedule.epoch(),
    revision: store.backupSchedule.read().revision,
    enabled: true,
    intervalHours: 1
  })
  return {
    directory,
    path,
    get store() {
      return store
    },
    input,
    advance: (ms: number) => {
      now += ms
    },
    reopen: () => {
      store.close()
      store = new BotStore(path, () => now)
    }
  }
}

it("persists a single config receipt, rejects stale/unsafe updates and preserves pending state across reopen", async () => {
  const f = await fixture(),
    request = f.input()
  expect(f.store.backupSchedule.read()).toMatchObject({ enabled: false, revision: 0 })
  const saved = f.store.backupSchedule.change(request)
  f.advance(3_600_000)
  const id = f.store.backupSchedule.claim()
  f.reopen()
  expect(f.store.backupSchedule.change(request)).toEqual(saved)
  expect(f.store.backupSchedule.read().pendingId).toBe(id)
  expect(() => f.store.backupSchedule.change({ ...request, nonce: randomUUID() })).toThrow("已变化")
  expect(() => f.store.backupSchedule.change({ ...f.input(), intervalHours: 0 })).toThrow(
    "配置无效"
  )
  expect(() => f.store.backupSchedule.change({ ...f.input(), directory: "/tmp" })).toThrow(
    "配置无效"
  )
  expect(() => f.store.backupSchedule.change({ ...f.input(), dataEpoch: "old" })).toThrow("已恢复")
  expect(() => f.store.backupSchedule.change({ ...request, enabled: false })).toThrow()
})

it("migrates v28 with a recoverable snapshot and preserves existing work", async () => {
  const f = await fixture()
  const bot = f.store.createBot({ nonce: "original", name: "Original" })
  f.store.close()
  const old = new DatabaseSync(f.path)
  old.exec("DROP TABLE bot_backup_schedule; UPDATE bot_schema SET version=28")
  old.close()
  // reopen closes the already closed adapter safely.
  f.reopen()
  expect(f.store.getBot(bot.bot.id).name).toBe("Original")
  expect(f.store.backupSchedule.read().enabled).toBe(false)
  expect(
    (await readdir(join(f.directory, "backups"))).some((file) => file.startsWith("bots-v28-"))
  ).toBe(true)
})

it("retries a published snapshot with the original nonce after lost worker response, without replaying elapsed periods", async () => {
  const f = await fixture(),
    attempts: string[] = []
  f.store.backupSchedule.change(f.input())
  const worker = {
    create: async (input: { nonce: string }) => {
      attempts.push(input.nonce)
      const backup = await createScheduledBotSnapshot(f.directory, input.nonce)
      if (attempts.length === 1) throw new Error("worker response lost")
      return backup
    }
  }
  let scheduler = new BotBackupScheduler(f.store.backupSchedule, f.directory, randomUUID(), worker)
  cleanup.push(() => scheduler.close())
  await scheduler.tick()
  expect(attempts).toHaveLength(0)
  f.advance(10 * 3_600_000)
  await Promise.all([scheduler.tick(), scheduler.tick(), scheduler.tick()])
  expect(attempts).toHaveLength(1)
  expect(scheduler.view()).toMatchObject({ error: "worker response lost", pendingId: attempts[0] })
  expect(await listBotBackups(f.directory)).toHaveLength(1)
  await scheduler.close()
  f.reopen()
  scheduler = new BotBackupScheduler(f.store.backupSchedule, f.directory, randomUUID(), worker)
  await scheduler.tick()
  expect(attempts).toHaveLength(1)
  f.advance(300_000)
  await scheduler.tick()
  expect(attempts).toEqual([attempts[0], attempts[0]])
  expect(scheduler.view()).toMatchObject({
    error: null,
    pendingId: null,
    lastBackup: { id: attempts[0] }
  })
  await scheduler.tick()
  expect(attempts).toHaveLength(2)
  expect(await listBotBackups(f.directory)).toHaveLength(1)
})

it("allows an in-flight copy to finish after disabling, using the latest settings for the next schedule", async () => {
  const f = await fixture()
  f.store.backupSchedule.change(f.input())
  f.advance(3_600_000)
  let release!: () => void, began!: () => void
  const started = new Promise<void>((r) => {
      began = r
    }),
    wait = new Promise<void>((r) => {
      release = r
    })
  const scheduler = new BotBackupScheduler(f.store.backupSchedule, f.directory, randomUUID(), {
    create: async (input) => {
      began()
      await wait
      return createScheduledBotSnapshot(f.directory, input.nonce)
    }
  })
  cleanup.push(() => scheduler.close())
  const copying = scheduler.tick()
  await started
  expect(scheduler.view().running).toBe(true)
  f.store.backupSchedule.change({ ...f.input(), enabled: false, intervalHours: 12 })
  release()
  await copying
  expect(scheduler.view()).toMatchObject({
    enabled: false,
    intervalHours: 12,
    nextAt: null,
    pendingId: null,
    error: null
  })
  f.advance(100 * 3_600_000)
  await scheduler.tick()
  expect(await listBotBackups(f.directory)).toHaveLength(1)
})

it("ends a deleted pending occurrence after restart without recreating it or immediately scheduling compensation", async () => {
  const f = await fixture(),
    attempts: string[] = []
  f.store.backupSchedule.change(f.input())
  f.advance(3_600_000)
  const first = new BotBackupScheduler(f.store.backupSchedule, f.directory, randomUUID(), {
    create: async (input) => {
      attempts.push(input.nonce)
      await createScheduledBotSnapshot(f.directory, input.nonce)
      throw new Error("worker response lost")
    }
  })
  await first.tick()
  const published = (await listBotBackups(f.directory))[0]
  await first.close()
  f.store.close()
  await executeBotBackup(f.directory, {
    action: "delete",
    backup: { id: published.id, sha256: published.sha256 }
  })
  f.reopen()
  const next = new BotBackupScheduler(f.store.backupSchedule, f.directory, randomUUID(), {
    create: async (input) => {
      attempts.push(input.nonce)
      return createScheduledBotSnapshot(f.directory, input.nonce)
    }
  })
  cleanup.push(() => next.close())
  f.advance(300_000)
  await next.tick()
  expect(next.view()).toMatchObject({ pendingId: null, retryAt: null, error: null })
  const future = next.view().nextAt
  expect(future).toBeGreaterThan(f.store.now())
  await next.tick()
  expect(attempts).toEqual([published.id, published.id])
  expect(await listBotBackups(f.directory)).toEqual([])
  f.advance(3_600_000)
  await next.tick()
  expect(attempts).toHaveLength(3)
  expect(attempts[2]).not.toBe(published.id)
  expect(next.view().lastBackup?.id).toBe(attempts[2])
})

it("cancels the worker during shutdown and resumes the same identity after restart", async () => {
  const f = await fixture()
  f.store.backupSchedule.change(f.input())
  f.advance(3_600_000)
  let began!: () => void
  const started = new Promise<void>((r) => {
    began = r
  })
  const scheduler = new BotBackupScheduler(f.store.backupSchedule, f.directory, randomUUID(), {
    create: (_input, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        began()
      })
  })
  void scheduler.tick()
  await started
  const id = scheduler.view().pendingId
  await scheduler.close()
  f.reopen()
  const next = new BotBackupScheduler(f.store.backupSchedule, f.directory, randomUUID(), {
    create: (input) => createScheduledBotSnapshot(f.directory, input.nonce)
  })
  cleanup.push(() => next.close())
  await next.tick()
  expect(next.view().lastBackup?.id).toBe(id)
})

it("restores data with schedules disabled and rejects old successful config receipts", async () => {
  const f = await fixture(),
    input = f.input()
  f.store.backupSchedule.change(input)
  f.advance(3_600_000)
  const id = f.store.backupSchedule.claim()!
  const backup = await createScheduledBotSnapshot(f.directory, id)
  f.store.close()
  await executeBotBackup(f.directory, {
    action: "restore",
    nonce: randomUUID(),
    backup: { id, sha256: backup.sha256 }
  })
  f.reopen()
  expect(f.store.backupSchedule.read()).toMatchObject({
    enabled: false,
    nextAt: null,
    pendingId: null,
    retryAt: null,
    error: null,
    revision: 2
  })
  expect(() => f.store.backupSchedule.change(input)).toThrow("已恢复")
})

it("uses the actual snapshot worker under the live Host lock, validates parent identity and preserves running tasks", async () => {
  const f = await fixture(),
    lock = BotHostLock.acquire(f.directory)!,
    hostId = randomUUID()
  cleanup.push(() => lock.release())
  lock.publish({
    pid: process.pid,
    version: BOT_PROTOCOL_VERSION,
    hostId,
    token: "fixture-only",
    socketPath: "fixture-only"
  })
  const compiled = process.env.CMB_BOT_BACKUP_TEST_COMPILED === "1"
  const worker = new BotBackupSnapshotProcess({
    entry: resolve(
      compiled ? "out/main/bot-backup-snapshot.js" : "src/main/bots/backup-snapshot-entry.ts"
    ),
    execArgv: compiled ? [] : ["--import", "tsx"]
  })
  const { conversationId } = f.store.createBot({ nonce: "bot", name: "Still running" })
  f.store.send({ nonce: "task", conversationId, text: "Continue" })
  const { lease } = f.store.claim("owner")!
  const input = { directory: f.directory, nonce: randomUUID(), hostId }
  const backup = await worker.create(input, new AbortController().signal)
  expect(backup.reason).toBe("scheduled")
  expect(await worker.create(input, new AbortController().signal)).toEqual(backup)
  expect(f.store.getRun(lease.runId).status).toBe("running")
  await expect(
    worker.create(
      { ...input, nonce: randomUUID(), hostId: randomUUID() },
      new AbortController().signal
    )
  ).rejects.toThrow("所属后台已变化")
  expect(await listBotBackups(f.directory)).toHaveLength(1)
  lock.release()
  f.store.close()
  await executeBotBackup(f.directory, {
    action: "delete",
    backup: { id: backup.id, sha256: backup.sha256 }
  })
  f.reopen()
  const reopenedLock = BotHostLock.acquire(f.directory)!
  cleanup.push(() => reopenedLock.release())
  reopenedLock.publish({
    pid: process.pid,
    version: BOT_PROTOCOL_VERSION,
    hostId,
    token: "fixture-only",
    socketPath: "fixture-only"
  })
  await expect(worker.create(input, new AbortController().signal)).rejects.toMatchObject({
    code: "snapshot_deleted"
  })
  expect(await listBotBackups(f.directory)).toEqual([])
}, 20_000)

it.each(["descriptor", "inode"])(
  "stops a real snapshot worker whose parent %s changes during capture",
  async (mode) => {
    if (mode === "inode" && process.platform === "win32") return // Windows denies renaming the open lock itself.
    const f = await fixture(),
      directory = await realpath(f.directory),
      lock = BotHostLock.acquire(directory)!,
      hostId = randomUUID(),
      descriptor = {
        pid: process.pid,
        version: BOT_PROTOCOL_VERSION,
        hostId,
        token: "fixture-only",
        socketPath: "fixture-only"
      }
    cleanup.push(() => lock.release())
    lock.publish(descriptor)
    const ready = join(directory, "capture-ready"),
      release = join(directory, "capture-release"),
      preload = join(directory, "hold-capture.mjs")
    // Hold the actual worker after VACUUM, before the publication guard. The test
    // hook lives in this disposable process; production accepts no hook IPC.
    await writeFile(
      preload,
      `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const rename = fs.rename;
fs.rename = async (...args) => {
  const result = await rename(...args);
  if (String(args[0]).endsWith('snapshot.sqlite')) {
    const changes = fs.watch(${JSON.stringify(directory)});
    try {
      await fs.writeFile(${JSON.stringify(ready)}, 'captured');
      for await (const _change of changes) {
        try { await fs.access(${JSON.stringify(release)}); break; } catch {}
      }
    } finally { await changes.return(); }
  }
  return result;
};
syncBuiltinESMExports();`
    )
    const compiled = process.env.CMB_BOT_BACKUP_TEST_COMPILED === "1",
      worker = new BotBackupSnapshotProcess({
        entry: resolve(
          compiled ? "out/main/bot-backup-snapshot.js" : "src/main/bots/backup-snapshot-entry.ts"
        ),
        execArgv: [...(compiled ? [] : ["--import", "tsx"]), "--import", preload]
      }),
      request = { directory, nonce: randomUUID(), hostId },
      rejected = expect(worker.create(request, new AbortController().signal)).rejects.toThrow(
        mode === "inode" ? "锁" : "所属后台已变化"
      )
    await expect
      .poll(
        async () => {
          try {
            return await readFile(ready, "utf8")
          } catch {
            return null
          }
        },
        { timeout: 10_000 }
      )
      .toBe("captured")
    if (mode === "descriptor") lock.publish({ ...descriptor, hostId: randomUUID() })
    else {
      await rename(join(directory, "host-lock.sqlite"), join(directory, "displaced-lock.sqlite"))
      const replacement = BotHostLock.acquire(directory)!
      replacement.release()
    }
    await writeFile(release, "continue")
    await rejected
    expect(await listBotBackups(directory)).toEqual([])
  },
  20_000
)

it("rejects a worker terminal result for another nonce and preserves explicit abort errors", async () => {
  const f = await fixture(),
    entry = join(f.directory, "different-result.js"),
    input = { directory: f.directory, nonce: randomUUID(), hostId: randomUUID() }
  await writeFile(
    entry,
    `process.once('message', () => process.send({result: {status: 'deleted', id: '${randomUUID()}'}}, () => process.exit(0)))`
  )
  const worker = new BotBackupSnapshotProcess({ entry })
  await expect(worker.create(input, new AbortController().signal)).rejects.toThrow("结果与任务不符")
  const cancelled = new AbortController(),
    reason = new Error("caller explicitly cancelled")
  cancelled.abort(reason)
  await expect(worker.create(input, cancelled.signal)).rejects.toBe(reason)
})

it("keeps transient error text retryable and uses the latest disabled config when ending a withdrawn occurrence", async () => {
  const f = await fixture()
  f.store.backupSchedule.change(f.input())
  f.advance(3_600_000)
  const scheduler = new BotBackupScheduler(f.store.backupSchedule, f.directory, randomUUID(), {
    create: async () => {
      throw new Error("恢复点已删除")
    }
  })
  cleanup.push(() => scheduler.close())
  await scheduler.tick()
  const pending = scheduler.view().pendingId!
  expect(scheduler.view()).toMatchObject({ pendingId: pending, error: "恢复点已删除" })
  f.store.backupSchedule.skipDeleted(randomUUID())
  expect(scheduler.view().pendingId).toBe(pending)
  f.store.backupSchedule.change({ ...f.input(), enabled: false })
  f.store.backupSchedule.skipDeleted(pending)
  f.store.backupSchedule.skipDeleted(pending)
  f.reopen()
  expect(f.store.backupSchedule.read()).toMatchObject({
    enabled: false,
    pendingId: null,
    retryAt: null,
    nextAt: null,
    error: null
  })
  expect(
    f.store.db.exec("SELECT COUNT(*) FROM bot_events WHERE kind='backup.skipped'")[0].values[0][0]
  ).toBe(1)
})

it("exposes the same validated schedule through RPC without granting worker/file access", async () => {
  const f = await fixture(),
    host = new BotHost(f.store)
  host.backups = new BotBackupScheduler(f.store.backupSchedule, f.directory, host.id)
  cleanup.push(() => host.backups!.close())
  const api = createBotAPI(host)
  expect(await api.backupSchedule()).toMatchObject({ available: true, enabled: false })
  await api.changeBackupSchedule(f.input())
  await expect(
    api.changeBackupSchedule({ ...f.input(), intervalHours: 999 })
  ).rejects.toMatchObject({ code: "invalid_input" })
  expect(await api.backupSchedule()).toMatchObject({ enabled: true, revision: 1 })
  expect(Object.keys(api)).not.toContain("createScheduledBotSnapshot")
})
