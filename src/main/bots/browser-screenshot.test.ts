import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { ToolMessage } from "@langchain/core/messages"
import { BotDomainError } from "../../shared/bot-types"
import type { BotBrowserTarget } from "../../shared/bot-computer"
import type { BotRuntimeRequest } from "./host"
import type { LocalBotComputerProvider } from "./computer-provider"
import { BotStore } from "./store"
import { BotArtifacts } from "./artifacts"
import { botBrowserTool } from "./browser-tool"
import { botDeliverFileTool } from "./deliver-file-tool"

const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const done of cleanup.splice(0).reverse()) await done()
  vi.restoreAllMocks()
})
async function fixture() {
  const directory = await mkdtemp(join(process.cwd(), ".browser-shot-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const store = new BotStore(join(directory, "bots.sqlite"))
  let storeClosed = false
  const closeStore = () => {
    if (!storeClosed) {
      store.close()
      storeClosed = true
    }
  }
  cleanup.push(closeStore)
  const files = new BotArtifacts(join(directory, "objects"), store)
  cleanup.push(() => files.close())
  await files.recover()
  const { bot, conversationId } = store.createBot({ nonce: "create", name: "Screenshot" })
  store.send({ nonce: "send", conversationId, text: "请把当前页面截图附给我" })
  const claim = store.claim("host", 300000)!
  const request: BotRuntimeRequest = {
    ...claim,
    bot,
    store,
    messages: store.messagesForRun(claim.run.id),
    signal: new AbortController().signal
  }
  const target: BotBrowserTarget = {
    botId: bot.id,
    viewId: "page-view",
    generation: "one",
    controlEpoch: 0,
    control: "bot"
  }
  const observation = {
    pageId: "actual-page",
    viewId: target.viewId,
    navigationEpoch: 1,
    title: "Actual page",
    url: "https://example.test/actual",
    urlSha256: createHash("sha256").update("https://example.test/actual").digest("hex")
  }
  // Deliberately opaque fixture bytes, never generated from a model response.
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x11, 0x22, 0x33, 0xff, 0xd9])
  const state = { missingImage: false, afterCapture: undefined as (() => void) | undefined }
  const broker = {
    ensure: vi.fn(async () => ({ ...target })),
    act: vi.fn(async () => {
      const result = {
        summary: "Took a screenshot",
        target: { ...target },
        observation: { ...observation },
        ...(state.missingImage
          ? {}
          : { image: `data:image/jpeg;base64,${bytes.toString("base64")}` })
      }
      state.afterCapture?.()
      return result
    }),
    assertBotObservation: vi.fn((expected: BotBrowserTarget) => {
      if (target.control !== "bot" || JSON.stringify(target) !== JSON.stringify(expected))
        throw new BotDomainError("stale_target", "control changed")
    })
  }
  const computer = { get: vi.fn(async () => broker) }
  const check = () => store.assertDispatch(claim.lease)
  const tool = botBrowserTool({
    request,
    computer: computer as unknown as LocalBotComputerProvider,
    files,
    check,
    approve: async (_id, _action, operation) => operation()
  })
  const invoke = (args: Record<string, unknown>, id = "shot") =>
    tool.invoke({
      type: "tool_call",
      name: "browser",
      id,
      args: { op: "screenshot", arguments_json: JSON.stringify(args) }
    })
  const attached = () => store.messages(conversationId).flatMap((message) => message.attachments)
  return {
    store,
    files,
    broker,
    computer,
    claim,
    request,
    target,
    observation,
    bytes,
    state,
    invoke,
    attached,
    conversationId,
    check,
    directory,
    closeStore
  }
}
function receipt(message: ToolMessage) {
  const content = message.content as { type: string; text?: string }[]
  return JSON.parse(content.find((item) => item.type === "text")!.text!)
}

it("keeps repeated default screenshots as model-only observations with actual page facts and no stored files", async () => {
  const f = await fixture()
  for (let i = 0; i < 6; i++) {
    const result = receipt(await f.invoke({}, `observe${i}`))
    expect(result.observation).toEqual(f.observation)
    expect(result.attachment.status).toBe("not_saved")
  }
  expect(f.attached()).toEqual([])
  expect(f.store.artifacts(f.conversationId)).toEqual([])
  expect(
    f.store.db.exec("SELECT count(*) FROM bot_receipts WHERE nonce LIKE '%browser-shot:%'")[0]
      .values[0][0]
  ).toBe(0)
})

it("attaches the captured bytes once, reuses the same call original without recapture, and allows original delivery", async () => {
  const f = await fixture()
  const first = receipt(await f.invoke({ deliver: true, name: "验收.jpg" }))
  expect(first.attachment).toEqual({ status: "attached", file_id: first.artifact.id })
  expect(first.artifact).toMatchObject({
    mime: "image/jpeg",
    origin: "browser",
    name: "验收.jpg",
    sha256: createHash("sha256").update(f.bytes).digest("hex")
  })
  expect((await f.files.read(first.artifact.id)).bytes).toEqual(f.bytes)
  expect(f.attached()).toEqual([first.artifact.id])
  expect(receipt(await f.invoke({ deliver: true, name: "验收.jpg" }))).toEqual(first)
  expect(f.broker.act).toHaveBeenCalledTimes(1)
  const delivery = botDeliverFileTool(f.request, f.files, f.check)
  await delivery.invoke({
    type: "tool_call",
    name: "deliver_file",
    id: "redeliver",
    args: { file_id: first.artifact.id }
  })
  expect(f.attached()).toEqual([first.artifact.id])
})

