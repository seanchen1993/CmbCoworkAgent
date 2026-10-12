import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import type { ToolMessage } from "@langchain/core/messages"
import type { BotRuntimeRequest } from "./host"
import { BotStore } from "./store"
import { BotArtifacts } from "./artifacts"
import { LocalBotComputerProvider } from "./computer-provider"
import { botBrowserTool } from "./browser-tool"

const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const done of cleanup.splice(0).reverse()) await done()
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cmb-browser-shot-real-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const store = new BotStore(join(directory, "bots.sqlite"))
  cleanup.push(() => store.close())
  const files = new BotArtifacts(join(directory, "objects"), store)
  cleanup.push(() => files.close())
  await files.recover()
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8")
    const title = req.url === "/long" ? "T".repeat(2100) : `Actual ${req.url}`
    res.end(
      `<html><head><title>${title}</title></head><body><h1>${req.url}</h1><input id="name" aria-label="Name"></body></html>`
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const computer = new LocalBotComputerProvider(join(directory, "profile"), "chrome")
  cleanup.push(() => computer.close())
  const broker = await computer.get()
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
  const check = () => store.assertDispatch(claim.lease)
  await broker.act(await broker.ensure(bot.id), { op: "navigate", url: `${origin}/first` }, check)
  let beforeDispatch: (() => Promise<void>) | undefined
  const tool = botBrowserTool({
    request,
    computer,
    files,
    check,
    approve: async (_id, _action, operation, beforeStart) => {
      const skipped = await beforeStart?.()
      if (skipped) return skipped
      await beforeDispatch?.()
      return operation()
    }
  })
  const invoke = (args: Record<string, unknown>, id = "shot") =>
    tool.invoke({
      type: "tool_call",
      name: "browser",
      id,
      args: { op: "screenshot", arguments_json: JSON.stringify(args) }
    })
  const getPage = async () => {
    const held = await broker.takeControl(broker.target(bot.id))
    const page = await broker.teachObserve(bot.id, async (page) => page)
    await broker.releaseControl(held)
    await broker.act(broker.target(bot.id), { op: "snapshot" }, check)
    return page
  }
  return {
    store,
    files,
    broker,
    bot,
    conversationId,
    origin,
    check,
    invoke,
    getPage,
    tool,
    request,
    setBeforeDispatch: (value?: () => Promise<void>) => (beforeDispatch = value)
  }
}
function receipt(message: ToolMessage) {
  const content = message.content as { type: string; text?: string; image_url?: { url: string } }[]
  return {
    data: JSON.parse(content.find((item) => item.type === "text")!.text!),
    image: content.find((item) => item.type === "image_url")?.image_url?.url
  }
}

