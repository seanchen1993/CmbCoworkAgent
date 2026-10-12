import { afterEach, expect, it } from "vitest"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { BotStore } from "./store"
import { BOT_SCHEMA_VERSION } from "./schema"
import { fenceBotCheckpointDatabase } from "./checkpoint-data"
import { BotDeletionLedger } from "./deletion-ledger"
import { botAutoReviewer } from "./auto-review"

const cleanups: (() => void)[] = []
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close())
)
const action = {
  shell: {
    command: "npm test",
    definition: {
      kind: "package_script",
      path: "package.json",
      sha256: "c".repeat(64),
      definition: "node test.cjs"
    },
    cwd: "C:/projects/payments",
    timeoutSeconds: 60,
    sandbox: "unelevated"
  }
}
const scope = "a".repeat(64)
function fixture(path = ":memory:") {
  let now = Date.now()
  const store = new BotStore(path, () => now)
  cleanups.push(() => store.close())
  const created = store.createBot({ nonce: "create", name: "研发助手" })
  store.send({ nonce: "send", conversationId: created.conversationId, text: "运行测试" })
  const { lease, run } = store.claim("host")!
  const ask = (value: unknown = action, ruleScope: string | undefined = scope) =>
    store.requestInteraction(lease, {
      kind: "approval",
      prompt: JSON.stringify(value),
      action: value,
      ruleScope
    })
  const remember = (answer = "approve") => {
    const approval = ask()
    const input = {
      id: approval.id,
      revision: approval.revision,
      answer,
      remember: true
    }
    const result = store.answerInteraction(input)
    expect(store.answerInteraction(input)).toEqual(result)
    return result
  }
  return {
    store,
    ...created,
    run,
    lease,
    ask,
    remember,
    advance: () => {
      now += 3600_001
    }
  }
}

it("stores a narrow rule atomically, records automatic approval and still consumes each approval once", () => {
  const f = fixture()
  expect(f.remember().review).toMatchObject({ remembered: true, source: "user" })
  const rules = f.store.approvalRules.read(f.bot.id)
  expect(rules.rules).toHaveLength(1)
  expect(rules.rules[0].prompt).toContain("npm test")
  const approval = f.ask()
  expect(approval).toMatchObject({
    status: "answered",
    answer: "approve",
    review: { source: "rule" }
  })
  expect(f.store.getRun(f.run.id).status).toBe("running")
  f.store.beginEffect(f.lease, { id: "effect", action, approvalId: approval.id })
  expect(() =>
    f.store.beginEffect(f.lease, { id: "duplicate", action, approvalId: approval.id })
  ).toThrow("已有执行记录")
  expect(
    f.store
      .runHistory({ conversationId: f.conversationId, runId: f.run.id })
      .items.map((i) => i.label)
  ).toContain("按已保存规则批准")
})

it.each(["command", "cwd", "timeout", "sandbox", "scope", "other-bot"])(
  "does not widen a saved rule (%s)",
  (mode) => {
    const f = fixture()
    f.remember()
    const next = structuredClone(action)
    if (mode === "command") next.shell.command += " -- --update"
    if (mode === "cwd") next.shell.cwd += "/other"
    if (mode === "timeout") next.shell.timeoutSeconds++
    if (mode === "sandbox") next.shell.sandbox = "none"
    if (mode === "other-bot") {
      const other = f.store.createBot({ nonce: "other", name: "另一助手" })
      f.store.send({ nonce: "other-task", conversationId: other.conversationId, text: "运行测试" })
      const { lease } = f.store.claim("other-host")!
      expect(
        f.store.requestInteraction(lease, {
          kind: "approval",
          prompt: JSON.stringify(action),
          action,
          ruleScope: scope
        }).status
      ).toBe("pending")
    } else expect(f.ask(next, mode === "scope" ? "b".repeat(64) : scope).status).toBe("pending")
  }
)

it("ask-first and deletion revoke queued automatic approvals; rule edits are versioned and retryable", () => {
  const f = fixture()
  f.remember()
  const automatic = f.ask()
  const rules = f.store.approvalRules.read(f.bot.id)
  const change = {
    botId: f.bot.id,
    ruleId: rules.rules[0].id,
    revision: rules.revision,
    dataEpoch: rules.dataEpoch,
    nonce: "ask-first",
    behavior: "ask" as const
  }
  const updated = f.store.approvalRules.change(change)
  expect(f.store.approvalRules.change(change)).toEqual(updated)
  expect(() =>
    f.store.beginEffect(f.lease, { id: "stale", action, approvalId: automatic.id })
  ).toThrow("自动批准失效")
  const manual = f.ask()
  expect(manual).toMatchObject({ status: "pending", review: { canRemember: false } })
  expect(() =>
    f.store.answerInteraction({
      id: manual.id,
      revision: manual.revision,
      answer: "approve",
      remember: true
    })
  ).toThrow("不能保存")
  f.store.answerInteraction({ id: manual.id, revision: manual.revision, answer: "approve" })
  expect(() => f.store.approvalRules.change({ ...change, nonce: "stale-edit" })).toThrow("已变化")
  expect(() =>
    f.store.approvalRules.change({
      ...change,
      nonce: "wrong-epoch",
      dataEpoch: "restored",
      revision: updated.revision
    })
  ).toThrow("已恢复")
  f.store.approvalRules.change({
    ...change,
    nonce: "delete",
    behavior: null,
    revision: updated.revision
  })
  expect(f.store.approvalRules.read(f.bot.id).rules).toEqual([])
  expect(f.ask().status).toBe("pending")
})

