import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost } from "./host"
import { BOT_ADMISSION, BOT_COMMUNICATION_TASK_SQL, botAdmissionLane } from "./admission"
import { BotMemoryService } from "./memory"
import { botDirectory } from "./paths"
import { buildBotMemoryPrompt } from "./prompt"
import type { BotTask } from "../../shared/bots/contracts"

const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
function fixture() {
  const native = new DatabaseSync(":memory:")
  const db = new NativeSqliteAdapter(native)
  cleanup.push(() => db.close())
  const store = new BotStore(db)
  const bot = store.create({ name: "Fixture", instructions: "", modelRef: null, color: "#123456" })
  return { native, db, store, bot }
}
const makeWork = (f: ReturnType<typeof fixture>, index = 0) => f.store.createWork({
  botId: f.bot.id, operationId: `create-${index}`, title: `Task ${index}`, goal: "Synthetic test"
})

it("invalidates only the owning work, coalesces updates and rolls back with failed writes", () => {
  const f = fixture(), work = makeWork(f)
  const take = () => f.store.workInvalidations.take()
  expect(take()).toEqual([{ botId: f.bot.id, audience: "desktop", workIds: [work.work.id], removedIds: [] }])
  const unrelated = f.store.enqueue({ botId: f.bot.id, requestId: "private", message: "Hi" })
  f.store.transition(unrelated.id, "running")
  f.store.settle(unrelated.id, "completed", null, "Hi")
  expect(take()).toEqual([])
  f.store.transition(work.task.id, "running")
  f.store.transition(work.task.id, "waiting_user")
  expect(take()[0].workIds).toEqual([work.work.id])
  f.db.run("BEGIN")
  f.db.run("UPDATE bot_work_items SET title='Rolled back' WHERE id=?", [work.work.id])
  f.db.run("ROLLBACK")
  expect(take()).toEqual([])
  // Existing activity upserts must not inherit a conflicting trigger policy.
  f.store.settle(work.task.id, "completed", null, "Done")
  expect(take()[0].workIds).toEqual([work.work.id])
  f.db.run("UPDATE bot_work_items SET detached=1 WHERE id=?", [work.work.id])
  expect(take()[0].removedIds).toEqual([work.work.id])
  f.db.run("DELETE FROM bot_work_items WHERE id=?", [work.work.id])
  expect(take()[0].removedIds).toEqual([work.work.id])
})

it("invalidates peer commands/workflows and bounds large transaction notifications", () => {
  const f = fixture(), work = makeWork(f)
  const peer = f.store.create({ name: "Peer", instructions: "", modelRef: null, color: "#123456" })
  f.store.transition(work.task.id, "running")
  const child = f.store.delegate(work.task.id, peer.id, "Check", "child")
  f.store.workInvalidations.take()
  f.store.transition(child.id, "running")
  f.store.acceptCommand(child.id, { id: "cmd", threadId: child.threadId, cwd: "/fixture", command: "fixture", startedAt: 1 })
  expect(f.store.workInvalidations.take()[0].workIds).toEqual([work.work.id])
  f.db.run("INSERT INTO bot_workflow_refs(thread_id,run_id,started_at,source_task_id,workspace_path) VALUES(?,?,?,?,?)", [child.threadId, "run", "now", child.id, "/fixture"])
  expect(f.store.workInvalidations.take()[0].workIds).toEqual([work.work.id])
  for (let i = 1; i <= 205; i++) makeWork(f, i)
  expect(f.store.workInvalidations.take()).toEqual([{ botId: f.bot.id, audience: "desktop", workIds: [], removedIds: [], reset: true }])
})

it("keeps SQL admission classification equivalent to runtime roles", () => {
  const { db } = fixture()
  const origins = [{ kind: "user" }, { kind: "mock" }, { kind: "introduction" },
    { kind: "work_result" }, { kind: "bot", expectsReply: true, rootWorkId: "w" },
    { kind: "schedule" }, { kind: "group" }, { kind: "discussion" },
    { kind: "notification", notificationKind: "workflow" }]
  for (const origin of origins) for (const workId of [undefined, "work"]) for (const transport of [undefined, "im", "mock"]) {
    const mockSource = transport ? { transport } : undefined
    const task = { origin, workId, mockSource } as BotTask
    const result = db.exec(`SELECT CASE WHEN ${BOT_COMMUNICATION_TASK_SQL} THEN 1 ELSE 0 END FROM
      (SELECT ? AS work_id,? AS origin_json,? AS mock_source_json) t`,
      [workId ?? null, JSON.stringify(origin), mockSource ? JSON.stringify(mockSource) : null])[0].values[0][0]
    expect(result, JSON.stringify(task)).toBe(botAdmissionLane(task) === "communication" ? 1 : 0)
  }
})

