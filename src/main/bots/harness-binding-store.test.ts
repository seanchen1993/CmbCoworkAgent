import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { BotHarnessBinding } from "../../shared/bot-harness-context"
import type { HarnessRequestUserInputConfig } from "../../shared/harness-board-types"
import { botHarnessSkillScopeSchema, parseBotHarnessRunContext } from "./harness-context-contract"
import { BOT_SCHEMA_VERSION } from "./schema"
import { BotStore } from "./store"

const stores = new Set<BotStore>()
const directories: string[] = []
let now = 1_800_000_000_000
const automaticPolicy: HarnessRequestUserInputConfig = {
  allowAutoResolution: true,
  defaultTimeoutMs: 30_000,
  autoResolutionType: "select_first"
}
const binding: BotHarnessBinding = {
  projectId: "project-a",
  featureSlug: "feature-a",
  instructionWorkspacePaths: ["/workspace/project"],
  requestUserInputConfig: automaticPolicy
}
const nextBinding: BotHarnessBinding = { ...binding, featureSlug: "feature-b" }
const fences = ["projects.json", "features.json", "bindings.json", "config.json", "AGENTS.md"].map(
  (name) => ({
    path: `/harness-source/${name}`,
    stamp: null,
    sha256: null
  })
)
const rootIdentities = [
  { path: "/workspace/project", declaredPath: "/workspace/project", device: "1", inode: "101" },
  { path: "/plugins/harness", declaredPath: "/plugins/harness", device: "1", inode: "102" }
]
const questionInput = {
  questions: [
    {
      id: "strategy",
      header: "Strategy",
      question: "Which strategy should be used?",
      options: [
        { label: "Incremental", description: "Keep the current design." },
        { label: "Rewrite", description: "Replace the design." }
      ]
    }
  ]
}
const questionPrompt = JSON.stringify({ botQuestions: { version: 1, input: questionInput } })
const manualAnswer = JSON.stringify({
  status: "submitted",
  answers: { strategy: { type: "option", questionId: "strategy", optionIndex: 1 } }
})

function open(path = ":memory:", clock = () => now): BotStore {
  const store = new BotStore(path, clock)
  stores.add(store)
  return store
}
function close(store: BotStore): void {
  store.close()
  stores.delete(store)
}
function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "bot-harness-store-"))
  directories.push(directory)
  return join(directory, "bots.sqlite")
}
function task(store: BotStore) {
  const created = store.createBot({
    nonce: "create",
    name: "Project assistant",
    workspacePath: "/workspace/project",
    harnessBinding: binding
  })
  store.send({
    nonce: "message",
    conversationId: created.conversationId,
    text: "Review the project."
  })
  return { ...created, ...store.claim("host-a", 300_000)! }
}
function freezeContext(store: BotStore, runId: string, policy = automaticPolicy) {
  const context = parseBotHarnessRunContext({
    version: 1,
    bindingDigest: "a".repeat(64),
    binding: { ...binding, requestUserInputConfig: policy },
    context: {
      pluginRoot: "/plugins/harness",
      pluginWorkspace: "/workspace/project",
      pluginId: "harness-plugin",
      pluginName: "Harness plugin",
      featureId: binding.featureSlug,
      harnessProjectId: binding.projectId,
      agentConfig: { toolConfig: { requestUserInput: policy } }
    },
    instructionPrompt: "Follow the project instructions.",
    catalog: {
      sources: { root: "/harness-source" },
      projectionDigest: "b".repeat(64),
      files: fences.slice(0, 4)
    },
    fences,
    rootIdentities
  })
  store.db.run("INSERT INTO bot_harness_run_contexts VALUES(?,?)", [runId, JSON.stringify(context)])
  return context
}
function saveSkillScope(store: BotStore, botId: string): string {
  const scope = botHarnessSkillScopeSchema.parse({
    binding,
    workspacePath: "/workspace/project",
    sourceRoot: "/harness-source",
    pluginId: "harness-plugin",
    pluginName: "Harness plugin",
    catalog: {
      sources: { root: "/harness-source" },
      projectionDigest: "b".repeat(64),
      files: fences.slice(0, 4)
    },
    fences,
    rootIdentities
  })
  const serialized = JSON.stringify(scope)
  store.db.run("INSERT INTO bot_harness_skill_scopes VALUES(?,?)", [botId, serialized])
  return serialized
}
function skillScope(store: BotStore, botId: string) {
  return store.db.exec("SELECT scope FROM bot_harness_skill_scopes WHERE bot_id=?", [botId])[0]
    ?.values[0]?.[0]
}
function deadline(prompt: string): number {
  return JSON.parse(prompt).harnessAutoResolution.deadline
}

