import { afterEach, expect, it } from "vitest"
import { BotStore } from "./store"
import {
  botSkillDependencyReport,
  type BotSkillDependencyEnvironment
} from "../../shared/bot-skill-dependencies"

const stores: BotStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function fixture() {
  let now = 1000
  const store = new BotStore(":memory:", () => now)
  stores.push(store)
  const created = store.createBot({ nonce: "bot", name: "Bot" })
  const skill = store.saveSkill({
    botId: created.bot.id,
    name: "Skill",
    instructions: `---\ncmbdevclaw-dependencies:\n  schemaVersion: 1\n  checks:\n    - {id: platform, kind: platform, platforms: [${process.platform}]}\n---\nSteps`,
    enabled: true
  })
  const selection = { botId: skill.botId, id: skill.id, version: skill.version }
  const receipt = store.skillDependencies.submit({
    nonce: "check",
    expectedDataEpoch: store.dataEpoch(),
    skill: selection
  })
  const environment: BotSkillDependencyEnvironment = {
    target: {
      id: "a".repeat(64),
      label: "Actual fixture platform",
      platform: process.platform as "darwin" | "win32" | "linux"
    },
    dataEpoch: store.dataEpoch(),
    authoritySha256: "b".repeat(64),
    workspaceSha256: "c".repeat(64),
    policyRevision: 1,
    commandRulesRevision: 1,
    reviewRevision: 1,
    botRevision: 1,
    buildId: "fixture"
  }
  const report = botSkillDependencyReport.parse({
    format: 1,
    skill: receipt.skill,
    environment,
    runId: receipt.runId,
    checkedAt: now,
    expiresAt: now + 600000,
    status: "satisfied",
    checks: [{ id: "platform", status: "satisfied", reason: "observed" }]
  })
  const { lease } = store.claim("host")!
  store.toolOnce(
    lease,
    "skill-dependencies:report",
    { skill: receipt.skill, environment },
    () => report
  )
  store.finish(lease, "succeeded", "依赖检查已满足，仅说明本次环境。")
  return {
    store,
    skill,
    selection,
    receipt,
    environment,
    report,
    advance: (amount: number) => {
      now += amount
    }
  }
}
it("reads the original bounded receipt rather than parsing user-facing Run text as proof", () => {
  const f = fixture()
  const view = f.store.skillDependencies.view(f.selection, f.environment)
  expect(view.history[0]).toMatchObject({ current: true, report: f.report })
  expect(f.store.getRun(f.receipt.runId).result).not.toContain('"authoritySha256"')
  f.store.db.run("DELETE FROM bot_receipts WHERE nonce=?", [
    `tool:${f.receipt.runId}:skill-dependencies:report`
  ])
  f.store.db.run("UPDATE bot_runs SET result=? WHERE id=?", [
    JSON.stringify(f.report),
    f.receipt.runId
  ])
  expect(f.store.skillDependencies.view(f.selection, f.environment).history[0]).toMatchObject({
    current: false,
    report: null,
    reason: "not_checked"
  })
})
it("retains historical observed facts but expires their current-environment projection", () => {
  const f = fixture()
  f.advance(600000)
  expect(f.store.skillDependencies.view(f.selection, f.environment).history[0]).toMatchObject({
    current: false,
    reason: "expired",
    report: { status: "satisfied" }
  })
})
it("configuration, physical target, workspace, permissions, rules and epoch each retire current evidence", () => {
  const f = fixture()
  const changes: Partial<BotSkillDependencyEnvironment>[] = [
    { target: { ...f.environment.target, id: "d".repeat(64) } },
    { workspaceSha256: "d".repeat(64) },
    { authoritySha256: "d".repeat(64) },
    { policyRevision: 2 },
    { commandRulesRevision: 2 },
    { reviewRevision: 2 },
    { botRevision: 2 },
    { dataEpoch: "restored" },
    { buildId: "new-build" }
  ]
  for (const change of changes)
    expect(
      f.store.skillDependencies.view(f.selection, { ...f.environment, ...change }).history[0]
    ).toMatchObject({
      current: false,
      reason: "stale_environment",
      report: { status: "satisfied" }
    })
  expect(f.store.skillDependencies.view(f.selection).history[0].current).toBe(false)
})
it("a revised selected version displays prior evidence as stale without inheriting trial verification", () => {
  const f = fixture(),
    next = f.store.saveSkill({ ...f.skill, instructions: f.skill.instructions + "\nNew steps." })
  const view = f.store.skillDependencies.view(
    { ...f.selection, version: next.version },
    f.environment
  )
  expect(view.skill.version).toBe(2)
  expect(view.history[0]).toMatchObject({
    current: false,
    reason: "stale_skill",
    report: { skill: { version: 1 }, status: "satisfied" }
  })
  expect(f.store.skills(f.skill.botId)[0].verified).toBe(false)
})
it("does not accept a forged check identity or another source in an otherwise valid receipt", () => {
  const f = fixture(),
    key = `tool:${f.receipt.runId}:skill-dependencies:report`
  for (const report of [
    { ...f.report, checks: [{ id: "other", status: "satisfied", reason: "observed" }] },
    { ...f.report, skill: { ...f.report.skill, sha256: "e".repeat(64) } }
  ]) {
    f.store.db.run("UPDATE bot_receipts SET response=? WHERE nonce=?", [
      JSON.stringify(report),
      key
    ])
    expect(f.store.skillDependencies.view(f.selection, f.environment).history[0]).toMatchObject({
      current: false,
      report: null
    })
  }
})

