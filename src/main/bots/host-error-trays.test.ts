import { afterEach, expect, it, vi } from "vitest"
import { APIError } from "openai"
import { BotHost, type BotRuntimePort } from "./host"
import { BotStore } from "./store"
import { captureBotModelAttemptFailure } from "./model-error-diagnostic-scope"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})
function fixture(execute: BotRuntimePort["execute"]) {
  const store = new BotStore(":memory:")
  cleanup.push(() => store.close())
  const host = new BotHost(store, { execute })
  cleanup.push(() => host.stop())
  const { bot, conversationId } = store.createBot({ nonce: "bot", name: "Worker" })
  const { runIds } = store.send({ nonce: "task", conversationId, text: "work" })
  return { store, host, bot, conversationId, runId: runIds[0]! }
}
const providerFailure = () => {
  const error = APIError.generate(
    429,
    { message: "rejected opaque-credential-private" },
    "rejected",
    new Headers({ "x-request-id": "provider-request" })
  )
  captureBotModelAttemptFailure(
    error,
    { status: 429, requestId: "provider-request", callId: "durable-call" },
    ["opaque-credential-private"]
  )
  return error
}

it("notifies only a committed failed run, persists exact diagnostics, and does not revive a dismissed error on heartbeat", async () => {
  const f = fixture(async () => {
    throw providerFailure()
  })
  f.host.tick()
  await vi.waitFor(() => expect(f.store.getRun(f.runId).status).toBe("failed"))
  const snapshot = f.host.getErrorTrays()
  expect(snapshot.items).toHaveLength(1)
  expect(snapshot.items[0]).toMatchObject({
    source: "run",
    botId: f.bot.id,
    conversationId: f.conversationId,
    runId: f.runId,
    diagnostic: { status: 429, requestId: "provider-request", callId: "durable-call" }
  })
  expect(JSON.stringify(snapshot)).not.toContain("opaque-credential-private")
  const item = snapshot.items[0]!
  f.host.dismissErrorTray({
    hostId: snapshot.hostId,
    dataEpoch: snapshot.dataEpoch,
    id: item.id,
    revision: item.revision
  })
  f.host.tick()
  expect(f.host.getErrorTrays().items).toEqual([])
  const history = f.store.runHistory({ conversationId: f.conversationId, runId: f.runId })
  expect(history.run.diagnostic).toEqual(item.diagnostic)
  expect(history.run.error).not.toContain("opaque-credential-private")
})

it("reports quota exhaustion accurately while keeping the provider failure in task history", async () => {
  const providerMessage = "Token Plan usage limit reached. (2056)"
  const f = fixture(async () => {
    throw APIError.generate(
      429,
      { message: providerMessage, type: "rate_limit_error" },
      providerMessage,
      new Headers({ "x-request-id": "quota-request" })
    )
  })
  f.host.tick()
  await vi.waitFor(() => expect(f.store.getRun(f.runId).status).toBe("failed"))
  const tray = f.host.getErrorTrays().items[0]!
  expect(tray).toMatchObject({
    title: "模型额度已用尽",
    hint: "请恢复额度或更换模型后重试",
    diagnostic: { code: "quota_exceeded", status: 429, requestId: "quota-request" }
  })
  const reply = f.store.messages(f.conversationId).at(-1)!
  expect(reply.sender).toBe("system")
  expect(reply.text).toBe("模型额度已用尽，请恢复额度或更换模型后重试。")
  const history = f.store.runHistory({ conversationId: f.conversationId, runId: f.runId })
  expect(history.run.error).toContain(providerMessage)
  expect(history.run.diagnostic?.code).toBe("quota_exceeded")
})

it("preserves unknown external effects as needs_review without presenting a replayable failure", async () => {
  const f = fixture(async ({ store, lease }) => {
    const action = { shell: "external operation" }
    const interaction = store.requestInteraction(lease, {
      kind: "approval",
      action,
      prompt: "approve"
    })
    store.answerInteraction({
      id: interaction.id,
      revision: interaction.revision,
      answer: "approve"
    })
    store.beginEffect(lease, { id: "unknown-effect", action, approvalId: interaction.id })
    throw providerFailure()
  })
  f.host.tick()
  await vi.waitFor(() => expect(f.store.getRun(f.runId).status).toBe("needs_review"))
  expect(f.host.getErrorTrays().items).toEqual([])
  expect(
    f.store.runHistory({ conversationId: f.conversationId, runId: f.runId }).run.diagnostic
  ).toBeUndefined()
})

it("deduplicates a continuous maintenance failure and reports a new failure after recovery", () => {
  let now = 1_900_000_000_000
  const store = new BotStore(":memory:", () => now)
  cleanup.push(() => store.close())
  const host = new BotHost(store)
  cleanup.push(() => host.stop())
  const fail = vi.spyOn(store, "dispatchDueRoutines").mockImplementation(() => {
    throw new Error("disk error; token=PRIVATE_CREDENTIAL")
  })
  host.tick()
  host.tick()
  const first = host.getErrorTrays()
  expect(first.items).toHaveLength(1)
  expect(first.items[0]?.count).toBe(1)
  expect(host.lastError).not.toContain("PRIVATE_CREDENTIAL")
  host.clearErrorTrays({
    hostId: first.hostId,
    dataEpoch: first.dataEpoch,
    throughRevision: first.revision
  })
  host.tick()
  expect(host.getErrorTrays().items).toEqual([])
  fail.mockRestore()
  host.tick()
  expect(host.lastError).toBeNull()
  vi.spyOn(store, "dispatchDueRoutines").mockImplementation(() => {
    throw new Error("another disk failure")
  })
  now += 1001
  host.tick()
  expect(host.getErrorTrays().items).toHaveLength(1)
})

it("retires notifications and ignores old background producers across a restore epoch", () => {
  const store = new BotStore(":memory:")
  cleanup.push(() => store.close())
  const host = new BotHost(store)
  cleanup.push(() => host.stop())
  const old = host.reportFailure(
    { source: "memory", title: "整理失败", episodeId: "old", dataEpoch: "initial" },
    new Error("failed")
  )
  store.db.run(
    "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('workspace.restored','restored-epoch','{}',?)",
    [store.now()]
  )
  expect(host.getErrorTrays()).toMatchObject({
    dataEpoch: "restored-epoch",
    revision: 0,
    items: []
  })
  expect(
    host.reportFailure(
      { source: "memory", title: "迟到失败", episodeId: "late", dataEpoch: "initial" },
      new Error("old")
    )
  ).toMatchObject({ items: [] })
  expect(
    host.clearErrorTrays({
      hostId: old.hostId,
      dataEpoch: old.dataEpoch,
      throughRevision: old.revision
    })
  ).toMatchObject({ revision: 0, items: [] })
})
