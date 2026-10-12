import { afterEach, expect, it } from "vitest"
import { BotStore } from "./store"
import { canonicalJson } from "./validation"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
const stores: BotStore[] = []
const directories: string[] = []
afterEach(() => {
  stores.splice(0).forEach((store) => store.close())
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
})
function fixture(store = new BotStore(":memory:")) {
  stores.push(store)
  const a = store.createBot({ nonce: "a", name: "Planner" }),
    b = store.createBot({ nonce: "b", name: "Specialist" }),
    c = store.createBot({ nonce: "c", name: "Reviewer" })
  const start = store.send({
    nonce: "user",
    conversationId: a.conversationId,
    text: "Original goal"
  })
  const parent = store.claim("a")!
  const sent = store.sendPeer(parent.lease, {
    nonce: "send",
    recipient: b.bot.id,
    text: "Actual work"
  })
  return { store, a, b, c, start, parent, sent }
}
it("ordinary direct reply needs no intent and owns the response route exactly once", () => {
  const f = fixture()
  f.store.finish(f.parent.lease, "succeeded", "Independent finished")
  const b = f.store.claim("b")!
  const reply = f.store.sendPeer(b.lease, {
    nonce: "reply",
    recipient: f.a.bot.id,
    text: "EXPLICIT RESULT"
  })
  expect(reply.runIds).toHaveLength(1)
  expect(
    f.store.sendPeer(b.lease, {
      nonce: "reply",
      recipient: f.a.bot.id,
      text: "EXPLICIT RESULT"
    })
  ).toEqual(reply)
  expect(f.store.peerDispatch.read(reply.runIds[0])?.intent).toBe("reply")
  f.store.finish(b.lease, "succeeded", "LOCAL FINAL")
  expect(f.store.messages(f.a.conversationId).filter((m) => m.text === "LOCAL FINAL")).toHaveLength(
    0
  )
  expect(f.store.messages(f.b.conversationId).filter((m) => m.text === "LOCAL FINAL")).toHaveLength(
    1
  )
  expect(
    f.store.db.exec("SELECT id FROM bot_runs WHERE bot_id=? ORDER BY rowid", [f.a.bot.id])[0].values
  ).toHaveLength(2)
})
it.each(["status", "question", "fyi"] as const)(
  "%s update retains one automatic final response",
  (intent) => {
    const f = fixture()
    f.store.finish(f.parent.lease, "succeeded", "Independent finished")
    const b = f.store.claim("b")!
    const reply = f.store.sendPeer(b.lease, {
      nonce: "update",
      recipient: f.a.bot.id,
      text: "UPDATE",
      intent
    })
    f.store.finish(b.lease, "succeeded", "FINAL RESULT")
    expect(f.store.peerDispatch.read(b.run.id)?.manualResponseSent).toBe(false)
    const runs = f.store.db.exec("SELECT id FROM bot_runs WHERE bot_id=? ORDER BY rowid", [
      f.a.bot.id
    ])[0].values
    expect(runs).toHaveLength(3)
    const automatic = runs
      .map(([id]) => f.store.peerDispatch.read(String(id)))
      .filter((m) => m?.automatic)
    expect(automatic).toHaveLength(1)
    expect(reply.runIds).toHaveLength(1)
  }
)
it("no explicit reply returns actual result and creates one fresh result turn", () => {
  const f = fixture()
  f.store.finish(f.parent.lease, "succeeded", "Independent finished")
  const b = f.store.claim("b")!
  f.store.finish(b.lease, "succeeded", "ACTUAL RESULT")
  const runs = f.store.db.exec("SELECT id FROM bot_runs WHERE bot_id=? ORDER BY rowid", [
    f.a.bot.id
  ])[0].values
  expect(runs).toHaveLength(2)
  expect(f.store.peerDispatch.read(String(runs[1][0]))).toMatchObject({
    intent: "result",
    automatic: true,
    activationScopeRunId: f.parent.run.id
  })
  expect(
    f.store.messages(f.a.conversationId).filter((m) => m.text === "ACTUAL RESULT")
  ).toHaveLength(1)
})
it("await child terminal keeps original turn without creating a duplicate result turn", () => {
  const f = fixture()
  f.store.waitForPeer(f.parent.lease, f.sent.runIds[0])
  const b = f.store.claim("b")!
  f.store.finish(b.lease, "succeeded", "AWAIT RESULT")
  expect(f.store.waitForPeer(f.parent.lease, b.run.id).status).toBe("succeeded")
  expect(f.store.getRun(f.parent.run.id).status).toBe("running")
  expect(
    f.store.db.exec("SELECT id FROM bot_runs WHERE bot_id=? ORDER BY rowid", [f.a.bot.id])[0].values
  ).toHaveLength(1)
})
it("ancestor reply leaves the immediate parent response intact and preserves root budget", () => {
  const f = fixture()
  f.store.finish(f.parent.lease, "succeeded", "Root finished")
  const b = f.store.claim("b")!
  const bc = f.store.sendPeer(b.lease, {
    nonce: "bc",
    recipient: f.c.bot.id,
    text: "Review"
  })
  f.store.finish(b.lease, "succeeded", "B finished")
  const c = f.store.claim("c")!
  expect(c.run.id).toBe(bc.runIds[0])
  const reply = f.store.sendPeer(c.lease, {
    nonce: "ca",
    recipient: f.a.bot.id,
    text: "Root progress"
  })
  expect(f.store.getRun(reply.runIds[0])).toMatchObject({
    rootRunId: c.run.rootRunId,
    parentRunId: c.run.id,
    depth: c.run.depth + 1
  })
  expect(f.store.peerDispatch.read(c.run.id)?.manualResponseSent).toBe(false)
  f.store.finish(c.lease, "succeeded", "C final")
  expect(f.store.messages(f.b.conversationId).some((m) => m.text === "C final")).toBe(true)
})
it("default false and absent fields retain original receipt hash; altered intent conflicts", () => {
  const f = fixture()
  const request = {
    op: "peer",
    parentId: f.parent.run.id,
    recipient: f.b.bot.id,
    content: "Actual work"
  }
  const hash = createHash("sha256").update(canonicalJson(request)).digest("hex")
  expect(
    f.store.db.exec("SELECT request_hash FROM bot_receipts WHERE nonce=?", ["send"])[0].values[0][0]
  ).toBe(hash)
  expect(
    f.store.sendPeer(f.parent.lease, {
      nonce: "send",
      recipient: f.b.bot.id,
      text: "Actual work",
      priority: false,
      images: []
    })
  ).toEqual(f.sent)
  expect(() =>
    f.store.sendPeer(f.parent.lease, {
      nonce: "send",
      recipient: f.b.bot.id,
      text: "Actual work",
      intent: "question"
    })
  ).toThrowError(/同一/)
})
it("return needs_review never becomes an executable success result turn", () => {
  const f = fixture()
  f.store.finish(f.parent.lease, "succeeded", "Root finished")
  const b = f.store.claim("b")!
  const action = { test: true }
  const approval = f.store.requestInteraction(b.lease, {
    kind: "approval",
    prompt: "Approve exact action",
    action
  })
  f.store.answerInteraction({
    id: approval.id,
    revision: approval.revision,
    answer: "approve"
  })
  f.store.beginEffect(b.lease, {
    id: "uncertain",
    action,
    approvalId: approval.id
  })
  expect(f.store.finish(b.lease, "succeeded", "UNCONFIRMED SUCCESS").status).toBe("needs_review")
  expect(
    f.store.db.exec("SELECT id FROM bot_runs WHERE bot_id=? ORDER BY rowid", [f.a.bot.id])[0].values
  ).toHaveLength(1)
  expect(f.store.messages(f.a.conversationId).some((m) => m.text === "UNCONFIRMED SUCCESS")).toBe(
    false
  )
})
it.each(["reply", "status", "question"] as const)(
  "awaited %s merges into the existing durable inbox without another target run",
  (intent) => {
    const f = fixture()
    f.store.waitForPeer(f.parent.lease, f.sent.runIds[0])
    const b = f.store.claim("b")!
    const input = {
      nonce: "waiting-update",
      recipient: f.a.bot.id,
      text: "WAITING SUBSTANCE",
      ...(intent === "reply" ? {} : { intent })
    }
    const delivered = f.store.sendPeer(b.lease, input)
    expect(delivered).toMatchObject({
      runIds: [],
      mergedIntoRunId: f.parent.run.id,
      responseRoute: intent === "reply" ? "explicit" : "automatic"
    })
    expect(f.store.sendPeer(b.lease, input)).toEqual(delivered)
    expect(f.store.steering.hasPending(f.parent.run.id)).toBe(true)
    expect(
      f.store.db.exec("SELECT id FROM bot_runs WHERE bot_id=?", [f.a.bot.id])[0].values
    ).toHaveLength(1)
    expect(() => f.store.steering.interruptIfPending(f.parent.lease)).toThrowError(/补充/)
    expect(f.store.getRun(f.parent.run.id).status).toBe("running")
    expect(
      f.store.message({
        conversationId: f.a.conversationId,
        id: delivered.messageId
      })
    ).toMatchObject({ sender: "bot", botId: f.b.bot.id, runId: b.run.id })
  }
)
it("awaited peer question is model input with real bot sender and original authority, and can be answered asynchronously", async () => {
  const f = fixture()
  f.store.waitForPeer(f.parent.lease, f.sent.runIds[0])
  const b = f.store.claim("b")!
  const question = f.store.sendPeer(b.lease, {
    nonce: "question",
    recipient: f.a.bot.id,
    text: "WHICH DIRECTION?",
    intent: "question"
  })
  expect(() => f.store.steering.interruptIfPending(f.parent.lease)).toThrowError(/补充/)
  const accepted = await f.store.steering.queue(f.parent.lease).take({
    threadId: f.parent.run.id,
    ownerRunToken: `${f.parent.lease.owner}:${f.parent.lease.fence}`,
    appliedIds: [],
    phase: "beforeModel"
  })
  expect(accepted).toHaveLength(1)
  expect(accepted[0].content).toContain("another bot reaching out, not the user")
  expect(accepted[0].content).toContain("question")
  expect(accepted[0].id).toBe(question.messageId)
  const answer = f.store.sendPeer(f.parent.lease, {
    nonce: "answer",
    recipient: f.b.bot.id,
    text: "USE VERIFIED DATA"
  })
  expect(f.store.peerDispatch.read(answer.runIds[0])?.intent).toBe("reply")
  expect(f.store.peerDispatch.read(b.run.id)?.manualResponseSent).toBe(false)
})
it("corrupt ancestor cycles are bounded and do not create a message, run or receipt", () => {
  const f = fixture()
  f.store.finish(f.parent.lease, "succeeded", "Done")
  const b = f.store.claim("b")!
  f.store.db.run("UPDATE bot_runs SET parent_run_id=?,depth=? WHERE id=?", [
    b.run.id,
    b.run.depth + 1,
    f.parent.run.id
  ])
  const before = f.store.db.exec("SELECT COUNT(*) FROM bot_runs")[0].values[0][0]
  expect(() =>
    f.store.sendPeer(b.lease, {
      nonce: "cycle",
      recipient: f.c.bot.id,
      text: "Not sent"
    })
  ).toThrowError(/关联/)
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_runs")[0].values[0][0]).toBe(before)
  expect(
    f.store.db.exec("SELECT 1 FROM bot_receipts WHERE nonce=?", ["cycle"])[0].values
  ).toHaveLength(0)
})
it("direct explicit result owns response; a direct question never claims final delivery", () => {
  const f = fixture()
  f.store.finish(f.parent.lease, "succeeded", "Done")
  const b = f.store.claim("b")!
  const result = f.store.sendPeer(b.lease, {
    nonce: "result",
    recipient: f.a.bot.id,
    text: "Exact result",
    intent: "result"
  })
  expect(result.responseRoute).toBe("explicit")
  expect(f.store.peerDispatch.read(b.run.id)?.manualResponseSent).toBe(true)
  f.store.finish(b.lease, "succeeded", "Local detail")
  expect(
    f.store.messages(f.a.conversationId).filter((m) => m.text === "Local detail")
  ).toHaveLength(0)
})
it("eight-depth and sixty-four-run budget rejects before any new messages or receipts", () => {
  const f = fixture()
  f.store.finish(f.parent.lease, "succeeded", "Done")
  const b = f.store.claim("b")!
  f.store.db.run("UPDATE bot_runs SET depth=8 WHERE id=?", [b.run.id])
  expect(() =>
    f.store.sendPeer(b.lease, {
      nonce: "limit-depth",
      recipient: f.c.bot.id,
      text: "No new work"
    })
  ).toThrowError(/关联|上限/)
  expect(
    f.store.db.exec("SELECT COUNT(*) FROM bot_receipts WHERE nonce=?", ["limit-depth"])[0]
      .values[0][0]
  ).toBe(0)
})
it("a peer update arriving past the graph input boundary stays peer/agent work in the original root, never a new user task", () => {
  const f = fixture()
  f.store.waitForPeer(f.parent.lease, f.sent.runIds[0])
  const b = f.store.claim("b")!
  const update = f.store.sendPeer(b.lease, {
    nonce: "late-update",
    recipient: f.a.bot.id,
    text: "LATE_ACTUAL_RESPONSE"
  })
  expect(() => f.store.steering.interruptIfPending(f.parent.lease)).toThrow(/补充/)
  // The real completion boundary can commit before accepting this inbox item.
  f.store.finish(f.parent.lease, "succeeded", "Final boundary already captured")
  const state = f.store.steering.state(update.messageId)!,
    next = f.store.getRun(state.runId)
  expect(state.state).toBe("queued")
  expect(next).toMatchObject({
    source: "peer",
    lane: "agent",
    parentRunId: b.run.id,
    rootRunId: b.run.rootRunId,
    messageId: update.messageId
  })
  expect(f.store.peerDispatch.requiresAdmission(next.id)).toBe(true)
  expect(
    f.store.message({
      conversationId: f.a.conversationId,
      id: update.messageId
    }).peerExchanges
  ).toMatchObject([
    {
      mergedMessageId: update.messageId,
      direction: "incoming",
      anchor: { runId: f.parent.run.id }
    }
  ])
})
it("automatic final return remains an exact read-only exchange instead of an invented missing-parent relation", () => {
  const f = fixture()
  f.store.finish(f.parent.lease, "succeeded", "Assigned")
  const b = f.store.claim("b")!
  f.store.finish(b.lease, "succeeded", "AUTO_READABLE")
  const runId = String(
    f.store.db.exec("SELECT run_id FROM bot_peer_dispatch WHERE automatic=1")[0].values[0][0]
  )
  const view = f.store.peerExchanges.read({
    anchor: { conversationId: f.a.conversationId, runId },
    peerRunId: runId,
    expectedDataEpoch: "initial"
  })
  expect(view.request.text).toBe("AUTO_READABLE")
  expect(view.sender.botId).toBe(f.b.bot.id)
  expect(view.recipient.botId).toBe(f.a.bot.id)
})
it("a real eight-deep original collaboration chain cannot allocate a ninth level", () => {
  const store = new BotStore(":memory:")
  stores.push(store)
  const bots = Array.from({ length: 10 }, (_, i) =>
    store.createBot({ nonce: `depth-${i}`, name: `Depth ${i}` })
  )
  store.send({
    nonce: "depth-root",
    conversationId: bots[0].conversationId,
    text: "Real chain"
  })
  let owner = store.claim("root")!
  for (let i = 1; i <= 8; i++) {
    const sent = store.sendPeer(owner.lease, {
      nonce: `depth-send-${i}`,
      recipient: bots[i].bot.id,
      text: `Task ${i}`
    })
    store.waitForPeer(owner.lease, sent.runIds[0])
    owner = store.claim(`depth-owner-${i}`)!
    expect(owner.run.depth).toBe(i)
  }
  expect(() =>
    store.sendPeer(owner.lease, {
      nonce: "ninth",
      recipient: bots[9].bot.id,
      text: "No extra depth"
    })
  ).toThrow(/上限/)
  expect(store.db.exec("SELECT COUNT(*) FROM bot_runs")[0].values[0][0]).toBe(9)
  expect(
    store.db.exec("SELECT COUNT(*) FROM bot_receipts WHERE nonce='ninth'")[0].values[0][0]
  ).toBe(0)
})
it("the original sixty-four-run root budget also bounds automatic final wake without rolling back the real child result", () => {
  const f = fixture()
  for (let i = 0; i < 62; i++)
    f.store.sendPeer(f.parent.lease, {
      nonce: `root-child-${i}`,
      recipient: f.b.bot.id,
      text: `Actual task ${i}`
    })
  expect(() =>
    f.store.sendPeer(f.parent.lease, {
      nonce: "overflow",
      recipient: f.c.bot.id,
      text: "No extra child"
    })
  ).toThrow(/上限/)
  f.store.finish(f.parent.lease, "succeeded", "Root independently finished")
  const child = f.store.claim("bounded-child")!
  f.store.finish(child.lease, "succeeded", "REAL_BOUNDED_RESULT")
  expect(f.store.getRun(child.run.id).status).toBe("succeeded")
  expect(f.store.messages(f.a.conversationId).some((m) => m.text === "REAL_BOUNDED_RESULT")).toBe(
    true
  )
  expect(
    f.store.db.exec("SELECT COUNT(*) FROM bot_runs WHERE root_run_id=?", [
      f.parent.run.rootRunId
    ])[0].values[0][0]
  ).toBe(64)
})