it("a subsequent pending or failed check does not silently reuse an earlier satisfied report", () => {
  const f = fixture()
  f.advance(1)
  f.store.skillDependencies.submit({
    nonce: "later",
    expectedDataEpoch: f.store.dataEpoch(),
    skill: f.selection
  })
  const history = f.store.skillDependencies.view(f.selection, f.environment).history
  expect(history[0]).toMatchObject({ status: "queued", report: null, current: false })
  expect(history[1]).toMatchObject({
    current: false,
    reason: "superseded",
    report: { status: "satisfied" }
  })
})

it("reads the current disabled private declaration without admitting a dependency check", () => {
  const f = fixture()
  const disabled = f.store.saveSkill({ ...f.skill, enabled: false })
  const selection = { ...f.selection, version: disabled.version }
  const runIds = f.store.snapshot().runs.map((run) => run.id)
  const view = f.store.skillDependencies.view(selection, f.environment)
  expect(view.skill).toMatchObject({ ...selection, scope: "bot" })
  expect(view.declaration).toMatchObject({ state: "structured", checks: [{ id: "platform" }] })
  expect(view.history[0]).toMatchObject({
    current: false,
    reason: "stale_skill",
    report: f.report,
    receipt: f.receipt
  })
  expect(() => f.store.skillDependencies.origin(selection)).toThrow("停用")
  expect(() =>
    f.store.skillDependencies.submit({
      nonce: "disabled-check",
      expectedDataEpoch: f.store.dataEpoch(),
      skill: selection
    })
  ).toThrow("停用")
  expect(f.store.snapshot().runs.map((run) => run.id)).toEqual(runIds)
})

it("reads a never-enabled current private skill as metadata with no invented history", () => {
  const f = fixture()
  const disabled = f.store.saveSkill({
    botId: f.skill.botId,
    name: "Read-only declaration",
    instructions: f.skill.instructions,
    enabled: false
  })
  const selection = { botId: disabled.botId, id: disabled.id, version: disabled.version }
  expect(f.store.skillDependencies.view(selection)).toMatchObject({
    skill: { ...selection, scope: "bot" },
    declaration: { state: "structured", checks: [{ id: "platform" }] },
    history: []
  })
  expect(() =>
    f.store.skillLibrary.current(selection.botId, selection.id, selection.version)
  ).toThrow("停用")
})

it("keeps queued execution, old versions, another Bot and deleted private identities fenced", () => {
  const f = fixture()
  const queued = f.store.skillDependencies.submit({
    nonce: "queued-before-disable",
    expectedDataEpoch: f.store.dataEpoch(),
    skill: f.selection
  })
  const claimed = f.store.claim("host")!
  expect(claimed.run.id).toBe(queued.runId)
  const disabled = f.store.saveSkill({ ...f.skill, enabled: false })
  const selection = { ...f.selection, version: disabled.version }
  expect(() => f.store.skillDependencies.assertCurrent(claimed.lease)).toThrow("停用")
  expect(f.store.effects(queued.runId)).toEqual([])
  expect(() => f.store.skillDependencies.view(f.selection)).toThrow("新版本")
  const other = f.store.createBot({ nonce: "other-bot", name: "Other" })
  expect(() => f.store.skillDependencies.view({ ...selection, botId: other.bot.id })).toThrow(
    "不属于"
  )
  f.store.deleteSkill({
    nonce: "delete-disabled",
    botId: disabled.botId,
    skillId: disabled.id,
    version: disabled.version
  })
  expect(() => f.store.skillDependencies.view(selection)).toThrow("已删除")
  expect(f.store.skillDependencies.report(f.receipt.runId)).toEqual(f.report)
})

it("keeps a withdrawn shared library identity unavailable to history inspection", () => {
  const f = fixture()
  const item = f.store.skillLibrary.publish({
    nonce: "publish-history",
    botId: f.skill.botId,
    skillId: f.skill.id,
    version: f.skill.version,
    libraryRevision: 0
  })
  const selection = { botId: f.skill.botId, id: item.id, version: item.revision }
  expect(f.store.skillDependencies.view(selection).skill.scope).toBe("user")
  f.store.skillLibrary.withdraw({ nonce: "withdraw-history", id: item.id, revision: item.revision })
  expect(() => f.store.skillDependencies.view(selection)).toThrow("撤回")
})

it("keeps installed versions, catalog suspension and source withdrawal guarded for history reads", () => {
  const f = fixture()
  const id = `desktop:${"a".repeat(64)}`
  const source = {
    id,
    catalogId: "installed",
    name: "Installed",
    description: "",
    instructions: "Workflow.",
    sha256: "b".repeat(64),
    fileStamp: "stable-1",
    filePath: "/installed/SKILL.md",
    catalogPath: "/installed",
    rootPath: "/installed",
    resources: [],
    dependencies: f.store.skillDependencies.view(f.selection).declaration,
    compatibility: "",
    pluginId: null,
    pluginName: null,
    source: "user" as const
  }
  f.store.externalSkills.apply({ skills: [source], warnings: [], truncated: false })
  const selection = { botId: f.skill.botId, id, version: 1 }
  expect(f.store.skillDependencies.view(selection).skill.scope).toBe("desktop")
  f.store.externalSkills.apply({
    skills: [{ ...source, sha256: "c".repeat(64), fileStamp: "stable-2" }],
    warnings: [],
    truncated: false
  })
  expect(() => f.store.skillDependencies.view(selection)).toThrow("新版本")
  f.store.externalSkills.suspend("catalog unavailable")
  expect(() => f.store.skillDependencies.view({ ...selection, version: 2 })).toThrow("unavailable")
  f.store.externalSkills.apply({ skills: [], warnings: [], truncated: false })
  expect(() => f.store.skillDependencies.view({ ...selection, version: 2 })).toThrow("卸载")
})
