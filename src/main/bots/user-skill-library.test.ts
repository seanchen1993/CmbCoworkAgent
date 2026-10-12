import { afterEach, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { BotTeachStore } from "./teach-store"
import { BOT_SCHEMA_VERSION } from "./schema"
import { BotWorkflowStore } from "./workflow-store"
import { BOT_USER_SKILL_HISTORY_BYTES, BOT_USER_SKILL_HISTORY_VERSIONS } from "./skill-library"

const stores: BotStore[] = []
afterEach(() => stores.splice(0).forEach((store) => store.close()))
function fixture(path = ":memory:") {
  const store = new BotStore(path)
  stores.push(store)
  const a = store.createBot({ nonce: "a", name: "Author" })
  const b = store.createBot({ nonce: "b", name: "Consumer" })
  const input = {
    nonce: "save",
    expectedDataEpoch: store.snapshot().dataEpoch,
    botId: a.bot.id,
    scope: "user" as const,
    name: "Review",
    instructions: "Read the evidence; report checked facts.",
    enabled: true
  }
  const skill = store.saveSkill(input)
  return { store, a, b, input, skill }
}
function toggle(
  f: ReturnType<typeof fixture>,
  botId: string,
  enabled: boolean,
  revision = 0,
  nonce = `toggle-${revision}`
) {
  return f.store.skillLibrary.setEnabled({
    nonce,
    expectedDataEpoch: f.store.snapshot().dataEpoch,
    botId,
    id: f.skill.id,
    version: f.skill.version,
    revision,
    enabled
  })
}

it("stores one authored definition, preserves private defaults and exposes it to all local Bots", () => {
  const f = fixture()
  expect(f.store.saveSkill(f.input)).toEqual(f.skill)
  const privateSkill = f.store.saveSkill({
    botId: f.a.bot.id,
    name: "Private",
    instructions: "Private conversation",
    enabled: true
  })
  const other = f.store.skillLibrary.available(f.b.bot.id)
  expect(other).toEqual([
    expect.objectContaining({
      id: f.skill.id,
      version: 1,
      scope: "user",
      userEditable: true,
      enabled: true,
      enablementRevision: 0
    })
  ])
  expect(f.store.skills(f.a.bot.id).map((item) => item.id)).toEqual([privateSkill.id])
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_user_skills")[0].values[0][0]).toBe(1)
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_user_skill_versions")[0].values[0][0]).toBe(1)
  const otherHost = new BotStore(":memory:")
  stores.push(otherHost)
  expect(otherHost.skillLibrary.list()).toEqual([])
})

function historyUsage(store: BotStore): number[] {
  return store.db
    .exec("SELECT versions,payload_bytes FROM bot_user_skill_history_usage WHERE id=1")[0]
    .values[0].map(Number)
}

it("accounts for every immutable field in UTF-8 exactly once and rolls usage back with failed writes", () => {
  const f = fixture()
  const bytes = (name: string, instructions: string) =>
    16 +
    [f.skill.id, name, instructions].reduce(
      (sum, value) => sum + Buffer.byteLength(value, "utf8"),
      0
    )
  const firstBytes = bytes(f.input.name, f.input.instructions)
  expect(historyUsage(f.store)).toEqual([1, firstBytes])
  const update = {
    ...f.input,
    nonce: "utf8",
    id: f.skill.id,
    version: 1,
    name: "研发技能",
    instructions: "核对证据 ✅"
  }
  const saved = f.store.saveSkill(update)
  expect(f.store.saveSkill(update)).toEqual(saved)
  expect(historyUsage(f.store)).toEqual([2, firstBytes + bytes(update.name, update.instructions)])
  expect(() =>
    f.store.transaction(() => {
      f.store.db.run("INSERT INTO bot_user_skill_versions VALUES(?,?,?,?,?)", [
        f.skill.id,
        3,
        "rolled back",
        "evidence",
        f.store.now()
      ])
      throw new Error("rollback")
    })
  ).toThrow("rollback")
  expect(historyUsage(f.store)).toEqual([2, firstBytes + bytes(update.name, update.instructions)])
})

it("bounds tiny historical versions by row count without discarding any history", () => {
  const f = fixture()
  f.store.transaction(() => {
    f.store.db.run(
      `WITH RECURSIVE versions(n) AS (SELECT 2 UNION ALL SELECT n+1 FROM versions WHERE n<?)
      INSERT INTO bot_user_skill_versions SELECT ?,n,'N','x',0 FROM versions`,
      [BOT_USER_SKILL_HISTORY_VERSIONS, f.skill.id]
    )
    f.store.db.run("UPDATE bot_skill_library SET revision=?,source_version=? WHERE id=?", [
      BOT_USER_SKILL_HISTORY_VERSIONS,
      BOT_USER_SKILL_HISTORY_VERSIONS,
      f.skill.id
    ])
  })
  const before = historyUsage(f.store)
  expect(before[0]).toBe(BOT_USER_SKILL_HISTORY_VERSIONS)
  expect(before[1]).toBeLessThan(BOT_USER_SKILL_HISTORY_BYTES)
  expect(() =>
    f.store.saveSkill({
      ...f.input,
      nonce: "over-rows",
      id: f.skill.id,
      version: BOT_USER_SKILL_HISTORY_VERSIONS
    })
  ).toThrow("16,384")
  expect(historyUsage(f.store)).toEqual(before)
  expect(f.store.skillLibrary.current(f.a.bot.id, f.skill.id).version).toBe(
    BOT_USER_SKILL_HISTORY_VERSIONS
  )
})

it("enforces the exact full-payload byte boundary while leaving existing versions readable", () => {
  const f = fixture()
  const candidate = {
    ...f.input,
    nonce: "over-bytes",
    id: f.skill.id,
    version: 1,
    name: "N".repeat(100),
    instructions: "x"
  }
  const nextBytes = Buffer.byteLength(f.skill.id) + 16 + 100 + 1
  const target = BOT_USER_SKILL_HISTORY_BYTES - nextBytes + 1
  const rowOverhead = Buffer.byteLength(f.skill.id) + 16 + 1
  const full = "x".repeat(64_000)
  let remaining = target - historyUsage(f.store)[1],
    version = 1
  f.store.transaction(() => {
    while (remaining > rowOverhead) {
      const text =
        remaining > rowOverhead + full.length ? full : "x".repeat(remaining - rowOverhead)
      f.store.db.run("INSERT INTO bot_user_skill_versions VALUES(?,?,?,?,?)", [
        f.skill.id,
        ++version,
        "N",
        text,
        f.store.now()
      ])
      remaining -= rowOverhead + Buffer.byteLength(text)
    }
    f.store.db.run("UPDATE bot_skill_library SET revision=?,source_version=? WHERE id=?", [
      version,
      version,
      f.skill.id
    ])
  })
  expect(remaining).toBe(0)
  expect(historyUsage(f.store)).toEqual([version, target])
  expect(() => f.store.saveSkill({ ...candidate, version })).toThrow("32 MiB")
  expect(historyUsage(f.store)).toEqual([version, target])
  const saved = f.store.saveSkill({
    ...candidate,
    nonce: "at-bytes",
    version,
    name: "N".repeat(99)
  })
  expect(saved.version).toBe(version + 1)
  expect(historyUsage(f.store)).toEqual([version + 1, BOT_USER_SKILL_HISTORY_BYTES])
})

it("initializes v74 history counters once on upgrade without rewriting definitions", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-user-skill-usage-")),
    path = join(directory, "bots.sqlite")
  let store = new BotStore(path)
  try {
    const bot = store.createBot({ nonce: "bot", name: "Author" })
    const skill = store.saveSkill({
      botId: bot.bot.id,
      scope: "user",
      name: "技能",
      instructions: "已有历史",
      enabled: true
    })
    const expected = historyUsage(store)
    store.db.run(
      "DROP TRIGGER bot_user_skill_history_insert; DROP TRIGGER bot_user_skill_history_delete; DROP TRIGGER bot_user_skill_history_update; DROP TABLE bot_user_skill_history_usage; UPDATE bot_schema SET version=74"
    )
    store.close()
    store = new BotStore(path)
    expect(historyUsage(store)).toEqual(expected)
    expect(store.skillLibrary.available(bot.bot.id)).toEqual([skill])
    expect(store.db.exec("PRAGMA foreign_key_check")[0]?.values ?? []).toEqual([])
    store.close()
    store = new BotStore(path)
    expect(historyUsage(store)).toEqual(expected)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("updates a canonical exact version from either Bot without copying verification or losing history", () => {
  const f = fixture()
  const trial = f.store.trialSkill({
    nonce: "trial",
    botId: f.a.bot.id,
    skillId: f.skill.id,
    version: 1,
    inputs: "source",
    criteria: "Evidence"
  })
  const claim = f.store.claim("host")!
  f.store.finish(claim.lease, "succeeded", "Checked evidence")
  f.store.reviewSkillTrial({ id: trial.id, verdict: "passed", note: "Reviewed" })
  expect(f.store.skillLibrary.current(f.a.bot.id, f.skill.id).verified).toBe(true)
  expect(f.store.skillLibrary.current(f.b.bot.id, f.skill.id).verified).toBe(false)
  const sent = f.store.send({
    nonce: "task",
    conversationId: f.b.conversationId,
    text: "Use the instructions",
    skills: [{ botId: f.b.bot.id, id: f.skill.id, version: 1 }]
  })
  const saved = f.store.saveSkill({
    ...f.input,
    nonce: "update",
    botId: f.b.bot.id,
    id: f.skill.id,
    version: 1,
    instructions: "Read the latest evidence."
  })
  expect(saved).toMatchObject({ id: f.skill.id, version: 2, verified: false })
  for (const botId of [f.a.bot.id, f.b.bot.id])
    expect(f.store.skillLibrary.current(botId, f.skill.id)).toMatchObject({
      version: 2,
      instructions: saved.instructions,
      verified: false
    })
  expect(f.store.getRun(sent.runIds[0]).status).toBe("cancelled")
  expect(() => f.store.assertRunSkillAuthority(sent.runIds[0])).toThrow()
  expect(() =>
    f.store.saveSkill({ ...f.input, nonce: "stale", id: f.skill.id, version: 1 })
  ).toThrow("已更新")
  expect(
    f.store.db.exec("SELECT version,instructions FROM bot_user_skill_versions ORDER BY version")[0]
      .values
  ).toEqual([
    [1, f.input.instructions],
    [2, saved.instructions]
  ])
})

it("toggles only one Bot with CAS and nonce receipts, and never reauthorizes a revoked task", () => {
  const f = fixture()
  const sent = f.store.send({
    nonce: "read",
    conversationId: f.a.conversationId,
    text: "Read skill"
  })
  f.store.skillLibrary.readForRun(sent.runIds[0], f.skill.id)
  const stopped = toggle(f, f.a.bot.id, false)
  expect(toggle(f, f.a.bot.id, false)).toEqual(stopped)
  expect(f.store.skillLibrary.available(f.a.bot.id)[0]).toMatchObject({
    enabled: false,
    version: 1,
    enablementRevision: 1
  })
  expect(f.store.skillLibrary.current(f.b.bot.id, f.skill.id).enabled).toBe(true)
  expect(() => f.store.skillLibrary.current(f.a.bot.id, f.skill.id)).toThrow("停用")
  expect(() => toggle(f, f.a.bot.id, true, 0, "stale")).toThrow("已变化")
  toggle(f, f.a.bot.id, true, 1, "enable")
  expect(f.store.skillLibrary.current(f.a.bot.id, f.skill.id).enabled).toBe(true)
  expect(() => f.store.assertRunSkillAuthority(sent.runIds[0])).toThrow("重新发起")
  expect(f.store.getRun(sent.runIds[0]).status).toBe("cancelled")
  expect(() => toggle(f, f.a.bot.id, true, 2, "toggle-0")).toThrow("不同")
})

it("retains a definition after its creator is deleted, and withdraws it globally without dropping audit versions", () => {
  const f = fixture()
  f.store.deleteBot(f.a.bot.id, f.a.bot.revision)
  expect(f.store.skillLibrary.current(f.b.bot.id, f.skill.id).instructions).toBe(
    f.skill.instructions
  )
  const input = {
    nonce: "delete",
    expectedDataEpoch: f.store.snapshot().dataEpoch,
    id: f.skill.id,
    revision: 1
  }
  const receipt = f.store.skillLibrary.withdraw(input)
  expect(f.store.skillLibrary.withdraw(input)).toEqual(receipt)
  expect(f.store.skillLibrary.list()).toEqual([])
  expect(() => f.store.skillLibrary.current(f.b.bot.id, f.skill.id)).toThrow("撤回")
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_user_skill_versions")[0].values[0][0]).toBe(1)
  expect(() =>
    f.store.saveSkill({
      ...f.input,
      nonce: "resurrect",
      botId: f.b.bot.id,
      id: f.skill.id,
      version: 1
    })
  ).toThrow("已更新")
})

it("fences restores and forbids model edits to existing shared definitions", () => {
  const f = fixture()
  const sent = f.store.send({ nonce: "model", conversationId: f.a.conversationId, text: "Learn" })
  const claim = f.store.claim("host")!
  expect(claim.run.id).toBe(sent.runIds[0])
  expect(() =>
    f.store.saveSkill(
      { ...f.input, nonce: "model-edit", id: f.skill.id, version: 1 },
      { kind: "task", lease: claim.lease }
    )
  ).toThrow("技能库中确认")
  expect(() =>
    f.store.saveSkill(
      { ...f.input, nonce: "foreign-model", botId: f.b.bot.id },
      { kind: "task", lease: claim.lease }
    )
  ).toThrow("自己的技能")
  expect(() =>
    f.store.skillLibrary.setEnabled({
      nonce: "restore",
      expectedDataEpoch: "another-workspace",
      botId: f.b.bot.id,
      id: f.skill.id,
      version: 1,
      revision: 0,
      enabled: false
    })
  ).toThrow()
  expect(f.store.skillLibrary.current(f.b.bot.id, f.skill.id).enabled).toBe(true)
})

it("keeps unresolved effects reviewable while revoking future skill dispatch", () => {
  const f = fixture()
  const sent = f.store.send({
    nonce: "review",
    conversationId: f.a.conversationId,
    text: "Read",
    skills: [{ botId: f.a.bot.id, id: f.skill.id, version: 1 }]
  })
  f.store.db.run("UPDATE bot_runs SET status='needs_review' WHERE id=?", [sent.runIds[0]])
  toggle(f, f.a.bot.id, false)
  expect(f.store.getRun(sent.runIds[0]).status).toBe("needs_review")
  toggle(f, f.a.bot.id, true, 1, "enable")
  expect(() => f.store.assertRunSkillAuthority(sent.runIds[0])).toThrow("重新发起")
})

it.each(["withdraw", "edit", "disable"] as const)(
  "permanently revokes owned peer work on %s while preserving review and unrelated work",
  (operation) => {
    const f = fixture()
    f.store.send({
      nonce: "parent",
      conversationId: f.a.conversationId,
      text: "Use flow",
      skills: [{ botId: f.a.bot.id, id: f.skill.id, version: 1 }]
    })
    const parent = f.store.claim("parent-host")!
    f.store.sendPeer(parent.lease, {
      nonce: "delegate",
      recipient: f.b.bot.id,
      text: "Write result"
    })
    const child = f.store.claim("child-host")!
    const approval = f.store.requestInteraction(child.lease, {
      kind: "approval",
      prompt: "Write?",
      action: "write"
    })
    f.store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
    f.store.beginEffect(child.lease, { id: "write", action: "write", approvalId: approval.id })
    f.store.settleEffect(child.lease, "write", "unknown", "Reply lost")
    expect(f.store.finish(child.lease, "failed", "Needs review").status).toBe("needs_review")
    const unrelated = f.store.send({
      nonce: "unrelated",
      conversationId: f.b.conversationId,
      text: "Independent work"
    })
    // A finished parent still owns the authority inherited by its outstanding delegates.
    if (operation === "withdraw")
      expect(f.store.finish(parent.lease, "succeeded", "Delegated").status).toBe("succeeded")
    if (operation === "withdraw")
      f.store.skillLibrary.withdraw({ nonce: "withdraw", id: f.skill.id, revision: 1 })
    if (operation === "edit")
      f.store.saveSkill({
        ...f.input,
        nonce: "edit",
        id: f.skill.id,
        version: 1,
        instructions: "New flow"
      })
    if (operation === "disable") {
      toggle(f, f.a.bot.id, false)
      toggle(f, f.a.bot.id, true, 1, "enable")
      expect(f.store.skillLibrary.current(f.b.bot.id, f.skill.id).enabled).toBe(true)
    }
    expect(() => f.store.assertRunSkillAuthority(unrelated.runIds[0])).not.toThrow()
    expect(f.store.getRun(unrelated.runIds[0]).status).toBe("queued")
    expect(() => f.store.assertRunSkillAuthority(child.run.id)).toThrow("重新发起")
    const review = f.store.getRun(child.run.id)
    expect(review.status).toBe("needs_review")
    const recovery = {
      id: review.id,
      revision: review.revision,
      note: "Checked destination",
      effects: [{ id: "write", outcome: "failed" as const, note: "No write occurred" }]
    }
    expect(() => f.store.recover({ ...recovery, decision: "resume" })).toThrow("重新发起")
    expect(f.store.effects(child.run.id)[0].status).toBe("unknown")
    expect(f.store.recover({ ...recovery, decision: "cancel" }).status).toBe("cancelled")
    expect(f.store.effects(child.run.id)[0].status).toBe("failed")
    expect(f.store.claim("next-host")?.run.id).toBe(unrelated.runIds[0])
  }
)

it("revokes nested peer/workflow descendants without preventing started receipts or human closure", () => {
  const f = fixture()
  f.store.send({
    nonce: "parent",
    conversationId: f.a.conversationId,
    text: "Use flow",
    skills: [{ botId: f.a.bot.id, id: f.skill.id, version: 1 }]
  })
  const root = f.store.claim("root-host")!
  f.store.sendPeer(root.lease, { nonce: "peer", recipient: f.b.bot.id, text: "Run workflow" })
  const peer = f.store.claim("peer-host")!
  const workflow = BotWorkflowStore.open(f.store, peer.lease, "workflow", {
    script: 'export const meta={name:"Review",description:"Review"}; return await agent("task");',
    maxConcurrency: 2,
    defaultModelId: "configured",
    agentProfiles: [],
    authority: { project: "test" }
  })
  const child = f.store.workflowChildren.claim(workflow, peer.lease, {
    prompt: "Write result",
    agentIndex: 1,
    toolStreamKey: `${"a".repeat(64)}_c0`,
    durableCallKey: `${"a".repeat(64)}_n0`,
    label: "Writer",
    phase: null,
    shellAccess: "full"
  })
  const approval = f.store.requestInteraction(child.lease!, {
    kind: "approval",
    prompt: "Write?",
    action: "write"
  })
  f.store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
  f.store.beginEffect(child.lease!, { id: "write", action: "write", approvalId: approval.id })
  f.store.finish(root.lease, "succeeded", "Delegated")
  toggle(f, f.a.bot.id, false)
  toggle(f, f.a.bot.id, true, 1, "enable")
  for (const run of [root.run, peer.run, child.run])
    expect(() => f.store.assertRunSkillAuthority(run.id)).toThrow("重新发起")
  expect(() => f.store.assertDispatch(child.lease!)).toThrow()
  f.store.settleEffect(child.lease!, "write", "unknown", "Reply lost during cancellation")
  const review = f.store.workflowChildren.settle(child.lease!, "cancelled", "Stopped")
  expect(review.status).toBe("needs_review")
  const recovery = {
    id: review.id,
    revision: review.revision,
    note: "Checked",
    effects: [{ id: "write", outcome: "succeeded" as const, note: "Confirmed committed" }]
  }
  expect(() => f.store.recover({ ...recovery, decision: "resume" })).toThrow("重新发起")
  expect(f.store.recover({ ...recovery, decision: "cancel" }).status).toBe("cancelled")
  expect(f.store.effects(child.run.id)[0].status).toBe("succeeded")
  expect(f.store.finish(peer.lease, "cancelled", "Stopped").status).toBe("cancelled")
})

it.each([undefined, "user"] as const)(
  "Teach persists its original %s scope and never shares recording data",
  (scope) => {
    const f = fixture(),
      teach = new BotTeachStore(f.store)
    let session = teach.create({
      nonce: "teach",
      botId: f.a.bot.id,
      conversationId: f.a.conversationId,
      ...(scope
        ? {
            skillScope: scope,
            target: {
              botId: f.a.bot.id,
              generation: "recording",
              controlEpoch: 1,
              control: "human" as const,
              viewId: "view"
            }
          }
        : {})
    })
    teach.addFrame(session.id, {
      at: 10,
      sha256: "a".repeat(64),
      size: 100,
      url: "https://private.example",
      title: "Private recording"
    })
    session = teach.update(session.id, session.revision, "finalizing")
    session = teach.update(session.id, session.revision, "queued", {
      video: { size: 200, sha256: "b".repeat(64), mime: "video/webm" }
    })
    session = teach.queue(session.id)
    const claim = f.store.claim("host")!
    expect(() =>
      teach.saveLearned(session.id, claim.lease, "save", {
        name: "Taught",
        instructions: "Generic reviewed steps"
      })
    ).toThrow("完整查看")
    teach.readFrames(session.id, claim.lease, [0])
    const skill = teach.saveLearned(session.id, claim.lease, "save", {
      name: "Taught",
      instructions: "Generic reviewed steps"
    })
    expect(
      teach.saveLearned(session.id, claim.lease, "save", {
        name: "Taught",
        instructions: "Generic reviewed steps"
      })
    ).toEqual(skill)
    expect(skill.scope).toBe(scope)
    expect(f.store.skillLibrary.available(f.b.bot.id).some((item) => item.id === skill.id)).toBe(
      scope === "user"
    )
    expect(JSON.stringify(f.store.skillLibrary.list())).not.toContain("private.example")
  }
)

it("migrates v72 without converting private skills or altering published snapshots", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-user-skill-migration-")),
    path = join(directory, "bots.sqlite")
  let store = new BotStore(path)
  try {
    const a = store.createBot({ nonce: "a", name: "A" }),
      b = store.createBot({ nonce: "b", name: "B" })
    const skill = store.saveSkill({
      botId: a.bot.id,
      name: "Private",
      instructions: "Original",
      enabled: true
    })
    const published = store.skillLibrary.publish({
      nonce: "publish",
      botId: a.bot.id,
      skillId: skill.id,
      version: 1,
      libraryRevision: 0
    })
    store.db.run(
      "DROP TABLE bot_run_skill_revocations; DROP TABLE bot_skill_enablement; DROP TABLE bot_user_skill_versions; DROP TABLE bot_user_skills; UPDATE bot_schema SET version=72"
    )
    store.close()
    store = new BotStore(path)
    expect(store.db.exec("SELECT version FROM bot_schema")[0].values[0][0]).toBe(BOT_SCHEMA_VERSION)
    expect(store.skills(a.bot.id)).toEqual([skill])
    expect(store.skillLibrary.list()).toEqual([published])
    expect(store.skillLibrary.available(b.bot.id)[0]).toMatchObject({
      id: published.id,
      userEditable: false
    })
    expect(store.db.exec("SELECT COUNT(*) FROM bot_user_skills")[0].values[0][0]).toBe(0)
    expect(store.db.exec("PRAGMA foreign_key_check")[0]?.values ?? []).toEqual([])
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("retires pending approvals and preserves an already started effect receipt on shared disable", () => {
  const f = fixture()
  f.store.send({
    nonce: "selected",
    conversationId: f.a.conversationId,
    text: "Run",
    skills: [{ botId: f.a.bot.id, id: f.skill.id, version: 1 }]
  })
  const claim = f.store.claim("host")!
  const action = { tool: "external_change" }
  const approval = f.store.requestInteraction(claim.lease, {
    kind: "approval",
    prompt: "Change?",
    action
  })
  f.store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
  f.store.beginEffect(claim.lease, { id: "inflight", action, approvalId: approval.id })
  toggle(f, f.a.bot.id, false)
  expect(f.store.getRun(claim.run.id).status).toBe("cancelling")
  f.store.settleEffect(claim.lease, "inflight", "unknown", "Connection lost after write")
  expect(f.store.finish(claim.lease, "cancelled", "Stopped").status).toBe("needs_review")
  toggle(f, f.a.bot.id, true, 1, "enable")
  const run = f.store.getRun(claim.run.id)
  expect(() =>
    f.store.recover({
      id: run.id,
      revision: run.revision,
      note: "Checked",
      decision: "resume",
      effects: [{ id: "inflight", outcome: "failed", note: "Confirmed no write" }]
    })
  ).toThrow("重新发起")
  expect(f.store.effects(run.id)[0]).toMatchObject({
    status: "unknown",
    result: "Connection lost after write"
  })
})

it("stops a keepAlive service after its turn completed without inventing a successful cancellation", () => {
  const f = fixture()
  f.store.bindLeaseGuard("host", () => {})
  f.store.send({
    nonce: "service",
    conversationId: f.a.conversationId,
    text: "Run server",
    skills: [{ botId: f.a.bot.id, id: f.skill.id, version: 1 }]
  })
  const claim = f.store.claim("host")!
  const action = { shell: { command: "server", keepAlive: true } }
  const approval = f.store.requestInteraction(claim.lease, {
    kind: "approval",
    prompt: "Start?",
    action
  })
  f.store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
  const reserved = f.store.toolOnce(claim.lease, "service-create", action, () => {
    f.store.beginEffect(claim.lease, { id: "effect", action, approvalId: approval.id })
    const jobId = f.store.shellJobs.reserve(claim.lease, "server", "effect", "server")
    return { jobId, service: f.store.shellServices.attach(claim.lease, jobId, 60_000) }
  })
  f.store.shellJobs.start(claim.lease, reserved.jobId)
  f.store.finish(claim.lease, "succeeded", "Started")
  toggle(f, f.a.bot.id, false)
  expect(f.store.shellJobs.get(claim.run.id, reserved.jobId, 0).status).toBe("cancelling")
  expect(f.store.getRun(claim.run.id).status).toBe("succeeded")
  f.store.shellServices.finish(reserved.service, {
    output: "Interrupted",
    exitCode: 130,
    truncated: false
  })
  expect(f.store.effects(claim.run.id)[0].status).toBe("unknown")
  expect(f.store.getRun(claim.run.id).status).toBe("needs_review")
})

it("pauses only affected routines and leaves another Bot's accepted work intact", () => {
  const f = fixture()
  const trial = f.store.trialSkill({
    nonce: "verify",
    botId: f.a.bot.id,
    skillId: f.skill.id,
    version: 1,
    inputs: "Read",
    criteria: "Evidence"
  })
  f.store.finish(f.store.claim("host")!.lease, "succeeded", "Evidence")
  f.store.reviewSkillTrial({ id: trial.id, verdict: "passed", note: "Checked" })
  const routine = f.store.saveRoutine(
    {
      botId: f.a.bot.id,
      name: "Reviewed",
      prompt: "Review",
      timezone: "UTC",
      enabled: true,
      schedule: { kind: "event", topic: "review.ready" },
      skills: [{ botId: f.a.bot.id, id: f.skill.id, version: 1 }]
    },
    { kind: "human" }
  )
  const queued = f.store.runRoutine({ id: routine.id, nonce: "queued" })
  const other = f.store.send({
    nonce: "other",
    conversationId: f.b.conversationId,
    text: "Review",
    skills: [{ botId: f.b.bot.id, id: f.skill.id, version: 1 }]
  })
  toggle(f, f.a.bot.id, false)
  expect(f.store.routine(f.a.bot.id, routine.id)).toMatchObject({
    enabled: false,
    revision: routine.revision + 1
  })
  expect(f.store.getRun(queued.id).status).toBe("cancelled")
  expect(f.store.getRun(other.runIds[0]).status).toBe("queued")
  expect(() => f.store.assertRunSkillAuthority(other.runIds[0])).not.toThrow()
})
