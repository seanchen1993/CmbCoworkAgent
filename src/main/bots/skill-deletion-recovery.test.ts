import { afterEach, expect, it } from "vitest"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"
import { randomUUID } from "node:crypto"
import { BotStore } from "./store"
import { BOT_DELETION_OUTBOX_SCHEMA } from "./deletion-ledger"
import { BOT_SCHEMA_VERSION } from "./schema"
import { executeBotBackup } from "./backups"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bot-private-skill-delete-"))
  roots.push(root)
  const path = join(root, "bots.sqlite")
  const store = new BotStore(path)
  const { bot, conversationId } = store.createBot({ nonce: "owner", name: "Owner" })
  const skill = store.saveSkill({
    botId: bot.id,
    name: "Private workflow",
    instructions: "PRIVATE_SKILL_DELETE_BODY",
    enabled: true
  })
  return {
    root,
    path,
    store,
    bot,
    skill,
    conversationId,
    input: { nonce: "remove", botId: bot.id, skillId: skill.id, version: 1 }
  }
}
function ledgerRows(path: string) {
  const db = new DatabaseSync(`${path}.deletions`, { readOnly: true })
  try {
    return db.prepare("SELECT kind,key,owner FROM deletions").all()
  } finally {
    db.close()
  }
}
it("exports no rolled-back private deletion and writes identity-only monotonic metadata", () => {
  const f = fixture()
  try {
    expect(() =>
      f.store.transaction(() => {
        f.store.db.run("INSERT INTO bot_skill_tombstones VALUES(?,?,1,1)", [f.skill.id, f.bot.id])
        throw new Error("rollback")
      })
    ).toThrow("rollback")
    expect(f.store.skills(f.bot.id)).toHaveLength(1)
    expect(ledgerRows(f.path)).toEqual([])
    f.store.deleteSkill(f.input)
    expect(ledgerRows(f.path)).toEqual([
      { kind: "private-skill", key: f.skill.id, owner: f.bot.id }
    ])
    expect(readFileSync(`${f.path}.deletions`).includes(Buffer.from(f.skill.instructions))).toBe(
      false
    )
  } finally {
    f.store.close()
  }
})

it.each(["export", "acknowledge"])(
  "recovers private deletion %s failure with the exact durable receipt",
  (phase) => {
    const f = fixture()
    const ledger = new DatabaseSync(`${f.path}.deletions`)
    try {
      if (phase === "export")
        ledger.exec(
          "CREATE TRIGGER fail_export BEFORE INSERT ON deletions BEGIN SELECT RAISE(ABORT,'private export failure'); END"
        )
      else
        f.store.db.run(
          "CREATE TEMP TRIGGER fail_ack BEFORE DELETE ON bot_deletion_outbox BEGIN SELECT RAISE(ABORT,'private acknowledge failure'); END"
        )
      expect(() => f.store.deleteSkill(f.input)).toThrow("failure")
      expect(f.store.skills(f.bot.id)).toEqual([])
      expect(f.store.db.exec("SELECT COUNT(*) FROM bot_deletion_outbox")[0].values[0][0]).toBe(1)
      if (phase === "export") ledger.exec("DROP TRIGGER fail_export")
    } finally {
      ledger.close()
      f.store.close()
    }
    const reopened = new BotStore(f.path)
    try {
      expect(reopened.db.exec("SELECT COUNT(*) FROM bot_deletion_outbox")[0].values[0][0]).toBe(0)
      const receipt = reopened.deleteSkill(f.input)
      expect(reopened.deleteSkill(f.input)).toEqual(receipt)
      expect(ledgerRows(f.path)).toEqual([
        { kind: "private-skill", key: f.skill.id, owner: f.bot.id }
      ])
      expect(
        reopened.db.exec("SELECT COUNT(*) FROM bot_events WHERE kind='skill.deleted'")[0]
          .values[0][0]
      ).toBe(1)
    } finally {
      reopened.close()
    }
  }
)

