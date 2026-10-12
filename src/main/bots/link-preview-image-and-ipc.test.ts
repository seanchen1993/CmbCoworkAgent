import { fileURLToPath, pathToFileURL } from "node:url"
import { test } from "vitest"
import assert from "node:assert/strict"
import { createCanvas } from "@napi-rs/canvas"
import { imageSize } from "image-size"
import { EventEmitter } from "node:events"
import { resolve } from "node:path"
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron"
import { previewImageHeader, BotLinkPreviewImageReader } from "./link-preview-image"
import { BotLinkPreviewService } from "./link-preview-service"
import { registerBotLinkPreviewIpc } from "./link-preview-main-adapter"
import { scrapeBotLinkPreview } from "./link-preview-metadata"
import { botLinkPreviewImage } from "../../shared/bot-link-preview"
const URL = "https://preview.candidate.net/page"
const imageWorker = process.env.CMB_BOT_DOCUMENT_NATIVE_ENTRY
  ? {
      entry: resolve(process.env.CMB_BOT_DOCUMENT_NATIVE_ENTRY),
      executable: process.env.CMB_BOT_NODE ?? process.execPath
    }
  : {
      entry: fileURLToPath(new globalThis.URL("./document-worker-entry.ts", import.meta.url)),
      execArgv: ["--import", pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href]
    }
const png = async () => {
  const canvas = createCanvas(800, 500)
  canvas.getContext("2d").fillRect(0, 0, 800, 500)
  return canvas.encode("png")
}

test("image header denies SVG/polyglot MIME, oversized bytes and dimensions before native decode", async () => {
  const bytes = await png()
  assert.equal(previewImageHeader(bytes, "image/png"), true)
  assert.equal(previewImageHeader(bytes, "image/jpeg"), false)
  assert.equal(
    previewImageHeader(Buffer.from("<svg><script>evil()</script></svg>"), "image/svg+xml"),
    false
  )
  assert.equal(previewImageHeader(Buffer.alloc(512 * 1024 + 1), "image/png"), false)
  const bomb = Buffer.from(bytes)
  bomb.writeUInt32BE(100_000, 16)
  bomb.writeUInt32BE(100_000, 20)
  assert.equal(previewImageHeader(bomb, "image/png"), false)
  assert.equal(
    botLinkPreviewImage.safeParse({
      mime: "image/svg+xml",
      base64: "c3Zn",
      width: 1,
      height: 1
    }).success,
    false
  )
})
test("actual existing utility transport returns new bounded JPEG, strips origin metadata and releases native child", async () => {
  const before = process.getActiveResourcesInfo().filter((value) => value === "ProcessWrap").length
  const reader = new BotLinkPreviewImageReader(imageWorker)
  const input = await png(),
    controller = new AbortController()
  const result = await reader.render(input, "image/png", controller.signal)
  assert.ok(result)
  assert.equal(result.mime, "image/jpeg")
  assert.equal(result.width, 480)
  assert.equal(result.height, 300)
  const encoded = Buffer.from(result.base64, "base64")
  assert.ok(encoded.length <= 128 * 1024)
  assert.notDeepEqual(encoded, input)
  assert.equal(imageSize(encoded).type, "jpg")
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(
    process.getActiveResourcesInfo().filter((value) => value === "ProcessWrap").length,
    before
  )
})
test("utility cancellation of an inflight request kills actual child and releases native resources", async () => {
  const before = process.getActiveResourcesInfo().filter((value) => value === "ProcessWrap").length
  const reader = new BotLinkPreviewImageReader(imageWorker)
  const bytes = await png(),
    controller = new AbortController(),
    pending = reader.render(bytes, "image/png", controller.signal)
  controller.abort(new Error("viewport unmounted"))
  await assert.rejects(pending, /viewport unmounted/)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(
    process.getActiveResourcesInfo().filter((value) => value === "ProcessWrap").length,
    before
  )
})
test("actual Main IPC rejects untrusted frames before lookup/cancel and sender destruction closes only its own scope", async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const ipc: Pick<IpcMain, "handle" | "removeHandler"> = {
    handle: (name, handler) => {
      handlers.set(name, handler)
    },
    removeHandler: (name) => {
      handlers.delete(name)
    }
  }
  let proxyCalls = 0
  const service = new BotLinkPreviewService({
    proxyFor: async (_url, signal) => {
      proxyCalls++
      return new Promise<string>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true
        })
      )
    },
    image: async () => null
  })
  const sender = new EventEmitter() as EventEmitter & { id: number }
  sender.id = 1
  const sender2 = new EventEmitter() as EventEmitter & { id: number }
  sender2.id = 2
  const event = (value: typeof sender, trusted = true) =>
    ({
      sender: value as unknown as WebContents,
      senderFrame: { trusted }
    }) as unknown as IpcMainInvokeEvent
  const dispose = registerBotLinkPreviewIpc(ipc, service, (raw) => {
    if (!(raw.senderFrame as unknown as { trusted: boolean }).trusted)
      throw new Error("main frame required")
  })
  try {
    await assert.rejects(
      Promise.resolve().then(() =>
        handlers.get("bots:getLinkPreview")!(event(sender, false), {
          requestId: crypto.randomUUID(),
          url: URL
        })
      ),
      /main frame/
    )
    assert.throws(
      () =>
        handlers.get("bots:cancelLinkPreview")!(event(sender, false), {
          requestId: crypto.randomUUID()
        }),
      /main frame/
    )
    assert.equal(proxyCalls, 0)
    const failure = handlers.get("bots:cancelLinkPreview")!(event(sender), {
      requestId: "secret-token-invalid"
    })
    assert.equal(
      (failure as { botFailure: { code: string } }).botFailure.code,
      "invalid_link_preview_request"
    )
    assert.equal(JSON.stringify(failure).includes("secret-token-invalid"), false)
    const first = handlers.get("bots:getLinkPreview")!(event(sender), {
      requestId: crypto.randomUUID(),
      url: URL
    })
    const second = handlers.get("bots:getLinkPreview")!(event(sender2), {
      requestId: crypto.randomUUID(),
      url: URL
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    sender.emit("destroyed")
    assert.deepEqual(await first, {
      status: "unavailable",
      reason: "cancelled"
    })
    assert.equal(service.metrics().requests, 1)
    sender2.emit("destroyed")
    assert.deepEqual(await second, {
      status: "unavailable",
      reason: "cancelled"
    })
  } finally {
    const closing = dispose()
    assert.equal(dispose(), closing)
    await closing
  }
})
test("bounded tokenizer has linear fixed attribute work and stops before body/template metadata", () => {
  const title = scrapeBotLinkPreview(
    Buffer.from(
      '<head><template><meta property="og:title" content="hidden"></template><title>real</title></head><body><meta property="og:title" content="fake"></body>'
    ),
    URL
  )
  assert.equal(title.title, "real")
  assert.throws(
    () =>
      scrapeBotLinkPreview(
        Buffer.from(
          "<meta " + Array.from({ length: 65 }, (_, index) => `attr${index}=x`).join(" ") + ">"
        ),
        URL
      ),
    /attribute limit/
  )
  assert.throws(() => scrapeBotLinkPreview(Buffer.from("<meta>".repeat(8193)), URL), /token limit/)
  const entities = Buffer.from("<head><title>" + "&amp;".repeat(45_000) + "</title></head>")
  const start = performance.now()
  assert.equal(scrapeBotLinkPreview(entities, URL).title.length, 512)
  assert.ok(performance.now() - start < 250)
})

