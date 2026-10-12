import { afterEach, expect, it, vi } from "vitest"
import { BotStore } from "./store"
import { BotWorkflowStore } from "./workflow-store"
const stores: BotStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function fixture() {
  const store = new BotStore(":memory:")
  stores.push(store)
  const a = store.createBot({ nonce: "a", name: "Planner" }),
    b = store.createBot({ nonce: "b", name: "Reviewer" }),
    c = store.createBot({ nonce: "c", name: "Verifier" })
  store.send({ nonce: "task", conversationId: a.conversationId, text: "Check this work" })
  const parent = store.claim("host-a")!
  const sent = store.sendPeer(parent.lease, {
    nonce: "handoff",
    recipient: b.bot.id,
    text: "Do the assigned work"
  })
  return { store, a, b, c, parent, sent }
}
it("cancels an owned queued peer without cancelling recipient unrelated user work", () => {
  const f = fixture()
  const unrelated = f.store.send({
    nonce: "unrelated",
    conversationId: f.b.conversationId,
    text: "Separate task"
  })
  f.store.cancel(f.parent.run.id)
  expect(f.store.getRun(f.sent.runIds[0]).status).toBe("cancelled")
  expect(f.store.getRun(unrelated.runIds[0]).status).toBe("queued")
  expect(f.store.claim("host-b")?.run.id).toBe(unrelated.runIds[0])
})
it("revokes an owned running peer first effect after cancelling its parent, even with a prior manual approval", () => {
  const f = fixture()
  const peer = f.store.claim("host-b")!
  const action = { connector: { tool: "publish", arguments: {} } }
  const approval = f.store.requestInteraction(peer.lease, {
    kind: "approval",
    prompt: "Publish assigned result?",
    action
  })
  f.store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
  f.store.cancel(f.parent.run.id)
  expect(() =>
    f.store.beginEffect(peer.lease, { id: "first-effect", action, approvalId: approval.id })
  ).toThrow()
  expect(f.store.effects(peer.run.id)).toEqual([])
})
it("propagates to a multi-Bot descendant without requiring the parent to await that peer", () => {
  const f = fixture()
  const peer = f.store.claim("host-b")!
  const next = f.store.sendPeer(peer.lease, {
    nonce: "next",
    recipient: f.c.bot.id,
    text: "Verify the assigned work"
  })
  f.store.cancel(f.parent.run.id)
  expect(f.store.getRun(peer.run.id).status).toBe("cancelling")
  expect(f.store.getRun(next.runIds[0]).status).toBe("cancelled")
})

