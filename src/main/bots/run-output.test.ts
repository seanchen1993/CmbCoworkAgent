import { afterEach, expect, it, vi } from "vitest"
import { BotStore } from "./store"
import { BotHost } from "./host"
import { createBotAPI } from "./rpc"
import { BOT_RUN_OUTPUT_PAGE_SIZE } from "../../shared/bot-run-output"

const stores: BotStore[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) store.close()
})
function fixture() {
  const store = new BotStore(":memory:")
  stores.push(store)
  const created = store.createBot({ nonce: "owner", name: "Owner" })
  const send = store.send({
    nonce: "task",
    conversationId: created.conversationId,
    text: "Task"
  })
  const claim = store.claim("host")!
  const address = {
    runId: send.runIds[0],
    conversationId: created.conversationId,
    dataEpoch: store.dataEpoch(),
    revision: store.getRun(send.runIds[0]).revision,
    fence: claim.lease.fence
  }
  return { store, created, claim, address }
}
it("keeps legacy snapshots exact while summary frames omit stored bodies without loading output rows", () => {
  const { store, claim, address } = fixture()
  store.streamOutput(claim.lease, "中😀".repeat(30_000))
  store.db.run("UPDATE bot_runs SET checkpoint=?,result=?,error=? WHERE id=?", [
    "checkpoint-body",
    "result-body",
    "e".repeat(2000),
    address.runId
  ])
  const prepare = vi.spyOn(store.db, "prepare")
  const exec = vi.spyOn(store.db, "exec")
  const summary = store.snapshot({ runProjection: "summary" })
  expect(summary.runs[0]).toMatchObject({
    id: address.runId,
    revision: address.revision,
    fence: address.fence,
    checkpoint: null,
    result: null,
    projection: "summary",
    hasOutput: true,
    outputLength: 90_000
  })
  expect(summary.runs[0].output).toBeUndefined()
  expect(summary.runs[0].error).toHaveLength(1000)
  const queries = [...prepare.mock.calls, ...exec.mock.calls].map(([sql]) => sql)
  expect(queries.some((sql) => /SELECT text FROM bot_run_outputs/.test(sql))).toBe(false)
  const legacy = store.snapshot()
  expect(legacy.runs[0]).toMatchObject({
    checkpoint: "checkpoint-body",
    result: "result-body",
    output: "中😀".repeat(30_000)
  })
  expect(store.getRun(address.runId).checkpoint).toBe("checkpoint-body")
})
it("does not serialize multi-Bot CJK output into modern global frames", () => {
  const store = new BotStore(":memory:")
  stores.push(store)
  for (let index = 0; index < 22; index++) {
    const { conversationId } = store.createBot({
      nonce: `bot-${index}`,
      name: `Bot ${index}`
    })
    store.send({ nonce: `task-${index}`, conversationId, text: "Task" })
    const claim = store.claim("host")!
    store.streamOutput(claim.lease, "中".repeat(128_000))
    store.db.run(
      "UPDATE bot_runs SET status='needs_review',lease_owner=NULL,lease_until=NULL WHERE id=?",
      [claim.lease.runId]
    )
  }
  expect(Buffer.byteLength(JSON.stringify(store.snapshot()))).toBeGreaterThan(8 * 1024 * 1024)
  const summary = store.snapshot({ runProjection: "summary" })
  expect(summary.runs).toHaveLength(22)
  expect(summary.runs.every((run) => run.status === "needs_review" && run.hasOutput)).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(100_000)
})
it("pages CJK and emoji with Unicode offsets and validates a prefix across append, rewrite and shortening", () => {
  const { store, claim, address } = fixture()
  let body = "中".repeat(BOT_RUN_OUTPUT_PAGE_SIZE - 1) + "😀" + "尾".repeat(10)
  store.streamOutput(claim.lease, body)
  const first = store.runOutput(address)
  expect(first.text).toBe(body.slice(0, BOT_RUN_OUTPUT_PAGE_SIZE + 1))
  expect(first.through).toBe(BOT_RUN_OUTPUT_PAGE_SIZE)
  expect(first.total).toBe(BOT_RUN_OUTPUT_PAGE_SIZE + 10)
  expect(first.text.endsWith("😀")).toBe(true)
  body += "继续😀"
  store.streamOutput(claim.lease, body)
  const appended = store.runOutput({
    ...address,
    offset: first.through,
    prefixSha256: first.prefixSha256
  })
  expect(appended.reset).toBe(false)
  expect(first.text + appended.text).toBe(body)
  store.streamOutput(claim.lease, "文" + body.slice(1))
  const rewritten = store.runOutput({
    ...address,
    offset: appended.through,
    prefixSha256: appended.prefixSha256
  })
  expect(rewritten.reset).toBe(true)
  expect(rewritten.offset).toBe(0)
  expect(rewritten.text.startsWith("文")).toBe(true)
  store.streamOutput(claim.lease, "短😀")
  const shorter = store.runOutput({
    ...address,
    offset: rewritten.through,
    prefixSha256: rewritten.prefixSha256
  })
  expect(shorter).toMatchObject({
    reset: true,
    offset: 0,
    through: 2,
    total: 2,
    nextOffset: null,
    text: "短😀"
  })
})
it("rejects wrong conversation/branch, stale lease generation/restore epoch and unbounded requests", () => {
  const { store, claim, address } = fixture()
  store.streamOutput(claim.lease, "Private")
  const other = store.createBot({ nonce: "other", name: "Other" })
  for (const input of [
    { ...address, conversationId: other.conversationId },
    { ...address, threadRootId: "wrong" }
  ])
    expect(() => store.runOutput(input)).toThrowError(
      expect.objectContaining({ code: "run_scope" })
    )
  for (const input of [
    { ...address, revision: address.revision + 1 },
    { ...address, fence: address.fence + 1 }
  ])
    expect(() => store.runOutput(input)).toThrowError(
      expect.objectContaining({ code: "run_output_stale" })
    )
  for (const input of [
    { ...address, limit: BOT_RUN_OUTPUT_PAGE_SIZE + 1 },
    { ...address, offset: 1 }
  ])
    expect(() => store.runOutput(input)).toThrowError(
      expect.objectContaining({ code: "invalid_input" })
    )
  store.db.run(
    "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('workspace.restored','restored','{}',1)"
  )
  expect(() => store.runOutput(address)).toThrowError(
    expect.objectContaining({ code: "stale_epoch" })
  )
})

