import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
import { prepareFunctionSessionTitle } from "./session-title"
import { withThreadRunMutationLock } from "../../ipc/thread-run-mutation-lock"
let directory = ""
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "mods-title-"))
  storage.path = join(directory, "threads.sqlite")
  await db.initializeDatabase()
})
afterAll(async () => {
  await db.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

it("persists a bounded title through the original DB without touching transcript or metadata", async () => {
  db.createThread("title", { title: "Original", workspacePath: directory })
  const before = db.getThreadCore("title")!
  const changed = vi.fn()
  const pending = prepareFunctionSessionTitle("title", () => {}, changed)
  try {
    expect(await pending.apply("  Reviewed task  ")).toBe(true)
    expect(db.getThreadCore("title")).toMatchObject({
      title: "Reviewed task",
      metadata: before.metadata
    })
    expect(changed).toHaveBeenCalledOnce()
    expect(await pending.apply("Duplicate")).toBe(false)
  } finally {
    pending.close()
  }
  await db.flushStrict()
  await db.closeDatabase()
  await db.initializeDatabase()
  expect(db.getThreadCore("title")?.title).toBe("Reviewed task")
})

it("preserves a concurrent user rename including same-millisecond A/B/A", async () => {
  db.createThread("rename", { title: "Original" })
  const clock = vi.spyOn(Date, "now").mockReturnValue(123456)
  const pending = prepareFunctionSessionTitle("rename", () => {}, vi.fn())
  try {
    db.updateThread("rename", { title: "Human title" })
    db.updateThread("rename", { title: "Original" })
    expect(await pending.apply("Late hook title")).toBe(false)
    expect(db.getThreadCore("rename")?.title).toBe("Original")
  } finally {
    clock.mockRestore()
    pending.close()
  }
})

it("allows unrelated metadata updates but refuses a same-id recreated thread", async () => {
  db.createThread("metadata", { title: "Original" })
  const pending = prepareFunctionSessionTitle("metadata", () => {}, vi.fn())
  try {
    db.updateThread("metadata", { metadata: JSON.stringify({ unrelated: true }) })
    expect(await pending.apply("After metadata")).toBe(true)
  } finally {
    pending.close()
  }
  const replaced = prepareFunctionSessionTitle("metadata", () => {}, vi.fn())
  try {
    db.deleteThread("metadata")
    db.createThread("metadata", { title: "Replacement" })
    await expect(replaced.apply("Late hook title")).rejects.toMatchObject({
      code: "MODS_SESSION_TITLE_STALE"
    })
    expect(db.getThreadCore("metadata")?.title).toBe("Replacement")
  } finally {
    replaced.close()
  }
})

it("rechecks cancellation after waiting for the existing thread mutation lock", async () => {
  db.createThread("cancel-title", { title: "Original" })
  const controller = new AbortController()
  const pending = prepareFunctionSessionTitle(
    "cancel-title",
    () => controller.signal.throwIfAborted(),
    vi.fn()
  )
  let release!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const locked = withThreadRunMutationLock("cancel-title", () => barrier)
  const applying = pending.apply("Cancelled")
  controller.abort()
  release()
  await locked
  await expect(applying).rejects.toThrow()
  expect(db.getThreadCore("cancel-title")?.title).toBe("Original")
  pending.close()
})

it("drops invalid, empty, multiline and disposed titles without a write", async () => {
  db.createThread("invalid-title", { title: "Original" })
  const changed = vi.fn()
  const pending = prepareFunctionSessionTitle("invalid-title", () => {}, changed)
  for (const value of [
    "",
    "   ",
    "line\nbreak",
    "line\u0085break",
    "line\u2028break",
    "x".repeat(513)
  ])
    expect(await pending.apply(value)).toBe(false)
  pending.close()
  expect(await pending.apply("Disposed")).toBe(false)
  expect(changed).not.toHaveBeenCalled()
  expect(db.getThreadCore("invalid-title")?.title).toBe("Original")
})

it("rejects a title proposal captured before database replacement", async () => {
  db.createThread("db-restart", { title: "Before restart" })
  const pending = prepareFunctionSessionTitle("db-restart", () => {}, vi.fn())
  try {
    await db.closeDatabase()
    await db.initializeDatabase()
    await expect(pending.apply("Stale database title")).rejects.toThrow(
      "MODS_SESSION_DATABASE_CHANGED"
    )
    expect(db.getThreadCore("db-restart")?.title).toBe("Before restart")
  } finally {
    pending.close()
  }
})

it("settles cancellation before a held thread lock is released and never writes later", async () => {
  db.createThread("cancel-wait", { title: "Original" })
  const controller = new AbortController()
  const pending = prepareFunctionSessionTitle(
    "cancel-wait",
    () => controller.signal.throwIfAborted(),
    vi.fn(),
    controller.signal
  )
  let release!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const locked = withThreadRunMutationLock("cancel-wait", () => barrier)
  const applying = pending.apply("Late title").catch((error) => error)
  controller.abort()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const outcome = await Promise.race([
      applying,
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve("still blocked"), 250)
      })
    ])
    expect(outcome).toMatchObject({ name: "AbortError" })
  } finally {
    if (timeout) clearTimeout(timeout)
    pending.close()
    release()
    await locked
    await applying
  }
  expect(db.getThreadCore("cancel-wait")?.title).toBe("Original")
})

it("does not write or notify when a hook proposes the already current title", async () => {
  db.createThread("same-title", { title: "Current" })
  const before = db.getThreadCore("same-title")!
  const changed = vi.fn()
  const pending = prepareFunctionSessionTitle("same-title", () => {}, changed)
  try {
    expect(await pending.apply("Current")).toBe(false)
    expect(changed).not.toHaveBeenCalled()
    expect(db.getThreadCore("same-title")?.updated_at).toBe(before.updated_at)
  } finally {
    pending.close()
  }
})
