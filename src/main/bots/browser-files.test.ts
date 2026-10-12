import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { BotStore } from "./store"
import { BotArtifacts } from "./artifacts"
import { BotHost } from "./host"
import { createBotAPI } from "./rpc"
import { botBrowserFileReceiver } from "./browser-files"

const cleanups: (() => void | Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cmb-browser-files-"))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const store = new BotStore(":memory:")
  cleanups.push(() => store.close())
  const files = new BotArtifacts(directory, store)
  cleanups.push(() => files.close())
  const { bot, conversationId } = store.createBot({ nonce: "a", name: "A" })
  return { store, files, botId: bot.id, conversationId }
}

it("publishes a completed download once, attaches it without waking a Bot and normalizes unsafe filenames", async () => {
  const f = await fixture()
  const receiver = botBrowserFileReceiver(f)
  const file = { guid: randomUUID(), bytes: Buffer.from("report"), suggestedName: "../con.txt" }
  receiver.started?.(file.guid)
  await receiver.complete(file, () => {})
  await receiver.complete(file, () => {})
  const artifacts = f.store.artifacts(f.conversationId)
  expect(artifacts).toHaveLength(1)
  expect(artifacts[0].name).toBe(`download-${file.guid}.bin`)
  expect((await f.files.read(artifacts[0].id)).bytes.toString()).toBe("report")
  expect(f.store.messages(f.conversationId)).toHaveLength(1)
  expect(f.store.messages(f.conversationId)[0].attachments).toEqual([artifacts[0].id])
  expect(f.store.snapshot().runs).toEqual([])
  expect(f.store.browserDownloads.recoverAtStartup()).toBe(0)
  receiver.failed("Browser error: https://site.test/export?token=PRIVATE /private/secret")
  expect(JSON.stringify(f.store.messages(f.conversationId))).not.toMatch(
    /PRIVATE|\/private\/secret/
  )
})

it("rechecks control ownership immediately before publication, after filesystem writes", async () => {
  const f = await fixture()
  let active = true
  let entered!: () => void, resume!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    resume = resolve
  })
  const publish = f.files.publish.bind(f.files)
  vi.spyOn(f.files, "publish").mockImplementation(async (...args) => {
    entered()
    await waiting
    return publish(...args)
  })
  const pending = botBrowserFileReceiver(f).complete(
    { guid: randomUUID(), bytes: Buffer.from("sensitive"), suggestedName: "report.txt" },
    () => {
      if (!active) throw new Error("control revoked")
    }
  )
  const rejected = expect(pending).rejects.toThrow("control revoked")
  await started
  active = false
  resume()
  await rejected
  expect(f.store.artifacts(f.conversationId)).toEqual([])
  expect(f.store.messages(f.conversationId)).toEqual([])
})

it("keeps human downloads in the captured branch and rejects foreign roots before browser takeover", async () => {
  const f = await fixture()
  const root = f.store.send({ nonce: "root", conversationId: f.conversationId, text: "讨论起点" })
  f.store.cancel(root.runIds[0])
  const receiver = botBrowserFileReceiver({ ...f, threadRootId: root.messageId })
  await receiver.complete(
    { guid: randomUUID(), bytes: Buffer.from("branch report"), suggestedName: "report.txt" },
    () => {}
  )
  receiver.failed("network")
  expect(f.store.messages(f.conversationId)).toHaveLength(1)
  const branch = f.store.messages(f.conversationId, undefined, 100, undefined, root.messageId)
  expect(branch).toHaveLength(2)
  expect(branch[0].attachments).toHaveLength(1)
  expect(branch.every((message) => message.threadRootId === root.messageId)).toBe(true)
  expect(f.store.snapshot().runs).toHaveLength(0)
  const other = f.store.createBot({ nonce: "other", name: "Other" })
  const api = createBotAPI(new BotHost(f.store))
  const target = {
    botId: other.bot.id,
    generation: "g",
    viewId: "v",
    controlEpoch: 0,
    control: "bot" as const,
    threadRootId: root.messageId
  }
  await expect(api.computerTake(target)).rejects.toThrow("所属对话")
  await expect(
    api.computerTake({ ...target, conversationId: other.conversationId })
  ).rejects.toThrow("分支起点")
})

it("rejects cross-conversation takeover before opening the browser and never retargets a file after membership removal", async () => {
  const f = await fixture()
  const other = f.store.createBot({ nonce: "b", name: "B" })
  const third = f.store.createBot({ nonce: "c", name: "C" })
  const api = createBotAPI(new BotHost(f.store))
  await expect(
    api.computerTake({
      botId: f.botId,
      generation: "g",
      viewId: "v",
      controlEpoch: 0,
      control: "bot",
      conversationId: other.conversationId
    })
  ).rejects.toThrow("不属于该对话")
  const group = f.store.createGroup({
    nonce: "group",
    name: "Group",
    members: [f.botId, other.bot.id]
  })
  const receiver = botBrowserFileReceiver({ ...f, conversationId: group.id })
  f.store.updateGroup({
    id: group.id,
    revision: group.revision,
    name: group.name,
    description: "",
    members: [other.bot.id, third.bot.id]
  })
  await expect(
    receiver.complete(
      { guid: randomUUID(), bytes: Buffer.from("no"), suggestedName: "report.txt" },
      () => {}
    )
  ).rejects.toThrow("已离开")
  expect(f.store.artifacts(group.id)).toEqual([])
  expect(f.store.artifacts(f.conversationId)).toEqual([])
})
