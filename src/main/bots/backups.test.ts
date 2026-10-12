import { afterEach, expect, it } from "vitest"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BOT_SCHEMA_VERSION } from "./schema"
import { DatabaseSync } from "node:sqlite"
import { BotStore } from "./store"
import { BotTeachStore } from "./teach-store"
import { avatarImage } from "./image-fixtures"
import { prepareBotAvatar } from "./avatar-image"
import { BotArtifacts } from "./artifacts"
import { BotHostLock } from "./host-lock"
import {
  executeBotBackup,
  listBotBackups,
  recoverBotRestore,
  createScheduledBotSnapshot
} from "./backups"
import type { BotBackupSummary } from "../../shared/bot-backup"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const selection = (backup: BotBackupSummary) => ({ id: backup.id, sha256: backup.sha256 })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bot-backup-")))
  roots.push(root)
  const store = new BotStore(join(root, "bots.sqlite")),
    files = new BotArtifacts(join(root, "objects"), store)
  const bot = store.createBot({ nonce: "bot", name: "备份测试" })
  const skill = store.saveSkill({
    botId: bot.bot.id,
    name: "Shared backup workflow",
    instructions: "Verify restored evidence",
    enabled: true
  })
  store.skillLibrary.publish({
    nonce: "publish-before-backup",
    botId: bot.bot.id,
    skillId: skill.id,
    version: 1,
    libraryRevision: 0
  })
  await store.sharedMemories.save({
    botId: bot.bot.id,
    botRevision: bot.bot.revision,
    scope: "user",
    nonce: "shared-before-backup",
    text: "Shared backup evidence"
  })
  const artifact = await files.upload({
    nonce: "report",
    conversationId: bot.conversationId,
    name: "成果.txt",
    mime: "text/plain",
    base64: Buffer.from("verified bytes").toString("base64")
  })
  const deleted = await files.upload({
    nonce: "deleted",
    conversationId: bot.conversationId,
    name: "已删除.txt",
    mime: "text/plain",
    base64: Buffer.from("deleted bytes").toString("base64")
  })
  await files.remove({
    nonce: "delete",
    conversationId: bot.conversationId,
    id: deleted.id,
    sha256: deleted.sha256
  })
  const session = randomUUID(),
    video = Buffer.from("video evidence"),
    frame = Buffer.from("frame evidence")
  await mkdir(join(root, "teach", session), { recursive: true })
  await writeFile(join(root, "teach", session, "video.webm"), video)
  await writeFile(join(root, "teach", session, "0.jpg"), frame)
  const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex")
  store.db.run(
    `INSERT INTO bot_teach_sessions(id,bot_id,conversation_id,nonce,phase,started_at,video) VALUES(?,?,?,?,'ready',1,?)`,
    [
      session,
      bot.bot.id,
      bot.conversationId,
      "teach",
      JSON.stringify({ size: video.length, sha256: sha(video), mime: "video/webm" })
    ]
  )
  store.db.run("INSERT INTO bot_teach_frames VALUES(?,0,1,?,?,?,?)", [
    session,
    sha(frame),
    frame.length,
    "https://example.test",
    "Example"
  ])
  const run = store.send({
    nonce: "send",
    conversationId: bot.conversationId,
    text: "尚未完成的工作"
  }).runIds[0]
  store.saveRoutine({
    botId: bot.bot.id,
    name: "维护",
    prompt: "检查",
    schedule: { kind: "interval", everyMs: 60_000, anchor: Date.now() + 60_000 },
    timezone: "Asia/Shanghai",
    enabled: true
  })
  await writeFile(join(root, "models.private"), "not in backup")
  await writeFile(join(root, "secrets.private"), "not in backup")
  await files.close()
  store.close()
  return { root, bot, artifact, deleted, session, run }
}
async function create(root: string, nonce = randomUUID()) {
  return (await executeBotBackup(root, { action: "create", nonce })).backup!
}

