import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, expect, it, vi } from "vitest"
import type { BotScheduleInput } from "../../shared/bots/contracts"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { LocalBotHost } from "./host"
import { BotStore } from "./store"

const fs = vi.hoisted(() => ({ stat: vi.fn<typeof import("node:fs/promises").stat>() }))
vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(),
  stat: fs.stat
}))

const interval: BotScheduleInput = {
  name: "Update the report",
  message: "Update it using the original directory",
  frequency: "interval",
  intervalMinutes: 10,
  enabled: true
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  fs.stat.mockReset()
  vi.restoreAllMocks()
})

async function fixture() {
  const { stat } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  fs.stat.mockImplementation(stat)
  const root = await mkdtemp(join(tmpdir(), "cmb-work-schedule-"))
  const project = join(root, "project")
  const path = join(project, "reports")
  await mkdir(path, { recursive: true })
  let now = Date.parse("2030-01-01T00:00:00Z")
  vi.spyOn(Date, "now").mockImplementation(() => now)
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(db, () => now)
  const execute = vi.fn(async () => ({ state: "completed" as const }))
  const release = vi.fn()
  const onError = vi.fn()
  const host = new LocalBotHost(store, {
    acquire: (_bot, task) => task.origin.kind === "schedule" ? { execute, release } : null,
    onAvailable: () => () => {},
    desktopWorkScheduleDirectory: (work) => work.workspace && { path: work.workspace.path }
  }, 2, onError, (input, from) =>
    input.runAt ?? new Date(Math.max(now, from.getTime()) + (input.intervalMinutes ?? 10) * 60_000).toISOString())
  cleanups.push(async () => {
    await host.stop()
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  const bot = store.create({ name: "Owner", instructions: "", color: "#123456", modelRef: null })
  const opener = store.enqueue({ botId: bot.id, requestId: "opener", message: "Open this Bot" })
  store.transition(opener.id, "running")
  store.settle(opener.id, "completed", null)
  const { work, task } = store.createWork({
    botId: bot.id, operationId: "work", title: "Report", goal: "Prepare the report"
  }, undefined, { kind: "directory", path })
  store.transition(task.id, "running")
  store.settle(task.id, "completed", null)
  const schedule = host.saveSchedule(bot.id, interval, undefined, undefined, {
    workId: work.id, operationId: "schedule"
  })
  return {
    bot, work, root, project, path, host, store, execute, release, onError, schedule,
    advance(ms = 10 * 60_000 + 5) {
      now += ms
      host.resume()
    },
    triggers: () => store.recentTasks().filter(task => task.origin.kind === "schedule")
  }
}

it.each(["missing directory", "file in the original path", "file in a parent path"])(
  "reports and pauses a repeated work schedule with a %s", async (change) => {
    const f = await fixture()
    await rename(f.project, join(f.root, "moved"))
    if (change === "file in the original path") {
      await mkdir(f.project)
      await writeFile(f.path, "")
    } else if (change === "file in a parent path") {
      await writeFile(f.project, "")
    }
    f.advance()
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledTimes(1))
    expect(fs.stat).toHaveBeenCalledExactlyOnceWith(f.path)
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.store.schedules()).toMatchObject([{
      id: f.schedule.id, enabled: false, nextRunAt: null, workUnavailable: true
    }])
    expect(f.triggers()).toMatchObject([{ state: "failed", error: expect.stringContaining("例行已暂停") }])
    expect(f.store.getWork(f.bot.id, f.work.id).activity?.preview).toContain("例行已暂停")
    f.advance()
    expect(f.triggers()).toHaveLength(1)
    expect(f.onError).not.toHaveBeenCalled()
  }
)

it.each(["reschedule", "pause"])("honors %s while the unstarted occurrence is checking its directory", async (change) => {
  const f = await fixture()
  const pending = Promise.withResolvers<never>()
  fs.stat.mockReturnValueOnce(pending.promise)
  f.advance()
  await vi.waitFor(() => expect(fs.stat).toHaveBeenCalledTimes(1))
  expect(f.triggers()).toMatchObject([{ state: "queued" }])
  const [before] = f.store.schedules()
  const saved = f.host.saveSchedule(f.bot.id,
    { ...interval, ...(change === "pause" ? { enabled: false } : { intervalMinutes: 20 }) }, before)
  pending.reject(Object.assign(new Error("missing directory"), { code: "ENOENT" }))
  await vi.waitFor(() => expect(f.release).toHaveBeenCalledTimes(1))
  expect(f.store.schedules()).toEqual([saved])
  expect(f.triggers()).toMatchObject([{ state: "cancelled" }])
  expect(f.execute).not.toHaveBeenCalled()
  expect(f.onError).not.toHaveBeenCalled()
})

