import { DatabaseSync } from "node:sqlite"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { upgradeWorkConversationSchema } from "./conversation-link-schema"
import type { LinkBotWorkConversationInput } from "../../shared/bots/conversation"

function upgrade(db: NativeSqliteAdapter) {
  db.run("SAVEPOINT upgrade")
  try {
    upgradeWorkConversationSchema(db)
    db.run("RELEASE upgrade")
  } catch (error) {
    db.run("ROLLBACK TO upgrade; RELEASE upgrade")
    throw error
  }
}
const oldSchema = `CREATE TABLE bot_work_items (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,
  thread_id TEXT UNIQUE NOT NULL,source_json TEXT,extra_value TEXT NOT NULL DEFAULT 'kept');
  CREATE INDEX old_extra_index ON bot_work_items(extra_value);
  CREATE TABLE audit (id TEXT);
  CREATE TRIGGER old_work_audit AFTER INSERT ON bot_work_items BEGIN INSERT INTO audit VALUES(new.id); END;`

describe("local conversation ownership journal", () => {
  it("preserves deleted ordinal high-water, all columns, indexes and triggers across real reopen and repeat upgrades", () => {
    const directory = mkdtempSync(join(tmpdir(), "bot-link-upgrade-")),
      path = join(directory, "control.sqlite")
    let db = new NativeSqliteAdapter(new DatabaseSync(path))
    try {
      db.run(oldSchema)
      db.run(
        "INSERT INTO bot_work_items(id,thread_id,source_json,extra_value) VALUES('original','thread','{\"kind\":\"mock\"}','original-extra')"
      )
      db.run(
        "INSERT INTO bot_work_items(ordinal,id,thread_id) VALUES(900,'removed','removed'); DELETE FROM bot_work_items WHERE id='removed'"
      )
      upgrade(db)
      expect(
        db.exec("SELECT ordinal,source_json,extra_value FROM bot_work_items")[0].values
      ).toEqual([[1, '{"kind":"mock"}', "original-extra"]])
      expect(
        db.exec("SELECT name FROM sqlite_master WHERE type='index' AND name='old_extra_index'")[0]
          .values
      ).toHaveLength(1)
      db.run("UPDATE bot_work_items SET detached=1 WHERE id='original'")
      db.run("INSERT INTO bot_work_items(id,thread_id) VALUES('new','thread')")
      expect(db.exec("SELECT ordinal FROM bot_work_items WHERE id='new'")[0].values[0][0]).toBe(901)
      expect(db.exec("SELECT id FROM audit WHERE id='new'")[0].values).toEqual([["new"]])
      expect(() =>
        db.run("INSERT INTO bot_work_items(id,thread_id) VALUES('conflict','thread')")
      ).toThrow()
      db.close()
      db = new NativeSqliteAdapter(new DatabaseSync(path))
      upgrade(db)
      db.run("INSERT INTO bot_work_items(id,thread_id) VALUES('after-reopen','other')")
      expect(
        db.exec("SELECT ordinal FROM bot_work_items WHERE id='after-reopen'")[0].values
      ).toEqual([[902]])
    } finally {
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it("refuses unknown foreign constraints atomically, preserving the old schema and data", () => {
    const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
    try {
      db.run(oldSchema)
      db.run(
        "INSERT INTO bot_work_items(id,thread_id) VALUES('old','thread'); CREATE TABLE extension(work_id TEXT REFERENCES bot_work_items(id))"
      )
      expect(() => upgrade(db)).toThrow("外键")
      expect(
        db.exec("PRAGMA table_info(bot_work_items)")[0].values.some((v) => v[1] === "detached")
      ).toBe(false)
      expect(db.exec("SELECT id FROM bot_work_items")[0].values).toEqual([["old"]])
      db.run("DROP TABLE extension")
      upgrade(db)
      expect(db.exec("SELECT id FROM bot_work_items")[0].values).toEqual([["old"]])
    } finally {
      db.close()
    }
  })
  it("journals admission without execution, recovers original IDs, and fences detached commands and old receipts", () => {
    const directory = mkdtempSync(join(tmpdir(), "bot-link-journal-")),
      path = join(directory, "control.sqlite")
    let db = new NativeSqliteAdapter(new DatabaseSync(path))
    try {
      let store = new BotStore(db)
      const bot = store.create({
        name: "Owner",
        instructions: "Keep role",
        color: "#ea2845",
        modelRef: null
      })
      const input: LinkBotWorkConversationInput = {
        botId: bot.id,
        operationId: "link-one",
        title: "Existing discussion",
        goal: "Continue this discussion",
        conversation: {
          kind: "local_thread",
          threadId: "original-thread",
          incarnation: { token: "original-token", legacyCreatedAt: 123 }
        }
      }
      const work = store.conversations.prepare(input)
      expect(work.conversation?.state).toBe("preparing")
      expect(store.recentTasks()).toHaveLength(0)
      expect(() =>
        store.enqueue({
          botId: bot.id,
          workId: work.id,
          requestId: "too-early",
          message: "Do not run"
        })
      ).toThrow("关联")
      db.close()
      db = new NativeSqliteAdapter(new DatabaseSync(path))
      store = new BotStore(db)
      expect(store.conversations.prepare(input).id).toBe(work.id)
      expect(() => store.conversations.prepare({ ...input, title: "Different" })).toThrow(
        "其他内容"
      )
      store.conversations.bound(bot.id, work.id, input.conversation)
      const task = store.enqueue({
        botId: bot.id,
        workId: work.id,
        requestId: "original-request",
        message: "Continue"
      })
      expect(() =>
        store.conversations.beginDetach(bot.id, work.id, store.getWork(bot.id, work.id).version)
      ).toThrow("待办")
      store.transition(task.id, "running")
      store.settle(task.id, "completed", null, "Done")
      store.conversations.beginDetach(bot.id, work.id, store.getWork(bot.id, work.id).version)
      store.conversations.detached(bot.id, work.id)
      expect(store.listWorks(bot.id).items).toHaveLength(0)
      expect(() => store.conversations.prepare(input)).toThrow("旧操作")
      expect(() => store.conversations.bound(bot.id, work.id, input.conversation)).toThrow()
      const another = store.conversations.prepare({ ...input, operationId: "link-two" })
      store.conversations.bound(bot.id, another.id, input.conversation)
      const check = [
        {
          requestId: task.requestId,
          messageHash: createHash("sha256").update(task.message).digest("hex")
        }
      ]
      expect(store.requestReceipts(bot.id, check, work.id)[0].state).toBe("accepted")
      expect(store.requestReceipts(bot.id, check, another.id)[0].state).toBe("conflict")
      expect(store.recentTasks()).toHaveLength(1)
      expect(() =>
        store.conversations.prepare({
          ...input,
          operationId: "cloud",
          conversation: { kind: "cloud_session", serviceId: "service", conversationId: "chat" }
        })
      ).toThrow("尚未开放")
      db.run("PRAGMA query_only=ON")
      expect(() =>
        store.conversations.beginDetach(
          bot.id,
          another.id,
          store.getWork(bot.id, another.id).version
        )
      ).toThrow()
      db.run("PRAGMA query_only=OFF")
      expect(store.getWork(bot.id, another.id).conversation?.state).toBe("bound")
    } finally {
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