it("captures an exact committed database while the live Host continues accepting work", async () => {
  const f = await fixture()
  const store = new BotStore(join(f.root, "bots.sqlite"))
  const lock = BotHostLock.acquire(f.root)!
  try {
    const claim = store.claim("host")!
    const nonce = randomUUID()
    const backup = await createScheduledBotSnapshot(f.root, nonce, async () => {
      store.saveMemory({ botId: f.bot.bot.id, text: "AFTER_SNAPSHOT" })
      store.send({
        nonce: "during-backup",
        conversationId: f.bot.conversationId,
        text: "ACCEPTED_DURING_BACKUP"
      })
    })
    expect(backup.reason).toBe("scheduled")
    expect(store.getRun(claim.run.id).status).toBe("running")
    expect(store.messages(f.bot.conversationId).at(-1)?.text).toBe("ACCEPTED_DURING_BACKUP")
    expect(await createScheduledBotSnapshot(f.root, nonce)).toEqual(backup)
    const snapshot = new DatabaseSync(
      join(f.root, "backups", "snapshots", backup.id, "bots.sqlite"),
      { readOnly: true }
    )
    try {
      expect(
        snapshot
          .prepare("SELECT COUNT(*) AS count FROM bot_messages WHERE text='ACCEPTED_DURING_BACKUP'")
          .get()?.count
      ).toBe(0)
      expect(
        snapshot
          .prepare("SELECT COUNT(*) AS count FROM bot_memories WHERE text='AFTER_SNAPSHOT'")
          .get()?.count
      ).toBe(0)
      expect(
        snapshot.prepare("SELECT status FROM bot_runs WHERE id=?").get(claim.run.id)?.status
      ).toBe("running")
    } finally {
      snapshot.close()
    }
    expect(
      await readFile(
        join(f.root, "backups", "snapshots", backup.id, "objects", f.artifact.sha256),
        "utf8"
      )
    ).toBe("verified bytes")
    expect(await listBotBackups(f.root)).toEqual([backup])
    await expect(
      executeBotBackup(f.root, { action: "create", nonce: randomUUID() })
    ).rejects.toThrow("仍在运行")
  } finally {
    store.close()
    lock.release()
  }
})

it.each(["delete", "change"])(
  "does not publish an online snapshot when a referenced file is concurrently %s",
  async (mode) => {
    const f = await fixture()
    const store = new BotStore(join(f.root, "bots.sqlite"))
    const files = new BotArtifacts(join(f.root, "objects"), store)
    try {
      await expect(
        createScheduledBotSnapshot(f.root, randomUUID(), async () => {
          if (mode === "delete")
            await files.remove({
              nonce: "concurrent-delete",
              conversationId: f.bot.conversationId,
              id: f.artifact.id,
              sha256: f.artifact.sha256
            })
          else await writeFile(join(f.root, "objects", f.artifact.sha256), "altered bytes!")
        })
      ).rejects.toThrow()
      expect(await listBotBackups(f.root)).toEqual([])
      expect(store.getBot(f.bot.bot.id).name).toBe("备份测试")
    } finally {
      await files.close()
      store.close()
    }
  }
)