it("consumes an exact automatic result already queued before await without running a duplicate source turn", () => {
  const f = fixture()
  const approval = f.store.requestInteraction(f.parent.lease, {
    kind: "approval",
    prompt: "Approve another collaborator",
    action: { next: "request" }
  })
  const child = f.store.claim("child")!
  f.store.finish(child.lease, "succeeded", "ACTUAL_EARLY_RESULT")
  const queued = String(
    f.store.db.exec("SELECT run_id FROM bot_peer_dispatch WHERE automatic=1")[0].values[0][0]
  )
  expect(f.store.getRun(queued).status).toBe("queued")
  expect(f.store.getInteraction(approval.id).status).toBe("pending")
  f.store.answerInteraction({
    id: approval.id,
    revision: approval.revision,
    answer: "approve"
  })
  expect(f.store.waitForPeer(f.parent.lease, child.run.id)).toMatchObject({
    status: "succeeded",
    result: "ACTUAL_EARLY_RESULT"
  })
  expect(f.store.getRun(queued)).toMatchObject({
    status: "cancelled",
    result: null,
    error: null,
    fence: 0
  })
  expect(
    f.store.messages(f.a.conversationId).filter((m) => m.text === "ACTUAL_EARLY_RESULT")
  ).toHaveLength(1)
  const view = f.store.peerExchanges.read({
    anchor: { conversationId: f.a.conversationId, runId: queued },
    peerRunId: queued,
    expectedDataEpoch: "initial"
  })
  expect(view.request.text).toBe("ACTUAL_EARLY_RESULT")
  expect(f.store.waitForPeer(f.parent.lease, child.run.id).result).toBe("ACTUAL_EARLY_RESULT")
  f.store.finish(f.parent.lease, "succeeded", "CONSOLIDATED_ONCE")
  expect(f.store.claim("should-not-run")).toBeNull()
  expect(
    f.store.events(0, 1000).filter((e) => e.kind === "run.settled" && e.entityId === queued)
  ).toHaveLength(1)
})

