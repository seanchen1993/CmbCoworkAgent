import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ManagedRunScheduler } from "./managed-run-scheduler"
import { openNativeSqliteDatabase, type NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import {
  ensureManagedRunSchedulesSchema,
  ManagedRunScheduleStore
} from "../db/managed-run-schedules"

vi.mock("../db", () => ({ getDb: vi.fn() }))
import type { ManagedRunSummary } from "../../shared/harness-board-types"

let root: string
let database: NativeSqliteAdapter
const now = new Date("2026-10-28T10:00:00Z")
const due = new Date("2026-10-28T14:00:00Z")
const input = {
  projectId: "project",
  featureId: "feature",
  workspacePath: "/workspace",
  initialUserMessage: "请继续",
  existingThreadId: "origin",
  scheduledAt: "2026-10-28 22:00:00"
}
const success = { status: "running" } as ManagedRunSummary
function make() {
  return new ManagedRunScheduler(new ManagedRunScheduleStore(() => database))
}
function runtime() {
  return { start: vi.fn(async () => success), changed: vi.fn() }
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "managed-run-schedule-"))
  database = openNativeSqliteDatabase(join(root, "main.sqlite")).database
  ensureManagedRunSchedulesSchema(database)
})
afterEach(() => {
  database.close()
  rmSync(root, { recursive: true, force: true })
})