it("restores approval history without re-enabling saved automatic execution rules", async () => {
  const f = await fixture()
  let store = new BotStore(join(f.root, "bots.sqlite"))
  const { lease } = store.claim("approval-host")!
  const action = {
    shell: {
      command: "npm test",
      cwd: "/project",
      timeoutSeconds: 60,
      sandbox: "none",
      definition: {
        kind: "package_script",
        path: "package.json",
        sha256: "c".repeat(64),
        definition: "node test.cjs"
      }
    }
  }
  const request = store.requestInteraction(lease, {
    kind: "approval",
    action,
    prompt: JSON.stringify(action),
    ruleScope: "a".repeat(64)
  })
  store.answerInteraction({
    id: request.id,
    revision: request.revision,
    answer: "approve",
    remember: true
  })
  store.finish(lease, "succeeded", "Test complete")
  const rules = store.approvalRules.read(f.bot.bot.id)
  const autoReview = store.autoReview.change({
    ...store.autoReview.read(f.bot.bot.id),
    nonce: "enable-review",
    isEnabled: true
  })
  store.close()
  const backup = await create(f.root)
  await executeBotBackup(f.root, {
    action: "restore",
    nonce: randomUUID(),
    backup: selection(backup)
  })
  store = new BotStore(join(f.root, "bots.sqlite"))
  try {
    expect(store.approvalRules.read(f.bot.bot.id)).toMatchObject({
      revision: rules.revision + 1,
      rules: [{ behavior: "ask" }]
    })
    expect(store.getInteraction(request.id).review?.remembered).toBe(true)
    expect(store.autoReview.read(f.bot.bot.id)).toMatchObject({
      isEnabled: false,
      revision: autoReview.revision + 1
    })
    expect(() => store.autoReview.change({ ...autoReview, nonce: "old-review" })).toThrow("已恢复")
    expect(() =>
      store.approvalRules.change({
        botId: f.bot.bot.id,
        ruleId: rules.rules[0].id,
        revision: rules.revision,
        dataEpoch: rules.dataEpoch,
        nonce: "old-change",
        behavior: "allow"
      })
    ).toThrow("已恢复")
  } finally {
    store.close()
  }
})

it("revokes webhook credentials on restore so an old backup cannot revive a withdrawn key", async () => {
  const f = await fixture()
  let store = new BotStore(join(f.root, "bots.sqlite"))
  const routine = store.saveRoutine({
    botId: f.bot.bot.id,
    name: "Webhook",
    prompt: "Check incoming event",
    schedule: { kind: "event", topic: "check" },
    timezone: "UTC",
    enabled: true
  })
  const input = {
    botId: f.bot.bot.id,
    routineId: routine.id,
    nonce: "first-key",
    operation: "rotate" as const,
    revision: 0
  }
  const first = store.webhooks.change(input)
  store.close()
  const backup = await create(f.root)
  store = new BotStore(join(f.root, "bots.sqlite"))
  const second = store.webhooks.change({ ...input, nonce: "second-key", revision: 1 })
  store.close()
  await executeBotBackup(f.root, {
    action: "restore",
    nonce: randomUUID(),
    backup: selection(backup)
  })
  store = new BotStore(join(f.root, "bots.sqlite"))
  try {
    expect(store.webhooks.authorize(routine.id, `Bearer ${first.key}`)).toBeNull()
    expect(store.webhooks.authorize(routine.id, `Bearer ${second.key}`)).toBeNull()
    expect(store.webhooks.describe({ botId: f.bot.bot.id, routineId: routine.id })).toMatchObject({
      enabled: false,
      routineEnabled: false,
      revision: 2
    })
    expect(store.webhooks.change(input).key).toBeNull()
    expect(store.webhooks.authorize(routine.id, `Bearer ${first.key}`)).toBeNull()
  } finally {
    store.close()
  }
})

it("restores normalized avatar images with their profile and idempotent save receipts", async () => {
  const f = await fixture()
  let store = new BotStore(join(f.root, "bots.sqlite"))
  const input = {
    nonce: "avatar-before",
    botId: f.bot.bot.id,
    revision: store.getBot(f.bot.bot.id).revision,
    pngBase64: await avatarImage()
  }
  const reader = { avatar: async (value: string) => prepareBotAvatar(value) }
  const saved = await store.avatars.change(input, new AbortController().signal, reader)
  store.close()
  const backup = await create(f.root)
  store = new BotStore(join(f.root, "bots.sqlite"))
  await store.avatars.change(
    { ...input, nonce: "avatar-after", revision: saved.revision, pngBase64: null },
    new AbortController().signal,
    reader
  )
  store.close()
  await executeBotBackup(f.root, {
    action: "restore",
    nonce: randomUUID(),
    backup: selection(backup)
  })
  store = new BotStore(join(f.root, "bots.sqlite"))
  try {
    expect(store.getBot(input.botId).avatarHash).toBe(saved.hash)
    expect(store.avatars.read({ botId: input.botId, hash: saved.hash! })).toBeTruthy()
    expect(await store.avatars.change(input, new AbortController().signal, reader)).toEqual(saved)
  } finally {
    store.close()
  }
})