afterEach(() => {
  for (const store of stores) store.close()
  stores.clear()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  now = 1_800_000_000_000
})

describe("durable Bot Harness bindings", () => {
  it("includes normalized project binding in create receipts and persisted Bot projections", () => {
    const store = open()
    const input = {
      nonce: "bound-create",
      name: "Project assistant",
      harnessBinding: {
        ...binding,
        projectId: " project-a ",
        instructionWorkspacePaths: ["/workspace/project", "/workspace/project"]
      }
    }
    const created = store.createBot(input)
    const eventCount = store.events(0).length
    expect(created.bot.harnessBinding).toEqual(binding)
    expect(store.createBot(input)).toEqual(created)
    expect(store.events(0)).toHaveLength(eventCount)
    expect(() => store.createBot({ ...input, harnessBinding: nextBinding })).toThrow("同一请求标识")
    expect(store.listBots()).toHaveLength(1)
    expect(store.snapshot().bots[0].harnessBinding).toEqual(binding)
  })

  it("replays a binding update without overwriting a newer binding, including after restart", () => {
    const path = databasePath()
    let store = open(path)
    const { bot } = store.createBot({
      nonce: "create",
      name: "Project assistant",
      harnessBinding: binding
    })
    const input = {
      id: bot.id,
      revision: bot.revision,
      nonce: "bind-next",
      harnessBinding: nextBinding
    }
    const saved = store.updateBot(input)
    const newer = store.updateBot({
      id: bot.id,
      revision: saved.revision,
      harnessBinding: { ...nextBinding, featureSlug: "feature-c" }
    })
    const eventCount = store.events(0).length
    close(store)
    store = open(path)
    expect(store.getBot(bot.id)).toEqual(newer)
    expect(store.updateBot(input)).toEqual(saved)
    expect(store.getBot(bot.id)).toEqual(newer)
    expect(store.events(0)).toHaveLength(eventCount)
    expect(() => store.updateBot({ ...input, harnessBinding: binding })).toThrow("同一请求标识")
  })

  it("preserves scopes for appearance edits and clears them when the binding is explicitly removed", () => {
    const store = open()
    const { bot } = store.createBot({
      nonce: "create",
      name: "Project assistant",
      harnessBinding: binding
    })
    const savedScope = saveSkillScope(store, bot.id)
    const renamed = store.updateBot({
      id: bot.id,
      revision: bot.revision,
      name: "Renamed assistant"
    })
    expect(renamed.harnessBinding).toEqual(binding)
    expect(skillScope(store, bot.id)).toBe(savedScope)
    const detached = store.updateBot({
      id: bot.id,
      revision: renamed.revision,
      nonce: "detach",
      harnessBinding: null
    })
    expect(detached.harnessBinding).toBeNull()
    expect(skillScope(store, bot.id)).toBeUndefined()
    expect(
      store.db.exec("SELECT binding FROM bot_harness_bindings WHERE bot_id=?", [bot.id])[0].values
    ).toEqual([])
  })

  it("clears previous skill scope when changing the project feature or workspace", () => {
    const store = open()
    const { bot } = store.createBot({
      nonce: "create",
      name: "Project assistant",
      harnessBinding: binding,
      workspacePath: "/workspace/project"
    })
    saveSkillScope(store, bot.id)
    const rebound = store.updateBot({
      id: bot.id,
      revision: bot.revision,
      harnessBinding: nextBinding
    })
    expect(skillScope(store, bot.id)).toBeUndefined()
    saveSkillScope(store, bot.id)
    const moved = store.updateBot({
      id: bot.id,
      revision: rebound.revision,
      workspacePath: "/workspace/next"
    })
    expect(moved.harnessBinding).toEqual(nextBinding)
    expect(skillScope(store, bot.id)).toBeUndefined()
  })

  it("rejects binding changes during running, waiting and cancelling work without consuming the update nonce", () => {
    const store = open()
    const { bot, run, lease } = task(store)
    const input = {
      id: bot.id,
      revision: bot.revision,
      nonce: "detach-after-work",
      harnessBinding: null
    }
    const savedScope = saveSkillScope(store, bot.id)
    expect(() => store.updateBot(input)).toThrow("请先停止")
    const question = store.requestInteraction(lease, { kind: "question", prompt: questionPrompt })
    expect(store.getRun(run.id).status).toBe("waiting_input")
    expect(() => store.updateBot(input)).toThrow("请先停止")
    store.cancel(run.id)
    expect(store.getRun(run.id).status).toBe("cancelling")
    expect(() => store.updateBot(input)).toThrow("请先停止")
    expect(store.getBot(bot.id)).toEqual(bot)
    expect(skillScope(store, bot.id)).toBe(savedScope)
    expect(store.getInteraction(question.id).status).toBe("cancelled")
    store.finish(lease, "cancelled", "Stopped.")
    expect(store.updateBot(input).harnessBinding).toBeNull()
    expect(skillScope(store, bot.id)).toBeUndefined()
  })

  it("clones the binding with a replayable identity while rebuilding skill grants for the new Bot", () => {
    const store = open()
    const { bot } = store.createBot({
      nonce: "create",
      name: "Project assistant",
      harnessBinding: binding
    })
    saveSkillScope(store, bot.id)
    const input = { id: bot.id, revision: bot.revision, nonce: "clone-project" }
    const cloned = store.cloneBot(input)
    expect(cloned.bot.id).not.toBe(bot.id)
    expect(cloned.bot.harnessBinding).toEqual(binding)
    expect(skillScope(store, cloned.bot.id)).toBeUndefined()
    store.updateBot({ id: bot.id, revision: bot.revision, harnessBinding: null })
    const eventCount = store.events(0).length
    expect(store.cloneBot(input)).toEqual(cloned)
    expect(store.getBot(cloned.bot.id).harnessBinding).toEqual(binding)
    expect(store.events(0)).toHaveLength(eventCount)
    expect(() => store.cloneBot({ ...input, revision: bot.revision + 1 })).toThrow("同一请求标识")
    expect(store.listBots()).toHaveLength(2)
  })
})