it("consumption only suppresses the exact child's automatic return and retains sibling and explicit reply turns", () => {
  const f = fixture()
  const second = f.store.sendPeer(f.parent.lease, {
    nonce: "second",
    recipient: f.c.bot.id,
    text: "SECOND_WORK"
  })
  const child = f.store.claim("child-one")!
  f.store.finish(child.lease, "succeeded", "CHILD_ONE_RESULT")
  const sibling = f.store.claim("child-two")!
  expect(sibling.run.id).toBe(second.runIds[0])
  const explicit = f.store.sendPeer(sibling.lease, {
    nonce: "explicit",
    recipient: f.a.bot.id,
    text: "EXPLICIT_SEPARATE_REPLY",
    intent: "result"
  })
  f.store.finish(sibling.lease, "succeeded", "LOCAL_SIBLING_FINAL")
  expect(f.store.waitForPeer(f.parent.lease, sibling.run.id).result).toBe("LOCAL_SIBLING_FINAL")
  expect(f.store.getRun(explicit.runIds[0]).status).toBe("queued")
  const automatic = String(
    f.store.db.exec("SELECT run_id FROM bot_peer_dispatch WHERE automatic=1")[0].values[0][0]
  )
  expect(f.store.getRun(automatic).status).toBe("queued")
  expect(f.store.waitForPeer(f.parent.lease, child.run.id).result).toBe("CHILD_ONE_RESULT")
  expect(f.store.getRun(automatic).status).toBe("cancelled")
  expect(f.store.getRun(explicit.runIds[0]).status).toBe("queued")
})