it.each([false, true])(
  "does not resurrect post-backup deletions (damaged current database: %s)",
  async (damaged) => {
    const f = await fixture()
    let store = new BotStore(join(f.root, "bots.sqlite"))
    const memory = store.saveMemory({ botId: f.bot.bot.id, text: "Remove this remembered fact" })
    const other = store.createBot({ nonce: "deleted-bot", name: "Later removed" })
    store.close()
    const backup = await create(f.root)
    store = new BotStore(join(f.root, "bots.sqlite"))
    try {
      store.cancel(f.run)
      store.deleteMemory(f.bot.bot.id, memory.id, memory.revision)
      store.deleteArtifact({
        nonce: "remove-after-backup",
        conversationId: f.bot.conversationId,
        id: f.artifact.id,
        sha256: f.artifact.sha256
      })
      store.deleteBot(other.bot.id, other.bot.revision)
    } finally {
      store.close()
    }
    if (damaged) await writeFile(join(f.root, "bots.sqlite"), "damaged database")
    await executeBotBackup(f.root, {
      action: "restore",
      nonce: randomUUID(),
      backup: selection(backup)
    })
    store = new BotStore(join(f.root, "bots.sqlite"))
    try {
      expect(store.memories(f.bot.bot.id)).toEqual([])
      expect(() => store.getArtifact(f.artifact.id)).toThrow("已删除")
      expect(() => store.getBot(other.bot.id)).toThrow()
    } finally {
      store.close()
    }
  }
)

it("keeps shared-memory, recording and workflow withdrawals across repeated restores, preserving shared bytes", async () => {
  const f = await fixture()
  let store = new BotStore(join(f.root, "bots.sqlite"))
  const files = new BotArtifacts(join(f.root, "objects"), store)
  const sharedBytes = await files.upload({
    nonce: "shared-content",
    conversationId: f.bot.conversationId,
    name: "另一个引用.txt",
    mime: "text/plain",
    base64: Buffer.from("verified bytes").toString("base64")
  })
  const routine = store.routines(f.bot.bot.id)[0]
  const shared = (
    await store.sharedMemories.list({
      botId: f.bot.bot.id,
      botRevision: f.bot.bot.revision,
      scope: "user"
    })
  )[0]
  const skill = store.skillLibrary.list()[0]
  await files.close()
  store.close()
  const backup = await create(f.root)
  store = new BotStore(join(f.root, "bots.sqlite"))
  try {
    store.cancel(f.run)
    store.deleteArtifact({
      nonce: "delete-reference",
      conversationId: f.bot.conversationId,
      id: f.artifact.id,
      sha256: f.artifact.sha256
    })
    await store.sharedMemories.remove({
      botId: f.bot.bot.id,
      botRevision: f.bot.bot.revision,
      scope: "user",
      id: shared.id,
      revision: shared.revision,
      nonce: "remove-shared"
    })
    store.deleteRoutine({
      botId: f.bot.bot.id,
      id: routine.id,
      revision: routine.revision,
      nonce: "remove-routine"
    })
    store.skillLibrary.withdraw({ id: skill.id, revision: skill.revision, nonce: "withdraw-skill" })
    const teach = new BotTeachStore(store)
    teach.discardSaved({ id: f.session, revision: teach.get(f.session).revision })
  } finally {
    store.close()
  }
  for (let i = 0; i < 2; i++) {
    await executeBotBackup(f.root, {
      action: "restore",
      nonce: randomUUID(),
      backup: selection(backup)
    })
    store = new BotStore(join(f.root, "bots.sqlite"))
    try {
      expect(store.routines(f.bot.bot.id)).toEqual([])
      expect(store.skillLibrary.list()).toEqual([])
      expect(
        await store.sharedMemories.list({
          botId: f.bot.bot.id,
          botRevision: f.bot.bot.revision,
          scope: "user"
        })
      ).toEqual([])
      expect(new BotTeachStore(store).history({ botId: f.bot.bot.id }).items).toEqual([])
      expect(() => store.getArtifact(f.artifact.id)).toThrow("已删除")
      expect(store.getArtifact(sharedBytes.id).sha256).toBe(f.artifact.sha256)
      expect(await readFile(join(f.root, "objects", f.artifact.sha256), "utf8")).toBe(
        "verified bytes"
      )
      await expect(readFile(join(f.root, "teach", f.session, "video.webm"))).rejects.toMatchObject({
        code: "ENOENT"
      })
      expect(store.db.exec("SELECT COUNT(*) FROM bot_teach_frames")[0].values[0][0]).toBe(0)
      expect(
        store.db.exec("SELECT COUNT(*) FROM bot_memory_tombstones")[0].values[0][0]
      ).toBeGreaterThan(0)
    } finally {
      store.close()
    }
  }
})