describe("Harness v47 database upgrade", () => {
  it("adds the v48 binding/visibility side tables and backs up original messages without rewriting them", () => {
    const path = databasePath()
    let store = open(path)
    const { bot, conversationId } = store.createBot({
      nonce: "existing",
      name: "Existing assistant"
    })
    store.send({ nonce: "message", conversationId, text: "Existing project work." })
    const before = store.snapshot()
    const messages = store.messages(conversationId)
    close(store)
    const tables = [
      "bot_harness_bindings",
      "bot_harness_run_contexts",
      "bot_harness_skill_scopes",
      "bot_external_skill_visibility"
    ]
    const old = new DatabaseSync(path)
    try {
      for (const table of tables) old.exec(`DROP TABLE ${table}`)
      old.exec("UPDATE bot_schema SET version=47")
    } finally {
      old.close()
    }
    store = open(path)
    expect(store.snapshot()).toEqual(before)
    expect(store.messages(conversationId)).toEqual(messages)
    expect(store.getBot(bot.id).harnessBinding).toBeNull()
    expect(store.db.exec("SELECT version FROM bot_schema")[0].values[0][0]).toBe(BOT_SCHEMA_VERSION)
    for (const table of tables)
      expect(store.db.exec(`SELECT COUNT(*) FROM ${table}`)[0].values[0][0]).toBe(0)
    const backupDirectory = join(path, "..", "backups")
    const backups = readdirSync(backupDirectory).filter((name) => name.startsWith("bots-v47-"))
    expect(backups).toHaveLength(1)
    const backup = new DatabaseSync(join(backupDirectory, backups[0]), { readOnly: true })
    try {
      expect(backup.prepare("SELECT version FROM bot_schema").get()?.version).toBe(47)
      expect(
        backup.prepare("SELECT text FROM bot_messages WHERE conversation_id=?").get(conversationId)
          ?.text
      ).toBe("Existing project work.")
      for (const table of tables)
        expect(
          backup.prepare("SELECT name FROM sqlite_master WHERE name=?").get(table)
        ).toBeUndefined()
    } finally {
      backup.close()
    }
    close(store)
    store = open(path)
    expect(store.messages(conversationId)).toEqual(messages)
    expect(readdirSync(backupDirectory).filter((name) => name.startsWith("bots-v47-"))).toEqual(
      backups
    )
  })
})

