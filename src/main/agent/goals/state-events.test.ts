import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate as tick } from "node:timers/promises"
import { afterAll, beforeAll, expect, it, vi } from "vitest"

const storage = vi.hoisted(() => ({ path: "" }))
vi.mock("../../storage", () => ({
  getDbPath: () => storage.path,
  getMemorySessionOptInMigrationState: () => ({
    migrated: true,
    legacyMemoryEnabled: false,
    legacyDreamEnabled: false
  }),
  markMemorySessionOptInMigrated: vi.fn()
}))
import * as db from "../../db"
import { SqlGoalStore, createNewGoal } from "./goal-store"
import { onGoalStateChanged } from "./state-events"

let directory = ""
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "mods-goal-idle-notification-"))
  storage.path = join(directory, "db.sqlite")
  await db.initializeDatabase()
})
afterAll(async () => {
  await db.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

it("notifies from actual SQLite mutations after the new state is readable, including bulk pause", async () => {
  const store = new SqlGoalStore()
  const observed: Array<{ id: string; status: string | undefined }> = []
  const stop = onGoalStateChanged((id) => observed.push({ id, status: store.get(id)?.status }))
  try {
    for (const threadId of ["goal-a", "goal-b"]) {
      db.createThread(threadId)
      store.upsert(createNewGoal({ threadId, text: "actual goal", maxTurns: 3 }))
    }
    expect(observed).toEqual([])
    await tick()
    expect(observed).toEqual([
      { id: "goal-a", status: "active" },
      { id: "goal-b", status: "active" }
    ])
    observed.length = 0
    expect(store.pauseActiveGoalsForRuntimeRestore()).toBe(2)
    expect(observed).toEqual([])
    await tick()
    expect(observed).toEqual([
      { id: "goal-a", status: "paused" },
      { id: "goal-b", status: "paused" }
    ])
    observed.length = 0
    store.delete("goal-a")
    await tick()
    expect(observed).toEqual([{ id: "goal-a", status: undefined }])
    stop()
    store.delete("goal-b")
    await tick()
    expect(observed).toHaveLength(1)
  } finally {
    stop()
  }
})