it("refuses a damaged deletion ledger before replacing current data", async () => {
  const f = await fixture(),
    backup = await create(f.root)
  const original = await readFile(join(f.root, "bots.sqlite"))
  await writeFile(join(f.root, "bots.sqlite.deletions"), "invalid deletion records")
  await expect(
    executeBotBackup(f.root, { action: "restore", nonce: randomUUID(), backup: selection(backup) })
  ).rejects.toThrow("删除记录")
  expect((await readFile(join(f.root, "bots.sqlite"))).equals(original)).toBe(true)
  expect(await readFile(join(f.root, "bots.sqlite.deletions"), "utf8")).toBe(
    "invalid deletion records"
  )
})

it("restores verified files and Teach evidence, keeps tombstones, fences queued work and retains the pre-restore snapshot", async () => {
  const f = await fixture(),
    nonce = randomUUID(),
    backup = await create(f.root, nonce)
  expect(await create(f.root, nonce)).toEqual(backup)
  const manifest = JSON.parse(
    await readFile(join(f.root, "backups", "snapshots", backup.id, "manifest.json"), "utf8")
  )
  expect(manifest.entries.map((file: { path: string }) => file.path)).toEqual(
    expect.arrayContaining([
      "bots.sqlite",
      `objects/${f.artifact.sha256}`,
      `teach/${f.session}/video.webm`,
      `teach/${f.session}/0.jpg`
    ])
  )
  expect(manifest.entries.some((file: { path: string }) => /private|deleted/.test(file.path))).toBe(
    false
  )
  let store = new BotStore(join(f.root, "bots.sqlite"))
  store.createBot({ nonce: "new", name: "备份后新增" })
  store.close()
  const request = { action: "restore" as const, nonce: randomUUID(), backup: selection(backup) }
  const result = await executeBotBackup(f.root, request)
  expect(result.safetyBackup?.reason).toBe("before-restore")
  expect((await listBotBackups(f.root)).length).toBe(2)
  store = new BotStore(join(f.root, "bots.sqlite"))
  try {
    expect(store.snapshot().bots.map((bot) => bot.name)).toEqual(["备份测试"])
    expect(store.getRun(f.run).status).toBe("cancelled")
    expect(store.getRun(f.run).error).toContain("外部操作")
    expect(store.routines(f.bot.bot.id)[0].enabled).toBe(false)
    expect(store.skillLibrary.list()).toEqual([
      expect.objectContaining({
        name: "Shared backup workflow",
        instructions: "Verify restored evidence",
        revision: 1,
        enabled: true
      })
    ])
    expect(
      (
        await store.sharedMemories.list({
          botId: f.bot.bot.id,
          botRevision: f.bot.bot.revision,
          scope: "user"
        })
      )[0].text
    ).toBe("Shared backup evidence")
    expect(() => store.getArtifact(f.deleted.id)).toThrow("已删除")
    expect(await readFile(join(f.root, "objects", f.artifact.sha256), "utf8")).toBe(
      "verified bytes"
    )
    expect(await readFile(join(f.root, "teach", f.session, "video.webm"), "utf8")).toBe(
      "video evidence"
    )
    expect(await readFile(join(f.root, "models.private"), "utf8")).toBe("not in backup")
  } finally {
    store.close()
  }
  expect(await executeBotBackup(f.root, request)).toEqual(result)
  expect((await listBotBackups(f.root)).length).toBe(2)
  // The safety snapshot actually contains the pre-restore state, not just a name.
  const db = new DatabaseSync(
    join(f.root, "backups", "snapshots", result.safetyBackup!.id, "bots.sqlite"),
    { readOnly: true }
  )
  try {
    expect(db.prepare("SELECT COUNT(*) n FROM bots").get()?.n).toBe(2)
  } finally {
    db.close()
  }
})