it("rechecks the original directory after an edit preserves the same occurrence", async () => {
  const f = await fixture()
  const previousProbe = Promise.withResolvers<never>()
  const currentProbe = Promise.withResolvers<never>()
  fs.stat.mockReturnValueOnce(previousProbe.promise).mockReturnValueOnce(currentProbe.promise)
  f.advance()
  await vi.waitFor(() => expect(fs.stat).toHaveBeenCalledTimes(1))
  const [before] = f.store.schedules()
  const edited = f.host.saveSchedule(f.bot.id, { ...interval, name: "Renamed" }, before)
  previousProbe.reject(Object.assign(new Error("missing directory"), { code: "ENOENT" }))
  await vi.waitFor(() => expect(fs.stat).toHaveBeenCalledTimes(2))
  expect(f.store.schedules()).toEqual([edited])
  expect(f.triggers()).toMatchObject([{ state: "queued" }])
  currentProbe.reject(Object.assign(new Error("missing directory"), { code: "ENOENT" }))
  await vi.waitFor(() => expect(f.release).toHaveBeenCalledTimes(2))
  expect(f.triggers()).toMatchObject([{ state: "failed" }])
  expect(f.store.schedules()).toMatchObject([{ name: edited.name, version: edited.version + 1, enabled: false }])
  expect(f.execute).not.toHaveBeenCalled()
})

it("cancels the exact queued occurrence during a directory check", async () => {
  const f = await fixture()
  const pending = Promise.withResolvers<never>()
  fs.stat.mockReturnValueOnce(pending.promise)
  f.advance()
  await vi.waitFor(() => expect(fs.stat).toHaveBeenCalledTimes(1))
  const [trigger] = f.triggers()
  f.host.cancel(trigger.id)
  await vi.waitFor(() => expect(f.release).toHaveBeenCalledTimes(1))
  pending.reject(Object.assign(new Error("missing directory"), { code: "ENOENT" }))
  expect(f.triggers()).toMatchObject([{ id: trigger.id, state: "cancelled" }])
  expect(f.store.schedules()).toMatchObject([{ id: f.schedule.id, enabled: true }])
  expect(f.execute).not.toHaveBeenCalled()
})

it("releases the claim and stops dispatch when the pause receipt cannot be persisted", async () => {
  const f = await fixture()
  await rename(f.project, join(f.root, "moved"))
  const error = new Error("database write failed")
  const persist = vi.spyOn(f.store, "pauseScheduleForMissingDirectory").mockImplementation(() => { throw error })
  f.advance()
  await vi.waitFor(() => expect(f.release).toHaveBeenCalledTimes(1))
  expect(f.onError).toHaveBeenCalledExactlyOnceWith(error)
  expect(f.triggers()).toMatchObject([{ state: "queued" }])
  expect(persist).toHaveBeenCalledTimes(1)
  f.advance()
  await Promise.resolve()
  expect(persist).toHaveBeenCalledTimes(1)
  expect(f.execute).not.toHaveBeenCalled()
})

it.each(["valid", "permission denied"])("leaves the schedule enabled for a %s directory check", async (change) => {
  const f = await fixture()
  if (change === "permission denied")
    fs.stat.mockRejectedValueOnce(Object.assign(new Error("cannot access directory"), { code: "EACCES" }))
  f.advance()
  await vi.waitFor(() => expect(f.release).toHaveBeenCalledTimes(1))
  expect(f.execute).toHaveBeenCalledTimes(1)
  expect(f.store.schedules()).toMatchObject([{ id: f.schedule.id, enabled: true }])
  expect(f.store.schedules()[0].workUnavailable).toBeUndefined()
})

it.each(["one-shot work schedule", "ordinary routine"])("skips directory preflight for %s", async (kind) => {
  const f = await fixture()
  f.host.removeSchedule(f.schedule.id, f.schedule.version)
  if (kind === "one-shot work schedule")
    f.host.saveSchedule(f.bot.id, {
      ...interval, frequency: "once", intervalMinutes: undefined,
      runAt: new Date(Date.now() + 5 * 60_000).toISOString()
    }, undefined, undefined, { workId: f.work.id, operationId: "once" })
  else {
    const other = f.store.create({ name: "Routine owner", instructions: "", color: "#123456", modelRef: null })
    const opener = f.store.enqueue({ botId: other.id, requestId: "open-other", message: "Open this Bot" })
    f.store.transition(opener.id, "running")
    f.store.settle(opener.id, "completed", null)
    f.host.saveSchedule(other.id, interval)
  }
  await rename(f.project, join(f.root, "moved"))
  f.advance()
  expect(f.triggers()).toMatchObject([{ state: "queued" }])
  expect(f.onError).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(f.release).toHaveBeenCalledTimes(1))
  expect(fs.stat).not.toHaveBeenCalled()
  expect(f.execute).toHaveBeenCalledTimes(1)
})
