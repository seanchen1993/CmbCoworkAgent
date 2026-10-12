import { afterEach, expect, it } from "vitest"
import { BotStore } from "./store"
import type { BotPrimaryState } from "../../shared/bot-primary"

const stores: BotStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function fixture() {
  let now = 1_000_000
  const store = new BotStore(":memory:", () => now)
  stores.push(store)
  const main = store.createBot({ nonce: "main", name: "Coordinator" })
  const target = store.createBot({ nonce: "target", name: "Worker" })
  const other = store.createBot({ nonce: "other", name: "Other" })
  store.send({
    nonce: "task",
    conversationId: target.conversationId,
    text: "Complete the existing work"
  })
  const work = store.claim("worker", 300_000)!
  store.primary.change({
    nonce: "choose",
    dataEpoch: store.dataEpoch(),
    revision: 0,
    botId: main.bot.id
  })
  let state = store.primary.configureCheckIn({
    nonce: "followup",
    dataEpoch: store.dataEpoch(),
    revision: 0,
    primaryRevision: store.primary.read().revision,
    botId: main.bot.id,
    enabled: true,
    prompt: "Coordinate and verify the existing work",
    targetBotIds: [target.bot.id, other.bot.id],
    everyMs: 60_000,
    timezone: "UTC"
  })
  return {
    store,
    main,
    target,
    other,
    work,
    advance() {
      now += 60_000
    },
    configuration() {
      return store.primary.read()
    },
    configure(nonce: string) {
      const current = store.primary.read()
      state = store.primary.configureCheckIn({
        nonce,
        dataEpoch: current.dataEpoch,
        revision: current.checkIn!.revision,
        primaryRevision: current.revision,
        botId: main.bot.id,
        enabled: true,
        prompt: state.checkIn!.prompt,
        targetBotIds: state.checkIn!.targetBotIds,
        everyMs: 60_000,
        timezone: "UTC"
      })
      return state
    },
    dispatch() {
      now += 60_000
      const ids = store.dispatchDueRoutines()
      return ids
    },
    fingerprint() {
      return store.db.exec("SELECT fingerprint FROM bot_primary_checkin WHERE id=1")[0]!
        .values[0]![0]
    }
  }
}
function currentRoutine(store: BotStore, state: BotPrimaryState) {
  return store.routine(state.botId!, state.checkIn!.routineId!)
}

it("keeps direct coordination without assigning an extra coordinator role in a group", () => {
  const f = fixture()
  f.store.send({ nonce: "main-direct", conversationId: f.main.conversationId, text: "Coordinate" })
  const direct = f.store.claim("main-direct-host")!
  expect(f.store.primary.coordinationPrompt(direct.run)).toContain("message_bot")
  f.store.finish(direct.lease, "succeeded", "done")
  const group = f.store.createGroup({
    nonce: "room",
    name: "Room",
    members: [f.main.bot.id, f.other.bot.id]
  })
  f.store.send({
    nonce: "main-room",
    conversationId: group.id,
    text: "Work together",
    recipients: [f.main.bot.id]
  })
  const room = f.store.claim("main-room-host")!
  expect(room.run.botId).toBe(f.main.bot.id)
  expect(f.store.primary.coordinationPrompt(room.run)).toBe("")
  expect(f.store.groups.scope(room.run.id)?.prompt).toContain("Work together")
  expect(f.store.primary.coordinationPrompt({ ...room.run, botId: f.other.bot.id })).toBe("")
})

it.each(["failed", "cancelled"] as const)(
  "does not acknowledge a %s check-in; unchanged work can retry on a later occurrence",
  (outcome) => {
    const f = fixture()
    const [first] = f.dispatch()
    expect(first).toBeTruthy()
    const claimed = f.store.claim("main-host", 300_000)!
    expect(claimed.run.id).toBe(first)
    const observed = f.store.db.exec(
      "SELECT observed_fingerprint FROM bot_primary_runs WHERE root_run_id=?",
      [first]
    )[0]!.values[0]![0]
    expect(observed).toMatch(/^[a-f0-9]{64}$/)
    expect(f.fingerprint()).toBeNull()
    f.store.finish(claimed.lease, outcome, "Model did not finish the follow-up")
    expect(f.fingerprint()).toBeNull()
    const [retry] = f.dispatch()
    expect(retry).toBeTruthy()
    expect(retry).not.toBe(first)
  }
)

it("acknowledges successful settlement and skips an unchanged later occurrence", () => {
  const f = fixture()
  const [id] = f.dispatch()
  const claimed = f.store.claim("main-host", 300_000)!
  expect(claimed.run.id).toBe(id)
  f.store.finish(claimed.lease, "succeeded", "Follow-up complete")
  expect(f.fingerprint()).toMatch(/^[a-f0-9]{64}$/)
  expect(f.dispatch()).toEqual([])
})