it("upgrades native v48 outbox and v1 independent ledger while retaining every old identity and sealed backup", () => {
  const f = fixture()
  f.store.close()
  const old = new DatabaseSync(f.path)
  const previousOutbox = BOT_DELETION_OUTBOX_SCHEMA.replace(",'private-skill'", "")
  try {
    old.exec(`DROP TABLE bot_skill_tombstones; DROP TABLE bot_deletion_outbox;
      ${previousOutbox} UPDATE bot_schema SET version=48;`)
    old.prepare("INSERT INTO bot_deletion_outbox VALUES('routine','old-outbox','')").run()
  } finally {
    old.close()
  }
  const ledger = new DatabaseSync(`${f.path}.deletions`)
  try {
    ledger.exec(`DROP TABLE deletions;
      ${previousOutbox.replace("bot_deletion_outbox", "deletions")} PRAGMA user_version=1;`)
    ledger.prepare("INSERT INTO deletions VALUES('routine','old-ledger','')").run()
  } finally {
    ledger.close()
  }
  const migrated = new BotStore(f.path)
  try {
    expect(migrated.db.exec("SELECT version FROM bot_schema")[0].values[0][0]).toBe(
      BOT_SCHEMA_VERSION
    )
    migrated.deleteSkill(f.input)
    expect(ledgerRows(f.path)).toEqual(
      expect.arrayContaining([
        { kind: "routine", key: "old-outbox", owner: "" },
        { kind: "routine", key: "old-ledger", owner: "" },
        { kind: "private-skill", key: f.skill.id, owner: f.bot.id }
      ])
    )
    const names = readdirSync(join(f.root, "backups")).filter((name) =>
      name.startsWith("bots-v48-")
    )
    expect(names).toHaveLength(1)
    const backup = new DatabaseSync(join(f.root, "backups", names[0]), { readOnly: true })
    try {
      expect(backup.prepare("SELECT version FROM bot_schema").get()?.version).toBe(48)
      expect(backup.prepare("SELECT COUNT(*) count FROM bot_skills").get()?.count).toBe(1)
      expect(backup.prepare("SELECT key FROM bot_deletion_outbox").get()?.key).toBe("old-outbox")
    } finally {
      backup.close()
    }
  } finally {
    migrated.close()
  }
})

it("keeps private deletion across repeated actual restores without withdrawing the published snapshot or destroying audit versions", async () => {
  const f = fixture()
  const shared = f.store.skillLibrary.publish({
    nonce: "publish",
    botId: f.bot.id,
    skillId: f.skill.id,
    version: 1,
    libraryRevision: 0
  })
  const trial = f.store.trialSkill({
    nonce: "verify",
    botId: f.bot.id,
    skillId: f.skill.id,
    version: 1,
    inputs: "42",
    criteria: "Evidence"
  })
  const claim = f.store.claim("review")!
  f.store.finish(claim.lease, "succeeded", "Verified")
  f.store.reviewSkillTrial({ id: trial.id, verdict: "passed", note: "Checked evidence" })
  const routine = f.store.saveRoutine(
    {
      botId: f.bot.id,
      name: "Bound",
      prompt: "Inspect",
      schedule: { kind: "event", topic: "evidence.ready" },
      enabled: true,
      timezone: "UTC",
      skills: [{ botId: f.bot.id, id: f.skill.id, version: 1 }]
    },
    { kind: "human" }
  )
  f.store.close()
  const backup = (await executeBotBackup(f.root, { action: "create", nonce: randomUUID() })).backup!
  const live = new BotStore(f.path)
  try {
    live.deleteSkill(f.input)
  } finally {
    live.close()
  }
  const sealed = readFileSync(join(f.root, "backups", "snapshots", backup.id, "bots.sqlite"))
  for (let index = 0; index < 2; index++) {
    await executeBotBackup(f.root, {
      action: "restore",
      nonce: randomUUID(),
      backup: { id: backup.id, sha256: backup.sha256 }
    })
    const restored = new BotStore(f.path)
    try {
      expect(restored.skills(f.bot.id)).toEqual([])
      expect(restored.skillVersion(f.bot.id, f.skill.id, 1)).toMatchObject({
        enabled: false,
        instructions: f.skill.instructions
      })
      expect(restored.skillTrials(f.bot.id)[0].verdict).toBe("passed")
      expect(restored.routine(f.bot.id, routine.id)).toMatchObject({
        enabled: false,
        nextAt: null,
        skillIssueCode: "skill_unavailable",
        skillReferences: [{ botId: f.bot.id, id: f.skill.id, version: 1, name: f.skill.name }]
      })
      expect(restored.skillLibrary.current(f.bot.id, shared.id, 1).instructions).toBe(
        f.skill.instructions
      )
      expect(() =>
        restored.saveSkill({
          ...f.skill,
          nonce: "revive-after-restore",
          expectedDataEpoch: restored.dataEpoch(),
          name: "Revived"
        })
      ).toThrow("删除")
      expect(restored.db.exec("SELECT COUNT(*) FROM bot_skills")[0].values[0][0]).toBe(1)
    } finally {
      restored.close()
    }
    expect(readFileSync(join(f.root, "backups", "snapshots", backup.id, "bots.sqlite"))).toEqual(
      sealed
    )
  }
}, 20_000)