describe("managed run reservations", () => {
  it("persists in SQLite without starting a run before the due time", async () => {
    const scheduler = make()
    const callbacks = runtime()
    scheduler.initialize(callbacks, now)
    const row = scheduler.create(input, now)
    expect(make().get("project", "feature")).toEqual(row)
    expect(row.createdAt).toBe("2026-10-28 18:00:00")
    await scheduler.tick(new Date(due.getTime() - 1))
    expect(callbacks.start).not.toHaveBeenCalled()
    database.close()
    database = openNativeSqliteDatabase(join(root, "main.sqlite")).database
    const restarted = make()
    restarted.initialize(runtime(), now)
    expect(restarted.get("project", "feature")).toEqual(row)
  })

  it("claims the reservation once, then clears it after successful startup", async () => {
    const scheduler = make()
    const callbacks = runtime()
    let finish!: (run: ManagedRunSummary) => void
    callbacks.start.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    scheduler.initialize(callbacks, now)
    const row = scheduler.create(input, now)
    await scheduler.tick(due)
    expect(callbacks.start).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ scheduleId: row.scheduleId, status: "starting" })
    )
    await scheduler.tick(due)
    expect(callbacks.start).toHaveBeenCalledTimes(1)
    expect(scheduler.listActive()).toEqual([expect.objectContaining({ status: "starting" })])
    expect(() => scheduler.cancel(row)).toThrow("托管正在启动")
    expect(() => scheduler.reschedule({ ...row, scheduledAt: "2026-10-28 23:00:00" }, now)).toThrow(
      "托管正在启动"
    )
    expect(() => scheduler.assertCanStart("project", "feature", row.scheduleId)).not.toThrow()
    expect(() => scheduler.assertCanStart("project", "feature", "wrong")).toThrow(
      "托管预约已发生变化"
    )
    finish(success)
    await vi.waitFor(() => expect(scheduler.get("project", "feature")).toBeNull())
  })

  it("can cancel and change the time without executing at the previous time", async () => {
    const scheduler = make()
    const callbacks = runtime()
    scheduler.initialize(callbacks, now)
    const row = scheduler.create(input, now)
    scheduler.reschedule({ ...row, scheduledAt: "2026-10-28 23:00:00" }, now)
    expect(make().get("project", "feature")?.scheduledAt).toBe("2026-10-28 23:00:00")
    await scheduler.tick(due)
    expect(callbacks.start).not.toHaveBeenCalled()
    scheduler.cancel(row)
    expect(make().get("project", "feature")).toBeNull()
    await scheduler.tick(new Date("2026-10-28T16:00:00Z"))
    expect(callbacks.start).not.toHaveBeenCalled()
  })

  it("rejects invalid times, duplicate reservations, and immediate startup while reserved", () => {
    const scheduler = make()
    expect(() => scheduler.create({ ...input, scheduledAt: "2026-10-28 18:00:00" }, now)).toThrow(
      "晚于当前时间"
    )
    expect(() => scheduler.create({ ...input, scheduledAt: "2026-02-30 22:00:00" }, now)).toThrow(
      "晚于当前时间"
    )
    const row = scheduler.create(input, now)
    expect(() => scheduler.create(input, now)).toThrow("已有托管预约")
    expect(() => scheduler.assertCanStart("project", "feature")).toThrow("已预约托管")
    expect(scheduler.hasActiveProject("project")).toBe(true)
    expect(() => scheduler.cancel({ ...row, scheduleId: "stale" })).toThrow("已发生变化")
    scheduler.cancel(row)
    expect(scheduler.hasActiveProject("project")).toBe(false)
    expect(() => scheduler.assertCanStart("project", "feature")).not.toThrow()
  })

  it("marks overdue reservations missed on restart and allows changing their time", async () => {
    const original = make()
    const row = original.create(input, now)
    const restarted = make()
    const callbacks = runtime()
    restarted.initialize(callbacks, due)
    expect(restarted.get("project", "feature")?.status).toBe("missed")
    expect(restarted.listActive()).toEqual([])
    await restarted.tick(due)
    expect(callbacks.start).not.toHaveBeenCalled()
    restarted.reschedule({ ...row, scheduledAt: "2026-10-28 23:00:00" }, due)
    expect(restarted.get("project", "feature")?.status).toBe("pending")
  })

  it("does not repeat startup interrupted by an application restart", async () => {
    const scheduler = make()
    const callbacks = runtime()
    callbacks.start.mockImplementation(() => new Promise(() => {}))
    scheduler.initialize(callbacks, now)
    scheduler.create(input, now)
    await scheduler.tick(due)
    const restarted = make()
    const nextCallbacks = runtime()
    restarted.initialize(nextCallbacks, due)
    expect(restarted.get("project", "feature")?.status).toBe("failed")
    await restarted.tick(due)
    expect(nextCallbacks.start).not.toHaveBeenCalled()
  })

  it("starts after sleep and records a startup failure without retrying", async () => {
    const scheduler = make()
    const callbacks = runtime()
    callbacks.start.mockRejectedValue(new Error("所选会话已删除"))
    scheduler.initialize(callbacks, now)
    scheduler.create(input, now)
    await scheduler.tick(new Date("2026-10-28T15:00:00Z"))
    await vi.waitFor(() => expect(scheduler.get("project", "feature")?.status).toBe("failed"))
    expect(scheduler.get("project", "feature")?.failureReason).toBe("所选会话已删除")
    expect(scheduler.listActive()).toEqual([])
    await scheduler.tick(due)
    expect(callbacks.start).toHaveBeenCalledTimes(1)
  })

  it("keeps projects separate in one table and only selects due pending work", async () => {
    const scheduler = make()
    const callbacks = runtime()
    scheduler.initialize(callbacks, now)
    const first = scheduler.create(input, now)
    scheduler.create(
      { ...input, projectId: "another-project", scheduledAt: "2026-10-28 23:00:00" },
      now
    )
    scheduler.create({ ...input, featureId: "other-feature" }, now)
    expect(database.exec("SELECT COUNT(*) FROM managed_run_schedules")[0].values[0][0]).toBe(3)
    expect(scheduler.listActive()).toHaveLength(3)
    await scheduler.tick(due)
    await vi.waitFor(() => expect(scheduler.get("project", "feature")).toBeNull())
    expect(callbacks.start).toHaveBeenCalledTimes(2)
    expect(scheduler.get("another-project", "feature")?.status).toBe("pending")
    expect(() => scheduler.cancel(first)).toThrow("已发生变化")
    scheduler.removeProject("project")
    expect(scheduler.get("another-project", "feature")?.status).toBe("pending")
  })

  it("removes failed records when their project is deleted", async () => {
    const scheduler = make()
    const callbacks = runtime()
    callbacks.start.mockRejectedValue(new Error("启动失败"))
    scheduler.initialize(callbacks, now)
    scheduler.create(input, now)
    await scheduler.tick(due)
    await vi.waitFor(() => expect(scheduler.get("project", "feature")?.status).toBe("failed"))
    scheduler.removeProject("project")
    expect(scheduler.get("project", "feature")).toBeNull()
  })
})
