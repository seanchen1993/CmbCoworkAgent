import { afterEach, expect, it } from "vitest"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"
import { BotStore } from "./store"
import { BOT_SCHEMA_VERSION } from "./schema"
import type { BotExternalSkill } from "./skill-catalog-contract"

const cleanup: (() => void)[] = []
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close())
)
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cmb-external-trials-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, "bots.sqlite")
  let now = Date.now()
  const store = new BotStore(path, () => now)
  cleanup.push(() => store.close())
  const { bot, conversationId } = store.createBot({ nonce: "owner", name: "Owner" })
  const { bot: other } = store.createBot({ nonce: "other", name: "Other" })
  const installed: BotExternalSkill = {
    id: `desktop:${"b".repeat(64)}`,
    name: "Check evidence",
    instructions: "EXACT_INSTALLED_STEPS",
    description: "",
    sha256: "c".repeat(64),
    fileStamp: "original",
    filePath: join(root, "SKILL.md"),
    catalogPath: root,
    rootPath: root,
    catalogId: "review",
    resources: [],
    compatibility: "Requires Node.js",
    pluginId: null,
    pluginName: null,
    source: "user"
  }
  const apply = (item = installed) =>
    store.externalSkills.apply({ skills: [item], warnings: [], truncated: false })
  apply()
  const input = {
    nonce: "trial",
    botId: bot.id,
    skillId: installed.id,
    version: 1,
    inputs: "record 42",
    criteria: "evidence matches 42"
  }
  const finish = (outcome: "succeeded" | "failed" = "succeeded") => {
    const claim = store.claim("host")!
    store.finish(claim.lease, outcome, "evidence 42")
  }
  return {
    root,
    path,
    store,
    bot,
    other,
    conversationId,
    installed,
    apply,
    input,
    finish,
    advance: () => {
      now += 1000
    }
  }
}

it("validates installed versions for one Bot, preserves receipts and invalidates every updated resource", () => {
  const f = fixture(),
    trial = f.store.trialSkill(f.input)
  const references = f.store.skillReferences.forRun(trial.runId)
  expect(references).toEqual([
    { botId: f.bot.id, id: f.installed.id, version: 1, name: f.installed.name }
  ])
  expect(f.store.externalSkills.current(f.bot.id, f.installed.id).verified).toBe(false)
  expect(() =>
    f.store.reviewSkillTrial({ id: trial.id, verdict: "passed", note: "checked" })
  ).toThrow("不能标记通过")
  f.finish()
  const reviewed = f.store.reviewSkillTrial({
    id: trial.id,
    verdict: "passed",
    note: "checked actual evidence"
  })
  expect(
    f.store.reviewSkillTrial({ id: trial.id, verdict: "passed", note: "checked actual evidence" })
  ).toEqual(reviewed)
  expect(f.store.externalSkills.current(f.bot.id, f.installed.id).verified).toBe(true)
  expect(f.store.externalSkills.list(f.bot.id)[0].verified).toBe(true)
  expect(f.store.externalSkills.current(f.other.id, f.installed.id).verified).toBe(false)
  expect(f.store.effects(trial.runId)).toEqual([])
  // A script/resource update changes the version even when instructions are identical.
  f.apply({
    ...f.installed,
    resources: [{ path: "check.js", kind: "file", size: 100, stamp: "new" }]
  })
  expect(f.store.externalSkills.current(f.bot.id, f.installed.id)).toMatchObject({
    version: 2,
    verified: false
  })
  expect(() => f.store.trialSkill({ ...f.input, nonce: "stale" })).toThrow("新版本")
  expect(f.store.trialSkill(f.input)).toEqual(trial)
  expect(() => f.store.skillReferences.assertCurrent(references)).toThrow("新版本")
  expect(f.store.skillTrials(f.bot.id)[0]).toMatchObject({ version: 1, verdict: "passed" })
  // The presentation uses the name accepted for this message, even after the
  // installed skill is renamed or removed from the current catalog.
  f.apply({ ...f.installed, name: "Renamed installed skill" })
  f.store.externalSkills.apply({ skills: [], warnings: [], truncated: false })
  const messageId = f.store.getRun(trial.runId).messageId
  expect(f.store.message({ conversationId: f.conversationId, id: messageId }).skillTrial).toEqual({
    id: trial.id,
    skillId: f.installed.id,
    name: f.installed.name,
    version: 1,
    inputs: f.input.inputs,
    criteria: f.input.criteria
  })
  const reopened = new BotStore(f.path)
  try {
    expect(
      reopened.message({ conversationId: f.conversationId, id: messageId }).skillTrial
    ).toEqual(f.store.message({ conversationId: f.conversationId, id: messageId }).skillTrial)
  } finally {
    reopened.close()
  }
})

