import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, expect, it, vi } from "vitest"

const storage = vi.hoisted(() => ({ path: "" }))
vi.mock("../storage", () => ({
  getDbPath: () => storage.path,
  getMemorySessionOptInMigrationState: () => ({
    migrated: true,
    legacyMemoryEnabled: false,
    legacyDreamEnabled: false
  }),
  markMemorySessionOptInMigrated: vi.fn()
}))
import * as db from "./index"

let directory = ""
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "plugin-prompt-origin-"))
  storage.path = join(directory, "db.sqlite")
  await db.initializeDatabase()
})
afterAll(async () => {
  await db.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})
const origin = { kind: "plugin" as const, name: "actual", asUser: true as const }
const message = (id = "prompt", content = "words") => ({
  id,
  role: "user" as const,
  content,
  created_at: new Date(1)
})
function commit(thread: string, id = "prompt") {
  db.upsertThreadMessages(thread, [message(id)], {
    preserveExistingOrder: true,
    hostPromptOrigin: { messageId: id, text: "words", origin }
  })
}

it("stores actual words and origin atomically and restores the source from pages and reload", async () => {
  db.createThread("durable")
  commit("durable")
  expect(db.getUserMessagePromptOrigin("durable", "prompt")).toEqual(origin)
  expect(db.getThreadMessagesPage("durable").messages[0]).toMatchObject({
    content: "words",
    prompt_origin: origin
  })
  await db.closeDatabase()
  await db.initializeDatabase()
  expect(db.getThreadMessagesByIds("durable", ["prompt"])[0].prompt_origin).toEqual(origin)
  // Ordinary renderer/model updates cannot erase or replace the durable host identity.
  db.upsertThreadMessages("durable", [
    { ...message(), content: "edited", prompt_origin: { kind: "plugin", name: "forged" } }
  ])
  expect(db.getUserMessagePromptOrigin("durable", "prompt")).toEqual(origin)
})

it("ignores renderer self-reported sources and refuses to stamp an existing human row", () => {
  db.createThread("spoof")
  db.upsertThreadMessages("spoof", [{ ...message(), prompt_origin: origin }])
  expect(db.getUserMessagePromptOrigin("spoof", "prompt")).toBeUndefined()
  expect(() => commit("spoof")).toThrow("MODS_PLUGIN_PROMPT_ORIGIN_CONFLICT")
  expect(db.getThreadMessages("spoof")[0].prompt_origin).toBeUndefined()
  expect(() =>
    db.upsertThreadMessages("spoof", [message("new")], {
      hostPromptOrigin: { messageId: "new", text: "wrong words", origin }
    })
  ).toThrow("MODS_PLUGIN_PROMPT_ORIGIN_INVALID")
  expect(db.getThreadMessagesByIds("spoof", ["new"])).toHaveLength(0)
})

it("rolls the user row and bucket back if the source update fails inside its transaction", () => {
  db.createThread("rollback")
  db.getDb().run(
    "CREATE TRIGGER reject_prompt_origin BEFORE UPDATE OF prompt_origin_json ON thread_messages BEGIN SELECT RAISE(ABORT, 'SOURCE_UPDATE_FAILED'); END"
  )
  try {
    expect(() => commit("rollback")).toThrow("SOURCE_UPDATE_FAILED")
    expect(db.getThreadMessages("rollback")).toHaveLength(0)
    expect(db.getThreadMessageCount("rollback")).toBe(0)
  } finally {
    db.getDb().run("DROP TRIGGER reject_prompt_origin")
  }
})

it("keeps the source with ID aliases, deletes it with the thread and never guesses old authors", () => {
  db.createThread("alias")
  commit("alias")
  expect(db.replaceThreadMessageId("alias", "prompt", "stable", "user")).toBe(true)
  expect(db.getUserMessagePromptOrigin("alias", "stable")).toEqual(origin)
  expect(db.getUserMessagePromptOrigin("alias", "prompt")).toBeUndefined()
  db.createThread("legacy")
  db.upsertThreadMessages("legacy", [message()])
  expect(db.getThreadMessages("legacy")[0].prompt_origin).toBeUndefined()
  db.deleteThread("alias")
  db.createThread("alias")
  expect(db.getUserMessagePromptOrigin("alias", "stable")).toBeUndefined()
})
