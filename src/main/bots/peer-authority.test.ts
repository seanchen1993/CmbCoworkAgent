import { afterEach, expect, it } from "vitest"
import { BotStore } from "./store"
import { BotWorkflowStore } from "./workflow-store"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BotHostLock } from "./host-lock"
import { createBotPeerDispatchAdmission } from "./peer-dispatch-admission"
import { ownedShellMaintenanceOwner } from "./owned-shell-maintenance-fence"

const stores: BotStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function fixture(enabled = true, path = ":memory:") {
  const store = new BotStore(path)
  stores.push(store)
  const a = store.createBot({ nonce: "a", name: "Planner", modelRef: "source-model" })
  const b = store.createBot({
    nonce: "b",
    name: "Reviewer",
    instructions: "Review assigned files",
    modelRef: "peer-model"
  })
  const c = store.createBot({ nonce: "c", name: "Tester" })
  for (const bot of [a.bot, b.bot, c.bot])
    store.autoReview.change({
      ...store.autoReview.read(bot.id),
      isEnabled: enabled,
      nonce: `enable-${bot.id}`
    })
  store.send({
    nonce: "task",
    conversationId: a.conversationId,
    text: "PRIVATE_SOURCE: review the project, do not publish anything"
  })
  const parent = store.claim("host")!
  const send = () =>
    store.sendPeer(parent.lease, {
      nonce: "handoff",
      recipient: b.bot.id,
      text: "Review the assigned file"
    })
  return { store, a, b, c, parent, send }
}

it("retains the source user's scope after completion while keeping peer model messages separate", () => {
  const f = fixture(),
    sent = f.send()
  expect(f.send()).toEqual(sent)
  f.store.finish(f.parent.lease, "succeeded", "Assigned")
  const task = f.store.autoReview.task(sent.runIds[0])!
  expect(task.messages[0].text).toContain("PRIVATE_SOURCE")
  expect(task.peer).toMatchObject({
    reviewerBotId: f.a.bot.id,
    handoffs: [
      {
        fromBotId: f.a.bot.id,
        toBotId: f.b.bot.id,
        assignment: "Review the assigned file",
        recipient: { modelRef: "peer-model", instructions: "Review assigned files" }
      }
    ]
  })
  expect(JSON.stringify(f.store.messagesForRun(sent.runIds[0]))).not.toContain("PRIVATE_SOURCE")
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_peer_authority")[0].values[0][0]).toBe(1)
})

it.each([
  "source-settings",
  "source-role",
  "recipient-role",
  "source-message",
  "source-cancel",
  "refusal"
])("revokes an undispatched peer decision when %s changes", (change) => {
  const f = fixture(),
    sent = f.send()
  const peer = f.store.claim("host")!
  expect(peer.run.id).toBe(sent.runIds[0])
  const action = { connector: { tool: "save", arguments: {} } }
  const record = f.store.autoReview.stamp(peer.lease, action, f.store.autoReview.read(f.b.bot.id), {
    decision: "allow",
    reason: "Within assigned scope",
    model: "source-model"
  })
  const approval = f.store.requestInteraction(peer.lease, {
    kind: "approval",
    action,
    prompt: JSON.stringify(action),
    autoReview: record
  })
  if (change === "source-settings")
    f.store.autoReview.change({
      ...f.store.autoReview.read(f.a.bot.id),
      isEnabled: false,
      nonce: "off"
    })
  if (change === "source-role" || change === "recipient-role") {
    const bot = change === "source-role" ? f.a.bot : f.b.bot
    // The executing Bot may update its own profile; ordinary UI role edits remain blocked.
    f.store.updateBotProfile(change === "source-role" ? f.parent.lease : peer.lease, {
      id: bot.id,
      revision: bot.revision,
      instructions: "Changed role"
    })
  }
  if (change === "source-message")
    f.store.send({
      nonce: "amend",
      conversationId: f.a.conversationId,
      steerRunId: f.parent.run.id,
      text: "Stop the delegated work"
    })
  if (change === "source-cancel") f.store.cancel(f.parent.run.id)
  if (change === "refusal") {
    const rejected = f.store.requestInteraction(f.parent.lease, {
      kind: "approval",
      action,
      prompt: JSON.stringify(action)
    })
    f.store.answerInteraction({ id: rejected.id, revision: rejected.revision, answer: "reject" })
    expect(f.store.autoReview.wasRejected(peer.run.id, action)).toBe(true)
  }
  expect(f.store.autoReview.task(peer.run.id)).toBeNull()
  expect(() =>
    f.store.beginEffect(peer.lease, { id: "write", action, approvalId: approval.id })
  ).toThrow(change === "source-cancel" ? "任务执行权已失效" : "自动审核依据已变化")
  if (change === "source-cancel") expect(f.store.getRun(peer.run.id).status).toBe("cancelling")
  expect(f.store.effects(peer.run.id)).toEqual([])
})