it.each([
  { secretRequest: { token: "secret" } },
  { connector: { arguments: { text: "external write" } } },
  { shell: { ...action.shell, command: "npm test && npm publish" } },
  { shell: { ...action.shell, command: "node arbitrary.cjs" } },
  { shell: { ...action.shell, background: true } }
])("keeps ineligible operations manual and rejects forged remember requests", (value) => {
  const f = fixture()
  const request = f.ask(value)
  expect(request.review).toBeUndefined()
  expect(() =>
    f.store.answerInteraction({
      id: request.id,
      revision: request.revision,
      answer: "approve",
      remember: true
    })
  ).toThrow("不能保存")
  expect(f.store.getInteraction(request.id).status).toBe("pending")
  expect(f.store.approvalRules.read(f.bot.id).rules).toEqual([])
})

it.each(["NPM.CMD test", ".\\gradlew.bat test", "build.cmd", "& '.\\check.ps1'"])(
  "requires a definition for Windows launchers and scripts before saving a rule (%s)",
  (command) => {
    const f = fixture()
    const request = f.ask({
      shell: {
        command,
        cwd: action.shell.cwd,
        timeoutSeconds: 60,
        sandbox: "unelevated"
      }
    })
    expect(request.review).toBeUndefined()
    expect(() =>
      f.store.answerInteraction({
        id: request.id,
        revision: request.revision,
        answer: "approve",
        remember: true
      })
    ).toThrow("不能保存")
  }
)

it("does not persist a rule after expiry, cancellation or missing host scope", () => {
  for (const mode of ["expired", "cancelled", "scope"] as const) {
    const f = fixture()
    const request =
      mode === "scope"
        ? f.store.requestInteraction(f.lease, {
            kind: "approval",
            prompt: JSON.stringify(action),
            action
          })
        : f.ask()
    if (mode === "expired") f.advance()
    if (mode === "cancelled") f.store.cancel(f.run.id)
    expect(() =>
      f.store.answerInteraction({
        id: request.id,
        revision: request.revision,
        answer: "approve",
        remember: true
      })
    ).toThrow()
    expect(f.store.approvalRules.read(f.bot.id).rules).toEqual([])
  }
})

it("remembers never atomically, rejects the exact action without waiting and cannot dispatch it", () => {
  const f = fixture()
  expect(f.remember("reject")).toMatchObject({
    answer: "reject",
    review: { remembered: true, source: "user" }
  })
  const rules = f.store.approvalRules.read(f.bot.id)
  expect(rules.rules).toHaveLength(1)
  expect(rules.rules[0].behavior).toBe("deny")
  const denied = f.ask()
  expect(denied).toMatchObject({ status: "answered", answer: "reject", review: { source: "rule" } })
  expect(f.store.getRun(f.run.id).status).toBe("running")
  expect(() =>
    f.store.beginEffect(f.lease, { id: "denied-effect", action, approvalId: denied.id })
  ).toThrow()
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_effects")[0].values[0][0]).toBe(0)
  expect(
    f.store
      .runHistory({ conversationId: f.conversationId, runId: f.run.id })
      .items.map((i) => i.label)
  ).toContain("按已保存规则拒绝")
  expect(f.ask({ shell: { ...action.shell, command: "npm test -- --update" } }).status).toBe(
    "pending"
  )
})

it("a one-time rejection does not create a never rule", () => {
  const f = fixture(),
    request = f.ask()
  f.store.answerInteraction({ id: request.id, revision: request.revision, answer: "reject" })
  expect(f.store.approvalRules.read(f.bot.id).rules).toEqual([])
  expect(f.ask().status).toBe("pending")
})

