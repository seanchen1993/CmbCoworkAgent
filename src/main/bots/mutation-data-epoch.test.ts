import { afterEach, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BotStore } from "./store"
import { BotWorkflowStore } from "./workflow-store"
import { avatarImage } from "./image-fixtures"

const dispose: (() => void)[] = []
afterEach(() => {
  for (const close of dispose.splice(0).reverse()) close()
})
function fixture(domain: "avatar" | "webhook" | "workflow") {
  const root = mkdtempSync(join(tmpdir(), "cmb-mutation-epoch-"))
  const store = new BotStore(join(root, "bots.sqlite"))
  dispose.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const owner = store.createBot({ nonce: "owner", name: "Owner" })
  const epoch = (id = "restored") =>
    store.db.run(
      "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('workspace.restored',?,'{}',?)",
      [id, store.now()]
    )
  if (domain === "avatar")
    return {
      store,
      epoch,
      input: { botId: owner.bot.id, nonce: "edit", revision: owner.bot.revision, pngBase64: null },
      change: (input: unknown) =>
        store.avatars.change(input, new AbortController().signal, {
          avatar: async (value) => value
        })
    }
  if (domain === "webhook") {
    const routine = store.saveRoutine({
      botId: owner.bot.id,
      name: "Check",
      prompt: "Check evidence",
      schedule: { kind: "event", topic: "check" },
      timezone: "UTC",
      enabled: true
    })
    return {
      store,
      epoch,
      input: {
        botId: owner.bot.id,
        routineId: routine.id,
        nonce: "edit",
        revision: 0,
        operation: "rotate" as const
      },
      change: async (input: unknown) => store.webhooks.change(input)
    }
  }
  store.send({ nonce: "task", conversationId: owner.conversationId, text: "Check evidence" })
  const parent = store.claim("host")!
  const workflow = BotWorkflowStore.open(store, parent.lease, "workflow", {
    script:
      'export const meta={name:"Check",description:"Check evidence"}; return await agent("task");',
    maxConcurrency: 2,
    defaultModelId: "configured",
    agentProfiles: [],
    authority: { project: "test" }
  })
  const child = store.workflowChildren.claim(workflow, parent.lease, {
    prompt: "Check evidence",
    agentIndex: 1,
    toolStreamKey: `${"a".repeat(64)}_c0`,
    durableCallKey: `${"a".repeat(64)}_n0`,
    label: "Check",
    phase: null,
    shellAccess: "read_only"
  })
  return {
    store,
    epoch,
    input: {
      conversationId: owner.conversationId,
      runId: child.run.id,
      nonce: "edit",
      revision: child.run.revision,
      operation: "message" as const,
      text: "Check the original evidence"
    },
    change: async (input: unknown) => store.controlWorkflowChild(input)
  }
}
const evidence = (store: BotStore) =>
  JSON.stringify([
    store.snapshot(),
    store.db.exec("SELECT * FROM bot_receipts"),
    store.db.exec("SELECT * FROM bot_messages"),
    store.db.exec("SELECT * FROM bot_avatar_images"),
    store.db.exec("SELECT * FROM bot_webhooks")
  ])
for (const domain of ["avatar", "webhook", "workflow"] as const) {
  it(`${domain}: a fresh unscoped legacy request cannot mutate restored data with matching IDs and revisions`, async () => {
    const f = fixture(domain)
    f.epoch()
    const before = evidence(f.store)
    await expect(f.change(f.input)).rejects.toMatchObject({ code: "data_epoch" })
    expect(evidence(f.store)).toBe(before)
  })
}
it("avatar: rechecks generation after asynchronous decoding, before any profile or receipt write", async () => {
  const f = fixture("avatar")
  const png = await avatarImage()
  let before = ""
  await expect(
    f.store.avatars.change({ ...f.input, pngBase64: png }, new AbortController().signal, {
      avatar: async () => {
        f.epoch()
        before = evidence(f.store)
        return png
      }
    })
  ).rejects.toMatchObject({ code: "data_epoch" })
  expect(evidence(f.store)).toBe(before)
})

for (const domain of ["avatar", "webhook", "workflow"] as const) {
  it(`${domain}: explicit current generation writes once and stale or unscoped fresh requests cannot follow it`, async () => {
    const f = fixture(domain)
    f.epoch()
    const request = { ...f.input, expectedDataEpoch: "restored" }
    await f.change(request)
    const before = evidence(f.store)
    await expect(
      f.change({ ...f.input, nonce: "stale", expectedDataEpoch: "initial" })
    ).rejects.toMatchObject({ code: "data_epoch" })
    await expect(f.change({ ...f.input, nonce: "legacy" })).rejects.toMatchObject({
      code: "data_epoch"
    })
    expect(evidence(f.store)).toBe(before)
  })
  it(`${domain}: historic accepted nonce remains a read-only receipt after another generation`, async () => {
    const f = fixture(domain)
    const saved = await f.change(f.input)
    f.epoch()
    const before = evidence(f.store)
    const replay = await f.change(f.input)
    expect(replay).toEqual(domain === "webhook" ? { ...saved, key: null } : saved)
    expect(evidence(f.store)).toBe(before)
  })
}