it("keeps an occurrence exclusive while a successful root still has a live peer; acknowledgement waits for the whole lineage", () => {
  const f = fixture()
  const [id] = f.dispatch()
  const root = f.store.claim("main-host", 300_000)!
  f.store.sendPeer(root.lease, {
    nonce: "peer",
    recipient: f.other.bot.id,
    text: "Review the assigned work",
    intent: "fyi"
  })
  f.store.finish(root.lease, "succeeded", "Awaiting the owned peer")
  expect(f.store.getRun(id).status).toBe("succeeded")
  expect(f.fingerprint()).toBeNull()
  expect(f.dispatch()).toEqual([])
  const peer = f.store.claim("peer-host", 300_000)!
  expect(peer.run.rootRunId).toBe(id)
  f.store.finish(peer.lease, "succeeded", "Review complete")
  expect(f.fingerprint()).toMatch(/^[a-f0-9]{64}$/)
  expect(f.dispatch()).toEqual([])
})

it("counts an automatic result return as live work before confirming the original observed state", () => {
  const f = fixture()
  const [id] = f.dispatch()
  const root = f.store.claim("main-host", 300_000)!
  f.store.sendPeer(root.lease, {
    nonce: "peer",
    recipient: f.other.bot.id,
    text: "Return a result",
    intent: "request"
  })
  f.store.finish(root.lease, "succeeded", "Waiting for result")
  const peer = f.store.claim("peer-host", 300_000)!
  f.store.finish(peer.lease, "succeeded", "Result delivered")
  const returns =
    f.store.db.exec("SELECT id FROM bot_runs WHERE root_run_id=? AND status='queued'", [id])[0]
      ?.values ?? []
  expect(returns).toHaveLength(1)
  expect(f.fingerprint()).toBeNull()
  expect(f.dispatch()).toEqual([])
})

it("retains a monotonically advancing configuration identity across routine delete/recreate and rejects the old root", () => {
  const f = fixture()
  const [id] = f.dispatch()
  const root = f.store.claim("main-host", 300_000)!
  const before = f.configuration(),
    routine = currentRoutine(f.store, before)
  f.store.deleteRoutine({
    nonce: "delete",
    botId: f.main.bot.id,
    id: routine.id,
    revision: routine.revision
  })
  const deleted = f.configuration()
  expect(deleted.checkIn).toMatchObject({ enabled: false, routineId: null })
  expect(deleted.checkIn!.revision).toBeGreaterThan(before.checkIn!.revision)
  expect(() => f.store.primary.assertDispatch(f.store.getRun(id))).toThrow(
    expect.objectContaining({ code: "primary_scope_revoked" })
  )
  const recreated = f.configure("recreate")
  expect(recreated.checkIn!.routineId).not.toBe(routine.id)
  expect(recreated.checkIn!.revision).toBeGreaterThan(deleted.checkIn!.revision)
  expect(() => f.store.primary.assertDispatch(f.store.getRun(id))).toThrow(
    expect.objectContaining({ code: "primary_scope_revoked" })
  )
  // The cancellation acknowledgement is not external-effect settlement.
  expect(f.store.getRun(root.run.id).status).toBe("cancelling")
})

it("a regular managed-routine edit revokes its original primary authority and cannot silently reactivate follow-up", () => {
  const f = fixture()
  const [id] = f.dispatch()
  f.store.claim("main-host", 300_000)!
  const before = f.configuration(),
    routine = currentRoutine(f.store, before)
  f.store.saveRoutine(
    {
      expectedDataEpoch: f.store.dataEpoch(),
      nonce: "ordinary-edit",
      id: routine.id,
      revision: routine.revision,
      botId: routine.botId,
      name: routine.name,
      prompt: "Different responsibility",
      schedule: routine.schedule,
      timezone: routine.timezone,
      enabled: true
    },
    { kind: "human" }
  )
  expect(f.configuration().checkIn!.enabled).toBe(false)
  expect(f.configuration().checkIn!.revision).toBeGreaterThan(before.checkIn!.revision)
  expect(() => f.store.primary.assertDispatch(f.store.getRun(id))).toThrow(
    expect.objectContaining({ code: "primary_scope_revoked" })
  )
  expect(f.dispatch()).toEqual([])
})