it("never takes precedence over independent review, including a proposed allow decision", () => {
  const f = fixture()
  f.remember("reject")
  const settings = f.store.autoReview.change({
    ...f.store.autoReview.read(f.bot.id),
    isEnabled: true,
    nonce: "review-on"
  })
  const proposed = f.store.autoReview.stamp(f.lease, action, settings, {
    decision: "allow",
    reason: "fixture allow",
    model: "fixture"
  })
  const result = f.store.requestInteraction(f.lease, {
    kind: "approval",
    prompt: JSON.stringify(action),
    action,
    ruleScope: scope,
    autoReview: proposed
  })
  expect(result).toMatchObject({ answer: "reject", status: "answered", review: { source: "rule" } })
  expect(result.autoReview).toBeUndefined()
  expect(() =>
    f.store.beginEffect(f.lease, { id: "never-reviewed", action, approvalId: result.id })
  ).toThrow()
})

it("returns a local refusal before model resolution when the independent reviewer sees never", async () => {
  const f = fixture()
  f.remember("reject")
  f.store.autoReview.change({
    ...f.store.autoReview.read(f.bot.id),
    isEnabled: true,
    nonce: "review-on"
  })
  const reviewer = botAutoReviewer({
    request: {
      run: f.run,
      bot: f.bot,
      store: f.store,
      lease: f.lease,
      messages: [],
      signal: new AbortController().signal
    },
    modelFile: "unused-review-fixture",
    snapshot: { version: 1, defaultRef: null, models: [] },
    config: undefined,
    check: () => {},
    scope: () => scope
  })
  expect(await reviewer.review(action)).toMatchObject({
    decision: "ask",
    reason: "此操作已设为从不允许。",
    model: null
  })
})

it("supports never under auto-review and preserves it until the human changes or removes the rule", () => {
  const f = fixture()
  f.store.autoReview.change({
    ...f.store.autoReview.read(f.bot.id),
    isEnabled: true,
    nonce: "review-on"
  })
  const request = f.ask()
  expect(request.review).toMatchObject({ canRemember: false, canDeny: true })
  f.store.answerInteraction({
    id: request.id,
    revision: request.revision,
    answer: "reject",
    remember: true
  })
  let rules = f.store.approvalRules.read(f.bot.id)
  expect(f.ask().answer).toBe("reject")
  rules = f.store.approvalRules.change({
    botId: f.bot.id,
    ruleId: rules.rules[0].id,
    revision: rules.revision,
    dataEpoch: rules.dataEpoch,
    nonce: "never-to-ask",
    behavior: "ask"
  })
  const manual = f.ask()
  expect(manual.status).toBe("pending")
  f.store.answerInteraction({ id: manual.id, revision: manual.revision, answer: "reject" })
  f.store.approvalRules.change({
    botId: f.bot.id,
    ruleId: rules.rules[0].id,
    revision: rules.revision,
    dataEpoch: rules.dataEpoch,
    nonce: "remove",
    behavior: null
  })
  expect(f.store.approvalRules.read(f.bot.id).rules).toEqual([])
})

it("a newly saved never rule revokes an earlier manual approval before its effect", () => {
  const f = fixture(),
    first = f.ask()
  f.store.answerInteraction({ id: first.id, revision: first.revision, answer: "approve" })
  f.remember("reject")
  expect(() =>
    f.store.beginEffect(f.lease, { id: "earlier-manual", action, approvalId: first.id })
  ).toThrow("从不允许")
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_effects")[0].values[0][0]).toBe(0)
})

it("upgrades the actual v50 constraint with a backup and retains rules and historical answers", () => {
  const directory = mkdtempSync(join(tmpdir(), "cmb-approval-never-v50-")),
    path = join(directory, "bots.sqlite")
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const f = fixture(path),
    original = f.remember(),
    before = f.store.approvalRules.read(f.bot.id)
  f.store.close()
  const old = new DatabaseSync(path)
  try {
    old.exec(`ALTER TABLE bot_approval_rules RENAME TO bot_approval_rules_new;
      CREATE TABLE bot_approval_rules(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL REFERENCES bots(id),scope TEXT NOT NULL,
      action_hash TEXT NOT NULL,title TEXT NOT NULL,prompt TEXT NOT NULL,
      behavior TEXT NOT NULL CHECK(behavior IN ('allow','ask')),created_at INTEGER NOT NULL,UNIQUE(bot_id,scope,action_hash));
      INSERT INTO bot_approval_rules SELECT * FROM bot_approval_rules_new; DROP TABLE bot_approval_rules_new;
      UPDATE bot_approval_reviews SET record=json_remove(record,'$.canDeny'); UPDATE bot_schema SET version=50;`)
  } finally {
    old.close()
  }
  const reopened = new BotStore(path)
  cleanups.push(() => reopened.close())
  expect(reopened.approvalRules.read(f.bot.id)).toEqual(before)
  expect(reopened.getInteraction(original.id)).toMatchObject({
    answer: "approve",
    review: { remembered: true, canDeny: true }
  })
  expect(reopened.db.exec("SELECT version FROM bot_schema")[0].values[0][0]).toBe(
    BOT_SCHEMA_VERSION
  )
  reopened.approvalRules.change({
    botId: f.bot.id,
    ruleId: before.rules[0].id,
    revision: before.revision,
    dataEpoch: before.dataEpoch,
    nonce: "deny-after-upgrade",
    behavior: "deny"
  })
  expect(reopened.approvalRules.read(f.bot.id).rules[0].behavior).toBe("deny")
  const backups = readdirSync(join(directory, "backups")).filter((name) =>
    name.startsWith("bots-v50-")
  )
  expect(backups).toHaveLength(1)
  const backup = new DatabaseSync(join(directory, "backups", backups[0]), { readOnly: true })
  try {
    expect(backup.prepare("SELECT version FROM bot_schema").get()?.version).toBe(50)
    expect(backup.prepare("SELECT behavior FROM bot_approval_rules").get()?.behavior).toBe("allow")
    expect(
      backup.prepare("SELECT sql FROM sqlite_master WHERE name='bot_approval_rules'").get()?.sql
    ).not.toContain("'deny'")
  } finally {
    backup.close()
  }
})