function approve(
  store: BotStore,
  lease: Parameters<BotStore["beginEffect"]>[0],
  label = "publish"
) {
  const action = { connector: { tool: label, arguments: {} } }
  const approval = store.requestInteraction(lease, {
    kind: "approval",
    prompt: "Approve assigned action?",
    action
  })
  store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
  return { action, approvalId: approval.id }
}
it("keeps a successful parent async assignment active and independently claimable", () => {
  const f = fixture()
  expect(f.store.finish(f.parent.lease, "succeeded", "Assigned for later").status).toBe("succeeded")
  f.store.cancel(f.parent.run.id)
  expect(f.store.getRun(f.sent.runIds[0]).status).toBe("queued")
  expect(f.store.claim("host-b")?.run.id).toBe(f.sent.runIds[0])
})
it("allows a started peer effect to settle while refusing new dispatch after the parent stops", () => {
  const f = fixture(),
    peer = f.store.claim("host-b")!
  const action = approve(f.store, peer.lease)
  f.store.beginEffect(peer.lease, { id: "started", ...action })
  const independent = f.store.send({
    nonce: "independent",
    conversationId: f.c.conversationId,
    text: "Independent task"
  })
  f.store.cancel(f.parent.run.id)
  f.store.settleEffect(peer.lease, "started", "succeeded", "Committed once")
  expect(f.store.effects(peer.run.id)).toMatchObject([
    { id: "started", status: "succeeded", result: "Committed once" }
  ])
  expect(f.store.finish(peer.lease, "succeeded", "Committed once").status).toBe("cancelled")
  expect(f.store.getRun(independent.runIds[0]).status).toBe("queued")
})
it("retains a peer unknown effect for review while stopping that peer queued descendants", () => {
  const f = fixture(),
    peer = f.store.claim("host-b")!
  const descendant = f.store.sendPeer(peer.lease, {
    nonce: "next",
    recipient: f.c.bot.id,
    text: "Verify later"
  })
  const action = approve(f.store, peer.lease)
  f.store.beginEffect(peer.lease, { id: "uncertain", ...action })
  f.store.settleEffect(peer.lease, "uncertain", "unknown", "Transport acknowledgement lost")
  expect(f.store.finish(peer.lease, "failed", "Needs checking").status).toBe("needs_review")
  f.store.cancel(f.parent.run.id)
  expect(f.store.getRun(peer.run.id).status).toBe("needs_review")
  expect(f.store.effects(peer.run.id)).toMatchObject([{ id: "uncertain", status: "unknown" }])
  expect(f.store.getRun(descendant.runIds[0]).status).toBe("cancelled")
})
it("stops owned peers when a reviewed interrupted parent is explicitly ended, preserving exact acknowledgement retry", () => {
  const f = fixture()
  f.store.fenceOwner("host-a", "Host interrupted")
  const reviewed = f.store.getRun(f.parent.run.id)
  const request = {
    id: reviewed.id,
    revision: reviewed.revision,
    decision: "cancel" as const,
    effects: [],
    note: "End the assignment",
    nonce: "review-stop",
    dataEpoch: f.store.backupSchedule.epoch()
  }
  const receipt = f.store.recover(request)
  expect(f.store.recover(request)).toEqual(receipt)
  expect(f.store.getRun(f.sent.runIds[0]).status).toBe("cancelled")
  expect(
    f.store
      .events()
      .filter(
        (event) => event.entityId === f.sent.runIds[0] && event.kind === "run.cancel_requested"
      )
  ).toHaveLength(1)
})
it("ends each owned peer once even when persisted ancestry contains a cycle", () => {
  const f = fixture(),
    peer = f.store.claim("host-b")!
  const descendant = f.store.sendPeer(peer.lease, {
    nonce: "next",
    recipient: f.c.bot.id,
    text: "Verify later"
  })
  f.store.db.run("UPDATE bot_runs SET parent_run_id=? WHERE id=?", [
    descendant.runIds[0],
    f.parent.run.id
  ])
  f.store.cancel(f.parent.run.id)
  f.store.cancel(f.parent.run.id)
  for (const id of [peer.run.id, descendant.runIds[0]])
    expect(
      f.store
        .events()
        .filter((event) => event.entityId === id && event.kind === "run.cancel_requested")
    ).toHaveLength(1)
})
it("rolls peer statuses, pending interactions and events back with the parent if cancellation fails", () => {
  const f = fixture(),
    peer = f.store.claim("host-b")!
  const question = f.store.requestInteraction(peer.lease, {
    kind: "question",
    prompt: "Which result?"
  })
  const events = f.store.events()
  f.store.db.run(`CREATE TRIGGER fail_parent_cancel BEFORE UPDATE OF status ON bot_runs
    WHEN OLD.id='${f.parent.run.id}' AND NEW.status='cancelling'
    BEGIN SELECT RAISE(ABORT, 'fixture cancellation commit failed'); END;`)
  expect(() => f.store.cancel(f.parent.run.id)).toThrow("fixture cancellation commit failed")
  expect(f.store.getRun(f.parent.run.id).status).toBe("running")
  expect(f.store.getRun(peer.run.id).status).toBe("waiting_input")
  expect(f.store.getInteraction(question.id).status).toBe("pending")
  expect(f.store.events()).toEqual(events)
  f.store.db.run("DROP TRIGGER fail_parent_cancel")
  f.store.cancel(f.parent.run.id)
  expect(f.store.getRun(peer.run.id).status).toBe("cancelling")
  expect(f.store.getInteraction(question.id).status).toBe("cancelled")
})
it("follows internal workflow ancestry without cancelling a sibling independent assignment", () => {
  const f = fixture()
  const definition = {
    script: 'export const meta={name:"Check",description:"Check"};return 1;',
    maxConcurrency: 1,
    defaultModelId: "configured",
    agentProfiles: [],
    authority: {}
  }
  const workflow = BotWorkflowStore.open(f.store, f.parent.lease, "workflow", definition)
  const child = f.store.workflowChildren.claim(workflow, f.parent.lease, {
    prompt: "Inspect assigned data",
    label: "Inspector",
    phase: null,
    agentIndex: 1,
    toolStreamKey: "a".repeat(64) + "_c0",
    durableCallKey: "a".repeat(64) + "_n0",
    shellAccess: "read_only"
  })
  const nestedPeer = f.store.sendPeer(child.lease!, {
    nonce: "workflow-handoff",
    recipient: f.c.bot.id,
    text: "Verify child findings"
  })
  const separate = f.store.send({
    nonce: "separate",
    conversationId: f.c.conversationId,
    text: "Unrelated request"
  })
  f.store.cancel(f.parent.run.id)
  expect(f.store.getRun(child.run.id).status).toBe("cancelling")
  expect(f.store.getRun(nestedPeer.runIds[0]).status).toBe("cancelled")
  expect(f.store.getRun(separate.runIds[0]).status).toBe("queued")
})

it("uses the durable root/parent index instead of rebuilding an index over historical runs on cancellation", () => {
  const f = fixture()
  const queries = vi.spyOn(f.store.db, "prepare")
  f.store.cancel(f.parent.run.id)
  const ancestry = queries.mock.calls.find(([query]) => query.startsWith("WITH RECURSIVE owned"))!
  expect(ancestry).toBeDefined()
  const plan = f.store.db
    .exec("EXPLAIN QUERY PLAN " + ancestry[0], ancestry[1])[0]
    .values.map((row) => String(row[3]))
  expect(plan).toContain(
    "SEARCH child USING INDEX bot_run_owned_children (root_run_id=? AND parent_run_id=?)"
  )
  expect(plan).toContain("SEARCH r USING INDEX sqlite_autoindex_bot_runs_1 (id=?)")
  expect(plan.some((detail) => detail.includes("AUTOMATIC"))).toBe(false)
})

it("stops a descendant through a successfully completed intermediate peer without revising the completed result", () => {
  const f = fixture(),
    peer = f.store.claim("host-b")!
  const descendant = f.store.sendPeer(peer.lease, {
    nonce: "next",
    recipient: f.c.bot.id,
    text: "Verify later"
  })
  f.store.finish(peer.lease, "succeeded", "Verifier assigned")
  const completed = f.store.getRun(peer.run.id)
  f.store.cancel(f.parent.run.id)
  expect(f.store.getRun(peer.run.id)).toEqual(completed)
  expect(f.store.getRun(descendant.runIds[0]).status).toBe("cancelled")
})
