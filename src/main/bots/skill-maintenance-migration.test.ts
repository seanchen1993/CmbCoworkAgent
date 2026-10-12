import { expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { BotStore } from "./store"
import { BOT_SCHEMA_VERSION } from "./schema"
import { executeBotBackup } from "./backups"

it("upgrades a 69 database, backs it up and preserves existing skill/run/receipt authority", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-hermes-migration-"))
  const path = join(directory, "bots.sqlite")
  let store: BotStore | undefined
  try {
    store = new BotStore(path)
    const owner = store.createBot({ nonce: "owner", name: "Owner" })
    const input = {
      nonce: "save",
      expectedDataEpoch: "initial",
      botId: owner.bot.id,
      name: "已有流程",
      instructions: "ORIGINAL_PRIVATE_STEPS",
      enabled: true
    }
    const skill = store.saveSkill(input)
    const sent = store.send({ nonce: "task", conversationId: owner.conversationId, text: "原任务" })
    const before = store.getRun(sent.runIds[0])
    store.close()
    store = undefined
    const prior = new DatabaseSync(path)
    prior.exec(
      "DROP TABLE bot_skill_use_receipts; DROP TABLE bot_skill_maintenance; DROP TABLE bot_skill_maintenance_policy; DROP INDEX bot_skill_maintenance_activity; UPDATE bot_schema SET version=69"
    )
    prior.close()
    store = new BotStore(path)
    expect(store.db.exec("SELECT version FROM bot_schema")[0].values[0][0]).toBe(BOT_SCHEMA_VERSION)
    expect(store.skills(owner.bot.id)).toEqual([skill])
    expect(store.saveSkill(input)).toEqual(skill)
    expect(store.getRun(before.id)).toEqual(before)
    expect(
      store.skillMaintenance.view({ botId: owner.bot.id, expectedDataEpoch: "initial" })
    ).toMatchObject({
      policy: { enabled: false },
      entries: [{ managed: false, pinned: false, archived: false }]
    })
    const backupName = readdirSync(join(directory, "backups")).find((name) =>
      name.startsWith("bots-v69-")
    )!
    const backup = new DatabaseSync(join(directory, "backups", backupName), { readOnly: true })
    try {
      expect(backup.prepare("SELECT version FROM bot_schema").get()?.version).toBe(69)
      expect(
        backup.prepare("SELECT name FROM sqlite_master WHERE name='bot_skill_maintenance'").get()
      ).toBeUndefined()
      expect(
        backup.prepare("SELECT instructions FROM bot_skills WHERE id=?").get(skill.id)?.instructions
      ).toBe(skill.instructions)
    } finally {
      backup.close()
    }
  } finally {
    store?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("retains maintenance policy, archive, pins and actual usage through a complete backup restore", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "bot-hermes-restore-")))
  const path = join(directory, "bots.sqlite")
  let store: BotStore | undefined
  try {
    store = new BotStore(path)
    const owner = store.createBot({ nonce: "owner", name: "Owner" })
    const scope = { botId: owner.bot.id, expectedDataEpoch: store.snapshot().dataEpoch }
    const archived = store.saveSkill({
      botId: owner.bot.id,
      name: "可恢复流程",
      instructions: "ORIGINAL_PRIVATE_STEPS",
      enabled: true
    })
    const pinned = store.saveSkill({
      botId: owner.bot.id,
      name: "保留流程",
      instructions: "PINNED_PRIVATE_STEPS",
      enabled: true
    })
    const sent = store.send({
      nonce: "task",
      conversationId: owner.conversationId,
      text: "使用流程"
    })
    const claim = store.claim("host")!
    store.skillLibrary.readForRun(claim.run.id, archived.id)
    store.skillLibrary.readForRun(claim.run.id, archived.id)
    store.finish(claim.lease, "succeeded", "完成")
    const change = (skillId: string, action: "manage" | "pin" | "archive" | "restore") => {
      const entry = store!.skillMaintenance
        .view(scope)
        .entries.find((item) => item.skillId === skillId)!
      return store!.skillMaintenance.change({
        ...scope,
        nonce: `${action}-${skillId}-${entry.revision}`,
        skillId,
        version: entry.version,
        revision: entry.revision,
        action
      })
    }
    change(archived.id, "manage")
    change(archived.id, "archive")
    change(pinned.id, "pin")
    store.skillMaintenance.configure({
      ...scope,
      nonce: "policy",
      revision: 0,
      enabled: true,
      staleAfterDays: 14,
      archiveAfterDays: 30
    })
    const before = store.skillMaintenance.view(scope)
    store.close()
    store = undefined
    const backup = (await executeBotBackup(directory, { action: "create", nonce: randomUUID() }))
      .backup!
    store = new BotStore(path)
    change(archived.id, "restore")
    store.close()
    store = undefined
    await executeBotBackup(directory, {
      action: "restore",
      nonce: randomUUID(),
      backup: { id: backup.id, sha256: backup.sha256 }
    })
    store = new BotStore(path)
    const epoch = store.snapshot().dataEpoch
    expect(epoch).not.toBe(scope.expectedDataEpoch)
    expect(store.skillMaintenance.view({ ...scope, expectedDataEpoch: epoch })).toEqual(before)
    expect(store.getRun(sent.runIds[0]).status).toBe("succeeded")
    expect(store.db.exec("SELECT COUNT(*) FROM bot_skill_use_receipts")[0].values[0][0]).toBe(1)
    expect(() => change(archived.id, "restore")).toThrow("恢复")
    expect(() => store!.skillLibrary.current(owner.bot.id, archived.id)).toThrow("归档")
    expect(store.skillVersion(owner.bot.id, archived.id, 1).instructions).toBe(
      "ORIGINAL_PRIVATE_STEPS"
    )
  } finally {
    store?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