it("retains explicit refusals while revoking approval authority when restoring data", () => {
  const directory = mkdtempSync(join(tmpdir(), "cmb-approval-never-restore-")),
    path = join(directory, "bots.sqlite")
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const f = fixture(path)
  f.remember("reject")
  const other = f.ask({ shell: { ...action.shell, command: "npm test -- --other" } })
  f.store.answerInteraction({
    id: other.id,
    revision: other.revision,
    answer: "approve",
    remember: true
  })
  const before = f.store.approvalRules.read(f.bot.id)
  f.store.close()
  const ledger = new BotDeletionLedger(path)
  try {
    fenceBotCheckpointDatabase(path, "restored-approval-epoch", ledger)
  } finally {
    ledger.close()
  }
  const reopened = new BotStore(path)
  cleanups.push(() => reopened.close())
  const restored = reopened.approvalRules.read(f.bot.id)
  expect(restored.dataEpoch).toBe("restored-approval-epoch")
  expect(restored.revision).toBe(before.revision + 1)
  expect(restored.rules.map((r) => r.behavior).sort()).toEqual(["ask", "deny"])
})

it("upgrades v31 with a backup, retaining exact rules and historical decisions across restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "cmb-approval-rules-"))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, "bots.sqlite")
  const old = new BotStore(path)
  old.close()
  const db = new DatabaseSync(path)
  db.exec(
    "DROP TABLE bot_approval_reviews; DROP TABLE bot_approval_rules; DROP TABLE bot_approval_policy; UPDATE bot_schema SET version=31"
  )
  db.close()
  const f = fixture(path)
  const approval = f.remember()
  expect(readdirSync(join(directory, "backups")).some((name) => name.startsWith("bots-v31-"))).toBe(
    true
  )
  f.store.close()
  cleanups.pop()
  const reopened = new BotStore(path)
  cleanups.push(() => reopened.close())
  expect(reopened.approvalRules.read(f.bot.id).rules).toHaveLength(1)
  expect(reopened.getInteraction(approval.id).review?.remembered).toBe(true)
})

it.each(["allow", "deny"] as const)(
  "remembers exact Linux pending-probe actions as %s without treating approval as capability",
  (behavior) => {
    const f = fixture(),
      target = { ...action, shell: { ...action.shell, sandbox: "pending-verification" } }
    const request = f.ask(target)
    expect(request.review).toMatchObject({ canRemember: true, canDeny: true, source: "user" })
    f.store.answerInteraction({
      id: request.id,
      revision: request.revision,
      answer: behavior === "allow" ? "approve" : "reject",
      remember: true
    })
    const next = f.ask(target)
    expect(next).toMatchObject({
      status: "answered",
      answer: behavior === "allow" ? "approve" : "reject",
      review: { source: "rule" }
    })
    const rule = f.store.approvalRules.read(f.bot.id).rules[0]
    expect(rule.prompt).toContain("pending-verification")
    // The exact unverified intent cannot grant a changed command, directory,
    // scope, or a forged completed native-probe diagnostic.
    for (const changed of [
      { ...target, shell: { ...target.shell, command: "npm test -- --update" } },
      { ...target, shell: { ...target.shell, cwd: target.shell.cwd + "/other" } },
      { ...target, shell: { ...target.shell, sandbox: "linux-codex-cgroup-v2" } }
    ]) {
      const changedRequest = f.ask(changed)
      expect(changedRequest.status).toBe("pending")
      f.store.answerInteraction({
        id: changedRequest.id,
        revision: changedRequest.revision,
        answer: "reject"
      })
    }
    expect(f.ask(target, "b".repeat(64)).status).toBe("pending")
  }
)