it("bounds production execution, admits main messages and refills released slots", async () => {
  const f = fixture()
  const errors = vi.fn(), finish = new Map<string, () => void>()
  const host = new LocalBotHost(f.store, {
    onAvailable: () => () => {},
    acquire: (_bot, task) => ({
      release() {},
      async execute(signal) {
        if (task.workId) await new Promise<void>(resolve => {
          finish.set(task.id, resolve)
          if (signal.aborted) resolve()
          else signal.addEventListener("abort", () => resolve(), { once: true })
        })
        return { state: "completed", result: "Done" }
      }
    })
  }, BOT_ADMISSION, errors)
  cleanup.push(() => host.stop())
  const works = Array.from({ length: 12 }, (_, i) => makeWork(f, i))
  host.resume()
  await vi.waitFor(() => expect(finish.size).toBe(4))
  expect(works.map(w => f.store.getTask(w.task.id).state).filter(state => state === "queued")).toHaveLength(8)
  const ping = host.send({ botId: f.bot.id, requestId: "ping", message: "hello" })
  await vi.waitFor(() => expect(f.store.getTask(ping.id).state).toBe("completed"))
  expect(finish.size).toBe(4)
  finish.values().next().value!()
  await vi.waitFor(() => expect(finish.size).toBe(5))
  expect(works.map(w => f.store.getTask(w.task.id).state).filter(state => state === "running")).toHaveLength(4)
  expect(errors).not.toHaveBeenCalled()
})

it("pages every Feature with scoped cursors, searches beyond page one and keeps old waiting work visible", async () => {
  const f = fixture()
  const scope = { botId: f.bot.id, audience: "desktop" }
  const ids: string[] = []
  for (let i = 0; i < 125; i++) ids.push(f.store.features.follow(scope, { projectId: "p", projectName: "Project", slug: `feature-${i}`, title: `Feature ${i}` }).id)
  f.db.run("INSERT INTO bot_feature_ops(id,follow_id,task_id,action,fingerprint,state,decision_id) VALUES('op',?,'task','manage','fp','active','decision')", [ids[0]])
  const host = new LocalBotHost(f.store, { onAvailable: () => () => {}, acquire: () => null })
  cleanup.push(() => host.stop())
  let cursor: string | undefined
  const seen: string[] = [], cursors = new Set<string>()
  do {
    const page = host.featureTaskPage(scope, { cursor })
    expect(page.items.length).toBeLessThanOrEqual(40)
    expect(page.priority.map(task => task.id)).toContain(ids[0])
    seen.push(...page.items.map(task => task.id))
    cursor = page.nextCursor ?? undefined
    if (cursor) { expect(cursors.has(cursor)).toBe(false); cursors.add(cursor) }
  } while (cursor)
  expect(seen).toEqual([...ids].reverse())
  expect(host.featureTaskPage(scope, { query: "Feature 124" }).items.map(task => task.id)).toEqual([ids[124]])
  expect(() => host.featureTaskPage({ ...scope, audience: "im:another" }, { cursor: [...cursors][0] })).toThrow("游标")
  expect(() => host.featureTaskPage(scope, { refreshIds: ids })).toThrow("查询")
  expect(host.featureTaskPage({ ...scope, audience: "im:another" }, { refreshIds: [ids[0]] }).refreshed).toEqual([])
  f.db.run("DELETE FROM bot_feature_follows WHERE id=?", [ids[1]])
  expect(host.featureTaskPage(scope, { refreshIds: [ids[1]] }).refreshed).toEqual([])
})