it.each(["fence", "effect", "wrong-root", "wrong-requester"] as const)(
  "does not consume an already-started, unresolved or mismatched automatic return (%s)",
  (mode) => {
    const f = fixture(),
      child = f.store.claim("child")!
    f.store.finish(child.lease, "succeeded", "REAL_RESULT")
    const id = String(
      f.store.db.exec("SELECT run_id FROM bot_peer_dispatch WHERE automatic=1")[0].values[0][0]
    )
    if (mode === "fence") f.store.db.run("UPDATE bot_runs SET fence=1 WHERE id=?", [id])
    else if (mode === "effect")
      f.store.db.run("INSERT INTO bot_effects VALUES(?,?,?,?,?,?,?,?)", [
        "unknown-result",
        id,
        0,
        "fixture",
        "unknown",
        null,
        f.store.now(),
        f.store.now()
      ])
    else if (mode === "wrong-root")
      f.store.db.run("UPDATE bot_runs SET root_run_id=? WHERE id=?", ["other-root", id])
    else
      f.store.db.run("UPDATE bot_peer_dispatch SET reply_to_run_id=? WHERE run_id=?", [
        child.run.id,
        id
      ])
    expect(f.store.waitForPeer(f.parent.lease, child.run.id).result).toBe("REAL_RESULT")
    expect(f.store.getRun(id).status).toBe("queued")
  }
)