it("takes committed WAL state, rejects a live Host lock and never copies an unsupported database", async () => {
  const f = await fixture(),
    lock = BotHostLock.acquire(f.root)!
  await expect(create(f.root)).rejects.toThrow("仍在运行")
  lock.release()
  const db = new DatabaseSync(join(f.root, "bots.sqlite"))
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0")
    db.prepare("UPDATE bots SET name=?").run("WAL committed")
    const backup = await create(f.root)
    const snapshot = new DatabaseSync(
      join(f.root, "backups", "snapshots", backup.id, "bots.sqlite"),
      { readOnly: true }
    )
    try {
      expect(snapshot.prepare("SELECT name FROM bots").get()?.name).toBe("WAL committed")
    } finally {
      snapshot.close()
    }
    db.exec("UPDATE bot_schema SET version=999")
    await expect(create(f.root)).rejects.toThrow("版本")
    expect(db.prepare("SELECT version FROM bot_schema").get()?.version).toBe(999)
  } finally {
    db.close()
  }
})

it("rejects corrupt content, changed selection and path escapes before replacing any current data", async () => {
  const f = await fixture(),
    backup = await create(f.root)
  const directory = join(f.root, "backups", "snapshots", backup.id)
  const before = await readFile(join(f.root, "bots.sqlite"))
  const restore = () =>
    executeBotBackup(f.root, { action: "restore", nonce: randomUUID(), backup: selection(backup) })
  await writeFile(join(directory, "objects", f.artifact.sha256), "corrupt bytes!")
  await expect(restore()).rejects.toThrow("校验失败")
  expect((await readFile(join(f.root, "bots.sqlite"))).equals(before)).toBe(true)
  expect((await listBotBackups(f.root)).length).toBe(1)
  await expect(
    executeBotBackup(f.root, {
      action: "restore",
      nonce: randomUUID(),
      backup: { ...selection(backup), id: "../outside" }
    })
  ).rejects.toThrow()
  await expect(
    executeBotBackup(f.root, {
      action: "delete",
      backup: { ...selection(backup), sha256: "0".repeat(64) }
    })
  ).rejects.toThrow("已变化")
  await rm(join(directory, "objects", f.artifact.sha256))
  await symlink(join(f.root, "models.private"), join(directory, "objects", f.artifact.sha256))
  await expect(restore()).rejects.toThrow("outside")
  expect((await readFile(join(f.root, "bots.sqlite"))).equals(before)).toBe(true)
})

it.each([
  "old:bots.sqlite",
  "next:bots.sqlite",
  "old:objects",
  "next:objects",
  "old:teach",
  "next:teach"
])(
  "recovers a crash after %s before opening the database and does not replay pending work",
  async (point) => {
    const f = await fixture(),
      backup = await create(f.root)
    const request = { action: "restore" as const, nonce: randomUUID(), backup: selection(backup) }
    await expect(
      executeBotBackup(f.root, request, (name) => {
        if (name === point) throw new Error("crash")
      })
    ).rejects.toThrow("crash")
    const lock = BotHostLock.acquire(f.root)!
    try {
      await recoverBotRestore(f.root)
    } finally {
      lock.release()
    }
    const store = new BotStore(join(f.root, "bots.sqlite"))
    try {
      expect(store.getRun(f.run).status).toBe("cancelled")
      expect(store.artifacts(f.bot.conversationId)).toHaveLength(1)
      expect(await readFile(join(f.root, "objects", f.artifact.sha256), "utf8")).toBe(
        "verified bytes"
      )
      expect(await readFile(join(f.root, "teach", f.session, "0.jpg"), "utf8")).toBe(
        "frame evidence"
      )
    } finally {
      store.close()
    }
    expect((await executeBotBackup(f.root, request)).safetyBackup).toBeDefined()
  }
)

