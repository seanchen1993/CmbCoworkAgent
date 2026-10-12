import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, realpath, mkdir, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { BotStore } from "./store"
import { BotHost } from "./host"
import { BotHostLock } from "./host-lock"
import { OwnedShellReceiptSlot } from "./owned-shell-receipts"
import { ownedShellMaintenanceOwner } from "./owned-shell-maintenance-fence"
import { createBotPeerDispatchAdmission } from "./peer-dispatch-admission"
import type { BotPeerAdmissionFailure } from "./peer-dispatch-admission"
const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cmb-peer-admit-")))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const lock = BotHostLock.acquire(directory)!
  cleanup.push(() => lock.release())
  const store = new BotStore(join(directory, "bots.sqlite"))
  cleanup.push(() => store.close())
  const a = store.createBot({ nonce: "a", name: "Owner" }),
    b = store.createBot({ nonce: "b", name: "Worker" })
  const seed = store.send({
      nonce: "goal",
      conversationId: a.conversationId,
      text: "Original goal"
    }),
    parent = store.claim("a")!
  const sent = store.sendPeer(parent.lease, {
    nonce: "send",
    recipient: b.bot.id,
    text: "Actual work"
  })
  store.finish(parent.lease, "succeeded", "Done")
  const child = store.claim("b")!
  const admission = createBotPeerDispatchAdmission(
    store,
    directory,
    ownedShellMaintenanceOwner(lock),
    () => lock.assertCurrent()
  )
  return { directory, lock, store, a, b, seed, parent, child, sent, admission }
}
it("actual stable owner and empty resource scope mint one single-use exact claim; arbitrary values cannot authorize", async () => {
  const f = await fixture()
  const sent = f.store.sendPeer(f.child.lease, {
    nonce: "reply",
    recipient: f.a.bot.id,
    text: "Real reply"
  })
  expect(f.store.claim("fake", 30_000, {} as never)).toBeNull()
  const plan = f.store.peerDispatch.admissionPlan(sent.runIds[0])!
  const permit = await f.admission.check(plan, new AbortController().signal)
  expect(permit).not.toBeNull()
  const claim = f.store.claim("real", 30_000, permit!)!
  expect(claim.run.id).toBe(sent.runIds[0])
  f.store.finish(claim.lease, "succeeded", "Read reply")
  const follow = f.store.sendPeer(f.child.lease, {
    nonce: "another",
    recipient: f.a.bot.id,
    text: "Another reply"
  })
  expect(f.store.claim("replay", 30_000, permit!)).toBeNull()
  expect(f.store.getRun(follow.runIds[0]).status).toBe("queued")
})
it("changed target revision/epoch between actual filesystem read and transaction invalidates the permit", async () => {
  const f = await fixture()
  const sent = f.store.sendPeer(f.child.lease, {
    nonce: "reply",
    recipient: f.a.bot.id,
    text: "Real reply"
  })
  const plan = f.store.peerDispatch.admissionPlan(sent.runIds[0])!,
    permit = await f.admission.check(plan, new AbortController().signal)
  f.store.db.run("UPDATE bots SET revision=revision+1 WHERE id=?", [f.a.bot.id])
  expect(f.store.claim("stale", 30_000, permit!)).toBeNull()
  expect(f.store.getRun(sent.runIds[0]).status).toBe("queued")
})
it("a real weak authorized receipt is preserved and cannot mint physical closure from a known business result", async () => {
  const f = await fixture()
  await mkdir(join(f.directory, "shell-resources"), { mode: 0o700 })
  const slot = await OwnedShellReceiptSlot.allocate(join(f.directory, "shell-resources"), {
    nonce: randomUUID(),
    hostId: "actual-owner",
    dataEpoch: f.store.backupSchedule.epoch(),
    policySha256: "a".repeat(64),
    runId: f.parent.run.id,
    helperSha256: "b".repeat(64),
    workerSha256: "c".repeat(64),
    containment: "controlled-inherited-group"
  })
  await slot.ready(process.pid, process.pid)
  await slot.authorizeRun()
  await expect(slot.closed()).rejects.toThrow(/physical cleanup/)
  await slot.settle(false)
  const before = await readFile(join(slot.directory, "owner.json"))
  const sent = f.store.sendPeer(f.child.lease, {
    nonce: "reply",
    recipient: f.a.bot.id,
    text: "Observed reply"
  })
  expect(
    await f.admission.check(
      f.store.peerDispatch.admissionPlan(sent.runIds[0])!,
      new AbortController().signal
    )
  ).toBeNull()
  expect(f.store.claim("without-proof")).toBeNull()
  expect(await readFile(join(slot.directory, "owner.json"))).toEqual(before)
})
it("more than 100 physically blocked peer rows cannot starve another Bot original queue selection", async () => {
  const f = await fixture(),
    c = f.store.createBot({ nonce: "c", name: "Available" })
  // Separate real user roots preserve the original 64-per-root budget. Keep A
  // reply runs queued; send creates neither an unbounded synthetic root nor SQL-injected run.
  for (let i = 0; i < 150; i++) {
    if (i) {
      f.store.send({
        nonce: `root-${i}`,
        conversationId: f.b.conversationId,
        text: "Distinct human goal"
      })
      const next = f.store.claim(`b-${i}`)!
      expect(next.run.botId).toBe(f.b.bot.id)
      Object.assign(f.child, next)
    }
    f.store.sendPeer(f.child.lease, {
      nonce: `priority-${i}`,
      recipient: f.a.bot.id,
      text: `Message ${i}`,
      priority: true
    })
    f.store.finish(f.child.lease, "succeeded", `Source ${i} done`)
  }
  const available = f.store.send({
    nonce: "available",
    conversationId: c.conversationId,
    text: "Actual ready work"
  })
  // Same agent lane, rather than relying only on user's already highest lane.
  f.store.db.run("UPDATE bot_runs SET lane='agent' WHERE id=?", [available.runIds[0]])
  const failed = f.store.peerDispatch.admissionPlan(
    String(
      f.store.db.exec(
        "SELECT id FROM bot_runs WHERE bot_id=? AND status='queued' ORDER BY rowid LIMIT 1",
        [f.a.bot.id]
      )[0].values[0][0]
    )
  )!
  const memo = new Map<string, BotPeerAdmissionFailure>([
    [
      f.a.bot.id,
      {
        runId: failed.runId,
        fingerprint: failed.fingerprint,
        scopeRunIds: failed.scopeRunIds,
        dataEpoch: failed.dataEpoch
      }
    ]
  ])
  expect(f.store.claim("available-owner", 30_000, undefined, memo)?.run.id).toBe(
    available.runIds[0]
  )
  expect(
    f.store.db.exec("SELECT COUNT(*) FROM bot_runs WHERE bot_id=? AND status='queued'", [
      f.a.bot.id
    ])[0].values[0][0]
  ).toBeGreaterThanOrEqual(150)
})
it("priority uses original cancellation only for a precise unrelated non-user target, and keeps user tasks running", async () => {
  const f = await fixture(),
    c = f.store.createBot({ nonce: "c", name: "Other" })
  const source = f.store.sendPeer(f.child.lease, {
    nonce: "c-work",
    recipient: c.bot.id,
    text: "Other work"
  })
  const cRun = f.store.claim("c")!
  expect(cRun.run.id).toBe(source.runIds[0])
  const urgent = f.store.sendPeer(f.child.lease, {
    nonce: "urgent-c",
    recipient: c.bot.id,
    text: "Urgent distinct requirement",
    priority: true
  })
  expect(f.store.getRun(cRun.run.id).status).toBe("cancelling")
  expect(f.store.getRun(urgent.runIds[0]).status).toBe("queued")
  f.store.finish(cRun.lease, "cancelled", "Stopped safely")
  // Source B continues its own task; priority metadata stays with the original root.
  expect(f.store.getRun(urgent.runIds[0]).rootRunId).toBe(f.child.run.rootRunId)
  const user = f.store.send({
    nonce: "user-c",
    conversationId: c.conversationId,
    text: "Direct human task"
  })
  const userRun = f.store.claim("user-c")!
  expect(userRun.run.id).toBe(user.runIds[0])
  f.store.sendPeer(f.child.lease, {
    nonce: "second-urgent",
    recipient: c.bot.id,
    text: "Please read later",
    priority: true
  })
  expect(f.store.getRun(userRun.run.id).status).toBe("running")
})
it("original active-finally retires cleanup blocking without a DB revision or polling private resources; other Bot still starts", async () => {
  const f = await fixture(),
    c = f.store.createBot({ nonce: "available-c", name: "Available" })
  const live = f.store.send({
    nonce: "current-a",
    conversationId: f.a.conversationId,
    text: "Known result with held cleanup"
  })
  let release!: () => void,
    captured!: () => void,
    otherStarted!: () => void,
    peerStarted!: () => void
  const held = new Promise<void>((r) => (release = r)),
    capture = new Promise<void>((r) => (captured = r)),
    other = new Promise<void>((r) => (otherStarted = r)),
    peer = new Promise<void>((r) => (peerStarted = r))
  const runtime = {
    execute: async (request: import("./host").BotRuntimeRequest) => {
      if (request.run.id === live.runIds[0]) {
        request.store.finish(request.lease, "succeeded", "Exact committed result")
        captured()
        await held
        return "Exact committed result"
      }
      if (request.run.botId === c.bot.id) otherStarted()
      else if (request.run.botId === f.a.bot.id) peerStarted()
      return "Observed input only"
    }
  }
  const check = vi.fn(f.admission.check.bind(f.admission)),
    host = new BotHost(f.store, runtime, 2)
  host.bindOwnership(f.lock)
  host.bindPeerDispatchAdmission({ check })
  cleanup.push(() => host.stop())
  cleanup.push(() => release())
  host.start()
  await capture
  const response = f.store.sendPeer(f.child.lease, {
    nonce: "held-reply",
    recipient: f.a.bot.id,
    text: "Real reply during cleanup"
  })
  f.store.send({
    nonce: "other-ready",
    conversationId: c.conversationId,
    text: "Other useful work"
  })
  const revision = f.store.getRun(live.runIds[0]).revision
  host.tick()
  await other
  expect(f.store.getRun(response.runIds[0]).status).toBe("queued")
  expect(check).not.toHaveBeenCalled()
  release()
  await peer
  expect(f.store.getRun(live.runIds[0]).revision).toBe(revision)
  expect(check).toHaveBeenCalledTimes(1)
  expect(f.store.getRun(response.runIds[0]).status).toBe("running")
  // This fixture holds the real Host runtime Promise boundary. No process,
  // fake strong-closure brand, stored permit or physical scope is manufactured.
})
it("priority approval freezes the actual active scope and never cancels a replacement task after manual review", async () => {
  const f = await fixture(),
    c = f.store.createBot({ nonce: "approval-c", name: "Target" })
  const initial = f.store.sendPeer(f.child.lease, {
    nonce: "initial-c",
    recipient: c.bot.id,
    text: "First target task"
  })
  const old = f.store.claim("c")!
  expect(old.run.id).toBe(initial.runIds[0])
  const { sendReviewedBotPeer } = await import("./peer-approval")
  const before = f.store.db.exec("SELECT COUNT(*) FROM bot_runs")[0].values[0][0]
  await expect(
    sendReviewedBotPeer(
      {
        store: f.store,
        ...f.child,
        bot: f.b.bot,
        messages: f.store.messagesForRun(f.child.run.id),
        signal: new AbortController().signal
      },
      {
        callId: "frozen-priority",
        recipient: c.bot.id,
        text: "Actual urgent work",
        priority: true
      },
      () => f.store.assertDispatch(f.child.lease),
      async (id, action, operation, commit) => {
        expect(
          (action as { peer: { dispatch: { activationScopeRunId: string } } }).peer.dispatch
            .activationScopeRunId
        ).toBe(old.run.id)
        const ask = f.store.requestInteraction(f.child.lease, {
          kind: "approval",
          prompt: JSON.stringify(action),
          action
        })
        f.store.answerInteraction({
          id: ask.id,
          revision: ask.revision,
          answer: "approve"
        })
        f.store.finish(old.lease, "succeeded", "Old task finished during review")
        const actual = f.store.send({
            nonce: "new-c",
            conversationId: c.conversationId,
            text: "New user-owned work"
          }),
          replacement = f.store.claim("new-c")!
        expect(replacement.run.id).toBe(actual.runIds[0])
        const apply = () =>
          f.store.approvedToolOnce(f.child.lease, { id, action, approvalId: ask.id }, operation)
        return commit ? commit(apply) : apply()
      }
    )
  ).rejects.toMatchObject({ code: "peer_route_changed" })
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_runs")[0].values[0][0]).toBe(Number(before) + 2)
  expect(
    f.store.db.exec("SELECT COUNT(*) FROM bot_peer_dispatch WHERE automatic=1")[0].values[0][0]
  ).toBe(1)
  expect(
    f.store.db.exec("SELECT COUNT(*) FROM bot_receipts WHERE nonce=?", [
      `peer:${f.child.run.id}:frozen-priority`
    ])[0].values[0][0]
  ).toBe(0)
  expect(
    f.store.db.exec(
      "SELECT status FROM bot_runs WHERE bot_id=? AND source='user' ORDER BY rowid DESC LIMIT 1",
      [c.bot.id]
    )[0].values[0][0]
  ).toBe("running")
})
it("ancestor urgent updates use the exact waiting inbox without cancelling its source or collaborator", () => {
  const store = new BotStore(":memory:")
  cleanup.push(() => store.close())
  const a = store.createBot({ nonce: "a", name: "A" }),
    b = store.createBot({ nonce: "b", name: "B" })
  store.send({
    nonce: "user",
    conversationId: a.conversationId,
    text: "Real human task"
  })
  const parent = store.claim("parent")!
  const sent = store.sendPeer(parent.lease, {
    nonce: "work",
    recipient: b.bot.id,
    text: "Actual work"
  })
  store.waitForPeer(parent.lease, sent.runIds[0])
  const child = store.claim("child")!
  const reply = store.sendPeer(child.lease, {
    nonce: "urgent-ancestor",
    recipient: a.bot.id,
    text: "Please clarify now",
    priority: true,
    intent: "question"
  })
  expect(reply).toMatchObject({
    runIds: [],
    mergedIntoRunId: parent.run.id,
    responseRoute: "automatic"
  })
  expect(store.getRun(parent.run.id).status).toBe("waiting_input")
  expect(store.getRun(child.run.id).status).toBe("running")
  // Explicit Stop retains the original recursive revocation semantics.
  store.cancel(parent.run.id)
  expect(store.getRun(child.run.id).status).toBe("cancelling")
  expect(() =>
    store.sendPeer(child.lease, {
      nonce: "revoked-followup",
      recipient: a.bot.id,
      text: "Must not revive"
    })
  ).toThrow()
})
it("started target effects settle through original cancellation while unknown effects keep priority unclaimable", async () => {
  const f = await fixture(),
    c = f.store.createBot({ nonce: "c-effect", name: "Effect owner" })
  const initial = f.store.sendPeer(f.child.lease, {
      nonce: "c-effect-work",
      recipient: c.bot.id,
      text: "Existing approved operation"
    }),
    target = f.store.claim("c")!
  expect(target.run.id).toBe(initial.runIds[0])
  const action = { effect: "exact" },
    ask = f.store.requestInteraction(target.lease, {
      kind: "approval",
      prompt: "Exact operation",
      action
    })
  f.store.answerInteraction({
    id: ask.id,
    revision: ask.revision,
    answer: "approve"
  })
  f.store.beginEffect(target.lease, {
    id: "started-target",
    action,
    approvalId: ask.id
  })
  const urgent = f.store.sendPeer(f.child.lease, {
    nonce: "c-urgent",
    recipient: c.bot.id,
    text: "Pending priority",
    priority: true
  })
  expect(f.store.getRun(target.run.id).status).toBe("cancelling")
  expect(f.store.peerDispatch.admissionPlan(urgent.runIds[0])!.blocked).toBe(true)
  f.store.settleEffect(target.lease, "started-target", "unknown", "ACK lost")
  expect(f.store.finish(target.lease, "cancelled", "Unconfirmed external result").status).toBe(
    "needs_review"
  )
  expect(
    await f.admission.check(
      f.store.peerDispatch.admissionPlan(urgent.runIds[0])!,
      new AbortController().signal
    )
  ).toBeNull()
  expect(f.store.claim("must-not-start")).toBeNull()
  expect(f.store.getRun(urgent.runIds[0]).status).toBe("queued")
})
