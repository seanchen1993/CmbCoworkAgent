import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost } from "./host"
import type { BotReactionTarget } from "../../shared/bots/message-reactions"
import nativeEmoji from "../../shared/bots/reaction-emoji-native.json"
import { parseBotReactionEmoji } from "../../shared/bots/message-reactions"

type Identity = { id: string; role: "user" | "assistant"; ordinal: number }
const databases: NativeSqliteAdapter[] = [],
  hosts: LocalBotHost[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()))
  databases.splice(0).forEach((db) => db.close())
})
function fixture(path = ":memory:") {
  const db = new NativeSqliteAdapter(new DatabaseSync(path))
  databases.push(db)
  const messages = new Map<string, Identity[]>()
  const read = vi.fn((_botId: string, threadId: string, ids: string[]) =>
    (messages.get(threadId) ?? []).filter((message) => ids.includes(message.id))
  )
  const store = new BotStore(db, () => 1000, undefined, undefined, undefined, undefined, read)
  const bot = store.create({ name: "A", instructions: "", color: "#123456", modelRef: null })
  const target: BotReactionTarget = { kind: "bot", botId: bot.id }
  messages.set(bot.threadId, [{ id: "native:message.1", role: "assistant", ordinal: 0 }])
  return { db, store, bot, target, messages, read }
}