it("deletes only the selected managed backup and allows an identical deletion retry", async () => {
  const f = await fixture(),
    backup = await create(f.root),
    other = await create(f.root)
  const request = { action: "delete", backup: selection(backup) }
  await executeBotBackup(f.root, request)
  await executeBotBackup(f.root, request)
  expect((await listBotBackups(f.root)).map((item) => item.id)).toEqual([other.id])
  expect(await readFile(join(f.root, "objects", f.artifact.sha256), "utf8")).toBe("verified bytes")
})

it("restores a valid snapshot when the current database is damaged and retains the original bytes for recovery", async () => {
  const f = await fixture(),
    backup = await create(f.root)
  const damaged = Buffer.from("damaged SQLite file")
  await writeFile(join(f.root, "bots.sqlite"), damaged)
  const request = { action: "restore" as const, nonce: randomUUID(), backup: selection(backup) }
  const result = await executeBotBackup(f.root, request)
  expect(result.safetyBackup).toBeUndefined()
  expect(result.recoveryCopy).toBe(request.nonce)
  expect(
    (
      await readFile(join(f.root, "backups", `recovery-${request.nonce}`, "old", "bots.sqlite"))
    ).equals(damaged)
  ).toBe(true)
  const store = new BotStore(join(f.root, "bots.sqlite"))
  try {
    expect(store.snapshot().dataEpoch).toBe(request.nonce)
    expect(store.getRun(f.run).status).toBe("cancelled")
  } finally {
    store.close()
  }
  expect(await executeBotBackup(f.root, request)).toEqual(result)
})

it("restores a version 14 backup through staged migration without changing the sealed original", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bot-backup-v14-")))
  roots.push(root)
  const path = join(root, "bots.sqlite")
  const store = new BotStore(path)
  const { bot } = store.createBot({ nonce: "legacy", name: "旧版 Bot" })
  store.saveMemory({ botId: bot.id, text: "旧版长期记忆" })
  store.close()
  const old = new DatabaseSync(path)
  old.exec(
    "DROP TABLE bot_memory_metadata; DROP TABLE bot_memory_state; DROP TABLE bot_memory_evidence; DROP TABLE bot_memory_tombstones; UPDATE bot_schema SET version=14"
  )
  old.close()
  const backup = (await executeBotBackup(root, { action: "create", nonce: randomUUID() })).backup!
  expect(backup.schemaVersion).toBe(14)
  expect(await listBotBackups(root)).toHaveLength(1)
  await executeBotBackup(root, {
    action: "restore",
    nonce: randomUUID(),
    backup: selection(backup)
  })
  const restored = new BotStore(path)
  try {
    expect(restored.memories(bot.id)[0]).toMatchObject({ text: "旧版长期记忆", origin: "explicit" })
    expect(restored.memory.policy(bot.id).enabled).toBe(true)
  } finally {
    restored.close()
  }
  const saved = new DatabaseSync(join(root, "backups", "snapshots", backup.id, "bots.sqlite"), {
    readOnly: true
  })
  expect(saved.prepare("SELECT version FROM bot_schema").get()?.version).toBe(14)
  saved.close()
  const upgraded = new DatabaseSync(path, { readOnly: true })
  expect(upgraded.prepare("SELECT version FROM bot_schema").get()?.version).toBe(BOT_SCHEMA_VERSION)
  upgraded.close()
})
