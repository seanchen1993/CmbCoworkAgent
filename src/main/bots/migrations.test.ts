import { expect, it } from "vitest"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"
import { BotStore } from "./store"
import { BotCheckpointSaver } from "./checkpointer"
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint"
import { HumanMessage } from "@langchain/core/messages"
import { BOT_SCHEMA_VERSION } from "./schema"
import { BotWorkflowStore } from "./workflow-store"
import { startBotModelUsage } from "./model-usage"

it("upgrades v46 with live-projection indexes while preserving messages and the original database", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-v46-projection-indexes-")),
    path = join(directory, "bots.sqlite")
  const indexes = [
    "bot_run_open_projection",
    "bot_run_owned_children",
    "bot_interaction_pending_projection",
    "bot_event_restore_cursor"
  ]
  let store = new BotStore(path)
  try {
    const { conversationId } = store.createBot({ nonce: "existing", name: "Existing" })
    store.send({ nonce: "message", conversationId, text: "Existing work" })
    const before = store.snapshot(),
      messages = store.messages(conversationId)
    store.close()
    const old = new DatabaseSync(path)
    try {
      for (const name of indexes) old.exec(`DROP INDEX ${name}`)
      old.exec("UPDATE bot_schema SET version=46")
    } finally {
      old.close()
    }
    store = new BotStore(path)
    expect(store.snapshot()).toEqual(before)
    expect(store.messages(conversationId)).toEqual(messages)
    const names = store.db
      .exec("SELECT name FROM sqlite_master WHERE type='index'")[0]
      .values.flat()
    for (const name of indexes) expect(names).toContain(name)
    expect(store.db.exec("SELECT version FROM bot_schema")[0].values[0][0]).toBe(BOT_SCHEMA_VERSION)
    const backups = readdirSync(join(directory, "backups")).filter((name) =>
      name.startsWith("bots-v46-")
    )
    expect(backups).toHaveLength(1)
    const backup = new DatabaseSync(join(directory, "backups", backups[0]), { readOnly: true })
    try {
      expect(backup.prepare("SELECT version FROM bot_schema").get()?.version).toBe(46)
      expect(
        backup.prepare("SELECT text FROM bot_messages WHERE conversation_id=?").get(conversationId)
          ?.text
      ).toBe("Existing work")
      expect(
        backup.prepare("SELECT name FROM sqlite_master WHERE name=?").get(indexes[0])
      ).toBeUndefined()
    } finally {
      backup.close()
    }
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("upgrades v45 without rewriting inline checkpoints and backs up the original database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-v45-message-deltas-")),
    path = join(directory, "bots.sqlite")
  let store = new BotStore(path)
  try {
    const { conversationId } = store.createBot({ nonce: "existing", name: "Existing" })
    store.send({ nonce: "message", conversationId, text: "Existing work" })
    const { run, lease } = store.claim("host", 300_000)!
    const saver = new BotCheckpointSaver(store, lease, run.id)
    const checkpoint = {
      ...emptyCheckpoint(),
      channel_values: { messages: [new HumanMessage("original inline history")] }
    }
    const config = await saver.put({ configurable: { thread_id: run.id } }, checkpoint, {
      source: "loop",
      step: 0,
      parents: {}
    })
    const [type, bytes] = await saver.serde.dumpsTyped(checkpoint)
    store.db.run("UPDATE bot_graph_checkpoints SET type=?,data=?", [type, bytes])
    store.close()
    const old = new DatabaseSync(path)
    try {
      old.exec(
        "DROP TABLE bot_graph_message_heads; DROP TABLE bot_graph_message_snapshots; UPDATE bot_schema SET version=45"
      )
    } finally {
      old.close()
    }
    store = new BotStore(path)
    const resumed = new BotCheckpointSaver(store, lease, run.id)
    expect((await resumed.getTuple(config))?.checkpoint.channel_values.messages).toEqual(
      checkpoint.channel_values.messages
    )
    expect(
      Buffer.from(
        store.db.exec("SELECT data FROM bot_graph_checkpoints")[0].values[0][0] as Uint8Array
      )
    ).toEqual(Buffer.from(bytes))
    const nextMessages = [...checkpoint.channel_values.messages, new HumanMessage("new work")]
    const next = await resumed.put(
      config,
      { ...emptyCheckpoint(), channel_values: { messages: nextMessages } },
      { source: "loop", step: 1, parents: {} }
    )
    expect(
      (await new BotCheckpointSaver(store, lease, run.id).getTuple(next))?.checkpoint.channel_values
        .messages
    ).toEqual(nextMessages)
    expect(store.db.exec("SELECT version FROM bot_schema")[0].values[0][0]).toBe(BOT_SCHEMA_VERSION)
    const backups = readdirSync(join(directory, "backups")).filter((name) =>
      name.startsWith("bots-v45-")
    )
    expect(backups).toHaveLength(1)
    const backup = new DatabaseSync(join(directory, "backups", backups[0]), { readOnly: true })
    try {
      expect(backup.prepare("SELECT version FROM bot_schema").get()?.version).toBe(45)
      expect(
        Buffer.from(
          backup.prepare("SELECT data FROM bot_graph_checkpoints").get()?.data as Uint8Array
        )
      ).toEqual(Buffer.from(bytes))
    } finally {
      backup.close()
    }
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("upgrades v44 with an empty download journal and preserves existing messages", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-v44-downloads-")),
    path = join(directory, "bots.sqlite")
  let store = new BotStore(path)
  try {
    const { conversationId } = store.createBot({ nonce: "existing", name: "Existing" })
    store.send({ nonce: "message", conversationId, text: "Existing work" })
    const messages = store.messages(conversationId)
    store.close()
    const old = new DatabaseSync(path)
    try {
      old.exec("DROP TABLE bot_browser_downloads; UPDATE bot_schema SET version=44")
    } finally {
      old.close()
    }
    store = new BotStore(path)
    expect(store.browserDownloads.recoverAtStartup()).toBe(0)
    expect(store.messages(conversationId)).toEqual(messages)
    expect(store.db.exec("SELECT version FROM bot_schema")[0].values[0][0]).toBe(BOT_SCHEMA_VERSION)
    expect(
      readdirSync(join(directory, "backups")).filter((name) => name.startsWith("bots-v44-"))
    ).toHaveLength(1)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("upgrades v43 without clearing unknown usage and applies newly configured output limits", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-v43-usage-")),
    path = join(directory, "bots.sqlite")
  let store = new BotStore(path)
  try {
    const { bot } = store.createBot({ nonce: "existing", name: "Existing" })
    startBotModelUsage(store, {
      botId: bot.id,
      model: { id: "test", model: "test", baseUrl: "https://unused.invalid" },
      purpose: "memory-synthesis",
      reserved: 100
    })
    const usage = store.usageBudgets.view({ botId: null }).usage
    store.close()
    const old = new DatabaseSync(path)
    try {
      old.exec(
        "DROP TABLE bot_usage_budgets; DROP INDEX bot_model_usage_window; UPDATE bot_schema SET version=43"
      )
    } finally {
      old.close()
    }
    store = new BotStore(path)
    const current = store.usageBudgets.view({ botId: null })
    expect(current).toMatchObject({ revision: 0, outputLimit: null, available: null, usage })
    store.usageBudgets.change({
      botId: null,
      nonce: "limit",
      revision: 0,
      dataEpoch: current.dataEpoch,
      outputLimit: 100
    })
    expect(() => store.usageBudgets.capacity(bot.id, 1)).toThrow("额度已用尽")
    store.close()
    store = new BotStore(path)
    expect(store.usageBudgets.view({ botId: null })).toMatchObject({
      revision: 1,
      outputLimit: 100,
      available: 0,
      usage
    })
    expect(store.db.exec("SELECT version FROM bot_schema")[0].values[0][0]).toBe(BOT_SCHEMA_VERSION)
    expect(
      readdirSync(join(directory, "backups")).filter((name) => name.startsWith("bots-v43-"))
    ).toHaveLength(1)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("upgrades v39 and recovers existing soft and audited hard deletion identities", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-v39-deletions-")),
    path = join(directory, "bots.sqlite")
  let store = new BotStore(path)
  try {
    const { bot, conversationId } = store.createBot({ nonce: "existing", name: "Existing" })
    const memory = store.saveMemory({ botId: bot.id, text: "Forgotten" })
    const routine = store.saveRoutine({
      botId: bot.id,
      name: "Removed",
      prompt: "Review",
      schedule: { kind: "interval", everyMs: 60_000, anchor: Date.now() },
      timezone: "UTC",
      enabled: false
    })
    store.deleteMemory(bot.id, memory.id, memory.revision)
    store.deleteRoutine({
      botId: bot.id,
      id: routine.id,
      revision: routine.revision,
      nonce: "remove"
    })
    const snapshot = store.snapshot(),
      messages = store.messages(conversationId)
    store.close()
    rmSync(`${path}.deletions`)
    const old = new DatabaseSync(path)
    old.exec(
      "DROP TABLE bot_deletion_outbox; DROP INDEX bot_deleted_event_identity; UPDATE bot_schema SET version=39"
    )
    old.close()
    store = new BotStore(path)
    expect(store.snapshot()).toEqual(snapshot)
    expect(store.messages(conversationId)).toEqual(messages)
    const ledger = new DatabaseSync(`${path}.deletions`, { readOnly: true })
    try {
      expect(ledger.prepare("SELECT kind,key FROM deletions").all()).toEqual(
        expect.arrayContaining([
          { kind: "memory", key: memory.id },
          { kind: "routine", key: routine.id }
        ])
      )
    } finally {
      ledger.close()
    }
    expect(
      readdirSync(join(directory, "backups")).some((name) => name.startsWith("bots-v39-"))
    ).toBe(true)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("upgrades v38 with durable pane intents while preserving existing tasks and messages", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-v38-panes-")),
    path = join(directory, "bots.sqlite")
  let store = new BotStore(path)
  try {
    const { bot, conversationId } = store.createBot({ nonce: "existing", name: "Existing" })
    store.send({ nonce: "work", conversationId, text: "Pending work" })
    const runs = store.snapshot().runs,
      messages = store.messages(conversationId)
    store.close()
    const old = new DatabaseSync(path)
    old.exec("DROP TABLE bot_plugin_pane_actions; UPDATE bot_schema SET version=38")
    old.close()
    store = new BotStore(path)
    expect(store.getBot(bot.id)).toEqual(bot)
    expect(store.snapshot().runs).toEqual(runs)
    expect(store.messages(conversationId)).toEqual(messages)
    expect(store.db.exec("SELECT count(*) FROM bot_plugin_pane_actions")[0].values[0][0]).toBe(0)
    expect(store.db.exec("SELECT version FROM bot_schema")[0].values[0][0]).toBe(BOT_SCHEMA_VERSION)
    expect(
      readdirSync(join(directory, "backups")).some((name) => name.startsWith("bots-v38-"))
    ).toBe(true)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("adds the trial message index on same-version reopen without changing existing records", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-trial-index-")),
    path = join(directory, "bots.sqlite")
  let store = new BotStore(path)
  try {
    const { bot, conversationId } = store.createBot({ nonce: "existing", name: "Existing" })
    const skill = store.saveSkill({
      botId: bot.id,
      name: "Review",
      instructions: "Check the supplied evidence",
      enabled: true
    })
    const trial = store.trialSkill({
      nonce: "existing-trial",
      botId: bot.id,
      skillId: skill.id,
      version: skill.version,
      inputs: "record 42",
      criteria: "matches the evidence"
    })
    const messages = store.messages(conversationId),
      snapshot = store.snapshot()
    store.close()
    const old = new DatabaseSync(path)
    try {
      old.exec("DROP INDEX bot_trial_trigger_message")
      expect(old.prepare("SELECT version FROM bot_schema").get()?.version).toBe(BOT_SCHEMA_VERSION)
    } finally {
      old.close()
    }
    store = new BotStore(path)
    expect(store.messages(conversationId)).toEqual(messages)
    expect(store.snapshot()).toEqual(snapshot)
    expect(store.trialForRun(trial.runId)).toEqual(trial)
    const inspection = new DatabaseSync(path, { readOnly: true })
    try {
      expect(inspection.prepare("SELECT version FROM bot_schema").get()?.version).toBe(
        BOT_SCHEMA_VERSION
      )
      expect(
        inspection
          .prepare("SELECT sql FROM sqlite_master WHERE name='bot_trial_trigger_message'")
          .get()?.sql
      ).toContain("ON bot_runs(message_id) WHERE source='skill-trial'")
    } finally {
      inspection.close()
    }
    expect(readdirSync(directory)).not.toContain("backups")
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("upgrades v36 with default notification preferences and preserves task identities", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-v36-notifications-")),
    path = join(directory, "bots.sqlite")
  let store = new BotStore(path)
  try {
    const { bot, conversationId } = store.createBot({ nonce: "existing", name: "Existing" })
    store.send({ nonce: "work", conversationId, text: "Pending work" })
    const runs = store.snapshot().runs
    store.close()
    const old = new DatabaseSync(path)
    old.exec("DROP TABLE bot_notification_settings; UPDATE bot_schema SET version=36")
    old.close()
    store = new BotStore(path)
    expect(store.getBot(bot.id)).toEqual(bot)
    expect(store.snapshot().runs).toEqual(runs)
    expect(store.snapshot().notificationSettings).toEqual([])
    expect(
      store.notifications.change({
        botId: bot.id,
        revision: 0,
        enabled: false,
        nonce: "mute",
        dataEpoch: store.backupSchedule.epoch()
      }).revision
    ).toBe(1)
    expect(
      readdirSync(join(directory, "backups")).filter((name) => name.startsWith("bots-v36-"))
    ).toHaveLength(1)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("upgrades a v21 non-null workflow usage ledger without releasing prior reservations", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-v21-budget-")),
    path = join(directory, "bots.sqlite")
  let store = new BotStore(path)
  try {
    const { conversationId } = store.createBot({ nonce: "owner", name: "Owner" })
    store.send({ nonce: "task", conversationId, text: "Keep reserved budget" })
    const parent = store.claim("migration", 60_000)!
    const workflow = BotWorkflowStore.open(store, parent.lease, "call", {
      script: 'export const meta={name:"Existing",description:"Existing"}; return "ok";',
      maxConcurrency: 1,
      defaultModelId: "test",
      agentProfiles: [],
      authority: {}
    })
    store.db.run("INSERT INTO bot_workflow_model_calls VALUES(?,?,?,?,?,NULL,?)", [
      "original-call",
      parent.run.id,
      workflow.id,
      parent.run.id,
      4096,
      1
    ])
    store.close()
    const old = new DatabaseSync(path)
    old.exec(`DROP INDEX bot_workflow_model_root;
      ALTER TABLE bot_workflow_model_calls RENAME TO fixture_new_ledger;
      CREATE TABLE bot_workflow_model_calls(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES bot_runs(id), workflow_id TEXT NOT NULL REFERENCES bot_workflows(id), root_run_id TEXT NOT NULL REFERENCES bot_runs(id), reserved INTEGER NOT NULL, consumed INTEGER, created_at INTEGER NOT NULL);
      INSERT INTO bot_workflow_model_calls SELECT * FROM fixture_new_ledger;
      DROP TABLE fixture_new_ledger; UPDATE bot_schema SET version=21;`)
    old.close()
    store = new BotStore(path)
    expect(store.db.exec("SELECT * FROM bot_workflow_model_calls")[0].values).toEqual([
      ["original-call", parent.run.id, workflow.id, parent.run.id, 4096, null, 1]
    ])
    store.db.run("INSERT INTO bot_workflow_model_calls VALUES(?,?,NULL,?,?,NULL,?)", [
      "new-parent-call",
      parent.run.id,
      parent.run.id,
      100,
      2
    ])
    store.close()
    store = new BotStore(path)
    expect(
      store.db.exec("SELECT SUM(COALESCE(consumed,reserved)) FROM bot_workflow_model_calls")[0]
        .values[0][0]
    ).toBe(4196)
    expect(
      readdirSync(join(directory, "backups")).filter((name) => name.startsWith("bots-v21-"))
    ).toHaveLength(1)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("upgrades v20 workflow children without rewriting durable task identities or checkpoints", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-v20-worktrees-")),
    path = join(directory, "bots.sqlite")
  let store = new BotStore(path)
  try {
    const { conversationId } = store.createBot({ nonce: "existing", name: "Existing" })
    store.send({ nonce: "task", conversationId, text: "Existing task" })
    const parent = store.claim("migration", 60_000)!
    const workflow = BotWorkflowStore.open(store, parent.lease, "call", {
      script:
        'export const meta = { name: "Migration", description: "Preserve state" }; return "ok"',
      maxConcurrency: 1,
      defaultModelId: "fixture",
      agentProfiles: [],
      authority: {}
    })
    const child = store.workflowChildren.claim(workflow, parent.lease, {
      prompt: "Existing child",
      label: "Existing child",
      phase: null,
      agentIndex: 1,
      toolStreamKey: `${"a".repeat(64)}_c1`,
      durableCallKey: `${"a".repeat(64)}_n1`
    })
    const original = store.getRun(child.run.id)
    const rows = store.db.exec("SELECT * FROM bot_workflow_children")
    store.close()
    const old = new DatabaseSync(path)
    old.exec(
      "DROP TABLE bot_worktree_actions; DROP TABLE bot_worktrees; DROP TABLE bot_worktree_sources; UPDATE bot_schema SET version=20"
    )
    old.close()
    store = new BotStore(path)
    expect(store.getRun(child.run.id)).toEqual(original)
    expect(store.db.exec("SELECT * FROM bot_workflow_children")).toEqual(rows)
    expect(store.db.exec("SELECT COUNT(*) FROM bot_worktrees")[0].values[0][0]).toBe(0)
    expect(store.db.exec("PRAGMA foreign_key_check").flatMap((result) => result.values)).toEqual([])
    expect(
      readdirSync(join(directory, "backups")).filter((name) => name.startsWith("bots-v20-"))
    ).toHaveLength(1)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("upgrades v16 and preserves published skill identities and run version fences across reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-v16-library-")),
    path = join(directory, "bots.sqlite")
  let store = new BotStore(path)
  const { bot, conversationId } = store.createBot({ nonce: "owner", name: "A" })
  const privateSkill = store.saveSkill({
    botId: bot.id,
    name: "Existing",
    instructions: "Keep original instructions",
    enabled: true
  })
  store.close()
  const previous = new DatabaseSync(path)
  previous.exec(
    "DROP TABLE bot_external_skills; DROP TABLE bot_run_skills; DROP TABLE bot_skill_library; UPDATE bot_schema SET version=16"
  )
  previous.close()
  store = new BotStore(path)
  try {
    expect(store.skills(bot.id)).toEqual([privateSkill])
    const input = {
      nonce: "publish",
      botId: bot.id,
      skillId: privateSkill.id,
      version: 1,
      libraryRevision: 0
    }
    const published = store.skillLibrary.publish(input)
    const runId = store.send({ nonce: "task", conversationId, text: "Read workflow" }).runIds[0]
    store.skillLibrary.readForRun(runId, published.id)
    store.close()
    store = new BotStore(path)
    expect(store.skillLibrary.publish(input)).toEqual(published)
    expect(() => store.skillLibrary.assertRun(runId)).not.toThrow()
    store.skillLibrary.withdraw({ nonce: "withdraw", id: published.id, revision: 1 })
    expect(() => store.skillLibrary.assertRun(runId)).toThrow("撤回")
    expect(
      readdirSync(join(directory, "backups")).filter((name) => name.startsWith("bots-v16-"))
    ).toHaveLength(1)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("upgrades an actual v17 database with the installed catalog absent without changing existing skills", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-v17-catalog-")),
    path = join(directory, "bots.sqlite")
  let store = new BotStore(path)
  const { bot } = store.createBot({ nonce: "existing", name: "Existing" })
  const skill = store.saveSkill({
    botId: bot.id,
    name: "Keep",
    instructions: "Keep steps",
    enabled: true
  })
  store.close()
  const old = new DatabaseSync(path)
  old.exec("DROP TABLE bot_external_skills; UPDATE bot_schema SET version=17")
  old.close()
  store = new BotStore(path)
  try {
    expect(store.skills(bot.id)).toEqual([skill])
    expect(store.externalSkills.status().ready).toBe(false)
    expect(store.db.exec("SELECT COUNT(*) FROM bot_external_skills")[0].values[0][0]).toBe(0)
    expect(
      readdirSync(join(directory, "backups")).filter((name) => name.startsWith("bots-v17-"))
    ).toHaveLength(1)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("upgrades the actual v9 group index and persists independent branch history/read state across reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-v9-upgrade-")),
    path = join(directory, "bots.sqlite")
  let store = new BotStore(path)
  const a = store.createBot({ nonce: "a", name: "A" }),
    b = store.createBot({ nonce: "b", name: "B" })
  const group = store.createGroup({
    nonce: "group",
    name: "Existing group",
    members: [a.bot.id, b.bot.id]
  })
  const root = store.send({
    nonce: "existing",
    conversationId: group.id,
    text: "Existing work",
    recipients: [a.bot.id]
  })
  store.close()
  const old = new DatabaseSync(path)
  old.exec(
    "DROP TABLE bot_thread_read_states; DROP TABLE bot_message_threads; DROP TABLE bot_threads; DROP INDEX bot_group_active; DROP INDEX bot_group_cycle_history; ALTER TABLE bot_group_cycles DROP COLUMN thread_root; CREATE UNIQUE INDEX bot_group_active ON bot_group_cycles(conversation_id) WHERE status='active'; UPDATE bot_schema SET version=9"
  )
  old.close()
  store = new BotStore(path)
  try {
    const sent = store.send({
      nonce: "branch",
      conversationId: group.id,
      threadRootId: root.messageId,
      text: "Separate discussion",
      recipients: [b.bot.id]
    })
    expect(store.getRun(root.runIds[0]).status).toBe("queued")
    expect(store.getRun(sent.runIds[0]).threadRootId).toBe(root.messageId)
    store.setReadState({
      conversationId: group.id,
      threadRootId: root.messageId,
      revision: 0,
      throughSequence: 0,
      unread: true
    })
    store.close()
    store = new BotStore(path)
    expect(store.messages(group.id)).toHaveLength(1)
    expect(store.threads.get({ conversationId: group.id, rootId: root.messageId })).toMatchObject({
      count: 1,
      readState: { manuallyUnread: true }
    })
    expect(store.getConversation(group.id).threadUnreadCount).toBe(1)
    expect(store.getRun(root.runIds[0]).status).toBe("queued")
    expect(store.getRun(sent.runIds[0]).status).toBe("queued")
    const backups = readdirSync(join(directory, "backups"))
    expect(backups).toHaveLength(1)
    const saved = new DatabaseSync(join(directory, "backups", backups[0]), { readOnly: true })
    try {
      expect(saved.prepare("SELECT version FROM bot_schema").get()?.version).toBe(9)
      expect(
        saved
          .prepare("PRAGMA table_info(bot_group_cycles)")
          .all()
          .some((column) => column.name === "thread_root")
      ).toBe(false)
    } finally {
      saved.close()
    }
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("backs up version 1 including WAL writes and preserves messages through the upgrade", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-upgrade-")),
    path = join(directory, "bots.sqlite")
  const initial = new BotStore(path)
  const { bot, conversationId } = initial.createBot({ nonce: "bot", name: "既有 Bot" })
  initial.close()
  const old = new DatabaseSync(path)
  let upgraded: BotStore | undefined
  try {
    old.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; DROP TABLE bot_personas; DROP TABLE bot_run_outputs; UPDATE bot_schema SET version=1"
    )
    old
      .prepare(
        "INSERT INTO bot_messages(id,conversation_id,sender,text,created_at) VALUES(?,?,'user',?,?)"
      )
      .run("pre-upgrade", conversationId, "升级前的工作", Date.now())
    upgraded = new BotStore(path)
    expect(upgraded.getBot(bot.id).name).toBe("既有 Bot")
    expect(upgraded.getBot(bot.id).avatarShape).toBeNull()
    expect(upgraded.messages(conversationId)[0].text).toBe("升级前的工作")
    const backups = readdirSync(join(directory, "backups"))
    expect(backups).toHaveLength(1)
    expect(backups[0]).toMatch(/^bots-v1-.*\.sqlite$/)
    const saved = new DatabaseSync(join(directory, "backups", backups[0]), { readOnly: true })
    try {
      expect(saved.prepare("SELECT version FROM bot_schema").get()?.version).toBe(1)
      expect(saved.prepare("SELECT text FROM bot_messages").get()?.text).toBe("升级前的工作")
    } finally {
      saved.close()
    }
    expect(old.prepare("SELECT version FROM bot_schema").get()?.version).toBe(BOT_SCHEMA_VERSION)
  } finally {
    old.close()
    upgraded?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("upgrades v6 while retaining messages and read state, then persists reactions across reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-v6-upgrade-")),
    path = join(directory, "bots.sqlite")
  const initial = new BotStore(path)
  const { conversationId } = initial.createBot({ nonce: "v6", name: "Bot" })
  const receipt = initial.send({ nonce: "v6-message", conversationId, text: "旧消息" })
  initial.close()
  const old = new DatabaseSync(path)
  old.exec("DROP TABLE bot_message_reactions; UPDATE bot_schema SET version=6")
  old.close()
  let upgraded = new BotStore(path)
  try {
    expect(upgraded.messages(conversationId)[0].reactionState).toMatchObject({
      revision: 0,
      reactions: []
    })
    upgraded.reactions.setUser({
      conversationId,
      messageId: receipt.messageId,
      revision: 0,
      active: true,
      emoji: "👍"
    })
    upgraded.close()
    upgraded = new BotStore(path)
    expect(upgraded.messages(conversationId)[0].reactionState).toMatchObject({
      revision: 1,
      reactions: [{ emoji: "👍", by: "me" }]
    })
    expect(readdirSync(join(directory, "backups"))).toHaveLength(1)
    expect(readdirSync(join(directory, "backups"))[0]).toMatch(/^bots-v6-/)
  } finally {
    upgraded.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("refuses future schemas without modifying their contents or journal mode", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-future-schema-")),
    path = join(directory, "bots.sqlite")
  const db = new DatabaseSync(path)
  db.exec("CREATE TABLE bot_schema(version INTEGER); INSERT INTO bot_schema VALUES(999)")
  db.close()
  try {
    const before = readFileSync(path)
    expect(() => new BotStore(path)).toThrow("不支持 Bot 数据版本 999")
    expect(readFileSync(path)).toEqual(before)
    expect(readdirSync(directory)).toEqual(["bots.sqlite"])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it("backs up v8 and preserves explicit recipients across reopen without inventing them for older messages", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-v8-upgrade-")),
    path = join(directory, "bots.sqlite")
  let store = new BotStore(path)
  const { bot, conversationId } = store.createBot({ nonce: "v8", name: "原名称" })
  store.send({ nonce: "old", conversationId, text: "原消息" })
  store.close()
  const old = new DatabaseSync(path)
  old.exec("DROP TABLE bot_message_recipients; UPDATE bot_schema SET version=8")
  old.close()
  store = new BotStore(path)
  try {
    expect(store.messages(conversationId)[0].recipientReferences).toEqual([])
    const sent = store.send({
      nonce: "selected",
      conversationId,
      text: "指定",
      recipients: [bot.id]
    })
    store.updateBot({ id: bot.id, revision: bot.revision, name: "后来改名" })
    store.close()
    store = new BotStore(path)
    expect(store.message({ conversationId, id: sent.messageId }).recipientReferences).toEqual([
      { botId: bot.id, name: "原名称" }
    ])
    const backups = readdirSync(join(directory, "backups"))
    expect(backups).toHaveLength(1)
    expect(backups[0]).toMatch(/^bots-v8-/)
    const saved = new DatabaseSync(join(directory, "backups", backups[0]), { readOnly: true })
    try {
      expect(saved.prepare("SELECT version FROM bot_schema").get()?.version).toBe(8)
      expect(saved.prepare("SELECT text FROM bot_messages").get()?.text).toBe("原消息")
    } finally {
      saved.close()
    }
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("upgrades v5 with preserved history and a durable independent read watermark", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-v5-upgrade-")),
    path = join(directory, "bots.sqlite")
  const initial = new BotStore(path)
  const created = initial.createBot({ nonce: "v5", name: "Inbox" })
  initial.send({ nonce: "old-message", conversationId: created.conversationId, text: "Work" })
  initial.finish(initial.claim("old-host")!.lease, "succeeded", "Result")
  initial.close()
  const old = new DatabaseSync(path)
  old.exec("DROP TABLE bot_read_states; UPDATE bot_schema SET version=5")
  old.close()
  const upgraded = new BotStore(path)
  try {
    const state = upgraded.getConversation(created.conversationId).readState!
    expect(state).toMatchObject({ revision: 0, unreadCount: 1, manuallyUnread: false })
    expect(
      upgraded.setReadState({
        conversationId: created.conversationId,
        revision: 0,
        throughSequence: state.latestSequence,
        unread: false
      }).unreadCount
    ).toBe(0)
    expect(readdirSync(join(directory, "backups"))[0]).toMatch(/^bots-v5-/)
    expect(upgraded.messages(created.conversationId)).toHaveLength(2)
  } finally {
    upgraded.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("upgrades version 3 without granting existing Bots access to desktop connectors", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-v3-upgrade-")),
    path = join(directory, "bots.sqlite")
  const initial = new BotStore(path)
  const { bot } = initial.createBot({ nonce: "v3", name: "Existing" })
  initial.close()
  const db = new DatabaseSync(path)
  db.exec("DROP TABLE bot_connector_grants; UPDATE bot_schema SET version=3")
  db.close()
  let upgraded: BotStore | undefined
  try {
    upgraded = new BotStore(path)
    expect(upgraded.getBot(bot.id).connectorIds).toEqual([])
    expect(readdirSync(join(directory, "backups"))[0]).toMatch(/^bots-v3-/)
    expect(
      upgraded.updateBot({ id: bot.id, revision: 1, connectorIds: ["approved"] }).connectorIds
    ).toEqual(["approved"])
  } finally {
    upgraded?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("upgrades version 4 with its existing groups and messages intact", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-v4-upgrade-")),
    path = join(directory, "bots.sqlite")
  const first = new BotStore(path)
  const a = first.createBot({ nonce: "a", name: "A" }),
    b = first.createBot({ nonce: "b", name: "B" })
  const group = first.createGroup({ nonce: "g", name: "既有群聊", members: [a.bot.id, b.bot.id] })
  first.close()
  const old = new DatabaseSync(path)
  old.exec(
    "DROP TABLE bot_group_runs; DROP TABLE bot_group_cycles; DROP TABLE bot_group_profiles; UPDATE bot_schema SET version=4"
  )
  old.close()
  const upgraded = new BotStore(path)
  try {
    expect(upgraded.getConversation(group.id)).toMatchObject({ name: "既有群聊", description: "" })
    expect(
      upgraded.send({ nonce: "send", conversationId: group.id, text: "@B 工作" }).runIds
    ).toHaveLength(1)
    expect(upgraded.claim("host")?.run.botId).toBe(b.bot.id)
    expect(readdirSync(join(directory, "backups"))[0]).toMatch(/^bots-v4-/)
  } finally {
    upgraded.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("upgrades v7 with a backup and persists exact skill references without altering older messages", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-v7-upgrade-")),
    path = join(directory, "bots.sqlite")
  let store = new BotStore(path)
  const { bot, conversationId } = store.createBot({ nonce: "v7", name: "Bot" })
  store.send({ nonce: "old-message", conversationId, text: "旧消息" })
  const skill = store.saveSkill({
    botId: bot.id,
    name: "流程",
    instructions: "检查",
    enabled: true
  })
  store.close()
  const old = new DatabaseSync(path)
  old.exec("DROP TABLE bot_message_skills; UPDATE bot_schema SET version=7")
  old.close()
  store = new BotStore(path)
  try {
    expect(store.messages(conversationId)[0].skillReferences).toEqual([])
    const selection = { botId: bot.id, id: skill.id, version: 1 }
    const sent = store.send({
      nonce: "new-message",
      conversationId,
      text: "运行",
      skills: [selection]
    })
    store.close()
    store = new BotStore(path)
    expect(store.skillReferences.forMessage(sent.messageId)).toEqual([
      { ...selection, name: "流程" }
    ])
    expect(readdirSync(join(directory, "backups"))).toHaveLength(1)
    expect(readdirSync(join(directory, "backups"))[0]).toMatch(/^bots-v7-/)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("upgrades v12 with a WAL-safe backup and preserves current-task instruction acceptance across reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-v12-upgrade-")),
    path = join(directory, "bots.sqlite")
  let store = new BotStore(path)
  const { conversationId } = store.createBot({ nonce: "bot", name: "A" })
  const sent = store.send({ nonce: "send", conversationId, text: "已有任务" })
  const { lease } = store.claim("host")!
  store.close()
  const previous = new DatabaseSync(path)
  previous.exec(
    "DROP TABLE bot_steering; DROP TABLE bot_run_drains; UPDATE bot_schema SET version=12"
  )
  previous.close()
  store = new BotStore(path)
  try {
    expect(store.getRun(sent.runIds[0]).status).toBe("running")
    expect(
      readdirSync(join(directory, "backups")).some((name) => name.startsWith("bots-v12-"))
    ).toBe(true)
    const extra = store.send({
      nonce: "extra",
      conversationId,
      text: "补充要求",
      steerRunId: sent.runIds[0]
    })
    await store.steering.queue(lease).take({
      threadId: lease.runId,
      ownerRunToken: `${lease.owner}:${lease.fence}`,
      appliedIds: [],
      phase: "beforeModel"
    })
    store.close()
    store = new BotStore(path)
    expect(store.steering.state(extra.messageId)?.state).toBe("accepted")
    expect(
      store.send({ nonce: "extra", conversationId, text: "补充要求", steerRunId: sent.runIds[0] })
    ).toEqual(extra)
    expect(store.messages(conversationId).map((message) => message.text)).toEqual([
      "已有任务",
      "补充要求"
    ])
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("upgrades v13 files without inventing provenance, then preserves deletion tombstones and historical references", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-v13-files-")),
    path = join(directory, "bots.sqlite")
  let store = new BotStore(path)
  const { conversationId } = store.createBot({ nonce: "bot", name: "File history" })
  const artifact = store.publishArtifact({
    id: "old-file",
    conversationId,
    runId: null,
    name: "old.txt",
    size: 3,
    mime: "text/plain",
    sha256: "a".repeat(64)
  })
  store.send({ nonce: "task", conversationId, text: "original", attachments: [artifact.id] })
  store.finish(store.claim("host")!.lease, "succeeded", "done")
  store.close()
  const old = new DatabaseSync(path)
  old.exec("DROP TABLE bot_artifact_lifecycle; UPDATE bot_schema SET version=13")
  old.close()
  store = new BotStore(path)
  try {
    expect(store.getArtifact(artifact.id).origin).toBeUndefined()
    expect(readdirSync(join(directory, "backups"))[0]).toMatch(/^bots-v13-/)
    const request = {
      nonce: "delete-old",
      conversationId,
      id: artifact.id,
      sha256: artifact.sha256
    }
    const deleted = store.deleteArtifact(request)
    store.close()
    store = new BotStore(path)
    expect(store.deleteArtifact(request)).toEqual(deleted)
    expect(store.artifacts(conversationId)).toEqual([])
    expect(store.messages(conversationId)[0].attachments).toEqual([artifact.id])
    expect(() => store.getArtifact(artifact.id)).toThrow("已删除")
    expect(() => store.publishArtifact(artifact)).toThrow("已删除")
    expect(store.artifactGarbage()).toEqual([artifact.sha256])
    store.artifactContentPurged(artifact.sha256)
    expect(store.artifactGarbage()).toEqual([])
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("upgrades v33 schedules without inventing standing human authorization", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-v33-routine-")),
    path = join(directory, "bots.sqlite")
  let store = new BotStore(path)
  try {
    const { bot } = store.createBot({ nonce: "owner", name: "Owner" })
    const routine = store.saveRoutine({
      botId: bot.id,
      name: "Original",
      prompt: "Original standing task",
      enabled: true,
      timezone: "UTC",
      schedule: { kind: "event", topic: "event" }
    })
    store.close()
    const old = new DatabaseSync(path)
    old.exec(
      "DROP TABLE bot_routine_run_authority; DROP TABLE bot_routine_authority; UPDATE bot_schema SET version=33"
    )
    old.close()
    store = new BotStore(path)
    expect(store.routine(bot.id, routine.id)).toEqual(routine)
    expect(store.db.exec("SELECT COUNT(*) FROM bot_routine_authority")[0].values[0][0]).toBe(0)
    const [legacy] = store.emitEvent({
      nonce: "old",
      topic: "event",
      payload: "Original event"
    }).runIds
    expect(store.autoReview.task(legacy)).toBeNull()
    store.saveRoutine({ ...routine, nonce: "confirm" }, { kind: "human" })
    const [current] = store.emitEvent({ nonce: "new", topic: "event", payload: "New event" }).runIds
    const standing = store.autoReview.task(current)
    expect(standing?.messages[0].text).toBe(routine.prompt)
    store.close()
    store = new BotStore(path)
    expect(store.autoReview.task(current)).toEqual(standing)
    expect(store.db.exec("PRAGMA foreign_key_check").flatMap((result) => result.values)).toEqual([])
    const backups = readdirSync(join(directory, "backups")).filter((name) =>
      name.startsWith("bots-v33-")
    )
    expect(backups).toHaveLength(1)
    const original = new DatabaseSync(join(directory, "backups", backups[0]), { readOnly: true })
    try {
      expect(original.prepare("SELECT version FROM bot_schema").get()?.version).toBe(33)
    } finally {
      original.close()
    }
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("upgrades v34 peers without inventing authority and retains new handoffs across reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-v34-peer-")),
    path = join(directory, "bots.sqlite")
  let store = new BotStore(path)
  try {
    const a = store.createBot({ nonce: "a", name: "Planner" }),
      b = store.createBot({ nonce: "b", name: "Inspector" })
    for (const bot of [a.bot, b.bot])
      store.autoReview.change({
        ...store.autoReview.read(bot.id),
        isEnabled: true,
        nonce: `enable-${bot.id}`
      })
    store.send({
      nonce: "task",
      conversationId: a.conversationId,
      text: "Original project assignment"
    })
    const parent = store.claim("migration", 60000)!
    const legacy = store.sendPeer(parent.lease, {
      nonce: "legacy",
      recipient: b.bot.id,
      text: "Inspect legacy"
    }).runIds[0]
    const originalRun = store.getRun(legacy)
    store.close()
    const old = new DatabaseSync(path)
    old.exec("DROP TABLE bot_peer_authority; UPDATE bot_schema SET version=34")
    old.close()
    store = new BotStore(path)
    expect(store.getRun(legacy)).toEqual(originalRun)
    expect(store.autoReview.task(legacy)).toBeNull()
    const next = store.sendPeer(parent.lease, {
      nonce: "current",
      recipient: b.bot.id,
      text: "Inspect current"
    }).runIds[0]
    const task = store.autoReview.task(next)
    expect(task?.messages[0].text).toBe("Original project assignment")
    store.finish(parent.lease, "succeeded", "Assigned")
    store.close()
    store = new BotStore(path)
    expect(store.autoReview.task(next)).toEqual(task)
    expect(store.autoReview.task(legacy)).toBeNull()
    expect(store.db.exec("PRAGMA foreign_key_check").flatMap((result) => result.values)).toEqual([])
    const backups = readdirSync(join(directory, "backups")).filter((name) =>
      name.startsWith("bots-v34-")
    )
    expect(backups).toHaveLength(1)
    const backup = new DatabaseSync(join(directory, "backups", backups[0]), { readOnly: true })
    try {
      expect(backup.prepare("SELECT version FROM bot_schema").get()?.version).toBe(34)
    } finally {
      backup.close()
    }
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("upgrades v35 without inventing completed project initialization", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-v35-setup-")),
    path = join(directory, "bots.sqlite")
  let store = new BotStore(path)
  try {
    const { bot } = store.createBot({
      nonce: "existing",
      name: "Existing",
      workspacePath: directory
    })
    store.close()
    const old = new DatabaseSync(path)
    old.exec("DROP TABLE bot_workspace_setup; UPDATE bot_schema SET version=35")
    old.close()
    store = new BotStore(path)
    expect(store.getBot(bot.id)).toEqual(bot)
    expect(store.db.exec("SELECT COUNT(*) FROM bot_workspace_setup")[0].values[0][0]).toBe(0)
    expect(
      readdirSync(join(directory, "backups")).filter((name) => name.startsWith("bots-v35-"))
    ).toHaveLength(1)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("upgrades a v37 pending approval without granting or losing either notification gate", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-v37-hook-notification-"))
  const path = join(directory, "bots.sqlite")
  let store = new BotStore(path)
  try {
    const { conversationId } = store.createBot({ nonce: "bot", name: "Bot" })
    store.send({ nonce: "task", conversationId, text: "work" })
    const { lease } = store.claim("host", 300_000)!
    const action = { operation: "write" }
    const original = store.requestInteraction(lease, { kind: "approval", prompt: "write", action })
    store.close()
    const old = new DatabaseSync(path)
    try {
      old.exec(`PRAGMA foreign_keys=OFF;
        DROP INDEX bot_one_pending_notification_approval;
        DROP INDEX bot_one_pending_interaction;
        ALTER TABLE bot_interactions DROP COLUMN notification_stage;
        DROP TABLE bot_hook_notifications;
        CREATE UNIQUE INDEX bot_one_pending_interaction ON bot_interactions(run_id) WHERE status='pending';
        UPDATE bot_schema SET version=37;`)
    } finally {
      old.close()
    }
    store = new BotStore(path)
    expect(store.getInteraction(original.id)).toEqual(original)
    expect(store.getRun(lease.runId).status).toBe("waiting_input")
    await store.hookNotifications.run(
      lease,
      {
        key: "write:1",
        interactionId: original.id,
        action
      },
      async (invocation) => {
        const hook = { hook: { event: "Notification", invocation } }
        store.hookNotifications.registerAction(lease, "hook:notify", hook)
        const secondary = store.requestInteraction(lease, {
          kind: "approval",
          prompt: "notify",
          action: hook
        })
        expect(secondary.id).not.toBe(original.id)
        expect(store.getInteraction(original.id).status).toBe("pending")
      }
    )
    expect(store.getInteraction(original.id).status).toBe("pending")
    expect(
      readdirSync(join(directory, "backups")).some((name) => name.startsWith("bots-v37-"))
    ).toBe(true)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
