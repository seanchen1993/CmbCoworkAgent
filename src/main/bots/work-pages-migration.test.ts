import { expect, it } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { BOT_SCHEMA_VERSION } from "./schema"

it("upgrades the prior v66 database by the one scope index and preserves the exact old backup", () => {
  const directory = mkdtempSync(join(tmpdir(), "cmb-work-pages-v66-")),
    path = join(directory, "bots.sqlite")
  let store = new BotStore(path)
  try {
    const created = store.createBot({ nonce: "owner", name: "Original" })
    store.send({
      nonce: "send",
      conversationId: created.conversationId,
      text: "Original retained message"
    })
    const before = store.snapshot(),
      messages = store.messages(created.conversationId)
    store.close()
    // Synthetic prior-schema fixture: B changes only this index and its version.
    const previous = new DatabaseSync(path)
    previous.exec("DROP INDEX bot_work_conversation_open; UPDATE bot_schema SET version=66")
    previous.close()
    store = new BotStore(path)
    expect(store.snapshot()).toEqual(before)
    expect(store.messages(created.conversationId)).toEqual(messages)
    expect(store.db.exec("SELECT version FROM bot_schema")[0].values[0][0]).toBe(BOT_SCHEMA_VERSION)
    expect(
      store.db.exec("SELECT name FROM sqlite_master WHERE name='bot_work_conversation_open'")[0]
        .values
    ).toHaveLength(1)
    const files = readdirSync(join(directory, "backups")).filter((name) =>
      name.startsWith("bots-v66-")
    )
    expect(files).toHaveLength(1)
    const backup = new DatabaseSync(join(directory, "backups", files[0]), { readOnly: true })
    try {
      expect(backup.prepare("SELECT version FROM bot_schema").get()?.version).toBe(66)
      expect(
        backup
          .prepare("SELECT name FROM sqlite_master WHERE name='bot_work_conversation_open'")
          .get()
      ).toBeUndefined()
      expect(
        backup
          .prepare("SELECT text FROM bot_messages WHERE conversation_id=?")
          .get(created.conversationId)?.text
      ).toBe("Original retained message")
    } finally {
      backup.close()
    }
    store.close()
    store = new BotStore(path)
    expect(store.snapshot()).toEqual(before)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