it("preserves Feature operation ordering while eliminating history sorts", () => {
  const f = fixture(), scope = { botId: f.bot.id, audience: "desktop" }
  const owner = f.store.features.follow(scope, { projectId: "p", projectName: "Project", slug: "f", title: "Feature" })
  let lastQuery = "", bindings: readonly unknown[] = []
  const prepare = f.db.prepare.bind(f.db)
  const capture = vi.spyOn(f.db, "prepare").mockImplementation((sql, args) => {
    if (sql.includes("AS ordinal,f.id")) { lastQuery = sql; bindings = args ?? [] }
    return prepare(sql, args)
  })
  const insert = (id: string, state: string, decision: string | null) => f.db.run("INSERT INTO bot_feature_ops(id,follow_id,task_id,action,fingerprint,state,decision_id) VALUES(?,?,?,'manage','fp',?,?)", [id, owner.id, id, state, decision])
  for (let i = 0; i < 5000; i++) insert(`old-${i}`, "finished", null)
  insert("active-decision", "active", "d")
  insert("finished-decision", "finished", "d2")
  insert("active", "active", null)
  insert("latest", "finished", null)
  expect(f.store.features.taskRows(scope)[0].phase).toBe("decision")
  const prior = lastQuery.replace(/o\.id=COALESCE\([\s\S]*?\)\n      WHERE f.bot_id/, `o.id=(SELECT id FROM bot_feature_ops WHERE follow_id=f.id AND action IN ('manage','session','continue') ORDER BY (decision_id IS NOT NULL) DESC,(state IN ('starting','active')) DESC,rowid DESC LIMIT 1)\n      WHERE f.bot_id`)
  expect(prior).not.toBe(lastQuery)
  expect(f.db.exec(lastQuery, bindings)).toEqual(f.db.exec(prior, bindings))
  const plans = f.db.exec(`EXPLAIN QUERY PLAN ${lastQuery}`, bindings)[0].values.map(row => String(row[3]))
  expect(plans.some(plan => plan.includes("TEMP B-TREE"))).toBe(false)
  expect(plans.some(plan => plan.includes("bot_feature_directory"))).toBe(true)
  capture.mockRestore()
})

it("reuses validated memory content while external edits, permissions and deletions stay fresh", async () => {
  const root = mkdtempSync(join(tmpdir(), "bot-perf-memory-"))
  const memory = new BotMemoryService(root)
  cleanup.push(async () => { await memory.close(); rmSync(root, { recursive: true, force: true }) })
  const written = memory.write("bot-a", { name: "Fact", content: "Version A", scope: { kind: "group", groupId: "a" } })
  const path = join(botDirectory(root, "memories", "bot-a"), `${written.id}.md`)
  const context = { groupId: "a" }
  const first = memory.forPrompt("bot-a", context)
  const parsed = vi.spyOn(memory as any, "scopeFromFile")
  expect(memory.forPrompt("bot-a", context)).toEqual(first)
  expect(parsed).not.toHaveBeenCalled()
  first[0].content = "Mutation"
  first[0].scope = { kind: "shared" }
  expect(memory.forPrompt("bot-a", {}).length).toBe(0)
  const before = statSync(path)
  writeFileSync(path, readFileSync(path, "utf8").replace("Version A", "Version B"))
  utimesSync(path, before.atime, before.mtime) // identical size + restored mtime still changes ctime
  expect(memory.forPrompt("bot-a", context)[0].content.trim()).toBe("Version B")
  expect(parsed).toHaveBeenCalledTimes(1)
  rmSync(path)
  expect(memory.forPrompt("bot-a", context)).toEqual([])
  const other = join(root, "outside.md")
  writeFileSync(other, "private")
  symlinkSync(other, path)
  expect(() => memory.forPrompt("bot-a", context)).toThrow("格式")
})

it("omits oversized facts without losing later small memories or changing escaping/budget", () => {
  const huge = { id: "large", name: "Large", content: "x".repeat(47000), version: "v" }
  const small = { id: "small", name: "Small", content: "Small useful fact", version: "v" }
  const prompt = buildBotMemoryPrompt([huge, small])
  expect(prompt).toContain("Small useful fact")
  expect(prompt).toContain("1 additional memories")
  expect(prompt).not.toContain(huge.content)
})
