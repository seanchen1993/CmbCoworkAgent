import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { BotStore } from "./store"
import { botTaskModelGuard } from "./runtime-model"
import { readBotModelSnapshot, writeBotModelSnapshot, type BotModelSnapshot } from "./model-config"
import type { BotRuntimeRequest } from "./host"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cmb-model-binding-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const database = join(root, "bots.sqlite"),
    modelFile = join(root, "models.private")
  let store = new BotStore(database)
  cleanup.push(() => store.close())
  const { bot, conversationId } = store.createBot({ nonce: "bot", name: "Model binding" })
  store.send({ nonce: "task", conversationId, text: "Keep working" })
  const claim = store.claim("original")!
  const controller = new AbortController()
  const request: BotRuntimeRequest = {
    ...claim,
    store,
    bot,
    signal: controller.signal,
    messages: []
  }
  const config = {
    ref: "primary",
    id: "primary",
    name: "Primary",
    model: "primary-model",
    apiKey: "private-credential-should-not-be-saved",
    baseUrl: "http://localhost:1234/v1"
  }
  const snapshot: BotModelSnapshot = {
    version: 1,
    defaultRef: "primary",
    models: [config, { ...config, ref: "backup", id: "backup", model: "backup-model" }]
  }
  await writeBotModelSnapshot(modelFile, snapshot)
  return {
    request,
    modelFile,
    config,
    snapshot,
    conversationId,
    controller,
    async recover() {
      store.fenceOwner("original", "process interrupted")
      const interrupted = store.getRun(claim.run.id)
      store.close()
      store = new BotStore(database)
      store.recover({
        id: interrupted.id,
        revision: interrupted.revision,
        decision: "resume",
        note: "Reviewed",
        effects: []
      })
      return { ...request, ...store.claim("restarted")!, store }
    }
  }
}

it.each(["unchanged", "key", "endpoint", "default"])(
  "restores the persisted model binding after reopening the database: %s",
  async (mode) => {
    const f = await fixture()
    await botTaskModelGuard(f.request, f.modelFile, null, f.config)()
    const rows = f.request.store.db.exec(
      "SELECT response FROM bot_receipts WHERE nonce LIKE '%runtime-model-configuration'"
    )[0].values
    expect(JSON.parse(String(rows[0][0]))).toEqual({ modelRef: "primary", model: "primary-model" })
    expect(JSON.stringify(rows)).not.toContain("private-credential")
    const recovered = await f.recover()
    if (mode === "key") f.snapshot.models[0].apiKey = "rotated-private-key"
    if (mode === "endpoint") f.snapshot.models[0].baseUrl = "http://localhost:4321/v1"
    if (mode === "default") f.snapshot.defaultRef = "backup"
    await writeBotModelSnapshot(f.modelFile, f.snapshot)
    const current = await readBotModelSnapshot(f.modelFile)
    const guard = botTaskModelGuard(
      recovered,
      f.modelFile,
      null,
      current.models.find((m) => m.ref === current.defaultRef)!
    )
    if (mode === "unchanged") await expect(guard()).resolves.toBeUndefined()
    else await expect(guard()).rejects.toMatchObject({ code: "model_configuration_changed" })
  }
)

it("keeps explicit selection stable when an unrelated model or display name changes", async () => {
  const f = await fixture()
  const guard = botTaskModelGuard(f.request, f.modelFile, "primary", f.config)
  await guard()
  f.snapshot.defaultRef = "backup"
  f.snapshot.models[1].apiKey = "unrelated-key"
  f.snapshot.models[0].name = "Renamed display label"
  await writeBotModelSnapshot(f.modelFile, f.snapshot)
  await expect(guard()).resolves.toBeUndefined()
})

it("does not consume or reject steering that arrives while model configuration is being read", async () => {
  const f = await fixture()
  const guard = botTaskModelGuard(f.request, f.modelFile, null, f.config)
  f.request.store.send({
    nonce: "steering",
    conversationId: f.conversationId,
    steerRunId: f.request.run.id,
    text: "Also check tests"
  })
  expect(f.request.store.steering.hasPending(f.request.run.id)).toBe(true)
  await expect(guard()).resolves.toBeUndefined()
  expect(f.request.store.steering.hasPending(f.request.run.id)).toBe(true)
})

it("refuses cancellation or an obsolete lease before creating a provider binding", async () => {
  const f = await fixture()
  const guard = botTaskModelGuard(f.request, f.modelFile, null, f.config)
  await f.recover()
  await expect(guard()).rejects.toThrow()
  f.controller.abort()
  await expect(guard()).rejects.toThrow()
})
