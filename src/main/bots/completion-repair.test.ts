import { afterEach, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { botCompletionRepair, BOT_MAX_COMPLETION_REPAIRS } from "./completion-repair"

const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "bot-completion-repair-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, "bots.sqlite")
  let store = new BotStore(path)
  cleanup.push(() => store.close())
  const created = store.createBot({ nonce: "bot", name: "Worker" })
  store.send({ nonce: "task", conversationId: created.conversationId, text: "Complete work" })
  const { lease } = store.claim("owner", 300_000)!
  return {
    get store() {
      return store
    },
    lease,
    ...created,
    reopen() {
      store.close()
      store = new BotStore(path)
    }
  }
}

it("replays the same repair cue and retains the total budget across writer reopen", async () => {
  const f = await fixture()
  const input = { kind: "teach" as const, recordingId: "recording", invocation: "head-1" }
  const first = botCompletionRepair(f.store, f.lease, input)
  expect(botCompletionRepair(f.store, f.lease, input)).toEqual(first)
  f.reopen()
  expect(botCompletionRepair(f.store, f.lease, input)).toEqual(first)
  for (let i = 2; i <= BOT_MAX_COMPLETION_REPAIRS; i++)
    expect(
      botCompletionRepair(f.store, f.lease, { ...input, invocation: `head-${i}` }).content
    ).toContain(`${i}/${BOT_MAX_COMPLETION_REPAIRS}`)
  // A different completion kind cannot reset the same run's budget.
  expect(() =>
    botCompletionRepair(f.store, f.lease, {
      kind: "delivery",
      reason: "Need current verification",
      invocation: "head-4"
    })
  ).toThrow(expect.objectContaining({ code: "completion_repair_limit" }))
})

it("keeps learning observational and delivery grounded without authorizing external replay", async () => {
  const f = await fixture()
  const teach = botCompletionRepair(f.store, f.lease, {
    kind: "teach",
    recordingId: "exact-recording",
    invocation: "head-1"
  })
  expect(teach.content).toContain("exact-recording")
  expect(teach.content).toContain("read_demonstration")
  expect(teach.content).toContain("save_taught_skill")
  expect(teach.content).toContain("Never invent")
  expect(teach.content).toContain("Do not execute demonstrated actions")
  expect(teach.content).toContain("approval boundaries and model budgets remain unchanged")
  const delivery = botCompletionRepair(f.store, f.lease, {
    kind: "delivery",
    reason: "Current requirements differ",
    invocation: "head-2"
  })
  expect(delivery.content).toContain("every required output")
  expect(delivery.content).toContain("current accepted user instructions and original sources")
  expect(delivery.content).toContain("corrected or unchanged originals")
  expect(delivery.content).toContain("Do not bypass verification")
  expect(delivery.content).toContain("repeat completed external actions")
  expect(f.store.effects(f.lease.runId)).toEqual([])
  const group = botCompletionRepair(f.store, f.lease, { kind: "group", invocation: "head-3" })
  expect(group.content).toContain("send_group_message")
  expect(group.content).toContain('exactly "(pass)"')
  expect(group.content).toContain("Plain assistant output is private scratch space")
  expect(group.content).toContain(
    "Never publish private one-on-one context, memory or internal reasoning"
  )
  expect(group.content).toContain("do not repeat completed external actions")
  expect(group.content).not.toContain("deliver_file")
  expect(group.content).not.toContain("save_taught_skill")
})

it("rejects stale owners and pending human changes before consuming a repair receipt", async () => {
  const f = await fixture()
  const input = { kind: "teach" as const, recordingId: "recording", invocation: "head-1" }
  f.store.send({
    nonce: "steer",
    conversationId: f.conversationId,
    steerRunId: f.lease.runId,
    text: "Change requirements"
  })
  expect(() => botCompletionRepair(f.store, f.lease, input)).toThrow("新")
  f.store.fenceOwner(f.lease.owner, "Owner stopped")
  expect(() => botCompletionRepair(f.store, f.lease, input)).toThrow()
  expect(
    f.store.db.exec("SELECT count(*) FROM bot_receipts WHERE nonce LIKE ?", [
      `tool:${f.lease.runId}:completion-repair:%`
    ])[0].values[0][0]
  ).toBe(0)
})
