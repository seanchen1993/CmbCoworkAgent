import { afterEach, expect, it } from "vitest"
import { randomBytes } from "node:crypto"
import { mkdtempSync, copyFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { BotDeletionLedger } from "./deletion-ledger"
import { fenceBotCheckpointDatabase } from "./checkpoint-data"
import { botRoutineTools } from "./routine-tools"
import type { BotRoutine } from "../../shared/bot-types"

const cleanup: (() => void | Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
function count(store: BotStore, sql: string, params: string[] = []) {
  return Number(store.db.exec(sql, params)[0]?.values[0]?.[0] ?? 0)
}
function verify(store: BotStore, botId: string, skillId: string) {
  const skill = store.skills(botId).find((x) => x.id === skillId)!
  const trial = store.trialSkill({
    nonce: `verify-${skillId}`,
    botId,
    skillId,
    version: skill.version,
    inputs: "isolated",
    criteria: "review isolated evidence"
  })
  const claimed = store.claim("actual-review")!
  expect(claimed.run.id).toBe(trial.runId)
  store.finish(claimed.lease, "succeeded", "isolated reviewed evidence")
  store.reviewSkillTrial({ id: trial.id, verdict: "passed", note: "Reviewed actual trial result" })
}
function fixture(durable = false) {
  const path = durable
    ? join(mkdtempSync(join(tmpdir(), "cmb-bot10-owning-")), "bots.sqlite")
    : ":memory:"
  const store = new BotStore(path, () => 1_800_000_000_000)
  cleanup.push(() => store.close())
  const source = store.createBot({ nonce: "source", name: "Source" })
  const skill = store.saveSkill({
    botId: source.bot.id,
    name: "Review",
    instructions: "Review isolated evidence",
    enabled: true
  })
  verify(store, source.bot.id, skill.id)
  const definition = {
    botId: source.bot.id,
    name: "Configured",
    prompt: "Use reviewed skill",
    timezone: "UTC",
    schedule: { kind: "event" as const, topic: "isolated.event" },
    skills: [{ botId: source.bot.id, id: skill.id, version: skill.version }]
  }
  store.saveRoutine({ ...definition, nonce: "active-source", enabled: true }, { kind: "human" })
  store.saveRoutine(
    { ...definition, nonce: "paused-source", name: "Paused", enabled: false },
    { kind: "human" }
  )
  const clone = store.cloneBot({ nonce: "clone", id: source.bot.id, revision: source.bot.revision })
  const copied = store.routines(clone.bot.id)
  return { store, path, source, skill, clone, copied }
}
function activation(r: BotRoutine, nonce = "activate") {
  return { ...r, nonce, enabled: true, desiredEnabled: true, expectedDataEpoch: "initial" }
}
it("copies authored intent without verification, occurrences or standing grants; durable reopen preserves the distinction", () => {
  const f = fixture(true)
  expect(f.copied.find((x) => x.name === "Configured")).toMatchObject({
    enabled: false,
    desiredEnabled: true,
    effectiveState: "needs_setup",
    activationRequired: true,
    skillIssueCode: "skill_unverified"
  })
  expect(f.copied.find((x) => x.name === "Paused")).toMatchObject({
    enabled: false,
    desiredEnabled: false,
    effectiveState: "paused",
    activationRequired: true
  })
  expect(f.store.skills(f.clone.bot.id).every((x) => !x.verified)).toBe(true)
  expect(
    count(
      f.store,
      "SELECT COUNT(*) FROM bot_routine_authority WHERE routine_id IN (SELECT id FROM bot_routines WHERE bot_id=?)",
      [f.clone.bot.id]
    )
  ).toBe(0)
  expect(count(f.store, "SELECT COUNT(*) FROM bot_runs WHERE bot_id=?", [f.clone.bot.id])).toBe(0)
  const expected = f.store.routines(f.clone.bot.id)
  f.store.close()
  const reopened = new BotStore(f.path)
  cleanup.push(() => reopened.close())
  expect(reopened.routines(f.clone.bot.id)).toEqual(expected)
})
it("trial and manual testing never enable copied routines; verified settings edits preserve intent and explicit pause clears it", () => {
  const f = fixture()
  verify(f.store, f.clone.bot.id, f.store.skills(f.clone.bot.id)[0].id)
  let active = f.store.routines(f.clone.bot.id).find((x) => x.name === "Configured")!
  expect(active).toMatchObject({
    enabled: false,
    desiredEnabled: true,
    effectiveState: "needs_setup",
    activationRequired: true
  })
  expect(active.skillIssue).toBeUndefined()
  expect(f.store.routines(f.clone.bot.id).find((x) => x.name === "Paused")?.desiredEnabled).toBe(
    false
  )
  f.store.emitEvent({ nonce: "before", topic: "isolated.event", payload: "isolated" })
  expect(
    count(f.store, "SELECT COUNT(*) FROM bot_runs WHERE bot_id=? AND source LIKE 'event:%'", [
      f.clone.bot.id
    ])
  ).toBe(0)
  const manual = f.store.runRoutine({ id: active.id, nonce: "manual", revision: active.revision })
  expect(manual.source).toBe(`routine-manual:${active.id}`)
  expect(f.store.routine(f.clone.bot.id, active.id)).toEqual(active)
  active = f.store.saveRoutine(
    { ...active, nonce: "settings", name: "Renamed", desiredEnabled: true, enabled: false },
    { kind: "human" }
  )
  expect(active).toMatchObject({
    enabled: false,
    desiredEnabled: true,
    activationRequired: true,
    effectiveState: "needs_setup"
  })
  const paused = f.store.saveRoutine(
    { ...active, nonce: "pause", desiredEnabled: false, enabled: false },
    { kind: "human" }
  )
  expect(paused).toMatchObject({ enabled: false, desiredEnabled: false, effectiveState: "paused" })
  expect(() =>
    f.store.saveRoutine(
      { ...paused, nonce: "invalid", desiredEnabled: false, enabled: true },
      { kind: "human" }
    )
  ).toThrow(expect.objectContaining({ code: "invalid_input" }))
})
it.each([
  "null",
  "task",
  "automatic",
  "changed-intent",
  "changed-skill",
  "human-approved"
] as const)("activation requires exact human authority (%s)", (mode) => {
  const f = fixture()
  verify(f.store, f.clone.bot.id, f.store.skills(f.clone.bot.id)[0].id)
  const routine = f.store.routines(f.clone.bot.id).find((x) => x.name === "Configured")!
  const input = activation(routine)
  if (mode === "null") {
    expect(() => f.store.saveRoutine(input)).toThrow(
      expect.objectContaining({ code: "approval_required" })
    )
  } else {
    f.store.send({
      nonce: "request",
      conversationId: f.clone.conversationId,
      text: "Enable the reviewed copied routine"
    })
    const { run, lease } = f.store.claim("activation-host")!
    if (mode === "task")
      expect(() => f.store.saveRoutine(input, { kind: "task", lease })).toThrow(
        expect.objectContaining({ code: "approval_required" })
      )
    else {
      f.store.autoReview.change({
        ...f.store.autoReview.read(f.clone.bot.id),
        nonce: "autoreview",
        isEnabled: true
      })
      const after = {
        ...input,
        ...(mode === "changed-intent" ? { desiredEnabled: false } : {}),
        ...(mode === "changed-skill" ? { skills: [] } : {})
      }
      const action = { routine: { operation: "update", before: routine, after } }
      const autoReview =
        mode === "automatic"
          ? f.store.autoReview.stamp(lease, action, f.store.autoReview.read(f.clone.bot.id), {
              decision: "allow",
              reason: "fixture auto",
              model: "fixture"
            })
          : undefined
      const approval = f.store.requestInteraction(lease, {
        kind: "approval",
        action,
        prompt: JSON.stringify(action),
        autoReview
      })
      if (mode !== "automatic")
        f.store.answerInteraction({
          id: approval.id,
          revision: approval.revision,
          answer: "approve"
        })
      const save = () =>
        f.store.approvedToolOnce(
          lease,
          { id: "activation-effect", action, approvalId: approval.id },
          () =>
            JSON.stringify(
              f.store.saveRoutine(input, {
                kind: "task",
                lease,
                approvalEffectId: "activation-effect"
              })
            )
        )
      if (mode === "human-approved") {
        save()
        expect(f.store.routine(f.clone.bot.id, routine.id)).toMatchObject({
          enabled: true,
          desiredEnabled: true,
          activationRequired: false,
          effectiveState: "active"
        })
        return
      }
      expect(save).toThrow(expect.objectContaining({ code: "approval_required" }))
      expect(f.store.effects(run.id)).toEqual([])
    }
  }
  expect(f.store.routine(f.clone.bot.id, routine.id)).toEqual(routine)
  expect(count(f.store, "SELECT COUNT(*) FROM bot_receipts WHERE nonce='activate'")).toBe(0)
})
it("authenticated public human activation commits one exact receipt and only then admits the original event scheduler", async () => {
  const { BotHost } = await import("./host"),
    { BotRpcServer } = await import("./rpc"),
    { BotTransportClient } = await import("./transport-client"),
    { BOT_PROTOCOL_VERSION } = await import("../../shared/bot-types")
  const f = fixture()
  verify(f.store, f.clone.bot.id, f.store.skills(f.clone.bot.id)[0].id)
  const routine = f.store.routines(f.clone.bot.id).find((x) => x.name === "Configured")!
  const host = new BotHost(f.store),
    token = randomBytes(32).toString("hex"),
    server = new BotRpcServer(host, token),
    dir = mkdtempSync(join(tmpdir(), "cmb-bot10-rpc-"))
  const socket =
    process.platform === "win32"
      ? `\\\\.\\pipe\\cmb-bot10-${token.slice(0, 16)}`
      : join(dir, "s.sock")
  await server.listen(socket)
  const client = new BotTransportClient({
    version: BOT_PROTOCOL_VERSION,
    hostId: host.id,
    pid: process.pid,
    socketPath: socket,
    token
  })
  cleanup.push(async () => {
    client.close()
    await server.close()
    await host.stop()
  })
  expect((await client.call("status")).capabilities).toContain("routine-readiness-state")
  const request = activation(routine, "rpc-activate")
  const saved = await client.call("saveRoutine", request)
  expect(saved).toMatchObject({
    enabled: true,
    desiredEnabled: true,
    activationRequired: false,
    effectiveState: "active"
  })
  const eventCount = count(f.store, "SELECT COUNT(*) FROM bot_events WHERE kind='routine.saved'")
  expect(await client.call("saveRoutine", request)).toEqual(saved)
  expect(count(f.store, "SELECT COUNT(*) FROM bot_events WHERE kind='routine.saved'")).toBe(
    eventCount
  )
  f.store.emitEvent({ nonce: "event-after", topic: "isolated.event", payload: "isolated" })
  expect(
    count(f.store, "SELECT COUNT(*) FROM bot_runs WHERE bot_id=? AND source LIKE 'event:%'", [
      f.clone.bot.id
    ])
  ).toBe(1)
})
it("the original no-auto-review natural language adapter cannot bypass explicit activation", async () => {
  const f = fixture()
  verify(f.store, f.clone.bot.id, f.store.skills(f.clone.bot.id)[0].id)
  const routine = f.store.routines(f.clone.bot.id).find((x) => x.name === "Configured")!
  f.store.send({
    nonce: "task",
    conversationId: f.clone.conversationId,
    text: "Resume copied routine"
  })
  const { run, lease } = f.store.claim("tool-host")!
  let approvals = 0
  const tools = botRoutineTools(
    {
      store: f.store,
      bot: f.clone.bot,
      run,
      lease,
      signal: new AbortController().signal,
      messages: f.store.messagesForRun(run.id)
    },
    () => f.store.assertLease(lease),
    async () => {
      throw Error("unused generic approval")
    },
    async (id, action, operation) => {
      approvals++
      const approval = f.store.requestInteraction(lease, {
        kind: "approval",
        action,
        prompt: JSON.stringify(action)
      })
      f.store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
      return f.store.approvedToolOnce(lease, { id, action, approvalId: approval.id }, operation)
    }
  )
  const update = tools.find((x) => x.name === "update_routine")!
  const call = {
    id: "activate-call",
    type: "tool_call" as const,
    name: update.name,
    args: { id: routine.id, revision: routine.revision, enabled: true }
  }
  await update.invoke(call)
  expect(approvals).toBe(1)
  expect(f.store.routine(f.clone.bot.id, routine.id)).toMatchObject({
    enabled: true,
    activationRequired: false
  })
  await update.invoke(call)
  expect(approvals).toBe(1)
})
it("an existing durable review plan is replayed before preparing against a changed routine revision", async () => {
  const f = fixture(true)
  verify(f.store, f.clone.bot.id, f.store.skills(f.clone.bot.id)[0].id)
  const original = f.store.routines(f.clone.bot.id).find((x) => x.name === "Configured")!
  f.store.send({
    nonce: "plan-task",
    conversationId: f.clone.conversationId,
    text: "Resume copied routine"
  })
  const { run, lease } = f.store.claim("plan-host")!
  const args = { id: original.id, revision: original.revision, enabled: true }
  const input = { tool: "update_routine", ...args }
  const callId = "recovered-plan"
  const plan = {
    before: original,
    after: {
      botId: f.clone.bot.id,
      id: original.id,
      revision: original.revision,
      name: original.name,
      prompt: original.prompt,
      timezone: original.timezone,
      enabled: true,
      desiredEnabled: true,
      schedule: original.schedule
    }
  }
  f.store.toolOnce(lease, `${callId}:routine-plan`, input, () => plan)
  const receiptBefore = f.store.db.exec(
    "SELECT request_hash,response FROM bot_receipts WHERE nonce=?",
    [`tool:${run.id}:${callId}:routine-plan`]
  )
  const changed = f.store.saveRoutine(
    { ...original, name: "Changed while awaiting review" },
    { kind: "human" }
  )
  let approvals = 0
  const tools = botRoutineTools(
    {
      store: f.store,
      bot: f.clone.bot,
      run,
      lease,
      signal: new AbortController().signal,
      messages: f.store.messagesForRun(run.id)
    },
    () => f.store.assertLease(lease),
    async () => {
      throw Error("unused generic approval")
    },
    async (id, action, operation) => {
      approvals++
      expect(action).toEqual({ routine: { operation: "update", ...plan } })
      const interaction = f.store.requestInteraction(lease, {
        kind: "approval",
        action,
        prompt: JSON.stringify(action)
      })
      f.store.answerInteraction({
        id: interaction.id,
        revision: interaction.revision,
        answer: "approve"
      })
      return f.store.approvedToolOnce(lease, { id, action, approvalId: interaction.id }, operation)
    }
  )
  const update = tools.find((x) => x.name === "update_routine")!
  const result = await update.invoke({ id: callId, type: "tool_call", name: update.name, args })
  expect(
    JSON.parse(typeof result === "string" ? result : (result as { content: string }).content)
  ).toMatchObject({ error: "revision_conflict" })
  expect(approvals).toBe(1)
  expect(f.store.routine(f.clone.bot.id, original.id)).toEqual(changed)
  expect(f.store.hasToolResult(lease, callId)).toBe(false)
  expect(
    f.store.db.exec("SELECT request_hash,response FROM bot_receipts WHERE nonce=?", [
      `tool:${run.id}:${callId}:routine-plan`
    ])
  ).toEqual(receiptBefore)
})
it("physical checkpoint fencing retains known intent, prevents stale activation, and keeps deletion revocation monotonic", () => {
  const f = fixture(true)
  const checkpoint = join(mkdtempSync(join(tmpdir(), "cmb-bot10-fence-")), "checkpoint.sqlite")
  f.store.close()
  copyFileSync(f.path, checkpoint)
  const ledger = new BotDeletionLedger(f.path)
  cleanup.push(() => ledger.close())
  fenceBotCheckpointDatabase(checkpoint, "restored-real-fence", ledger)
  const restored = new BotStore(checkpoint)
  cleanup.push(() => restored.close())
  const routine = restored.routines(f.source.bot.id).find((x) => x.name === "Configured")!
  expect(routine).toMatchObject({
    enabled: false,
    desiredEnabled: true,
    activationRequired: true,
    effectiveState: "needs_setup",
    nextAt: null
  })
  expect(() =>
    restored.saveRoutine(
      { ...activation(routine), expectedDataEpoch: "initial" },
      { kind: "human" }
    )
  ).toThrow(expect.objectContaining({ code: "data_epoch" }))
  expect(count(restored, "SELECT COUNT(*) FROM bot_receipts WHERE nonce='activate'")).toBe(0)
  const before = restored.routine(f.source.bot.id, routine.id)
  restored.deleteSkill({
    nonce: "delete-skill",
    botId: f.source.bot.id,
    skillId: f.skill.id,
    version: f.skill.version
  })
  const blocked = restored.routine(f.source.bot.id, routine.id)
  expect(blocked).toMatchObject({
    desiredEnabled: true,
    enabled: false,
    activationRequired: true,
    skillIssueCode: "skill_unavailable"
  })
  expect(blocked.revision).toBe(before.revision)
  expect(() =>
    restored.runRoutine({
      nonce: "revoked",
      id: routine.id,
      expectedDataEpoch: restored.dataEpoch()
    })
  ).toThrow()
})
it("a completed one-shot retains the original dispatch/cursor semantics and is not falsely marked needs_setup", () => {
  let now = 1_800_000_000_000
  const store = new BotStore(":memory:", () => now)
  cleanup.push(() => store.close())
  const { bot } = store.createBot({ nonce: "once-bot", name: "Once" })
  const routine = store.saveRoutine(
    {
      botId: bot.id,
      name: "Once",
      prompt: "One report",
      enabled: true,
      timezone: "UTC",
      schedule: { kind: "once", at: now + 1000 }
    },
    { kind: "human" }
  )
  now += 1000
  expect(store.dispatchDueRoutines()).toHaveLength(1)
  expect(store.routine(bot.id, routine.id)).toMatchObject({
    enabled: false,
    desiredEnabled: true,
    activationRequired: false,
    effectiveState: "paused",
    nextAt: null
  })
  expect(store.dispatchDueRoutines()).toEqual([])
  const completed = store.routine(bot.id, routine.id)
  expect(
    store.saveRoutine({ ...completed, name: "Completed report" }, { kind: "human" })
  ).toMatchObject({
    enabled: false,
    desiredEnabled: true,
    activationRequired: false,
    effectiveState: "paused",
    nextAt: null
  })
})
it("independent auto-review returns manual activation before model resolution", async () => {
  const { botAutoReviewer } = await import("./auto-review")
  const f = fixture()
  verify(f.store, f.clone.bot.id, f.store.skills(f.clone.bot.id)[0].id)
  const routine = f.store.routines(f.clone.bot.id).find((x) => x.name === "Configured")!
  f.store.send({
    nonce: "review-task",
    conversationId: f.clone.conversationId,
    text: "Resume copied routine"
  })
  const { run, lease } = f.store.claim("review-host")!
  f.store.autoReview.change({
    ...f.store.autoReview.read(f.clone.bot.id),
    isEnabled: true,
    nonce: "review-enable"
  })
  const reviewer = botAutoReviewer({
    request: {
      store: f.store,
      bot: f.clone.bot,
      run,
      lease,
      signal: new AbortController().signal,
      messages: f.store.messagesForRun(run.id)
    },
    modelFile: "must-not-resolve-provider",
    snapshot: { version: 1, defaultRef: null, models: [] },
    config: undefined,
    check: () => f.store.assertLease(lease),
    scope: () => "a".repeat(64)
  })
  expect(
    await reviewer.review({
      routine: { operation: "update", before: routine, after: activation(routine) }
    })
  ).toMatchObject({ decision: "ask", reason: "此例程需要你确认后启用。", model: null })
})