describe("durable Harness automatic question resolution", () => {
  it("atomically stamps the minimum timeout despite a clock advancing on every read", () => {
    const store = open(":memory:", () => ++now)
    const { lease, conversationId } = task(store)
    freezeContext(store, lease.runId)
    const question = store.requestInteraction(lease, {
      kind: "question",
      prompt: questionPrompt,
      questionAutoResolutionMs: 30_000
    })
    const due = deadline(question.prompt)
    expect(due).toBe(question.createdAt + 30_000)
    now = due - 20
    expect(store.autoResolveHarnessQuestion(lease, question.id).status).toBe("pending")
    now = due
    const resolved = store.autoResolveHarnessQuestion(lease, question.id)
    expect(resolved.status).toBe("answered")
    expect(JSON.parse(resolved.answer!)).toMatchObject({
      status: "auto_resolved",
      source: "project_policy",
      answers: { strategy: { optionIndex: 0 } }
    })
    expect(store.getRun(lease.runId).status).toBe("running")
    const messages = store
      .messages(conversationId)
      .filter((message) => message.runId === lease.runId)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      sender: "system",
      text: "问题等待超时，已按项目配置自动处理。此处理不授予操作权限。"
    })
    const eventCount = store.events(0).length
    expect(store.autoResolveHarnessQuestion(lease, question.id)).toEqual(resolved)
    expect(store.events(0)).toHaveLength(eventCount)
    expect(
      store.messages(conversationId).filter((message) => message.runId === lease.runId)
    ).toEqual(messages)
    expect(() =>
      store.beginEffect(lease, {
        id: "unauthorized-effect",
        action: { kind: "write" },
        approvalId: question.id
      })
    ).toThrow("未经有效批准")
  })

  it.each(["missing", "disabled"] as const)(
    "rejects automatic deadlines when frozen run policy is %s",
    (mode) => {
      const store = open()
      const { lease } = task(store)
      if (mode === "disabled")
        freezeContext(store, lease.runId, {
          allowAutoResolution: false,
          autoResolutionType: "select_first"
        })
      expect(() =>
        store.requestInteraction(lease, {
          kind: "question",
          prompt: questionPrompt,
          questionAutoResolutionMs: 30_000
        })
      ).toThrow("项目未授权")
      expect(store.getRun(lease.runId).status).toBe("running")
      expect(store.db.exec("SELECT COUNT(*) FROM bot_interactions")[0].values[0][0]).toBe(0)
      const prompt = JSON.stringify({
        ...JSON.parse(questionPrompt),
        harnessAutoResolution: { deadline: now + 30_000 }
      })
      const question = store.requestInteraction(lease, { kind: "question", prompt })
      now += 30_000
      expect(store.autoResolveHarnessQuestion(lease, question.id).status).toBe("pending")
    }
  )

  it("rejects timed approval cards and unstructured questions and never automatically approves an action", () => {
    const store = open()
    const { lease } = task(store)
    freezeContext(store, lease.runId)
    const action = { kind: "external-write", target: "project" }
    expect(() =>
      store.requestInteraction(lease, {
        kind: "approval",
        prompt: questionPrompt,
        action,
        questionAutoResolutionMs: 30_000
      })
    ).toThrow("仅适用于结构化问题")
    expect(() =>
      store.requestInteraction(lease, {
        kind: "question",
        prompt: "Proceed?",
        questionAutoResolutionMs: 30_000
      })
    ).toThrow("仅适用于结构化问题")
    expect(() =>
      store.requestInteraction(lease, {
        kind: "question",
        prompt: questionPrompt,
        questionAutoResolutionMs: 30_000,
        expiresInMs: 30_000
      })
    ).toThrow("等待时间超过有效期")
    const approval = store.requestInteraction(lease, {
      kind: "approval",
      prompt: questionPrompt,
      action
    })
    now += 30_000
    expect(store.autoResolveHarnessQuestion(lease, approval.id)).toEqual(approval)
    expect(() =>
      store.beginEffect(lease, { id: "external-write", action, approvalId: approval.id })
    ).toThrow()
    expect(store.getInteraction(approval.id).answer).toBeNull()
  })

  it("lets an explicit manual answer win before the host attempts timeout resolution", () => {
    const store = open()
    const { lease, conversationId } = task(store)
    freezeContext(store, lease.runId)
    const question = store.requestInteraction(lease, {
      kind: "question",
      prompt: questionPrompt,
      questionAutoResolutionMs: 30_000
    })
    now = deadline(question.prompt)
    const answered = store.answerInteraction({
      id: question.id,
      revision: question.revision,
      answer: manualAnswer
    })
    expect(store.autoResolveHarnessQuestion(lease, question.id)).toEqual(answered)
    expect(JSON.parse(answered.answer!)).toMatchObject({
      status: "submitted",
      answers: { strategy: { optionIndex: 1, label: "Rewrite" } }
    })
    const messages = store
      .messages(conversationId)
      .filter((message) => message.runId === lease.runId)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ sender: "user" })
    expect(messages[0].text).toContain("Rewrite")
    expect(
      store
        .events(0)
        .filter((event) => event.kind === "interaction.answered" && event.entityId === question.id)
    ).toHaveLength(1)
  })

  it("retains the frozen context and original question deadline across reopening", () => {
    const path = databasePath()
    let store = open(path)
    const { lease } = task(store)
    const context = freezeContext(store, lease.runId)
    const question = store.requestInteraction(lease, {
      kind: "question",
      prompt: questionPrompt,
      questionAutoResolutionMs: 30_000
    })
    const due = deadline(question.prompt)
    close(store)
    now = due - 1
    store = open(path)
    expect(store.getInteraction(question.id)).toEqual(question)
    expect(
      JSON.parse(
        String(
          store.db.exec("SELECT context FROM bot_harness_run_contexts WHERE run_id=?", [
            lease.runId
          ])[0].values[0][0]
        )
      )
    ).toEqual(context)
    expect(store.autoResolveHarnessQuestion(lease, question.id).status).toBe("pending")
    now = due
    expect(store.autoResolveHarnessQuestion(lease, question.id).status).toBe("answered")
    expect(deadline(store.getInteraction(question.id).prompt)).toBe(due)
  })
})