test("animation frame amplification is refused by bounded container scan before the native decoder", async () => {
  const pngBytes = await png(),
    animatedPNG = Buffer.concat([
      pngBytes.subarray(0, 33),
      Buffer.from([0, 0, 0, 0, 97, 99, 84, 76, 0, 0, 0, 0]),
      pngBytes.subarray(33)
    ])
  assert.equal(previewImageHeader(animatedPNG, "image/png"), false)
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64")
  const frame = gif.subarray(gif.indexOf(0x2c), gif.length - 1)
  assert.equal(previewImageHeader(gif, "image/gif"), true)
  assert.equal(
    previewImageHeader(
      Buffer.concat([gif.subarray(0, gif.length - 1), frame, Buffer.from([0x3b])]),
      "image/gif"
    ),
    false
  )
})

test("partial IPC registration removes only its newly installed channel, preserving an existing owner", async () => {
  const channels = new Map<string, unknown>()
  const existing = () => "existing"
  channels.set("bots:cancelLinkPreview", existing)
  const ipc: Pick<IpcMain, "handle" | "removeHandler"> = {
    handle(name, handler) {
      if (channels.has(name)) throw new Error("duplicate channel")
      channels.set(name, handler)
    },
    removeHandler: (name) => {
      channels.delete(name)
    }
  }
  const service = new BotLinkPreviewService({
    proxyFor: async () => "DIRECT",
    image: async () => null
  })
  assert.throws(() => registerBotLinkPreviewIpc(ipc, service, () => {}), /duplicate channel/)
  assert.equal(channels.has("bots:getLinkPreview"), false)
  assert.equal(channels.get("bots:cancelLinkPreview"), existing)
  await service.close()
})