it("a superseded parent lease cannot consume a real automatic return", () => {
  const f = fixture(),
    child = f.store.claim("child")!
  f.store.finish(child.lease, "succeeded", "REAL_RESULT")
  const id = String(
    f.store.db.exec("SELECT run_id FROM bot_peer_dispatch WHERE automatic=1")[0].values[0][0]
  )
  f.store.db.run("UPDATE bot_runs SET fence=fence+1 WHERE id=?", [f.parent.run.id])
  expect(() => f.store.waitForPeer(f.parent.lease, child.run.id)).toThrow(/执行权/)
  expect(f.store.getRun(id).status).toBe("queued")
})

it("retains exact early-result consumption across Host restart and explicit parent recovery", () => {
  const directory = mkdtempSync(join(tmpdir(), "cmb-peer-consumption-restart-"))
  directories.push(directory)
  const file = join(directory, "bots.sqlite"),
    f = fixture(new BotStore(file))
  const child = f.store.claim("old-child")!
  f.store.finish(child.lease, "succeeded", "DURABLE_TERMINAL_RESULT")
  const automatic = String(
    f.store.db.exec("SELECT run_id FROM bot_peer_dispatch WHERE automatic=1")[0].values[0][0]
  )
  f.store.close()
  stores.splice(stores.indexOf(f.store), 1)
  const reopened = new BotStore(file)
  stores.push(reopened)
  reopened.recoverAbandonedAtStartup()
  const review = reopened.getRun(f.parent.run.id)
  expect(review.status).toBe("needs_review")
  reopened.recover({
    id: review.id,
    revision: review.revision,
    decision: "resume",
    note: "Reviewed current task",
    effects: []
  })
  const owner = reopened.claim("new-host")!
  expect(owner.run.id).toBe(f.parent.run.id)
  expect(reopened.waitForPeer(owner.lease, child.run.id).result).toBe("DURABLE_TERMINAL_RESULT")
  expect(reopened.getRun(automatic).status).toBe("cancelled")
  reopened.finish(owner.lease, "succeeded", "DURABLE_CONSOLIDATION")
  expect(reopened.claim("after-restart")).toBeNull()
})

it("stopping the parent never marks an unconsumed child result as read", () => {
  const f = fixture(),
    child = f.store.claim("child")!
  f.store.finish(child.lease, "succeeded", "CHILD_RESULT_RETAINED")
  const automatic = String(
    f.store.db.exec("SELECT run_id FROM bot_peer_dispatch WHERE automatic=1")[0].values[0][0]
  )
  f.store.cancel(f.parent.run.id)
  expect(() => f.store.waitForPeer(f.parent.lease, child.run.id)).toThrow(/执行权/)
  expect(f.store.getRun(child.run.id).result).toBe("CHILD_RESULT_RETAINED")
  expect(
    f.store
      .events(0, 1000)
      .some(
        (e) =>
          e.entityId === automatic &&
          e.kind === "run.settled" &&
          (e.payload as { reason?: string }).reason === "peer_result_consumed"
      )
  ).toBe(false)
})