describe.runIf(process.env.CMB_BOT_BROWSER_TEST === "1")(
  "original screenshot delivery in owned Chrome",
  () => {
    it("reports actual page facts, stores only explicit delivery, and replays original bytes after page changes", async () => {
      const f = await fixture()
      const observed = receipt(await f.invoke({}, "observe"))
      expect(observed.data.observation).toMatchObject({
        title: "Actual /first",
        url: `${f.origin}/first`
      })
      expect(observed.data.observation.pageId).toBeTruthy()
      expect(observed.data.attachment.status).toBe("not_saved")
      expect(f.store.artifacts(f.conversationId)).toEqual([])
      const first = receipt(await f.invoke({ deliver: true, name: "original.jpg" }))
      const original = (await f.files.read(first.data.artifact.id)).bytes
      expect(original.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
      expect(first.image).toBe(`data:image/jpeg;base64,${original.toString("base64")}`)
      expect(first.data.artifact.sha256).toBe(createHash("sha256").update(original).digest("hex"))
      expect(f.store.messages(f.conversationId).flatMap((message) => message.attachments)).toEqual([
        first.data.artifact.id
      ])
      await f.broker.act(
        f.broker.target(f.bot.id),
        { op: "navigate", url: `${f.origin}/second` },
        f.check
      )
      const act = vi.spyOn(f.broker, "act")
      expect(receipt(await f.invoke({ deliver: true, name: "original.jpg" }))).toEqual(first)
      expect(act).not.toHaveBeenCalled()
      expect(f.store.artifacts(f.conversationId)).toHaveLength(1)
    }, 20000)

    it("rejects a same-URL document replacement during the actual screenshot", async () => {
      const f = await fixture()
      const page = await f.getPage()
      const capture = page.screenshot.bind(page)
      vi.spyOn(page, "screenshot").mockImplementationOnce(async (options) => {
        const bytes = await capture(options)
        await page.reload()
        return bytes
      })
      await expect(f.invoke({ deliver: true })).rejects.toMatchObject({ code: "stale_target" })
      expect(f.store.artifacts(f.conversationId)).toEqual([])
      await expect(f.invoke({ deliver: true })).rejects.toMatchObject({
        code: "effect_requires_review"
      })
      expect(page.screenshot).toHaveBeenCalledTimes(1)
    }, 20000)

    it("fences takeover after capture and before the artifact transaction", async () => {
      const f = await fixture()
      const publish = f.files.publish.bind(f.files)
      vi.spyOn(f.files, "publish").mockImplementationOnce(async (...args) => {
        await f.broker.takeControl(f.broker.target(f.bot.id))
        return publish(...args)
      })
      await expect(f.invoke({ deliver: true })).rejects.toThrow()
      expect(f.store.artifacts(f.conversationId)).toEqual([])
      expect(f.store.messages(f.conversationId).flatMap((message) => message.attachments)).toEqual(
        []
      )
    }, 20000)

    it("labels bounded title text and retains full URL identity without failing a completed navigation", async () => {
      const f = await fixture()
      await f.broker.act(
        f.broker.target(f.bot.id),
        { op: "navigate", url: `${f.origin}/long` },
        f.check
      )
      const result = await f.broker.act(f.broker.target(f.bot.id), { op: "snapshot" }, f.check)
      expect(result.observation).toMatchObject({
        title: "T".repeat(2000),
        titleTruncated: true,
        url: `${f.origin}/long`
      })
      expect(result.observation?.urlSha256).toBe(
        createHash("sha256").update(`${f.origin}/long`).digest("hex")
      )
      const delivered = receipt(await f.invoke({ deliver: true }))
      expect(delivered.data.attachment.status).toBe("attached")
    }, 20000)

    it("does not add a title read to completed input, while failed observations cannot publish an attachment", async () => {
      const f = await fixture()
      const page = await f.getPage()
      const snapshot = await f.broker.act(f.broker.target(f.bot.id), { op: "snapshot" }, f.check)
      const ref = /Name[^\n]*?ref=(e\d+)/.exec(snapshot.data!)![1]
      const title = vi
        .spyOn(page, "title")
        .mockRejectedValue(
          new Error("Execution context was destroyed, most likely because of a navigation")
        )
      const filled = await f.broker.act(
        f.broker.target(f.bot.id),
        { op: "fill", ref, value: "completed" },
        f.check
      )
      expect(await page.locator("#name").inputValue()).toBe("completed")
      expect(filled.observation?.url).toBe(`${f.origin}/first`)
      expect(filled.observation?.title).toBeUndefined()
      expect(title).not.toHaveBeenCalled()
      await expect(f.invoke({ deliver: true })).rejects.toThrow("Execution context was destroyed")
      expect(f.store.artifacts(f.conversationId)).toEqual([])
      await expect(f.invoke({ deliver: true })).rejects.toMatchObject({
        code: "effect_requires_review"
      })
    }, 20000)

    it("does not fill a replaced approved element and accepts only a fresh reviewed call", async () => {
      const f = await fixture()
      const page = await f.getPage()
      const snapshot = await f.broker.act(f.broker.target(f.bot.id), { op: "snapshot" }, f.check)
      const ref = /Name[^\n]*?ref=(e\d+)/.exec(snapshot.data!)![1]
      f.setBeforeDispatch(async () => {
        await page.locator("#name").evaluate((field) => field.replaceWith(field.cloneNode(true)))
      })
      const fill = (ref: string, id: string) =>
        f.tool.invoke({
          type: "tool_call",
          name: "browser",
          id,
          args: { op: "fill", arguments_json: JSON.stringify({ ref, value: "approved" }) }
        })
      const rejected = await fill(ref, "replaced-field")
      expect(String(rejected.content)).toContain("NOT performed")
      expect(await page.locator("#name").inputValue()).toBe("")
      expect(f.store.getRun(f.request.run.id).status).toBe("running")
      f.setBeforeDispatch()
      const fresh = await f.broker.act(f.broker.target(f.bot.id), { op: "snapshot" }, f.check)
      const freshRef = /Name[^\n]*?ref=(e\d+)/.exec(fresh.data!)![1]
      const accepted = await fill(freshRef, "fresh-field")
      expect(String(accepted.content)).not.toContain("NOT performed")
      expect(await page.locator("#name").inputValue()).toBe("approved")
    }, 20000)
  }
)
