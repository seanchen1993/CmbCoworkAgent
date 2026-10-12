import { afterEach, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BotStore } from "./store"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bot-recovery-receipt-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  let now = 1_800_000_000_000
  const open = () => {
    const store = new BotStore(join(root, "state.sqlite"), () => now)
    cleanup.push(() => store.close())
    return store
  }
  const store = open()
  const { conversationId } = store.createBot({ nonce: "create", name: "Recovery" })
  store.send({ nonce: "send", conversationId, text: "Verify output" })
  const { lease } = store.claim("first-host")!
  const action = { command: "verify" }
  const approval = store.requestInteraction(lease, { kind: "approval", prompt: "Verify", action })
  store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
  store.beginEffect(lease, { id: "effect", action, approvalId: approval.id })
  const interrupt = () => {
    now += 31_000
    store.recoverExpired()
  }
  interrupt()
  const run = store.getRun(lease.runId)
  const input = {
    id: run.id,
    revision: run.revision,
    nonce: "recovery-request",
    dataEpoch: "initial",
    decision: "resume" as "resume" | "cancel",
    note: "Checked the saved report",
    effects: [{ id: "effect", outcome: "succeeded" as const, note: "Report exists" }]
  }
  return { store, open, run, input, interrupt }
}

it.each(["resume", "cancel"] as const)(
  "replays a committed %s receipt after restart without changing newer task state",
  (decision) => {
    const f = fixture()
    f.input.decision = decision
    const receipt = f.store.recover(f.input)
    if (decision === "resume") {
      expect(f.store.claim("second-host")!.run.id).toBe(f.run.id)
      f.interrupt()
      expect(f.store.getRun(f.run.id).status).toBe("needs_review")
    }
    const current = f.store.getRun(f.run.id)
    const events = f.store.events()
    f.store.close()
    const reopened = f.open()
    expect(reopened.recover(f.input)).toEqual(receipt)
    expect(reopened.getRun(f.run.id)).toEqual(current)
    expect(reopened.events()).toEqual(events)
    expect(reopened.effects(f.run.id)[0]).toMatchObject({
      status: "succeeded",
      result: "人工核对：Report exists"
    })
    expect(() => reopened.recover({ ...f.input, note: "Different review" })).toThrow("同一请求标识")
    expect(() => reopened.recover({ ...f.input, nonce: "different-request" })).toThrow("状态已变化")
  }
)

it("does not consume a rejected recovery identity or accept a receipt across a restore", () => {
  const f = fixture()
  const events = f.store.events()
  expect(() => f.store.recover({ ...f.input, effects: [] })).toThrow("逐项核对")
  expect(f.store.events()).toEqual(events)
  expect(f.store.effects(f.run.id)[0].status).toBe("unknown")
  const receipt = f.store.recover(f.input)
  expect(receipt.status).toBe("queued")
  f.store.transaction(() => {
    f.store.db.run(
      "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('workspace.restored','new-epoch','{}',?)",
      [f.store.now()]
    )
  })
  expect(() => f.store.recover(f.input)).toThrow("数据已恢复")
})

it("retains exact human failure feedback across restart and rejects old or unrelated leases", () => {
  const f = fixture()
  f.store.recover({
    ...f.input,
    effects: [{ id: "effect", outcome: "failed", note: "The action did not complete." }]
  })
  const next = f.store.claim("replacement-host", 300_000)!
  const expected = {
    operationNote: "The action did not complete.",
    taskNote: "Checked the saved report"
  }
  expect(f.store.reviewedEffectFailure(next.lease, "effect")).toEqual(expected)
  expect(f.store.reviewedEffectFailure(next.lease, "other-effect")).toBeNull()
  f.store.close()
  const reopened = f.open()
  expect(reopened.reviewedEffectFailure(next.lease, "effect")).toEqual(expected)
  expect(() =>
    reopened.reviewedEffectFailure({ ...next.lease, fence: next.lease.fence - 1 }, "effect")
  ).toThrow()
  const otherBot = reopened.createBot({ nonce: "other-bot", name: "Unrelated" })
  reopened.send({
    nonce: "other-task",
    conversationId: otherBot.conversationId,
    text: "Other task"
  })
  const other = reopened.claim("other-host", 300_000)!
  expect(reopened.reviewedEffectFailure(other.lease, "effect")).toBeNull()
})