it("keeps shared acceptance separate from its author, other Bots and later publication revisions", () => {
  const f = fixture(),
    own = f.store.saveSkill({
      botId: f.other.id,
      name: "Review",
      instructions: "SHARED_STEPS",
      enabled: true
    })
  const publication = {
    nonce: "publish",
    botId: f.other.id,
    skillId: own.id,
    version: 1,
    libraryRevision: 0
  }
  const shared = f.store.skillLibrary.publish(publication)
  const trial = f.store.trialSkill({ ...f.input, skillId: shared.id })
  f.finish()
  f.store.reviewSkillTrial({ id: trial.id, verdict: "passed", note: "checked by this Bot" })
  expect(f.store.skillLibrary.current(f.bot.id, shared.id).verified).toBe(true)
  expect(
    f.store.skillLibrary.available(f.bot.id).find((skill) => skill.id === shared.id)?.verified
  ).toBe(true)
  expect(f.store.skillLibrary.current(f.other.id, shared.id).verified).toBe(false)
  expect(f.store.skillVersion(f.other.id, own.id, 1).verified).toBe(false)
  const routine = f.store.saveRoutine({
    botId: f.bot.id,
    name: "Check",
    prompt: "Check record 42",
    timezone: "UTC",
    enabled: true,
    schedule: { kind: "event", topic: "check.ready" },
    skills: [{ botId: f.bot.id, id: shared.id, version: 1 }]
  })
  const clone = f.store.cloneBot({ nonce: "clone", id: f.bot.id, revision: f.bot.revision })
  expect(f.store.routines(clone.bot.id)[0]).toMatchObject({
    enabled: false,
    skillIssueCode: "skill_unverified"
  })
  f.store.skillLibrary.publish({ ...publication, nonce: "update", libraryRevision: 1 })
  expect(f.store.skillLibrary.current(f.bot.id, shared.id).verified).toBe(false)
  expect(f.store.emitEvent({ nonce: "event", topic: "check.ready", payload: "42" }).runIds).toEqual(
    []
  )
  expect(f.store.routine(f.bot.id, routine.id)).toMatchObject({
    enabled: false,
    skillIssueCode: "skill_changed"
  })
  f.store.skillLibrary.withdraw({ nonce: "withdraw", id: shared.id, revision: 2 })
  expect(f.store.skillTrials(f.bot.id)[0]).toMatchObject({ verdict: "passed", version: 1 })
})

it("does not consume events or permanently pause due routines while the installed catalog is unavailable", () => {
  const f = fixture(),
    trial = f.store.trialSkill(f.input)
  f.finish()
  f.store.reviewSkillTrial({ id: trial.id, verdict: "passed", note: "actual evidence" })
  const settings = {
    botId: f.bot.id,
    name: "Check",
    prompt: "Check",
    timezone: "UTC",
    enabled: true,
    skills: [{ botId: f.bot.id, id: f.installed.id, version: 1 }]
  }
  const timed = f.store.saveRoutine({
    ...settings,
    schedule: { kind: "once", at: f.store.now() + 1 }
  })
  const event = f.store.saveRoutine({
    ...settings,
    schedule: { kind: "event", topic: "build.ready" }
  })
  f.advance()
  f.store.externalSkills.suspend("scan pending")
  expect(f.store.routines(f.bot.id)).toHaveLength(2)
  expect(f.store.dispatchDueRoutines()).toEqual([])
  const input = { nonce: "event", topic: "build.ready", payload: "42" }
  expect(() => f.store.emitEvent(input)).toThrow("scan pending")
  expect(f.store.routine(f.bot.id, timed.id)).toMatchObject({
    enabled: true,
    revision: timed.revision,
    nextAt: timed.nextAt
  })
  f.apply()
  expect(f.store.dispatchDueRoutines()).toHaveLength(1)
  const receipt = f.store.emitEvent(input)
  expect(receipt.runIds).toHaveLength(1)
  expect(f.store.emitEvent(input)).toEqual(receipt)
  f.store.externalSkills.apply({ skills: [], warnings: [], truncated: false })
  expect(() => f.store.trialSkill({ ...f.input, nonce: "removed" })).toThrow("停用")
  expect(f.store.emitEvent({ ...input, nonce: "revoked" }).runIds).toEqual([])
  expect(f.store.routine(f.bot.id, event.id).enabled).toBe(false)
})