it("does not recapture or claim an attachment after publication fails", async () => {
  const f = await fixture()
  vi.spyOn(f.files, "publish").mockRejectedValueOnce(new Error("fixture disk failure"))
  await expect(f.invoke({ deliver: true })).rejects.toThrow("fixture disk failure")
  expect(f.attached()).toEqual([])
  await expect(f.invoke({ deliver: true })).rejects.toMatchObject({
    code: "effect_requires_review"
  })
  expect(f.broker.act).toHaveBeenCalledTimes(1)
  expect(f.store.artifacts(f.conversationId)).toEqual([])
})

it("uses durable capture and publication receipts after reopening the Store with no browser access", async () => {
  const f = await fixture()
  const first = receipt(await f.invoke({ deliver: true }))
  await f.files.close()
  f.closeStore()
  const store = new BotStore(join(f.directory, "bots.sqlite"))
  cleanup.push(() => store.close())
  const files = new BotArtifacts(join(f.directory, "objects"), store)
  cleanup.push(() => files.close())
  await files.recover()
  f.computer.get.mockRejectedValue(new Error("browser must not be opened on replay"))
  const tool = botBrowserTool({
    request: { ...f.request, store },
    computer: f.computer as unknown as LocalBotComputerProvider,
    files,
    check: () => store.assertDispatch(f.claim.lease),
    approve: async (_id, _action, operation) => operation()
  })
  const replay = await tool.invoke({
    type: "tool_call",
    name: "browser",
    id: "shot",
    args: { op: "screenshot", arguments_json: JSON.stringify({ deliver: true }) }
  })
  expect(receipt(replay)).toEqual(first)
  expect((await files.read(first.artifact.id)).bytes).toEqual(f.bytes)
  expect(f.broker.act).toHaveBeenCalledTimes(1)
  expect(store.messages(f.conversationId).flatMap((message) => message.attachments)).toEqual([
    first.artifact.id
  ])
})

it("does not recapture or resurrect a deleted original on replay", async () => {
  const f = await fixture()
  const first = receipt(await f.invoke({ deliver: true }))
  f.store.transaction(() =>
    f.store.db.run("UPDATE bot_artifact_lifecycle SET deleted_at=? WHERE artifact_id=?", [
      f.store.now(),
      first.artifact.id
    ])
  )
  await expect(f.invoke({ deliver: true })).rejects.toMatchObject({ code: "artifact_deleted" })
  expect(f.broker.act).toHaveBeenCalledTimes(1)
  expect(f.store.artifacts(f.conversationId)).toEqual([])
})

it("pins the original screenshot arguments under the call receipt", async () => {
  const f = await fixture()
  await f.invoke({ deliver: true, name: "first.jpg" })
  await expect(f.invoke({ deliver: true, name: "different.jpg" })).rejects.toThrow()
  expect(f.broker.act).toHaveBeenCalledTimes(1)
  expect(f.attached()).toHaveLength(1)
})

it.each(["takeover", "target", "epoch"])(
  "does not publish after capture when %s changes",
  async (change) => {
    const f = await fixture()
    f.state.afterCapture = () => {
      if (change === "takeover") f.target.control = "human"
      if (change === "target") f.target.generation = "new-generation"
      if (change === "epoch") vi.spyOn(f.store, "dataEpoch").mockReturnValue("restored-epoch")
    }
    await expect(f.invoke({ deliver: true })).rejects.toBeInstanceOf(BotDomainError)
    expect(f.attached()).toEqual([])
    expect(f.store.artifacts(f.conversationId)).toEqual([])
  }
)

it("does not invent a file when capture did not produce original image bytes", async () => {
  const f = await fixture()
  f.state.missingImage = true
  await expect(f.invoke({ deliver: true })).rejects.toMatchObject({
    code: "effect_requires_review"
  })
  expect(f.attached()).toEqual([])
  await expect(f.invoke({ deliver: true })).rejects.toMatchObject({
    code: "effect_requires_review"
  })
  expect(f.broker.act).toHaveBeenCalledTimes(1)
})

it.each([
  { deliver: "yes" },
  { deliver: true, name: "../bad.jpg" },
  { deliver: true, name: "not-a-jpeg.png" },
  { name: "no-delivery.jpg" }
])("validates screenshot delivery before opening a browser: %j", async (args) => {
  const f = await fixture()
  const result = await f.invoke(args)
  expect(result.status).toBe("error")
  expect(f.computer.get).not.toHaveBeenCalled()
  expect(f.attached()).toEqual([])
})
