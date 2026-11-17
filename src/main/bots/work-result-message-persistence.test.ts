import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { beforeAll, afterAll, expect, it, vi } from "vitest"
import * as db from "../db"
import { completeBotResultMessage } from "./work-result-publication"

const storage = vi.hoisted(() => ({ path: "", root: "" }))
vi.mock("../storage", () => ({ getDbPath: () => storage.path,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }), markMemorySessionOptInMigrated: vi.fn() }))
vi.mock("../agent/renderer-stream-mirror", () => ({ mirrorStandardTurnStreamToRenderer: vi.fn() }))
vi.mock("../app-attention-events", () => ({ emitAppAttention: vi.fn() }))
vi.mock("../services/notify", () => ({ notifyIfBackground: vi.fn() }))
beforeAll(async () => {
  storage.root = mkdtempSync(join(tmpdir(), "cmb-bot-result-persistence-"))
  storage.path = join(storage.root, "threads.sqlite")
  await db.initializeDatabase()
})
afterAll(async () => { await db.closeDatabase(); rmSync(storage.root, { recursive: true, force: true }) })

it.each([false, true])("retains links across echo, retry and reopen (blocks=%s)", async blocks => {
  const thread = `result-parent-${blocks}`, id = "normal-final", original = "  Report ready\n"
  const source = blocks ? [{ type: "text" as const, text: original }] : original
  const content = "Report ready\n\n[report.md](#bot-history/work/file/incarnation)"
  db.createThread(thread)
  db.upsertThreadMessages(thread, [{ id, role: "assistant", content: source,
    content_mode: "snapshot", content_priority: 3, created_at: new Date(1) }])
  completeBotResultMessage(thread, id, original.trim(), content)
  // A later unmarked checkpoint echo must not erase appended formal links.
  db.upsertThreadMessages(thread, [{ id, role: "assistant", content: source, created_at: new Date(1) }])
  completeBotResultMessage(thread, id, original.trim(), content)
  await db.closeDatabase()
  await db.initializeDatabase()
  const rows = db.getThreadMessages(thread)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ id, content, content_priority: 3 })
  expect(() => completeBotResultMessage(thread, "missing", "Other", "replacement")).toThrow()
  expect(db.getThreadMessages(thread)).toHaveLength(1)
})