it("a managed routine converted to an event cannot bypass primary admission", () => {
  const f = fixture()
  const state = f.configuration(),
    routine = currentRoutine(f.store, state)
  f.store.saveRoutine(
    {
      expectedDataEpoch: f.store.dataEpoch(),
      nonce: "event-edit",
      id: routine.id,
      revision: routine.revision,
      botId: routine.botId,
      name: routine.name,
      prompt: "Different responsibility",
      schedule: { kind: "event", topic: "changed" },
      timezone: routine.timezone,
      enabled: true
    },
    { kind: "human" }
  )
  expect(f.configuration().checkIn!.enabled).toBe(false)
  expect(f.store.emitEvent({ nonce: "fire", topic: "changed", payload: "event" }).runIds).toEqual(
    []
  )
  expect(() => f.store.primary.assertRoutineEvent(routine.id)).toThrow(
    expect.objectContaining({ code: "primary_routine_scope" })
  )
})

it("stopping follow-up remains possible after a participant was deleted and never creates a new routine", () => {
  const f = fixture()
  const current = f.configuration()
  const other = f.store.getBot(f.other.bot.id)
  f.store.deleteBot(other.id, other.revision, f.store.dataEpoch())
  const stopped = f.store.primary.configureCheckIn({
    nonce: "stop",
    dataEpoch: current.dataEpoch,
    revision: current.checkInRevision,
    primaryRevision: current.revision,
    botId: current.botId!,
    enabled: false,
    prompt: current.checkIn!.prompt,
    targetBotIds: current.checkIn!.targetBotIds,
    everyMs: current.checkIn!.everyMs,
    timezone: current.checkIn!.timezone
  })
  expect(stopped.checkIn!.enabled).toBe(false)
  expect(stopped.checkInRevision).toBeGreaterThan(current.checkInRevision)
  expect(stopped.checkIn!.routineId).toBe(current.checkIn!.routineId)
  expect(f.dispatch()).toEqual([])
})

it.each(["failed", "cancelled"] as const)(
  "a successful root cannot acknowledge a %s descendant",
  (outcome) => {
    const f = fixture()
    const [id] = f.dispatch()
    const root = f.store.claim("main-host", 300_000)!
    f.store.sendPeer(root.lease, {
      nonce: "peer",
      recipient: f.other.bot.id,
      text: "Review the work",
      intent: "fyi"
    })
    f.store.finish(root.lease, "succeeded", "Follow-up started")
    const peer = f.store.claim("peer-host", 300_000)!
    f.store.finish(peer.lease, outcome, "Peer did not finish")
    expect(f.store.getRun(id).status).toBe("succeeded")
    expect(f.fingerprint()).toBeNull()
    expect(f.dispatch()).toHaveLength(1)
  }
)

it("an unknown descendant effect retains review and blocks another automatic occurrence", () => {
  const f = fixture()
  const [id] = f.dispatch()
  const root = f.store.claim("main-host", 300_000)!
  f.store.sendPeer(root.lease, {
    nonce: "peer",
    recipient: f.other.bot.id,
    text: "Review the work",
    intent: "fyi"
  })
  f.store.finish(root.lease, "succeeded", "Follow-up started")
  const peer = f.store.claim("peer-host", 300_000)!
  const action = { op: "submit" }
  const approval = f.store.requestInteraction(peer.lease, {
    kind: "approval",
    prompt: "Submit",
    action
  })
  f.store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
  f.store.beginEffect(peer.lease, { id: "unknown-effect", action, approvalId: approval.id })
  const pending = f.store.finish(peer.lease, "succeeded", "Result is not confirmed")
  expect(pending.status).toBe("needs_review")
  expect(f.store.getRun(id).status).toBe("succeeded")
  expect(f.fingerprint()).toBeNull()
  expect(f.dispatch()).toEqual([])
})

it("primary composite mutations remain atomic without relaxing the public nested-transaction guard", () => {
  const store = new BotStore(":memory:")
  stores.push(store)
  const input = {
    nonce: "ensure",
    dataEpoch: store.dataEpoch(),
    revision: 0,
    profile: {
      name: "Coordinator",
      instructions: "Coordinate assigned work",
      modelRef: null,
      workspacePath: null
    }
  }
  const result = store.primary.ensure(input)
  expect(result.outcome).toBe("created")
  expect(store.getBot(result.botId!).pinned).toBe(true)
  expect(store.primary.ensure(input)).toEqual(result)
  expect(store.listBots()).toHaveLength(1)
  expect(() => store.transaction(() => store.transaction(() => undefined))).toThrow(
    expect.objectContaining({ code: "nested_transaction" })
  )
  const before = store.primary.read()
  expect(() =>
    store.primary.change({
      nonce: "missing-bot",
      revision: before.revision,
      dataEpoch: before.dataEpoch,
      botId: "00000000-0000-4000-8000-000000000001"
    })
  ).toThrow(expect.objectContaining({ code: "not_found" }))
  expect(store.primary.read()).toEqual(before)
  expect(() => store.transaction(() => store.transaction(() => undefined))).toThrow(
    expect.objectContaining({ code: "nested_transaction" })
  )
})
