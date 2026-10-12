import { expect, it } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { BOT_SCHEMA_VERSION } from "./schema"
it("upgrades schema 67 without inferring contracts from historical tasks and keeps the exact prior backup", () => {
  const directory = mkdtempSync(join(tmpdir(), "cmb-output-v67-")),
    path = join(directory, "bots.sqlite")
  let store = new BotStore(path)
  try {
    const { conversationId } = store.createBot({ nonce: "original", name: "Original" })
    const sent = store.send({
      nonce: "old-task",
      conversationId,
      text: "交付 result.csv（project_id、amount万元）"
    })
    const before = store.messages(conversationId)
    store.close()
    const previous = new DatabaseSync(path)
    previous.exec(
      "DROP TABLE bot_output_deliveries; DROP TABLE bot_output_attempts; DROP TABLE bot_output_contracts; DROP TABLE bot_output_messages; UPDATE bot_schema SET version=67"
    )
    previous.close()
    store = new BotStore(path)
    expect(store.messages(conversationId)).toEqual(before)
    expect(store.db.exec("SELECT version FROM bot_schema")[0].values[0][0]).toBe(BOT_SCHEMA_VERSION)
    expect(store.db.exec("SELECT count(*) FROM bot_output_messages")[0].values[0][0]).toBe(0)
    const claimed = store.claim("new-host", 300000)!
    expect(claimed.run.id).toBe(sent.runIds[0])
    expect(store.outputContracts.instructions(claimed.lease)).toBeUndefined()
    const backups = readdirSync(join(directory, "backups")).filter((name) =>
      name.startsWith("bots-v67-")
    )
    expect(backups).toHaveLength(1)
    const backup = new DatabaseSync(join(directory, "backups", backups[0]), { readOnly: true })
    try {
      expect(backup.prepare("SELECT version FROM bot_schema").get()?.version).toBe(67)
      expect(
        backup.prepare("SELECT name FROM sqlite_master WHERE name='bot_output_messages'").get()
      ).toBeUndefined()
      expect(
        backup.prepare("SELECT text FROM bot_messages WHERE id=?").get(sent.messageId)?.text
      ).toBe(before[0].text)
    } finally {
      backup.close()
    }
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
