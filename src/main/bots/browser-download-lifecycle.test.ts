import { afterEach, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium, type BrowserContext, type Page } from "playwright"
import { createServer } from "node:http"
import { BotBrowserDownloads } from "./browser-downloads"
import { BotStore } from "./store"
import { BotArtifacts } from "./artifacts"
import { botBrowserFileReceiver } from "./browser-files"
import { pdfDocument } from "./document-fixtures"

it.runIf(process.env.CMB_BOT_BROWSER_TEST === "1")(
  "downloads inline PDF and text originals with one authenticated GET, redirects and server filenames",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "bot-inline-download-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const pdf = pdfDocument(["Original inline PDF"])
    const requests: { path: string; method: string; cookie?: string }[] = []
    const server = createServer((request, response) => {
      requests.push({ path: request.url!, method: request.method!, cookie: request.headers.cookie })
      if (request.url === "/redirect") {
        response.writeHead(302, { Location: "/inline.pdf" })
        response.end()
        return
      }
      if (request.url === "/inline.pdf") {
        response.setHeader("Content-Type", "application/pdf")
        response.end(pdf)
        return
      }
      response.setHeader("Content-Type", "text/plain; charset=utf-8")
      if (request.url === "/server-name")
        response.setHeader("Content-Disposition", "inline; filename*=UTF-8''%E5%8E%9F%E4%BB%B6.txt")
      response.end("INLINE_ORIGINAL\n")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    cleanup.push(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Owned HTTP fixture did not start")
    const url = `http://127.0.0.1:${address.port}`
    const context = await chromium.launchPersistentContext(join(root, "profile"), {
      channel:
        process.env.CMB_BOT_BROWSER_CHANNEL ?? (process.platform === "win32" ? "msedge" : "chrome"),
      chromiumSandbox: true,
      headless: true,
      acceptDownloads: true
    })
    cleanup.push(() => context.close())
    await context.addCookies([{ name: "inline_test", value: "owned", url }])
    const downloads = new BotBrowserDownloads(context, join(root, "staging"))
    cleanup.push(() => downloads.close())
    await downloads.ready()
    for (const [path, name, bytes] of [
      ["/redirect", "inline.pdf", pdf],
      ["/server-name", "原件.txt", Buffer.from("INLINE_ORIGINAL\n")],
      [
        "/%E8%B5%84%E6%96%99%3B%27.txt?do_not_use_as_filename=1",
        "资料;'.txt",
        Buffer.from("INLINE_ORIGINAL\n")
      ]
    ] as const) {
      const page = await context.newPage()
      const result = await downloads.fetch(
        page,
        `${url}${path}`,
        () => {},
        new AbortController().signal
      )
      expect(result.bytes.equals(bytes)).toBe(true)
      expect(result.suggestedName).toBe(name)
      expect(page.isClosed()).toBe(true)
    }
    expect(requests.map((request) => request.path)).toEqual([
      "/redirect",
      "/inline.pdf",
      "/server-name",
      "/%E8%B5%84%E6%96%99%3B%27.txt?do_not_use_as_filename=1"
    ])
    expect(
      requests.every(
        (request) => request.method === "GET" && request.cookie === "inline_test=owned"
      )
    ).toBe(true)
  },
  25_000
)

it.runIf(process.env.CMB_BOT_BROWSER_TEST === "1")(
  "downloads again after reopening the same owned persistent Chromium profile",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "bot-download-profile-reopen-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    for (const phase of ["blob", "post", "post"] as const) {
      const context = await chromium.launchPersistentContext(join(root, "profile"), {
        channel:
          process.env.CMB_BOT_BROWSER_CHANNEL ??
          (process.platform === "win32" ? "msedge" : "chrome"),
        chromiumSandbox: true,
        headless: true,
        args: ["--disable-updater-scheduler"],
        acceptDownloads: true
      })
      const events: unknown[] = []
      const browser = context.browser()!
      const open = browser.newBrowserCDPSession.bind(browser)
      vi.spyOn(browser, "newBrowserCDPSession").mockImplementation(async () => {
        const session = await open()
        const send = session.send.bind(session)
        vi.spyOn(session, "send").mockImplementation(async (method, params) => {
          if (method === "Browser.cancelDownload") events.push({ kind: "cancel" })
          return send(method, params)
        })
        session.on("Browser.downloadWillBegin", (event) => events.push({ kind: "begin", ...event }))
        session.on("Browser.downloadProgress", (event) =>
          events.push({ kind: "progress", ...event })
        )
        return session
      })
      const downloads = new BotBrowserDownloads(context, join(root, "staging"))
      try {
        await downloads.ready()
        const page = await context.newPage()
        page.on("pageerror", (error) => events.push({ kind: "page-error", message: error.message }))
        await downloads.watch(page)
        await page.route("http://127.0.0.1:39174/**", (route) => {
          if (route.request().url().endsWith("/file")) {
            expect(route.request().method()).toBe("POST")
            return route.fulfill({
              headers: { "content-disposition": 'attachment; filename="report.txt"' },
              body: "PROFILE_POST_VERIFIED"
            })
          }
          return route.fulfill({
            contentType: "text/html; charset=utf-8",
            body:
              phase === "post"
                ? '<form action="/file" method="POST"><button>Download</button></form>'
                : `<button onclick="const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob(['PROFILE_BLOB_VERIFIED']));a.download='report.txt';a.click()">Download</button>`
          })
        })
        await page.goto("http://127.0.0.1:39174/")
        events.push({ kind: "owned-page", body: await page.locator("body").innerHTML() })
        const file = await downloads.capture(
          page,
          () => page.getByRole("button", { name: "Download", exact: true }).click(),
          () => {},
          new AbortController().signal
        )
        expect(file.bytes.toString()).toBe(
          phase === "post" ? "PROFILE_POST_VERIFIED" : "PROFILE_BLOB_VERIFIED"
        )
        expect(events.filter((event) => (event as { kind: string }).kind === "cancel")).toEqual([])
      } catch (error) {
        console.error("Owned profile download diagnostic", phase, JSON.stringify(events))
        throw error
      } finally {
        // Match the provider's shutdown order and reuse the exact same profile.
        await context.close()
        await downloads.close()
      }
    }
  },
  35_000
)

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})