it("keeps disabled senders and unrecorded historical handoffs manual", () => {
  const f = fixture(false),
    sent = f.send()
  expect(f.store.autoReview.task(sent.runIds[0])).toBeNull()
  f.store.autoReview.change({
    ...f.store.autoReview.read(f.a.bot.id),
    isEnabled: true,
    nonce: "late-enable"
  })
  expect(f.store.autoReview.task(sent.runIds[0])).toBeNull()
})

it("keeps a multi-Bot chain bound to the original reviewer and all sender policies", () => {
  const f = fixture()
  f.send()
  const b = f.store.claim("host")!
  const sent = f.store.sendPeer(b.lease, {
    nonce: "next",
    recipient: f.c.bot.id,
    text: "Run assigned checks"
  })
  f.store.finish(b.lease, "succeeded", "Assigned checks")
  const task = f.store.autoReview.task(sent.runIds[0])!
  expect(task.peer?.reviewerBotId).toBe(f.a.bot.id)
  expect(task.peer?.handoffs.map((handoff) => handoff.assignment)).toEqual([
    "Review the assigned file",
    "Run assigned checks"
  ])
  expect(task.messages).toHaveLength(1)
  expect(task.peer?.handoffs.every((handoff) => handoff.reviewPolicy.isEnabled)).toBe(true)
  f.store.autoReview.change({
    ...f.store.autoReview.read(f.a.bot.id),
    blockInstructions: ["Always ask"],
    nonce: "change-policy"
  })
  expect(f.store.autoReview.task(sent.runIds[0])).toBeNull()
})

it("carries peer scope into its real workflow child without sharing source messages with execution", () => {
  const f = fixture()
  f.send()
  const peer = f.store.claim("host")!
  const workflow = BotWorkflowStore.open(f.store, peer.lease, "workflow", {
    script: 'export const meta={name:"Check",description:"Check"};return 1;',
    maxConcurrency: 1,
    defaultModelId: "peer-model",
    agentProfiles: [],
    authority: {}
  })
  const child = f.store.workflowChildren.claim(workflow, peer.lease, {
    prompt: "Inspect assigned data",
    label: "Inspector",
    phase: null,
    agentIndex: 1,
    toolStreamKey: "a".repeat(64) + "_c0",
    durableCallKey: "a".repeat(64) + "_n0",
    shellAccess: "read_only"
  })
  expect(f.store.autoReview.task(child.run.id)).toMatchObject({
    peer: { reviewerBotId: f.a.bot.id },
    delegation: { assignment: "Inspect assigned data", shellAccess: "read_only" }
  })
  expect(JSON.stringify(f.store.messagesForRun(peer.run.id))).not.toContain("PRIVATE_SOURCE")
})

it("falls back to human review after the completed sender is deleted", () => {
  const f = fixture(),
    sent = f.send()
  f.store.finish(f.parent.lease, "succeeded", "Assigned")
  f.store.deleteBot(f.a.bot.id, f.a.bot.revision)
  expect(f.store.autoReview.task(sent.runIds[0])).toBeNull()
})