it("rejects malformed and cross-owner trials without scheduling work, and preserves failed evidence", () => {
  const f = fixture()
  const privateSkill = f.store.saveSkill({
    botId: f.other.id,
    name: "Private",
    instructions: "DO_NOT_READ",
    enabled: true
  })
  for (const patch of [
    { botId: "missing" },
    { version: 0 },
    { permissions: ["shell"] },
    { criteria: " " },
    { skillId: privateSkill.id }
  ])
    expect(() => f.store.trialSkill({ ...f.input, ...patch })).toThrow()
  expect(f.store.snapshot().runs).toEqual([])
  const trial = f.store.trialSkill(f.input)
  f.finish("failed")
  expect(() =>
    f.store.reviewSkillTrial({ id: trial.id, verdict: "passed", note: "guessed" })
  ).toThrow("不能标记通过")
  f.store.reviewSkillTrial({ id: trial.id, verdict: "failed", note: "missing evidence" })
  expect(f.store.externalSkills.current(f.bot.id, f.installed.id).verified).toBe(false)
})

it("upgrades the actual private-only v25 table with its evidence and receipts intact, then persists external trials", () => {
  const f = fixture(),
    skill = f.store.saveSkill({
      botId: f.bot.id,
      name: "Private",
      instructions: "ORIGINAL",
      enabled: true
    })
  const input = { ...f.input, skillId: skill.id }
  const oldTrial = f.store.trialSkill(input)
  f.finish()
  f.store.reviewSkillTrial({ id: oldTrial.id, verdict: "passed", note: "checked original" })
  f.store.close()
  const old = new DatabaseSync(f.path)
  old.exec(`DROP INDEX bot_trial_run; DROP INDEX bot_trial_verified;
    ALTER TABLE bot_skill_trials RENAME TO saved_trials;
    CREATE TABLE bot_skill_trials(
      id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), skill_id TEXT NOT NULL, version INTEGER NOT NULL,
      inputs TEXT NOT NULL, criteria TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES bot_runs(id),
      verdict TEXT NOT NULL DEFAULT 'pending', note TEXT, created_at INTEGER NOT NULL,
      FOREIGN KEY(skill_id,version) REFERENCES bot_skills(id,version));
    INSERT INTO bot_skill_trials SELECT * FROM saved_trials;
    DROP TABLE saved_trials; CREATE UNIQUE INDEX bot_trial_run ON bot_skill_trials(run_id);
    UPDATE bot_schema SET version=25;`)
  old.close()
  const upgraded = new BotStore(f.path)
  cleanup.push(() => upgraded.close())
  expect(upgraded.db.exec("SELECT version FROM bot_schema")[0].values[0][0]).toBe(
    BOT_SCHEMA_VERSION
  )
  expect(upgraded.db.exec("PRAGMA foreign_key_check")[0]?.values ?? []).toEqual([])
  expect(upgraded.trialSkill(input)).toEqual(oldTrial)
  expect(upgraded.skillTrials(f.bot.id)[0]).toMatchObject({
    verdict: "passed",
    note: "checked original"
  })
  expect(readdirSync(join(f.root, "backups")).some((file) => file.startsWith("bots-v25-"))).toBe(
    true
  )
  upgraded.externalSkills.apply({ skills: [f.installed], warnings: [], truncated: false })
  const external = upgraded.trialSkill({ ...f.input, nonce: "external" })
  const claim = upgraded.claim("host")!
  upgraded.finish(claim.lease, "succeeded", "actual result")
  upgraded.reviewSkillTrial({
    id: external.id,
    verdict: "passed",
    note: "reviewed installed version"
  })
  upgraded.close()
  const reopened = new BotStore(f.path)
  cleanup.push(() => reopened.close())
  expect(reopened.trialSkill({ ...f.input, nonce: "external" })).toEqual(external)
  expect(reopened.skillLibrary.verified(f.bot.id, f.installed.id, 1)).toBe(true)
  expect(() => reopened.externalSkills.current(f.bot.id, f.installed.id)).toThrow("尚未同步")
  reopened.externalSkills.apply({ skills: [f.installed], warnings: [], truncated: false })
  expect(reopened.externalSkills.current(f.bot.id, f.installed.id).verified).toBe(true)
})
