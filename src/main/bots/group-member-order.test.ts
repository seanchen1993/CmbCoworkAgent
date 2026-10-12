import { afterEach, expect, it, vi } from "vitest"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { BotStore } from "./store"
import { initializeBotDatabase } from "./migrations"
import { BOT_SCHEMA_VERSION } from "./schema"

const cleanup: (() => void)[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) close()
})

function directory() {
  const root = mkdtempSync(join(tmpdir(), "bot-member-order-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function open(path = ":memory:") {
  const store = new BotStore(path)
  cleanup.push(() => store.close())
  return store
}

function members(store: BotStore) {
  // Oppose lexical UUID order deterministically; do not rely on chance.
  return Array.from(
    { length: 4 },
    (_, index) => store.createBot({ nonce: `bot-${index}`, name: `Bot ${index}` }).bot.id
  )
    .sort()
    .reverse()
}

it("persists the user's initial member order and dispatches that first speaker after reopen", () => {
  const path = join(directory(), "bots.sqlite")
  const store = open(path)
  const selected = members(store)
  const input = { nonce: "group", name: "Project", members: selected }
  const group = store.createGroup(input)
  expect(group.members).toEqual(selected)
  store.close()
  const reopened = open(path)
  expect(reopened.createGroup(input)).toEqual(group)
  expect(reopened.getConversation(group.id).members).toEqual(selected)
  reopened.send({ nonce: "work", conversationId: group.id, text: "Check the project" })
  expect(reopened.claim("host")?.run.botId).toBe(selected[0])
})

it("keeps an unchanged set's order and active approval, but stores the order of changed membership", () => {
  const store = open()
  const ids = members(store)
  const group = store.createGroup({ nonce: "group", name: "Project", members: ids.slice(0, 3) })
  store.send({ nonce: "work", conversationId: group.id, text: "Check" })
  const claim = store.claim("host")!
  const approval = store.requestInteraction(claim.lease, {
    kind: "approval",
    action: { tool: "check" },
    prompt: "Check"
  })
  const run = store.getRun(claim.run.id)
  const current = store.getConversation(group.id)
  expect(
    store.updateGroup({
      ...group,
      description: "",
      nonce: "same-set",
      members: [...group.members].reverse()
    })
  ).toEqual(current)
  expect(store.getRun(claim.run.id)).toEqual(run)
  expect(store.getInteraction(approval.id).status).toBe("pending")
  const selected = [ids[3], ids[1], ids[0]]
  const changed = store.updateGroup({
    ...group,
    description: "",
    nonce: "changed-set",
    members: selected
  })
  expect(changed.members).toEqual(selected)
  expect(changed.revision).toBe(group.revision + 1)
  expect(store.getInteraction(approval.id).status).toBe("cancelled")
  expect(store.getRun(claim.run.id).status).toBe("cancelling")
})

function legacy70() {
  const root = directory()
  const path = join(root, "bots.sqlite")
  const store = open(path)
  const selected = members(store).reverse()
  const group = store.createGroup({ nonce: "legacy-group", name: "Existing", members: selected })
  store.send({ nonce: "legacy-work", conversationId: group.id, text: "Already accepted" })
  const claim = store.claim("legacy-host")!
  const before = store.getRun(claim.run.id)
  const current = store.getConversation(group.id)
  store.close()
  const db = new DatabaseSync(path)
  cleanup.push(() => db.close())
  db.exec("ALTER TABLE bot_members DROP COLUMN position; UPDATE bot_schema SET version=70")
  // Legacy display order was bot_id, irrespective of physical insertion order.
  db.prepare("DELETE FROM bot_members WHERE conversation_id=?").run(group.id)
  for (const id of [...selected].reverse())
    db.prepare("INSERT INTO bot_members VALUES(?,?)").run(group.id, id)
  const cycles = db.prepare("SELECT * FROM bot_group_cycles ORDER BY id").all()
  const groupRuns = db.prepare("SELECT * FROM bot_group_runs ORDER BY run_id").all()
  return { root, path, db, group: current, before, selected, cycles, groupRuns }
}

it("upgrades schema70 without changing legacy visible order or in-flight cycle authority", () => {
  const f = legacy70()
  initializeBotDatabase(f.db, f.path)
  expect(f.db.prepare("SELECT version FROM bot_schema").get()?.version).toBe(BOT_SCHEMA_VERSION)
  expect(f.db.prepare("SELECT * FROM bot_group_cycles ORDER BY id").all()).toEqual(f.cycles)
  expect(f.db.prepare("SELECT * FROM bot_group_runs ORDER BY run_id").all()).toEqual(f.groupRuns)
  const store = open(f.path)
  expect(store.getConversation(f.group.id)).toEqual(f.group)
  expect(store.getRun(f.before.id)).toEqual(f.before)
  expect(
    store.db.exec(
      "SELECT bot_id,position FROM bot_members WHERE conversation_id=? ORDER BY position",
      [f.group.id]
    )[0].values
  ).toEqual(f.selected.map((id, position) => [id, position]))
  const name = readdirSync(join(f.root, "backups")).find((value) => value.startsWith("bots-v70-"))!
  const backup = new DatabaseSync(join(f.root, "backups", name), { readOnly: true })
  try {
    expect(backup.prepare("SELECT version FROM bot_schema").get()?.version).toBe(70)
    expect(
      backup
        .prepare("PRAGMA table_info(bot_members)")
        .all()
        .map((column) => column.name)
    ).not.toContain("position")
    expect(backup.prepare("SELECT * FROM bot_group_cycles ORDER BY id").all()).toEqual(f.cycles)
  } finally {
    backup.close()
  }
})

it("rolls back an interrupted order backfill and retains the legacy backup", () => {
  const f = legacy70()
  const exec = f.db.exec.bind(f.db)
  let added = false
  vi.spyOn(f.db, "exec").mockImplementation((sql) => {
    if (sql.includes("WITH ranked AS")) {
      added = f.db
        .prepare("PRAGMA table_info(bot_members)")
        .all()
        .some((column) => column.name === "position")
      throw new Error("controlled order backfill failure")
    }
    return exec(sql)
  })
  expect(() => initializeBotDatabase(f.db, f.path)).toThrow("controlled order backfill failure")
  expect(added).toBe(true)
  expect(f.db.prepare("SELECT version FROM bot_schema").get()?.version).toBe(70)
  expect(
    f.db
      .prepare("PRAGMA table_info(bot_members)")
      .all()
      .map((column) => column.name)
  ).not.toContain("position")
  expect(f.db.prepare("SELECT * FROM bot_group_cycles ORDER BY id").all()).toEqual(f.cycles)
  expect(
    readdirSync(join(f.root, "backups")).filter((value) => value.startsWith("bots-v70-"))
  ).toHaveLength(1)
})