it("preserves a workflow sender's restricted assignment through subsequent peer workflow delegation", () => {
  const f = fixture()
  const createChild = (lease: typeof f.parent.lease, assignment: string) => {
    const workflow = BotWorkflowStore.open(f.store, lease, "workflow", {
      script: 'export const meta={name:"Check",description:"Check"};return 1;',
      maxConcurrency: 1,
      defaultModelId: "source-model",
      agentProfiles: [],
      authority: {}
    })
    return f.store.workflowChildren.claim(workflow, lease, {
      prompt: assignment,
      label: "Inspector",
      phase: null,
      agentIndex: 1,
      toolStreamKey: "a".repeat(64) + "_c0",
      durableCallKey: "a".repeat(64) + "_n0",
      shellAccess: "read_only",
      disallowedTools: ["write_file"],
      roleSystemPrompt: "Inspect only"
    })
  }
  const source = createChild(f.parent.lease, "Read project notes only")
  f.store.sendPeer(source.lease!, {
    nonce: "child-handoff",
    recipient: f.b.bot.id,
    text: "Inspect notes"
  })
  const peer = f.store.claim("host")!
  const child = createChild(peer.lease, "Check note structure")
  expect(f.store.autoReview.task(child.run.id)).toMatchObject({
    delegation: { assignment: "Check note structure" },
    peer: {
      handoffs: [
        {
          sourceDelegation: {
            assignment: "Read project notes only",
            shellAccess: "read_only",
            disallowedTools: ["write_file"]
          }
        }
      ]
    }
  })
})

it("validates eight peer handoffs without retaining cached authorization across reads", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cmb-peer-authority-depth-")))
  const lock = BotHostLock.acquire(directory)!
  let f: ReturnType<typeof fixture> | undefined
  try {
    f = fixture(true, join(directory, "bots.sqlite"))
    const admission = createBotPeerDispatchAdmission(
      f.store,
      directory,
      ownedShellMaintenanceOwner(lock),
      () => lock.assertCurrent()
    )
    let parent = f.parent
    for (let i = 0; i < 8; i++) {
      const next =
        i === 0
          ? f.b
          : i === 1
            ? f.c
            : f.store.createBot({ nonce: `depth-${i}`, name: `Worker ${i}` })
      if (i > 1)
        f.store.autoReview.change({
          ...f.store.autoReview.read(next.bot.id),
          isEnabled: true,
          nonce: `enabled-${i}`
        })
      const sent = f.store.sendPeer(parent.lease, {
        nonce: `send-${i}`,
        recipient: next.bot.id,
        text: `Bounded assignment ${i}`
      })
      f.store.finish(parent.lease, "succeeded", "Assigned")
      // Original automatic replies now share the queue. Settle those actual
      // turns with the held physical owner before claiming the next assignment.
      for (let reads = 0; ; reads++) {
        const pending = f.store.nextClaim()!
        expect(pending).not.toBeNull()
        if (pending.id === sent.runIds[0]) break
        expect(reads).toBeLessThan(8)
        expect(f.store.peerDispatch.read(pending.id)?.automatic).toBe(true)
        const plan = f.store.peerDispatch.admissionPlan(pending.id)!
        expect(plan).not.toBeNull()
        const permit = await admission.check(plan, new AbortController().signal)
        expect(permit).not.toBeNull()
        const reply = f.store.claim("host", 30_000, permit!)!
        expect(reply.run.id).toBe(pending.id)
        f.store.finish(reply.lease, "succeeded", "Read collaborator result")
      }
      parent = f.store.claim("host")!
      expect(parent.run.id).toBe(sent.runIds[0])
    }
    expect(f.store.autoReview.task(parent.run.id)?.peer?.handoffs).toHaveLength(8)
    f.store.autoReview.change({
      ...f.store.autoReview.read(f.a.bot.id),
      isEnabled: false,
      nonce: "revoke-origin"
    })
    expect(f.store.autoReview.task(parent.run.id)).toBeNull()
  } finally {
    if (f) {
      stores.splice(stores.indexOf(f.store), 1)
      f.store.close()
    }
    lock.release()
    await rm(directory, { recursive: true, force: true })
  }
})
