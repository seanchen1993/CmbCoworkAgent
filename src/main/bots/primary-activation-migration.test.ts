import { expect, it } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { BOT_SCHEMA, BOT_SCHEMA_VERSION } from "./schema"
import { initializeBotDatabase } from "./migrations"

it("adds the nullable activation baseline to an older v64 table without changing its configuration or acknowledgement", () => {
  const db = new DatabaseSync(":memory:")
  try {
    // Explicitly synthetic schema contract, not an alleged historical product snapshot.
    db.exec(BOT_SCHEMA)
    db.exec(
      "ALTER TABLE bot_primary_checkin DROP COLUMN activation_fingerprint; UPDATE bot_schema SET version=64"
    )
    const configuration = JSON.stringify({
      botId: "a",
      enabled: true,
      prompt: "Existing goal",
      targetBotIds: ["b"],
      everyMs: 60000,
      timezone: "UTC"
    })
    db.prepare(
      "INSERT INTO bot_primary_checkin(id,revision,routine_id,configuration,fingerprint) VALUES(1,9,NULL,?,?)"
    ).run(configuration, "a".repeat(64))
    initializeBotDatabase(db, ":memory:")
    expect(db.prepare("SELECT version FROM bot_schema").get()?.version).toBe(BOT_SCHEMA_VERSION)
    expect(
      db
        .prepare(
          "SELECT revision,routine_id,configuration,fingerprint,activation_fingerprint FROM bot_primary_checkin WHERE id=1"
        )
        .get()
    ).toMatchObject({
      revision: 9,
      routine_id: null,
      configuration,
      fingerprint: "a".repeat(64),
      activation_fingerprint: null
    })
    initializeBotDatabase(db, ":memory:")
    expect(
      db
        .prepare("PRAGMA table_info(bot_primary_checkin)")
        .all()
        .filter((column) => column.name === "activation_fingerprint")
    ).toHaveLength(1)
  } finally {
    db.close()
  }
})