describe("persisted local user message reactions", () => {
  it("keeps different emoji, cancels one, canonicalizes heart aliases and advances revision only for changes", () => {
    const f = fixture(),
      id = "native:message.1",
      revision = f.store.revision()
    expect(f.store.setMessageReaction(f.target, id, "👍", true).revision).toBe(revision + 1)
    expect(f.store.setMessageReaction(f.target, id, "👍", true).revision).toBe(revision + 1)
    f.store.setMessageReaction(f.target, id, "❤", true)
    f.store.setMessageReaction(f.target, id, "❤️", true)
    const state = f.store.messageReactions(f.target, [id]).items[0]
    expect(state).toEqual({
      messageId: id,
      canReact: true,
      reactions: [
        { emoji: "❤️", count: 1, mine: true },
        { emoji: "👍", count: 1, mine: true }
      ]
    })
    const changed = f.store.setMessageReaction(f.target, id, "👍", false)
    expect(changed.item.reactions).toEqual([{ emoji: "❤️", count: 1, mine: true }])
    expect(f.store.setMessageReaction(f.target, id, "👍", false).revision).toBe(changed.revision)
    expect(
      f.db.exec("PRAGMA table_info(bot_message_reactions)")[0].values.map((row) => row[1])
    ).toEqual(["scope_kind", "scope_id", "message_id", "emoji", "added_at", "actor"])
  })
  it("binds identical native IDs separately in private/work/other Bot/public group scopes", () => {
    const f = fixture(),
      id = "native:message.1"
    const peer = f.store.create({ name: "B", instructions: "", color: "#123456", modelRef: null })
    const work = f.store.createWork({
      botId: f.bot.id,
      operationId: "work",
      title: "Work",
      goal: "Draft"
    }).work
    f.messages.set(work.threadId, [{ id, role: "user", ordinal: 0 }])
    f.messages.set(peer.threadId, [{ id, role: "assistant", ordinal: 0 }])
    const workTarget: BotReactionTarget = {
      ...(f.target as { kind: "bot"; botId: string }),
      workId: work.id
    }
    f.store.setMessageReaction(f.target, id, "👍", true)
    f.store.setMessageReaction(workTarget, id, "🎉", true)
    expect(
      f.store.messageReactions({ kind: "bot", botId: peer.id }, [id]).items[0].reactions
    ).toEqual([])
    expect(() =>
      f.store.messageReactions({ kind: "bot", botId: peer.id, workId: work.id }, [id])
    ).toThrow("不属于")
    const group = f.store.saveGroup({ name: "Group", memberIds: [f.bot.id, peer.id] })
    f.db.run(
      "INSERT INTO bot_group_messages(id,group_id,author_bot_id,text,targets_json,created_at) VALUES(?,?,NULL,'','[]',1)",
      [id, group.id]
    )
    const groupTarget: BotReactionTarget = { kind: "group", groupId: group.id }
    f.store.setMessageReaction(groupTarget, id, "😂", true)
    expect(
      f.store.messageReactions(groupTarget, [id]).items[0].reactions.map((r) => r.emoji)
    ).toEqual(["😂"])
    expect(
      f.store.messageReactions(workTarget, [id]).items[0].reactions.map((r) => r.emoji)
    ).toEqual(["🎉"])
    expect(f.store.messageReactions(f.target, [id]).items[0].reactions.map((r) => r.emoji)).toEqual(
      ["👍"]
    )
    const other = f.store.saveGroup({ name: "Other", memberIds: [f.bot.id] })
    expect(() =>
      f.store.setMessageReaction({ kind: "group", groupId: other.id }, id, "👍", true)
    ).toThrow("不可用")
  })
  it("accepts file-only identities, refuses absent/tool/temporary IDs and never queries other transcript scopes", () => {
    const f = fixture()
    f.messages.set(f.bot.threadId, [
      { id: "file-only", role: "user", ordinal: 1 },
      { id: "tool", role: "tool", ordinal: 2 } as unknown as Identity,
      { id: "temporary", role: "assistant" } as Identity
    ])
    expect(f.store.setMessageReaction(f.target, "file-only", "👍🏽", true).item.canReact).toBe(true)
    const revision = f.store.revision()
    for (const id of ["tool", "temporary", "missing"])
      expect(() => f.store.setMessageReaction(f.target, id, "👍", true)).toThrow("不可用")
    expect(f.store.revision()).toBe(revision)
    expect(f.store.messageReactions(f.target, ["missing"]).items).toEqual([
      { messageId: "missing", canReact: false, reactions: [] }
    ])
    expect(
      f.read.mock.calls.every((call) => call[0] === f.bot.id && call[1] === f.bot.threadId)
    ).toBe(true)
    f.messages.delete(f.bot.threadId)
    expect(f.store.messageReactions(f.target, ["file-only"]).items[0].reactions).toEqual([])
  })
  it("restores reactions and revision after control database close/reopen without copying the transcript", () => {
    const directory = mkdtempSync(join(tmpdir(), "bot-reaction-reopen-")),
      path = join(directory, "control.sqlite")
    try {
      const f = fixture(path)
      f.store.setMessageReaction(f.target, "native:message.1", "🎉", true)
      const expected = f.store.messageReactions(f.target, ["native:message.1"])
      databases.splice(databases.indexOf(f.db), 1)
      f.db.close()
      const db = new NativeSqliteAdapter(new DatabaseSync(path))
      databases.push(db)
      const reopened = new BotStore(
        db,
        () => 2000,
        undefined,
        undefined,
        undefined,
        undefined,
        f.read
      )
      const restored = reopened.messageReactions(f.target, ["native:message.1"])
      expect(restored.items).toEqual(expected.items)
      // Existing Host startup can advance the shared revision for channel recovery.
      expect(restored.revision).toBeGreaterThanOrEqual(expected.revision)
      databases.splice(databases.indexOf(db), 1)
      db.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it("cleans actual deleted scopes while preserving admitted/detached conversations and surviving group messages", () => {
    const f = fixture(),
      id = "native:message.1"
    const admitted = f.store.createWork({
      botId: f.bot.id,
      operationId: "admitted",
      title: "Existing",
      goal: "Existing"
    }).work
    const disposable = f.store.createWork({
      botId: f.bot.id,
      operationId: "disposable",
      title: "Disposable",
      goal: "Disposable"
    }).work
    f.messages.set(admitted.threadId, [{ id, role: "user", ordinal: 0 }])
    f.messages.set(disposable.threadId, [{ id, role: "user", ordinal: 0 }])
    f.store.setMessageReaction(
      { kind: "bot", botId: f.bot.id, workId: admitted.id },
      id,
      "❤️",
      true
    )
    f.store.setMessageReaction(
      { kind: "bot", botId: f.bot.id, workId: disposable.id },
      id,
      "👍",
      true
    )
    f.store.setMessageReaction(f.target, id, "👍", true)
    f.db.run("UPDATE bot_work_items SET detached=1 WHERE id=?", [admitted.id])
    const group = f.store.saveGroup({ name: "Retained group", memberIds: [f.bot.id] })
    f.db.run(
      "INSERT INTO bot_group_messages(id,group_id,author_bot_id,text,targets_json,created_at) VALUES(?,?,?,'history','[]',1)",
      [id, group.id, f.bot.id]
    )
    f.store.setMessageReaction({ kind: "group", groupId: group.id }, id, "🎉", true)
    const deleted = f.store.beginDeletion(f.bot.id, f.bot.version)
    expect(deleted).not.toContain(admitted.threadId)
    expect(f.db.exec("SELECT COUNT(*) FROM bot_message_reactions")[0].values).toEqual([[4]])
    f.store.finishDeletion(f.bot.id, deleted)
    expect(
      f.db.exec("SELECT scope_kind,scope_id FROM bot_message_reactions ORDER BY scope_kind")[0]
        .values
    ).toEqual([
      ["group", group.id],
      ["thread", admitted.threadId]
    ])
    f.store.beginGroupDeletion(group.id, f.store.getGroup(group.id).version)
    f.store.finishGroupDeletion(group.id)
    expect(f.db.exec("SELECT scope_id FROM bot_message_reactions")[0].values).toEqual([
      [admitted.threadId]
    ])
    f.store.removeMessageReactionsForThreads([admitted.threadId])
    expect(f.db.exec("SELECT COUNT(*) FROM bot_message_reactions")[0].values).toEqual([[0]])
  })
  it("publishes only changed revisions and creates no task or model wake for reactions", async () => {
    const f = fixture(),
      acquire = vi.fn(() => null)
    const host = new LocalBotHost(f.store, { acquire, onAvailable: () => () => {} })
    hosts.push(host)
    await new Promise<void>((resolve) => setImmediate(resolve))
    const listener = vi.fn()
    host.subscribe(listener)
    acquire.mockClear()
    const before = f.store.recentTasks()
    host.setMessageReaction(f.target, "native:message.1", "👍", true)
    host.setMessageReaction(f.target, "native:message.1", "👍", true)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0]).toEqual({
      hostId: "local",
      revision: f.store.revision(),
      reactionTarget: f.target
    })
    expect(f.store.recentTasks()).toEqual(before)
    expect(acquire).not.toHaveBeenCalled()
  })
})

describe("model reactions to the current private user message", () => {
  function userRun() {
    const f = fixture()
    const task = f.store.enqueue({
      botId: f.bot.id,
      requestId: "current-user",
      message: "React here"
    })
    f.store.transition(task.id, "running")
    f.messages.set(f.bot.threadId, [{ id: task.requestId, role: "user", ordinal: 1 }])
    return { ...f, task }
  }

  it("requires the actual live Host run and rejects further reactions after Stop", async () => {
    const f = fixture()
    const task = f.store.enqueue({
      botId: f.bot.id,
      requestId: "host-current",
      message: "React here"
    })
    f.messages.set(f.bot.threadId, [{ id: task.requestId, role: "user", ordinal: 1 }])
    let started!: () => void
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    const host = new LocalBotHost(f.store, {
      acquire: () => ({
        release() {},
        execute: async (signal) => {
          started()
          return new Promise<{ state: "failed"; error: string }>((resolve) => {
            signal.addEventListener("abort", () => resolve({ state: "failed", error: "Stopped" }), {
              once: true
            })
          })
        }
      }),
      onAvailable: () => () => {}
    })
    hosts.push(host)
    await running
    host.setBotMessageReaction(task.id, "👍", true)
    await host.stop()
    const before = f.store.messageReactions(f.target, [task.requestId])
    expect(() => host.setBotMessageReaction(task.id, "👍", false)).toThrow()
    expect(f.store.messageReactions(f.target, [task.requestId])).toEqual(before)
  })

  it("keeps Bot and user presence independent, idempotent and accurately attributed", () => {
    const f = userRun(),
      id = f.task.requestId
    expect(f.store.reactionUserMessage(f.task.id)).toBe(id)
    f.store.setMessageReaction(f.target, id, "👍", true)
    const botAdded = f.store.setBotMessageReaction(f.task.id, "👍", true)
    expect(botAdded.item.reactions).toEqual([
      { emoji: "👍", count: 2, mine: true, actors: [{ botId: f.bot.id, name: "A" }] }
    ])
    expect(f.store.setBotMessageReaction(f.task.id, "👍", true)).toEqual(botAdded)
    const userRemoved = f.store.setMessageReaction(f.target, id, "👍", false)
    expect(userRemoved.item.reactions).toEqual([
      { emoji: "👍", count: 1, mine: false, actors: [{ botId: f.bot.id, name: "A" }] }
    ])
    expect(f.store.setMessageReaction(f.target, id, "👍", false)).toEqual(userRemoved)
    const removed = f.store.setBotMessageReaction(f.task.id, "👍", false)
    expect(removed.item.reactions).toEqual([])
    expect(f.store.setBotMessageReaction(f.task.id, "👍", false)).toEqual(removed)
    expect(f.store.recentTasks()).toHaveLength(1)
  })

  it("migrates legacy user rows and timestamps without changing their projection or losing another actor", () => {
    const f = userRun(),
      id = f.task.requestId
    f.db.run(`DROP TABLE bot_message_reactions;
      CREATE TABLE bot_message_reactions (
        scope_kind TEXT NOT NULL CHECK(scope_kind IN ('thread','group')),
        scope_id TEXT NOT NULL,message_id TEXT NOT NULL,emoji TEXT NOT NULL,added_at INTEGER NOT NULL,
        PRIMARY KEY(scope_kind,scope_id,message_id,emoji));`)
    f.db.run("INSERT INTO bot_message_reactions VALUES('thread',?,?,?,123)", [
      f.bot.threadId,
      id,
      "👍"
    ])
    const reopened = new BotStore(
      f.db,
      () => 2000,
      undefined,
      undefined,
      undefined,
      undefined,
      f.read
    )
    expect(reopened.messageReactions(f.target, [id]).items[0].reactions).toEqual([
      { emoji: "👍", count: 1, mine: true }
    ])
    expect(
      f.db.exec(
        "SELECT scope_kind,scope_id,message_id,emoji,added_at,actor FROM bot_message_reactions"
      )[0].values
    ).toEqual([["thread", f.bot.threadId, id, "👍", 123, "user"]])
    const pk = f.db
      .exec("PRAGMA table_info(bot_message_reactions)")[0]
      .values.filter((row) => Number(row[5]) > 0)
      .sort((a, b) => Number(a[5]) - Number(b[5]))
      .map((row) => row[1])
    expect(pk).toEqual(["scope_kind", "scope_id", "message_id", "emoji", "actor"])
    reopened.setBotMessageReaction(f.task.id, "👍", true)
    const expected = reopened.messageReactions(f.target, [id]).items
    const again = new BotStore(f.db, () => 3000, undefined, undefined, undefined, undefined, f.read)
    expect(again.messageReactions(f.target, [id]).items).toEqual(expected)
    again.removeMessageReactionsForThreads([f.bot.threadId])
    expect(f.db.exec("SELECT COUNT(*) FROM bot_message_reactions")[0].values).toEqual([[0]])
  })

  it("uses the latest consumed real user source, never an introduction, assistant, stale or external-looking user row", () => {
    const f = fixture(),
      intro = f.store.introduce(f.bot.id)!
    f.store.transition(intro.id, "running")
    expect(() => f.store.reactionUserMessage(intro.id)).toThrow()
    const first = f.store.enqueue({ botId: f.bot.id, requestId: "first", message: "First" })
    const latest = f.store.enqueue({ botId: f.bot.id, requestId: "latest", message: "Latest" })
    f.store.injectIntoRun(first.id, intro.id)
    f.store.injectIntoRun(latest.id, intro.id)
    f.messages.set(f.bot.threadId, [
      { id: first.requestId, role: "user", ordinal: 1 },
      { id: latest.requestId, role: "user", ordinal: 2 }
    ])
    expect(f.store.reactionUserMessage(intro.id)).toBe(latest.requestId)
    f.messages.set(f.bot.threadId, [{ id: latest.requestId, role: "assistant", ordinal: 2 }])
    expect(() => f.store.setBotMessageReaction(intro.id, "👍", true)).toThrow()
    f.messages.set(f.bot.threadId, [{ id: latest.requestId, role: "user", ordinal: 2 }])
    f.db.run("UPDATE bot_tasks SET mock_source_json='{}' WHERE id=?", [latest.id])
    expect(() => f.store.setBotMessageReaction(intro.id, "👍", true)).toThrow()
    f.db.run("UPDATE bot_tasks SET mock_source_json=NULL WHERE id=?", [latest.id])
    f.store.settleRun(intro.id, [first.id, latest.id], "completed", null, "Done")
    expect(() => f.store.setBotMessageReaction(intro.id, "👍", true)).toThrow()
    expect(f.db.exec("SELECT COUNT(*) FROM bot_message_reactions")[0].values).toEqual([[0]])
  })

  it("counts the 64-emoji limit distinctly while refusing non-private task provenance", () => {
    const f = userRun(),
      id = f.task.requestId
    const emoji = [...new Set(nativeEmoji.map(parseBotReactionEmoji))].slice(0, 65)
    for (const value of emoji.slice(0, 64)) f.store.setMessageReaction(f.target, id, value, true)
    expect(f.store.setBotMessageReaction(f.task.id, emoji[0], true).item.reactions).toHaveLength(64)
    expect(() => f.store.setBotMessageReaction(f.task.id, emoji[64], true)).toThrow("上限")
    for (const origin of [
      { kind: "notification", notificationKind: "command", key: "cmd" },
      { kind: "group", groupId: "other", messageId: id }
    ]) {
      f.db.run("UPDATE bot_tasks SET origin_json=? WHERE id=?", [JSON.stringify(origin), f.task.id])
      expect(() => f.store.setBotMessageReaction(f.task.id, "👍", true)).toThrow()
    }
    f.db.run("UPDATE bot_tasks SET origin_json=?,work_id=? WHERE id=?", [
      JSON.stringify({ kind: "user" }),
      "foreign-work",
      f.task.id
    ])
    expect(() => f.store.setBotMessageReaction(f.task.id, "👍", true)).toThrow()
  })
})