class Session extends EventEmitter {
  send = vi.fn(async (method: string): Promise<Record<string, unknown>> => {
    void method
    return {}
  })
  detach = vi.fn(async () => {})
}

async function fixture(open: () => Promise<Session>) {
  const root = await mkdtemp(join(tmpdir(), "bot-download-lifecycle-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, "unrelated.txt"), "keep")
  const newBrowserCDPSession = vi.fn(open)
  const context = {
    browser: () => ({ newBrowserCDPSession })
  } as unknown as BrowserContext
  const downloads = new BotBrowserDownloads(context, root)
  cleanup.push(() => downloads.close())
  return { downloads, root, context, newBrowserCDPSession }
}

it("coalesces setup and permits an explicit retry after transport attachment fails", async () => {
  const session = new Session()
  let attempts = 0
  const f = await fixture(async () => {
    if (++attempts === 1) throw new Error("transient attachment failure")
    return session
  })
  const failed = await Promise.allSettled([f.downloads.ready(), f.downloads.ready()])
  expect(failed.map((item) => item.status)).toEqual(["rejected", "rejected"])
  expect(f.newBrowserCDPSession).toHaveBeenCalledTimes(1)
  await Promise.all([f.downloads.ready(), f.downloads.ready()])
  await f.downloads.ready()
  expect(f.newBrowserCDPSession).toHaveBeenCalledTimes(2)
  expect(session.send.mock.calls.map(([method]) => method)).toEqual([
    "Target.setDiscoverTargets",
    "Browser.setDownloadBehavior"
  ])
})

it("cleans only its failed staging folder before retrying download configuration", async () => {
  const failed = new Session(),
    healthy = new Session()
  failed.send.mockImplementation(async (method) => {
    if (method === "Browser.setDownloadBehavior") throw new Error("transient configuration failure")
    return {}
  })
  let attempts = 0
  const f = await fixture(async () => (++attempts === 1 ? failed : healthy))
  await expect(f.downloads.ready()).rejects.toThrow("transient configuration failure")
  expect(failed.detach).toHaveBeenCalledTimes(1)
  expect(await readdir(f.root)).toEqual(["unrelated.txt"])
  await f.downloads.ready()
  expect((await readdir(f.root)).filter((name) => name.startsWith("session-"))).toHaveLength(1)
  const firstClose = f.downloads.close()
  const secondClose = f.downloads.close()
  expect(secondClose).toBe(firstClose)
  await firstClose
  expect(healthy.detach).toHaveBeenCalledTimes(1)
  expect(await readdir(f.root)).toEqual(["unrelated.txt"])
  await expect(f.downloads.ready()).rejects.toThrow("下载服务已关闭")
  expect(f.newBrowserCDPSession).toHaveBeenCalledTimes(2)
})

it("does not enable downloads when shutdown wins a pending attachment", async () => {
  const session = new Session()
  let release!: (session: Session) => void
  const f = await fixture(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const pending = f.downloads.ready()
  const rejected = expect(pending).rejects.toThrow("下载服务已关闭")
  const closing = f.downloads.close()
  release(session)
  await rejected
  await closing
  expect(session.send).not.toHaveBeenCalled()
  expect(session.detach).toHaveBeenCalledTimes(1)
  expect(await readdir(f.root)).toEqual(["unrelated.txt"])
})

it("rejects late readiness and drains cleanup when shutdown interrupts configuration", async () => {
  const session = new Session()
  let release!: () => void, started!: () => void
  const configured = new Promise<void>((resolve) => {
    started = resolve
  })
  session.send.mockImplementation(async (method) => {
    if (method === "Browser.setDownloadBehavior") {
      started()
      await new Promise<void>((resolve) => {
        release = resolve
      })
    }
    return {}
  })
  const f = await fixture(async () => session)
  const pending = f.downloads.ready()
  const rejected = expect(pending).rejects.toThrow("下载服务已关闭")
  await configured
  const closing = f.downloads.close()
  release()
  await rejected
  await closing
  expect(session.detach).toHaveBeenCalledTimes(1)
  expect(await readdir(f.root)).toEqual(["unrelated.txt"])
})

function pageSession() {
  const session = new Session()
  session.send.mockImplementation(async (method) => {
    if (method === "Target.getTargetInfo") return { targetInfo: { targetId: "page-target" } }
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } }
    return {}
  })
  const pageEvents = Object.assign(new EventEmitter(), { isClosed: () => false })
  return { session, page: pageEvents as unknown as Page, pageEvents }
}

it("records an accepted download before progress and keeps its identity on interruption", async () => {
  const session = new Session()
  const f = await fixture(async () => session)
  const target = pageSession()
  Object.assign(f.context, { newCDPSession: vi.fn(async () => target.session) })
  const receiver = {
    owner: "bot",
    check: vi.fn(),
    started: vi.fn(),
    complete: vi.fn(async () => {}),
    failed: vi.fn()
  }
  await f.downloads.watch(target.page, () => receiver)
  const guid = "416ce371-0293-4b7a-9328-e5d5e86a1a58"
  session.emit("Browser.downloadWillBegin", {
    frameId: "main-frame",
    guid,
    suggestedFilename: "report.txt"
  })
  expect(receiver.started).toHaveBeenCalledExactlyOnceWith(guid)
  await f.downloads.close()
  expect(receiver.complete).not.toHaveBeenCalled()
  expect(receiver.failed).toHaveBeenCalledExactlyOnceWith("浏览器已关闭，下载未完成", guid)
})

it("cancels without starting a job when its durable identity cannot be recorded", async () => {
  const session = new Session()
  const f = await fixture(async () => session)
  const target = pageSession()
  Object.assign(f.context, { newCDPSession: vi.fn(async () => target.session) })
  const receiver = {
    owner: "bot",
    check: vi.fn(),
    started: vi.fn(() => {
      throw new Error("storage unavailable")
    }),
    complete: vi.fn(async () => {}),
    failed: vi.fn()
  }
  await f.downloads.watch(target.page, () => receiver)
  const guid = "416ce371-0293-4b7a-9328-e5d5e86a1a58"
  session.emit("Browser.downloadWillBegin", {
    frameId: "main-frame",
    guid,
    suggestedFilename: "report.txt"
  })
  expect(session.send).toHaveBeenCalledWith("Browser.cancelDownload", { guid })
  expect(f.downloads.busy).toBe(false)
  expect(receiver.failed).toHaveBeenCalledExactlyOnceWith("storage unavailable")
  session.emit("Browser.downloadProgress", {
    guid,
    receivedBytes: 1,
    totalBytes: 1,
    state: "completed"
  })
  await f.downloads.close()
  expect(receiver.complete).not.toHaveBeenCalled()
})

it("drains a late page attachment instead of registering a page after shutdown", async () => {
  const f = await fixture(async () => new Session())
  await f.downloads.ready()
  const { session, page, pageEvents } = pageSession()
  let release!: (session: Session) => void, started!: () => void
  const attaching = new Promise<void>((resolve) => {
    started = resolve
  })
  Object.assign(f.context, {
    newCDPSession: vi.fn(() => {
      started()
      return new Promise<Session>((resolve) => {
        release = resolve
      })
    })
  })
  const pending = f.downloads.watch(page)
  const rejected = expect(pending).rejects.toThrow("下载服务已关闭")
  await attaching
  const closing = f.downloads.close()
  release(session)
  await rejected
  await closing
  expect(session.send).not.toHaveBeenCalled()
  expect(session.detach).toHaveBeenCalledTimes(1)
  expect(pageEvents.listenerCount("close")).toBe(0)
})

it("removes page listeners and rejects cached watchers when downloads close", async () => {
  const f = await fixture(async () => new Session())
  const { session, page, pageEvents } = pageSession()
  Object.assign(f.context, { newCDPSession: vi.fn(async () => session) })
  await f.downloads.watch(page)
  expect(pageEvents.listenerCount("close")).toBe(1)
  await f.downloads.close()
  expect(pageEvents.listenerCount("close")).toBe(0)
  expect(session.listenerCount("Page.frameAttached")).toBe(0)
  expect(session.listenerCount("Page.frameNavigated")).toBe(0)
  expect(session.listenerCount("Page.frameDetached")).toBe(0)
  expect(session.detach).toHaveBeenCalledTimes(1)
  await expect(f.downloads.watch(page)).rejects.toThrow("下载服务已关闭")
  pageEvents.emit("close", page)
  expect(session.detach).toHaveBeenCalledTimes(1)
})

it.runIf(process.env.CMB_BOT_BROWSER_TEST === "1")(
  "recovers a detached Chromium control session and collects a real page download",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "bot-download-cdp-retry-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const profile = await mkdtemp(join(tmpdir(), "bot-download-retry-profile-"))
    cleanup.push(() => rm(profile, { recursive: true, force: true }))
    const context = await chromium.launchPersistentContext(profile, {
      channel:
        process.env.CMB_BOT_BROWSER_CHANNEL ?? (process.platform === "win32" ? "msedge" : "chrome"),
      chromiumSandbox: true,
      headless: true,
      args: ["--disable-updater-scheduler"],
      acceptDownloads: true
    })
    cleanup.push(() => context.close())
    const browser = context.browser()!
    const open = browser.newBrowserCDPSession.bind(browser)
    let first = true
    const attempts = vi.spyOn(browser, "newBrowserCDPSession").mockImplementation(async () => {
      const session = await open()
      if (first) {
        first = false
        await session.detach()
      }
      return session
    })
    const store = new BotStore(":memory:")
    cleanup.push(async () => store.close())
    const objects = await mkdtemp(join(tmpdir(), "bot-download-retry-objects-"))
    cleanup.push(() => rm(objects, { recursive: true, force: true }))
    const files = new BotArtifacts(objects, store)
    cleanup.push(() => files.close())
    const { bot, conversationId } = store.createBot({ nonce: "bot", name: "Download Bot" })
    const downloads = new BotBrowserDownloads(context, root)
    cleanup.push(() => downloads.close())
    await expect(downloads.ready()).rejects.toThrow()
    expect(await readdir(root)).toEqual([])
    await Promise.all([downloads.ready(), downloads.ready()])
    expect(attempts).toHaveBeenCalledTimes(2)
    const page = await context.newPage()
    const errors: string[] = []
    await downloads.watch(page, () =>
      botBrowserFileReceiver({
        store,
        files,
        botId: bot.id,
        conversationId,
        errors
      })
    )
    await page.route("http://127.0.0.1:39174/**", (route) =>
      route.fulfill(
        route.request().url().endsWith("/file")
          ? {
              body: "DOWNLOAD_RETRIED",
              headers: {
                "content-disposition": 'attachment; filename="report.txt"',
                "content-type": "text/plain"
              }
            }
          : { body: '<a href="/file">下载报告</a>', contentType: "text/html; charset=utf-8" }
      )
    )
    await page.goto("http://127.0.0.1:39174/")
    await page.getByRole("link", { name: "下载报告" }).click()
    await expect.poll(() => store.artifacts(conversationId), { timeout: 10_000 }).toHaveLength(1)
    expect((await files.read(store.artifacts(conversationId)[0].id)).bytes.toString()).toBe(
      "DOWNLOAD_RETRIED"
    )
    expect(store.messages(conversationId)).toHaveLength(1)
    expect(store.browserDownloads.recoverAtStartup()).toBe(0)
    expect(errors).toEqual([])
    await downloads.close()
    expect(await readdir(root)).toEqual([])
  },
  25_000
)
