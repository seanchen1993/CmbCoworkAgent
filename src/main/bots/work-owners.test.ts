import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import type { ThreadSummaryRow } from "../db"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { BotStore } from "./store"
import { LocalBotHost } from "./host"
import { botThreadOwners } from "./work-owners"

const native = vi.hoisted(() => ({ rows: new Map<string, ThreadSummaryRow>() }))
vi.mock("../db", () => ({ getThreadCore: (id: string) => native.rows.get(id) ?? null }))
const resources: Array<{ db: NativeSqliteAdapter; host: LocalBotHost }> = []
afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async ({ db, host }) => {
      await host.stop()
      db.close()
    })
  )
  native.rows.clear()
})
async function fixture() {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:")),
    store = new BotStore(db)
  const bot = store.create({
    name: "Assistant",
    instructions: "Private instructions must not be projected",
    color: "#123456",
    modelRef: null
  })
  const host = new LocalBotHost(store, { acquire: () => null, onAvailable: () => () => {} })
  resources.push({ db, host })
  const { work } = await host.createWork({
    botId: bot.id,
    operationId: "owner",
    title: "Work",
    goal: "Private task details"
  })
  const row: ThreadSummaryRow = {
    thread_id: work.threadId,
    title: "Work",
    status: "idle",
    created_at: 10,
    updated_at: 20,
    metadata: JSON.stringify({
      botHostId: "local",
      botId: bot.id,
      botWorkId: work.id,
      botAudienceKey: "desktop",
      workspacePath: "/original"
    })
  }
  native.rows.set(row.thread_id, row)
  return { db, store, host, bot, work, row }
}
describe("sidebar work owners", () => {
  it("reports exact live work activity for unopened rows and stops while waiting or settled", async () => {
    const { store, host, work, bot } = await fixture()
    const { work: other } = await host.createWork({
      botId: bot.id, operationId: "other", title: "Other", goal: "Independent work"
    })
    const [task] = store.pendingTasksForThread(work.threadId)
    const [otherTask] = store.pendingTasksForThread(other.threadId)
    store.transition(otherTask.id, "running")
    const working = () => {
      const revision = store.revision()
      const value = botThreadOwners(host, [work.threadId])[0]?.working === true
      expect(store.revision()).toBe(revision)
      return value
    }
    expect(working()).toBe(false)
    store.transition(task.id, "running")
    expect(working()).toBe(true)
    store.transition(task.id, "waiting_user")
    expect(working()).toBe(false)
    store.transition(task.id, "running")
    expect(working()).toBe(true)
    store.transition(task.id, "completed")
    expect(working()).toBe(false)
    expect(store.getTask(otherTask.id).state).toBe("running")
  })
  it("projects a native unopened work without binding, transcript reads or task changes", async () => {
    const f = await fixture(),
      before = f.store.recentTasks(),
      revision = f.store.revision()
    const result = botThreadOwners(f.host, [f.work.threadId, "ordinary-unrelated"])
    expect(result).toEqual([
      {
        threadId: f.work.threadId,
        threadCreatedAt: 10,
        workId: f.work.id,
        bot: {
          id: f.bot.id,
          name: f.bot.name,
          color: f.bot.color,
          shape: f.bot.shape,
          archived: false
        }
      }
    ])
    expect(JSON.stringify(result)).not.toContain("Private")
    expect(f.store.getWork(f.bot.id, f.work.id).conversation).toBeUndefined()
    expect(f.store.recentTasks()).toEqual(before)
    expect(f.store.revision()).toBe(revision)
    expect(() =>
      botThreadOwners(
        f.host,
        Array.from({ length: 65 }, (_, i) => `thread-${i}`)
      )
    ).toThrow("批次")
  })
  it("reports user control only after the original execution has settled", async () => {
    const { host, store, work, bot } = await fixture()
    const [task] = store.pendingTasksForThread(work.threadId)
    store.transition(task.id, "running")
    const control = host.changeWorkControl({
      botId: bot.id, workId: work.id, expectedVersion: work.version, operationId: "take", action: "take"
    })
    expect(control.userControl?.settling).toBe(true)
    expect(botThreadOwners(host, [work.threadId])[0]).not.toHaveProperty("userControlled")

    store.transition(task.id, "completed")
    expect(store.finishWorkControlHandoffs(new Set())).toBe(true)
    expect(botThreadOwners(host, [work.threadId])[0].userControlled).toBe(true)
    host.changeWorkControl({
      botId: bot.id, workId: work.id, expectedVersion: store.getWork(bot.id, work.id).version,
      operationId: "return", action: "return"
    })
    expect(botThreadOwners(host, [work.threadId])[0]).not.toHaveProperty("userControlled")
  })
  it("omits preparing/detached work and verifies the bound thread incarnation", async () => {
    const f = await fixture(),
      ref = {
        kind: "local_thread" as const,
        threadId: f.row.thread_id,
        incarnation: captureThreadIncarnation(f.row)
      }
    f.host.conversationLinks.prepareCreated(f.bot.id, f.work.id, ref)
    expect(botThreadOwners(f.host, [f.row.thread_id])).toEqual([])
    f.host.conversationLinks.bound(f.bot.id, f.work.id, ref)
    f.row.metadata = JSON.stringify({
      ...JSON.parse(f.row.metadata!),
      botLocalConversation: true,
      botWorkOrigin: "created"
    })
    expect(botThreadOwners(f.host, [f.row.thread_id])).toHaveLength(1)
    f.row.created_at = 11
    expect(botThreadOwners(f.host, [f.row.thread_id])).toEqual([])
    f.row.created_at = 10
    await f.host.stopConversation(f.bot.id, undefined, f.work.id)
    f.host.conversationLinks.beginDetach(
      f.bot.id,
      f.work.id,
      f.store.getWork(f.bot.id, f.work.id).version
    )
    expect(botThreadOwners(f.host, [f.row.thread_id])).toEqual([])
    f.host.conversationLinks.detached(f.bot.id, f.work.id)
    expect(botThreadOwners(f.host, [f.row.thread_id])).toEqual([])
  })
  it("never labels a missing, foreign or channel conversation as the desktop work", async () => {
    const f = await fixture(),
      metadata = JSON.parse(f.row.metadata!)
    for (const patch of [
      { botId: "another-bot" },
      { botWorkId: "another-work" },
      { botGroupId: "group" },
      { botMockBindingId: "channel" }
    ]) {
      f.row.metadata = JSON.stringify({ ...metadata, ...patch })
      expect(botThreadOwners(f.host, [f.row.thread_id])).toEqual([])
    }
    native.rows.delete(f.row.thread_id)
    expect(botThreadOwners(f.host, [f.row.thread_id])).toEqual([])
  })
})