it("exposes negotiated host-bound pages through the actual API and retains final transcript/history delivery", async () => {
  const { store, claim, address } = fixture()
  const host = new BotHost(store)
  const api = createBotAPI(host)
  store.streamOutput(claim.lease, "Provisional body")
  expect((await api.status()).capabilities).toContain("run-output-pages-v1")
  expect((await api.snapshot()).runs[0].output).toBe("Provisional body")
  expect((await api.snapshot({ runProjection: "summary" })).hostId).toBe(host.id)
  expect(await api.runOutput(address)).toMatchObject({
    hostId: host.id,
    text: "Provisional body",
    fence: address.fence
  })
  store.finish(claim.lease, "succeeded", "Final durable answer")
  expect((await api.snapshot({ runProjection: "summary" })).runs).toEqual([])
  expect((await api.messages({ conversationId: address.conversationId })).at(-1)?.text).toBe(
    "Final durable answer"
  )
  expect(
    (await api.runHistory({ conversationId: address.conversationId, runId: address.runId })).run
      .result
  ).toBe("Final durable answer")
})

it("rejects NUL at the existing write boundary without corrupting valid page content", () => {
  const { store, claim, address } = fixture()
  store.streamOutput(claim.lease, "中😀原文")
  expect(() => store.streamOutput(claim.lease, "中😀\u0000后文")).toThrowError(
    expect.objectContaining({ code: "invalid_input" })
  )
  expect(store.runOutput(address)).toMatchObject({
    text: "中😀原文",
    through: 4,
    total: 4,
    nextOffset: null
  })
})
