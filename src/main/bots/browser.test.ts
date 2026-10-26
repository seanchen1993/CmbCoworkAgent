import { EventEmitter } from "node:events"
import { DatabaseSync } from "node:sqlite"
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  realpathSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  truncateSync,
  symlinkSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BotBrowserService } from "./browser"
import type { BotBrowserEngine } from "./browser-engine"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost, type BotRunPort } from "./host"
import { botGroupBrowserScope } from "../../shared/bots/contracts"

const launch = vi.fn()
class TestPage extends EventEmitter {
  closed = false
  address = "about:blank"
  goto = vi.fn(async (url: string) => {
    this.address = url
  })
  goBack = vi.fn(async (_options: unknown) => null)
  goForward = vi.fn(async (_options: unknown) => null)
  reload = vi.fn(async (_options: unknown) => null)
  fill = vi.fn(async () => {})
  click = vi.fn(async () => {})
  press = vi.fn(async () => {})
  setInputFiles = vi.fn<(file: string) => Promise<void>>(async () => {})
  getByLabel = vi.fn(() => ({ count: async () => 1, setInputFiles: this.setInputFiles }))
  snapshot = vi.fn(async () => '- textbox "Name"')
  _snapshotForAI = async () => ({ full: await this.snapshot() })
  fileInputs = vi.fn(
    async (): Promise<{
      controls: { label: string | null; multiple: boolean; accept: string; disabled: boolean }[]
      truncated: boolean
    }> => ({ controls: [], truncated: false })
  )
  mouse = { wheel: vi.fn(async () => {}) }
  bringToFront = vi.fn(async () => {})
  getByRole() {
    return { count: async () => 1, fill: this.fill, click: this.click, press: this.press }
  }
  locator(selector: string) {
    return {
      ariaSnapshot: this.snapshot,
      evaluateAll: selector === 'input[type="file"]' ? this.fileInputs : undefined
    }
  }
  url() {
    return this.address
  }
  title = async () => "Test page"
  screenshot = async () => Buffer.from("fixture")
  opener = async (): Promise<TestPage | null> => null
  isClosed() {
    return this.closed
  }
  async close() {
    if (!this.closed) {
      this.closed = true
      this.emit("close")
    }
  }
}
class TestContext extends EventEmitter {
  entries: TestPage[] = []
  pages() {
    return this.entries
  }
  async newPage() {
    const page = new TestPage()
    this.entries.push(page)
    this.emit("page", page)
    return page
  }
  setDefaultTimeout = vi.fn()
  setDefaultNavigationTimeout = vi.fn()
  async close() {
    await Promise.all(this.entries.map((page) => page.close()))
    this.emit("close")
  }
}
let context: TestContext, service: BotBrowserService, directory: string
let hidden: ((page: TestPage, generation: number) => void) | undefined
const signal = () => new AbortController().signal
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "bot-browser-test-"))
  context = new TestContext()
  hidden = undefined
  launch.mockReset().mockImplementation(
    async () =>
      ({
        context,
        createPage: () => context.newPage(),
        getTitle: async () => "Test page",
        getPageState: async () => ({ title: "Test page", canGoBack: false, canGoForward: false }),
        capturePage: vi.fn(async (_page: TestPage) => Buffer.from("fixture")),
        show: (page: TestPage) => page.bringToFront(),
        onWindowHidden: (listener: (page: TestPage, generation: number) => void) => {
          hidden = listener
          return () => {
            if (hidden === listener) hidden = undefined
          }
        },
        hide: async () => {},
        close: () => context.close()
      }) as unknown as BotBrowserEngine
  )
  service = new BotBrowserService(launch)
})
afterEach(async () => {
  await service.close()
  rmSync(directory, { recursive: true, force: true })
})

describe("Bot browser ownership and control", () => {
  it.each(["help", "manual"] as const)(
    "releases a removed member's %s lease through Host without affecting its other conversations",
    async (mode) => {
      const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
      const store = new BotStore(db)
      const errors = vi.fn()
      const cleanup: Promise<void>[] = []
      let scope = ""
      let pageId = ""
      let runSignal: AbortSignal | undefined
      const waiting = vi.fn()
      const removeGroupMemberBrowser = vi.fn((groupId: string, botId: string) => {
        const operation = service.removeGroupMember(groupId, botId)
        cleanup.push(operation)
        return operation
      })
      const runtime: BotRunPort = {
        browser: true,
        onAvailable: () => () => {},
        removeGroupMemberBrowser,
        acquire: () => ({
          release() {},
          async execute(signal, active) {
            runSignal = signal
            await service.act(
              scope,
              mode === "help"
                ? { action: "request_help", pageId, instruction: "Synthetic member step" }
                : { action: "observe", pageId },
              signal,
              (value) => {
                waiting(value)
                active(value)
              }
            )
            return { state: "completed" }
          }
        })
      }
      const host = new LocalBotHost(store, runtime, 2, errors)
      try {
        const input = { name: "A", instructions: "", color: "#123456", modelRef: null }
        const a = host.create(input)
        const b = host.create({ ...input, name: "B" })
        let group = host.saveGroup({ name: "Removed member", memberIds: [a.id, b.id] })
        const other = host.saveGroup({ name: "Other room", memberIds: [a.id, b.id] })
        scope = botGroupBrowserScope(group.id, a.id)
        pageId = JSON.parse(await service.act(scope, { action: "observe" }, signal())).pageId
        for (const owner of [
          a.id,
          botGroupBrowserScope(other.id, a.id),
          `work-synthetic--${a.id}`
        ])
          await service.act(owner, { action: "observe" }, signal())
        if (mode === "manual") await service.takeOver(scope, pageId)
        host.sendGroup({
          groupId: group.id,
          requestId: "member-help",
          text: "Synthetic step",
          targetBotIds: [a.id]
        })
        await vi.waitFor(() => expect(waiting).toHaveBeenCalledWith(true))
        group = host.saveGroup({ name: "Renamed", memberIds: [b.id, a.id] }, group)
        expect(removeGroupMemberBrowser).not.toHaveBeenCalled()
        expect(runSignal?.aborted).toBe(false)
        group = host.saveGroup({ name: group.name, memberIds: [b.id] }, group)
        expect(runSignal?.aborted).toBe(true)
        expect(removeGroupMemberBrowser).toHaveBeenCalledExactlyOnceWith(group.id, a.id)
        expect(() => host.browserScope(scope)).toThrow("离开")
        // Start the remaining member's claim immediately, before old page cleanup settles.
        const remaining = botGroupBrowserScope(group.id, b.id)
        await service.takeOver(host.browserScope(remaining))
        await Promise.all(cleanup)
        await vi.waitFor(() => expect(host.hasActiveRuns()).toBe(false))
        expect(store.recentTasks().find((task) => task.origin.kind === "group")?.state).toBe(
          "cancelled"
        )
        expect((await service.preview(remaining)).control).toBe("human")
        expect((await service.preview(scope)).pages).toEqual([])
        expect(context.entries.slice(0, 4).map((page) => page.closed)).toEqual([
          true, false, false, false
        ])
        await service.giveBack(remaining)
        group = host.saveGroup({ name: group.name, memberIds: [a.id, b.id] }, group)
        const rejoined = JSON.parse(
          await service.act(host.browserScope(scope), { action: "observe" }, signal())
        )
        expect(rejoined.pageId).not.toBe(pageId)
        await service.takeOver(scope, rejoined.pageId)
        expect((await service.preview(scope)).control).toBe("human")
        await service.giveBack(scope)
        expect(errors).not.toHaveBeenCalled()
      } finally {
        await host.stop()
        db.close()
      }
    }
  )

  it("does not let delayed old-page close events revoke a quickly rejoined member's lease", async () => {
    const scope = "group-room--a"
    await service.act(scope, { action: "observe" }, signal())
    await service.takeOver(scope)
    const entered = deferred()
    const finish = deferred()
    const old = context.entries[0]
    const close = old.close.bind(old)
    old.close = async () => {
      entered.resolve()
      await finish.promise
      await close()
    }
    const removing = service.removeGroupMember("room", "a")
    await entered.promise
    const rejoining = service.takeOver(scope)
    finish.resolve()
    await Promise.all([removing, rejoining])
    const current = await service.preview(scope)
    expect(current.control).toBe("human")
    expect(current.pages).toHaveLength(1)
    expect(old.closed).toBe(true)
    expect(context.entries[1].closed).toBe(false)
    await service.giveBack(scope, current.generation)
  })

  it("cleans a cancelled in-flight creation before allowing a new member page and rejects its late popup", async () => {
    const engine = await launch()
    launch.mockResolvedValue(engine)
    const entered = deferred()
    const finish = deferred()
    const create = engine.createPage
    engine.createPage = async () => {
      entered.resolve()
      await finish.promise
      return create()
    }
    const controller = new AbortController()
    const creating = service.act("group-room--a", { action: "observe" }, controller.signal)
    const rejected = expect(creating).rejects.toThrow("removed member")
    await entered.promise
    controller.abort(new Error("removed member"))
    const removing = service.removeGroupMember("room", "a")
    finish.resolve()
    await rejected
    await removing
    expect(context.entries[0].closed).toBe(true)
    await service.takeOver("b")
    const popup = new TestPage()
    popup.opener = async () => context.entries[0]
    context.entries[0].emit("popup", popup)
    context.emit("page", popup)
    await vi.waitFor(() => expect(popup.closed).toBe(true))
    expect((await service.preview("b")).pages).toHaveLength(1)
    expect((await service.preview("b")).control).toBe("human")
    await service.giveBack("b")
    await service.act("group-room--a", { action: "observe" }, signal())
    expect((await service.preview("group-room--a")).pages).toHaveLength(1)
  })

  it("rejects a queued old takeover before page creation and preserves another scope's new claim", async () => {
    const peer = JSON.parse(await service.act("peer", { action: "observe" }, signal()))
    const entered = deferred()
    const finish = deferred()
    context.entries[0].snapshot.mockImplementationOnce(async () => {
      entered.resolve()
      await finish.promise
      return "- heading Peer"
    })
    const observing = service.act("peer", { action: "observe", pageId: peer.pageId }, signal())
    const observed = Promise.allSettled([observing])
    await entered.promise
    const stale = service.takeOver("group-room--a")
    const rejected = expect(stale).rejects.toThrow("控制权已改变")
    const removing = service.removeGroupMember("room", "a")
    const current = service.takeOver("b")
    const waiting = vi.fn()
    let outcome = "pending"
    const pending = service.act("b", { action: "observe" }, signal(), waiting).then(
      (result) => {
        outcome = "resolved"
        return { result }
      },
      (error: unknown) => {
        outcome = "rejected"
        return { error }
      }
    )
    expect(waiting).toHaveBeenCalledExactlyOnceWith(true)
    finish.resolve()
    await Promise.all([observed, rejected, removing, current])
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(context.entries).toHaveLength(2)
    expect((await service.preview("group-room--a")).pages).toEqual([])
    expect((await service.preview("b")).control).toBe("human")
    expect(outcome).toBe("pending")
    expect(waiting).toHaveBeenCalledExactlyOnceWith(true)
    await service.giveBack("b")
    const returned = await pending
    expect(returned).not.toHaveProperty("error")
    if (!("result" in returned)) throw returned.error
    expect(JSON.parse(returned.result)).toMatchObject({
      control: "bot",
      content: '- textbox "Name"'
    })
    expect(waiting.mock.calls).toEqual([[true], [false]])
  })

  it("releases and wakes observation when the current claim's show fails", async () => {
    const engine = await launch()
    launch.mockResolvedValue(engine)
    const entered = deferred()
    const finish = deferred()
    const show = engine.show
    engine.show = async () => {
      entered.resolve()
      await finish.promise
      throw new Error("Synthetic current show failure")
    }
    const taking = service.takeOver("b")
    const rejected = expect(taking).rejects.toThrow("Synthetic current show failure")
    await entered.promise
    const waiting = vi.fn()
    const observing = service.act("b", { action: "observe" }, signal(), waiting)
    expect(waiting).toHaveBeenCalledExactlyOnceWith(true)
    finish.resolve()
    await rejected
    expect(JSON.parse(await observing)).toMatchObject({
      control: "bot",
      content: '- textbox "Name"'
    })
    expect(waiting.mock.calls).toEqual([[true], [false]])
    expect((await service.preview("b")).control).toBe("bot")
    engine.show = show
    await service.takeOver("b")
    expect((await service.preview("b")).control).toBe("human")
    await service.giveBack("b")
  })

  it("does not let a removed member's delayed return wake or invalidate a newer help request", async () => {
    const engine = await launch()
    launch.mockResolvedValue(engine)
    await service.takeOver("group-room--a")
    const entered = deferred()
    const finish = deferred()
    engine.hide = async () => {
      entered.resolve()
      await finish.promise
    }
    const returning = service.giveBack("group-room--a")
    await entered.promise
    const removing = service.removeGroupMember("room", "a")
    const taking = service.takeOver("b")
    finish.resolve()
    await Promise.all([returning, removing, taking])
    const current = await service.preview("b")
    expect(current.control).toBe("human")
    const waiting = vi.fn()
    const action = service.act("b", { action: "observe", pageId: current.pageId! }, signal(), waiting)
    await vi.waitFor(() => expect(waiting).toHaveBeenCalledWith(true))
    expect(waiting).not.toHaveBeenCalledWith(false)
    engine.hide = async () => {}
    await service.giveBack("b", current.generation)
    expect(JSON.parse(await action).control).toBe("bot")
  })

  it("keeps a peer's in-flight observation valid when releasing the removed member's human lease", async () => {
    await service.takeOver("group-room--a")
    const entered = deferred()
    const finish = deferred()
    const peer = JSON.parse(await service.act("peer", { action: "observe" }, signal()))
    context.entries[1].snapshot.mockImplementationOnce(async () => {
      entered.resolve()
      await finish.promise
      return '- heading "Peer result"'
    })
    const observing = service.act("peer", { action: "observe", pageId: peer.pageId }, signal())
    await entered.promise
    const removing = service.removeGroupMember("room", "a")
    finish.resolve()
    expect(JSON.parse(await observing).content).toBe('- heading "Peer result"')
    await removing
    expect(context.entries[1].closed).toBe(false)
    expect((await service.preview("peer")).pageId).toBe(peer.pageId)
  })

  it("retains a failed native close for cleanup retry without permanently retiring the member scope", async () => {
    await service.takeOver("group-room--a")
    vi.spyOn(context.entries[0], "close").mockRejectedValueOnce(new Error("Synthetic close failure"))
    await expect(service.removeGroupMember("room", "a")).rejects.toThrow("Synthetic close failure")
    expect((await service.preview("group-room--a")).control).toBe("bot")
    expect((await service.preview("group-room--a")).pages).toHaveLength(1)
    await service.removeGroupMember("room", "a")
    expect(context.entries[0].closed).toBe(true)
    await service.takeOver("group-room--a")
    expect((await service.preview("group-room--a")).control).toBe("human")
    expect(context.entries[1].closed).toBe(false)
    await service.giveBack("group-room--a")
  })

  it("publishes a downloaded file only after saving its complete contents", async () => {
    service = new BotBrowserService(launch, () => directory)
    await service.act("a", { action: "observe" }, signal())
    const entered = deferred()
    const finish = deferred()
    const deleted = deferred()
    const download = {
      suggestedFilename: () => "complete.csv",
      saveAs: vi.fn(async (path: string) => {
        writeFileSync(path, "partial")
        entered.resolve()
        await finish.promise
        writeFileSync(path, "id,amount\n1,14.25\n2,-2.75\n")
      }),
      cancel: vi.fn(async () => {}),
      delete: vi.fn(async () => deleted.resolve())
    }
    context.entries[0].emit("download", download)
    try {
      await entered.promise
      const saving = JSON.parse(await service.act("a", { action: "observe" }, signal()))
        .downloads[0]
      expect(saving.state).toBe("saving")
      expect(existsSync(join(directory, saving.file))).toBe(false)
      finish.resolve()
      await deleted.promise
      const saved = JSON.parse(await service.act("a", { action: "observe" }, signal())).downloads[0]
      expect(saved).toEqual({ file: saving.file, state: "saved" })
      expect(readFileSync(join(directory, saved.file), "utf8")).toBe(
        "id,amount\n1,14.25\n2,-2.75\n"
      )
      expect(
        readdirSync(join(directory, "downloads")).filter((name) => name.endsWith(".part"))
      ).toEqual([])
      expect(download.saveAs).toHaveBeenCalledTimes(1)
      expect(download.delete).toHaveBeenCalledTimes(1)
    } finally {
      finish.resolve()
      await deleted.promise
    }
  })

  it.each(["save failure", "oversize"])(
    "cleans a %s without deleting another file at the intended destination",
    async (failure) => {
      service = new BotBrowserService(launch, () => directory)
      await service.act("a", { action: "observe" }, signal())
      const entered = deferred()
      const finish = deferred()
      const deleted = deferred()
      const download = {
        suggestedFilename: () => "failed.csv",
        saveAs: vi.fn(async (path: string) => {
          writeFileSync(path, "partial")
          entered.resolve()
          await finish.promise
          if (failure === "save failure") throw new Error("Synthetic save failure")
          // A sparse file exercises the limit without allocating a 100 MiB buffer.
          truncateSync(path, 100 * 1024 * 1024 + 1)
        }),
        cancel: vi.fn(async () => {}),
        delete: vi.fn(async () => deleted.resolve())
      }
      context.entries[0].emit("download", download)
      try {
        await entered.promise
        const saving = JSON.parse(await service.act("a", { action: "observe" }, signal()))
          .downloads[0]
        const otherFile = join(directory, saving.file)
        writeFileSync(otherFile, "existing peer result")
        finish.resolve()
        await deleted.promise
        const failed = JSON.parse(await service.act("a", { action: "observe" }, signal()))
          .downloads[0]
        expect(failed).toEqual({ file: saving.file, state: "failed" })
        expect(readFileSync(otherFile, "utf8")).toBe("existing peer result")
        expect(readdirSync(join(directory, "downloads"))).toEqual([saving.file.split("/").at(-1)])
        expect(download.delete).toHaveBeenCalledTimes(1)
      } finally {
        finish.resolve()
        await deleted.promise
      }
    }
  )

  it("keeps preview metadata from blocking dialog handling on the same browser queue", async () => {
    const { pageId } = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    const page = context.entries[0]
    let releaseTitle!: (title: string) => void
    page.title = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releaseTitle = resolve
        })
    )
    let finishInput!: () => void
    const accept = vi.fn(async () => finishInput())
    page.click.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishInput = resolve
          page.emit("dialog", { type: () => "confirm", message: () => "Synthetic", accept })
        })
    )
    try {
      const opened = JSON.parse(
        await service.act("a", { action: "click", pageId, role: "button", name: "Open" }, signal())
      )
      expect(opened.dialog.type).toBe("confirm")
      const engine = (await launch.mock.results[0].value) as BotBrowserEngine
      const capture = vi.spyOn(engine, "capturePage")
      let preview: Awaited<ReturnType<BotBrowserService["preview"]>> | undefined
      const pending = service.preview("a", pageId).then((value) => {
        preview = value
      })
      await vi.waitFor(() => expect(preview).toBeDefined(), { timeout: 300 })
      await pending
      expect(preview!.pages).toEqual([
        { id: pageId, url: "about:blank", title: "Test page", canGoBack: false, canGoForward: false }
      ])
      expect(preview!.dialogPending).toBe(true)
      expect(page.title).not.toHaveBeenCalled()
      expect(capture).not.toHaveBeenCalled()
      const handled = JSON.parse(
        await service.act("a", { action: "dialog", pageId, accept: true }, signal())
      )
      expect(handled.dialog).toBeUndefined()
      expect(accept).toHaveBeenCalledTimes(1)
      expect(page.click).toHaveBeenCalledTimes(1)
      const resumed = await service.preview("a", pageId)
      expect(resumed.dialogPending).toBe(false)
      expect(resumed.image).toBeTruthy()
    } finally {
      releaseTitle?.("Test page")
      finishInput?.()
    }
  })
  it("returns current control and history metadata when capture fails, then recovers on the same page", async () => {
    const { pageId } = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    const page = context.entries[0]
    await service.takeOver("a", pageId)
    const lease = await service.preview("a", pageId)
    const engine = (await launch.mock.results[0].value) as BotBrowserEngine
    engine.getPageState = vi.fn(async () => ({
      title: "Native history",
      canGoBack: true,
      canGoForward: false
    }))
    const screenshot = vi.spyOn(page, "screenshot").mockRejectedValue(new Error("fonts never ready"))
    const capture = vi.spyOn(engine, "capturePage").mockRejectedValueOnce(new Error("capture failed"))
    const failed = await service.preview("a", pageId)
    expect(failed).toMatchObject({
      pageId,
      image: null,
      captureError: "暂时无法获取浏览器画面，请刷新重试",
      control: "human",
      generation: lease.generation,
      pages: [{ id: pageId, title: "Native history", canGoBack: true, canGoForward: false }]
    })
    expect(page.isClosed()).toBe(false)
    await service.giveBack("a", failed.generation)
    const recovered = await service.preview("a", pageId)
    expect(recovered.control).toBe("bot")
    expect(recovered.pageId).toBe(pageId)
    expect(recovered.image).toBeTruthy()
    expect(recovered.captureError).toBeUndefined()
    page.emit("dialog", { type: () => "confirm", message: () => "Synthetic" })
    expect(await service.preview("a", pageId)).toMatchObject({
      image: null,
      dialogPending: true
    })
    expect((await service.preview("a", pageId)).captureError).toBeUndefined()
    expect(capture).toHaveBeenCalledTimes(2)
    expect(capture).toHaveBeenLastCalledWith(page)
    expect(screenshot).not.toHaveBeenCalled()
    await page.close()
    expect(await service.preview("a")).toMatchObject({ pages: [], image: null })
    expect((await service.preview("a")).captureError).toBeUndefined()
  })

  it.each([false, true])(
    "retains the last shown page after return and default preview reentry (help=%s)",
    async (help) => {
      const first = JSON.parse(await service.act("a", { action: "observe" }, signal()))
      const second = JSON.parse(
        await service.act(
          "a",
          { action: "navigate", newTab: true, url: "https://example.test/B" },
          signal()
        )
      )
      const waiting = vi.fn()
      let resumed: Promise<string> | undefined
      if (help) {
        resumed = service.act(
          "a",
          { action: "request_help", pageId: second.pageId, instruction: "Inspect B" },
          signal(),
          waiting
        )
        await vi.waitFor(() => expect(waiting).toHaveBeenCalledWith(true))
      } else await service.takeOver("a", second.pageId)
      try {
        const before = await service.preview("a")
        expect(before.pageId).toBe(second.pageId)
        await service.giveBack("a", before.generation)
        if (resumed) expect(JSON.parse(await resumed).pageId).toBe(second.pageId)
        for (let reentry = 0; reentry < 2; reentry++)
          expect(await service.preview("a")).toMatchObject({
            pageId: second.pageId,
            control: "bot",
            pages: [{ id: first.pageId }, { id: second.pageId }]
          })
        // UI selection does not retarget a model call that omitted pageId.
        expect(JSON.parse(await service.act("a", { action: "observe" }, signal())).pageId).toBe(
          first.pageId
        )
        expect(context.entries[1].bringToFront).toHaveBeenCalledOnce()
      } finally {
        if ((await service.preview("a")).control === "human") await service.giveBack("a")
        await resumed
      }
    }
  )

  it("keeps the original default until a page is selected and remembers each owner's choice", async () => {
    const first = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    const second = JSON.parse(
      await service.act(
        "a",
        { action: "navigate", newTab: true, url: "https://example.test/B" },
        signal()
      )
    )
    const peer = JSON.parse(await service.act("b", { action: "observe" }, signal()))
    expect((await service.preview("a")).pageId).toBe(first.pageId)
    await service.preview("a", second.pageId)
    expect((await service.preview("b")).pageId).toBe(peer.pageId)
    expect((await service.preview("a")).pageId).toBe(second.pageId)
    await service.takeOver("a")
    expect(context.entries[0].bringToFront).not.toHaveBeenCalled()
    expect(context.entries[1].bringToFront).toHaveBeenCalledOnce()
    await service.giveBack("a")
    expect((await service.preview("b")).pageId).toBe(peer.pageId)
    expect((await service.preview("a")).pages.map((page) => page.id)).toEqual([
      first.pageId,
      second.pageId
    ])
  })

  it("does not replace the remembered page with a missing or foreign explicit target", async () => {
    await service.act("a", { action: "observe" }, signal())
    const second = JSON.parse(
      await service.act(
        "a",
        { action: "navigate", newTab: true, url: "https://example.test/B" },
        signal()
      )
    )
    const peer = JSON.parse(await service.act("b", { action: "observe" }, signal()))
    await service.preview("a", second.pageId)
    expect(await service.preview("a", "missing")).toMatchObject({ pageId: null, image: null })
    await expect(service.preview("a", peer.pageId)).rejects.toThrow("不属于")
    await expect(service.takeOver("a", "missing")).rejects.toThrow("已关闭")
    expect((await service.preview("a")).pageId).toBe(second.pageId)
    expect(context.entries.every((page) => !page.closed)).toBe(true)
  })

  it.each([false, true])(
    "keeps the last successful view when showing another page fails (active=%s)",
    async (active) => {
      const first = JSON.parse(await service.act("a", { action: "observe" }, signal()))
      const second = JSON.parse(
        await service.act(
          "a",
          { action: "navigate", newTab: true, url: "https://example.test/B" },
          signal()
        )
      )
      await service.preview("a", first.pageId)
      if (active) await service.takeOver("a", first.pageId)
      const engine = (await launch.mock.results[0].value) as BotBrowserEngine
      vi.spyOn(engine, "show").mockRejectedValueOnce(new Error("Synthetic show failure"))
      await expect(service.takeOver("a", second.pageId)).rejects.toThrow("Synthetic show failure")
      expect((await service.preview("a")).pageId).toBe(first.pageId)
      if (active) await service.giveBack("a")
      expect((await service.preview("a")).pageId).toBe(first.pageId)
    }
  )

  it("retries the selected page after capture failure instead of returning to the first page", async () => {
    await service.act("a", { action: "observe" }, signal())
    const second = JSON.parse(
      await service.act(
        "a",
        { action: "navigate", newTab: true, url: "https://example.test/B" },
        signal()
      )
    )
    const engine = (await launch.mock.results[0].value) as BotBrowserEngine
    const capture = vi
      .spyOn(engine, "capturePage")
      .mockRejectedValueOnce(new Error("Synthetic capture failure"))
    expect(await service.preview("a", second.pageId)).toMatchObject({
      pageId: second.pageId,
      image: null,
      captureError: "暂时无法获取浏览器画面，请刷新重试"
    })
    expect(await service.preview("a")).toMatchObject({ pageId: second.pageId, control: "bot" })
    expect(capture).toHaveBeenLastCalledWith(context.entries[1])
    expect(context.entries.every((page) => !page.closed)).toBe(true)
  })

  it("forgets a closed viewed page and retains a successfully opened human tab after return", async () => {
    const first = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    const second = JSON.parse(
      await service.act(
        "a",
        { action: "navigate", newTab: true, url: "https://example.test/B" },
        signal()
      )
    )
    const peer = JSON.parse(await service.act("b", { action: "observe" }, signal()))
    await service.preview("a", second.pageId)
    await service.act("a", { action: "close", pageId: second.pageId }, signal())
    expect((await service.preview("a")).pageId).toBe(first.pageId)
    await service.takeOver("a")
    const lease = await service.preview("a")
    const next = await service.operateAsHuman("a", { action: "new" }, lease.generation)
    await service.giveBack("a", lease.generation)
    expect((await service.preview("a")).pageId).toBe(next)
    await service.act("a", { action: "close", pageId: next! }, signal())
    expect((await service.preview("a")).pageId).toBe(first.pageId)
    expect((await service.preview("b")).pageId).toBe(peer.pageId)
    expect(context.entries).toHaveLength(4)
  })

  it("keeps human navigation and tab controls on the leased owner's exact pages", async () => {
    const a = JSON.parse(
      await service.act("a", { action: "navigate", url: "https://example.test/form" }, signal())
    )
    const b = JSON.parse(await service.act("b", { action: "observe" }, signal()))
    await expect(service.operateAsHuman("a", { action: "reload", pageId: a.pageId }, 0)).rejects.toThrow(
      "控制权"
    )
    await service.takeOver("a", a.pageId)
    const lease = await service.preview("a", a.pageId)
    await expect(
      service.operateAsHuman("a", { action: "reload", pageId: b.pageId }, lease.generation)
    ).rejects.toThrow("不属于")
    await expect(
      service.operateAsHuman("a", { action: "reload", pageId: "missing" }, lease.generation)
    ).rejects.toThrow("已关闭")
    await expect(
      service.operateAsHuman("b", { action: "close", pageId: b.pageId }, lease.generation)
    ).rejects.toThrow("控制权")
    await expect(
      service.operateAsHuman("a", { action: "new" }, lease.generation - 1)
    ).rejects.toThrow("控制权")
    const original = context.entries[0]
    for (const [action, method] of [
      ["back", original.goBack],
      ["forward", original.goForward],
      ["reload", original.reload]
    ] as const) {
      expect(await service.operateAsHuman("a", { action, pageId: a.pageId }, lease.generation)).toBe(
        a.pageId
      )
      expect(method).toHaveBeenCalledExactlyOnceWith({ waitUntil: "domcontentloaded" })
    }
    const next = await service.operateAsHuman("a", { action: "new" }, lease.generation)
    expect(next).toBeTruthy()
    expect(next).not.toBe(a.pageId)
    expect(context.entries).toHaveLength(3)
    expect(context.entries[2].bringToFront).toHaveBeenCalledOnce()
    expect((await service.preview("a", next!)).generation).toBe(lease.generation)
    expect((await service.preview("a")).pageId).toBe(next)
    expect(await service.operateAsHuman("a", { action: "close", pageId: a.pageId }, lease.generation)).toBe(
      next
    )
    expect(original.isClosed()).toBe(true)
    expect(context.entries[1].isClosed()).toBe(false)
    expect(context.entries[2].bringToFront).toHaveBeenCalledTimes(2)
    expect((await service.preview("a")).pageId).toBe(next)
    expect(await service.operateAsHuman("a", { action: "close", pageId: next! }, lease.generation)).toBeNull()
    expect((await service.preview("a")).pages).toEqual([])
    expect((await service.preview("b")).pages.map((page) => page.id)).toEqual([b.pageId])
    expect((await service.preview("a")).control).toBe("bot")
    expect(context.entries).toHaveLength(3)
  })

  it("rechecks the human claim after a queued operation waits for the browser lock", async () => {
    const { pageId } = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    await service.takeOver("a", pageId)
    const lease = await service.preview("a", pageId)
    const entered = deferred(),
      finish = deferred()
    const engine = (await launch.mock.results[0].value) as BotBrowserEngine
    vi.spyOn(engine, "capturePage").mockImplementationOnce(async () => {
      entered.resolve()
      await finish.promise
      return Buffer.from("fixture")
    })
    const preview = service.preview("a", pageId)
    await entered.promise
    const pending = service.operateAsHuman("a", { action: "reload", pageId }, lease.generation)
    const rejected = expect(pending).rejects.toThrow("控制权")
    const returned = service.giveBack("a", lease.generation)
    finish.resolve()
    await Promise.all([preview, rejected, returned])
    expect(context.entries[0].reload).not.toHaveBeenCalled()
    expect((await service.preview("a", pageId)).control).toBe("bot")
  })

  it("applies existing page capacity limits to human-created tabs", async () => {
    await service.takeOver("a")
    const lease = await service.preview("a")
    for (let index = 1; index < 6; index++)
      await service.operateAsHuman("a", { action: "new" }, lease.generation)
    await expect(service.operateAsHuman("a", { action: "new" }, lease.generation)).rejects.toThrow(
      "上限"
    )
    expect(context.entries).toHaveLength(6)
    expect(await service.preview("a")).toMatchObject({
      control: "human",
      generation: lease.generation
    })
  })

  it("returns ordinary human control on native hide without closing or replaying the page", async () => {
    const { pageId } = JSON.parse(
      await service.act("a", { action: "navigate", url: "https://example.test/form" }, signal())
    )
    await service.takeOver("a", pageId)
    const lease = await service.preview("a", pageId)
    const waiting = vi.fn()
    const pending = service.act(
      "a",
      { action: "fill", pageId, role: "textbox", name: "Name", text: "must not replay" },
      signal(),
      waiting
    )
    hidden!(context.entries[0], lease.generation)
    const returned = JSON.parse(await pending)
    expect(returned).toMatchObject({ pageId, url: "https://example.test/form", control: "bot" })
    expect(context.entries[0].isClosed()).toBe(false)
    expect(context.entries[0].fill).not.toHaveBeenCalled()
    expect(context.entries[0].goto).toHaveBeenCalledOnce()
    expect(waiting.mock.calls).toEqual([[true], [false]])
    expect(context.entries).toHaveLength(1)
  })

  it("handles native hide before show completes without leaving the takeover waiting", async () => {
    const { pageId } = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    const engine = (await launch.mock.results[0].value) as BotBrowserEngine
    engine.show = vi.fn(async (page, generation) => {
      hidden!(page as unknown as TestPage, generation!)
    })
    await service.takeOver("a", pageId)
    await vi.waitFor(async () => expect((await service.preview("a", pageId)).control).toBe("bot"))
    expect(context.entries[0].isClosed()).toBe(false)
    expect((await service.preview("a", pageId)).generation).toBe(2)
    await service.takeOver("a", pageId, "Confirm the form")
    expect(await service.preview("a", pageId)).toMatchObject({
      control: "human",
      helpInstruction: "Confirm the form"
    })
  })

  it("does not repeat a return when native hide arrives during an existing giveBack", async () => {
    const { pageId } = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    await service.takeOver("a", pageId)
    const lease = await service.preview("a", pageId)
    const engine = (await launch.mock.results[0].value) as BotBrowserEngine
    const entered = deferred(),
      finish = deferred()
    engine.hide = vi.fn(async () => {
      entered.resolve()
      await finish.promise
    })
    const returned = service.giveBack("a", lease.generation)
    await entered.promise
    hidden!(context.entries[0], lease.generation)
    finish.resolve()
    await returned
    expect(await service.preview("a", pageId)).toMatchObject({
      control: "bot",
      generation: lease.generation + 1
    })
    expect(engine.hide).toHaveBeenCalledOnce()
  })

  it("keeps explicit help waiting and rejects hidden events from a peer or an older lease", async () => {
    const a = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    await service.act("b", { action: "observe" }, signal())
    await service.takeOver("a", a.pageId)
    const old = await service.preview("a", a.pageId)
    await service.giveBack("a", old.generation)
    await service.takeOver("a", a.pageId)
    const current = await service.preview("a", a.pageId)
    hidden!(context.entries[0], old.generation)
    hidden!(context.entries[1], current.generation)
    expect(await service.preview("a", a.pageId)).toMatchObject({
      control: "human",
      generation: current.generation
    })
    await service.giveBack("a", current.generation)
    const waiting = vi.fn()
    let completed = false
    const help = service
      .act("a", { action: "request_help", pageId: a.pageId, instruction: "Confirm this form" }, signal(), waiting)
      .then((value) => {
        completed = true
        return value
      })
    await vi.waitFor(() => expect(waiting).toHaveBeenCalledWith(true))
    const requested = await service.preview("a", a.pageId)
    hidden!(context.entries[0], requested.generation)
    expect(await service.preview("a", a.pageId)).toMatchObject({
      control: "human",
      generation: requested.generation,
      helpInstruction: "Confirm this form"
    })
    expect(completed).toBe(false)
    await service.giveBack("a", requested.generation)
    expect(JSON.parse(await help).pageId).toBe(a.pageId)
    expect(context.entries[0].isClosed()).toBe(false)
    expect(context.entries).toHaveLength(2)
  })

  it("ignores a previous page hidden event from the same current human generation", async () => {
    const first = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    const second = JSON.parse(
      await service.act(
        "a",
        { action: "navigate", newTab: true, url: "https://example.test/second" },
        signal()
      )
    )
    await service.takeOver("a", first.pageId)
    const generation = (await service.preview("a")).generation
    await service.takeOver("a", second.pageId)
    const waiting = vi.fn()
    let returned = false
    const pending = service
      .act("a", { action: "observe", pageId: second.pageId }, signal(), waiting)
      .then((value) => {
        returned = true
        return value
      })
    await vi.waitFor(() => expect(waiting).toHaveBeenCalledWith(true))
    try {
      hidden!(context.entries[0], generation)
      expect(await service.preview("a")).toMatchObject({
        control: "human",
        pageId: second.pageId,
        generation
      })
      expect(returned).toBe(false)
      hidden!(context.entries[1], generation)
      expect(JSON.parse(await pending).pageId).toBe(second.pageId)
      expect((await service.preview("a")).control).toBe("bot")
    } finally {
      if ((await service.preview("a")).control === "human") await service.giveBack("a")
      await pending
    }
  })
  it("returns the newly selected page when native hide arrives before its show reply", async () => {
    const first = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    const second = JSON.parse(
      await service.act(
        "a",
        { action: "navigate", newTab: true, url: "https://example.test/second" },
        signal()
      )
    )
    await service.takeOver("a", first.pageId)
    const engine = (await launch.mock.results[0].value) as BotBrowserEngine
    engine.show = vi.fn(async (page, generation) => {
      hidden!(page as unknown as TestPage, generation!)
    })
    await service.takeOver("a", second.pageId)
    await vi.waitFor(async () => expect((await service.preview("a")).control).toBe("bot"))
    expect(context.entries[0].isClosed()).toBe(false)
    expect(context.entries[1].isClosed()).toBe(false)
  })
  it("reports the exact closed help page instead of observing a different remaining page", async () => {
    const first = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    const second = JSON.parse(
      await service.act(
        "a",
        { action: "navigate", newTab: true, url: "https://example.test/help" },
        signal()
      )
    )
    const waiting = vi.fn()
    const help = service.act(
      "a",
      { action: "request_help", pageId: second.pageId, instruction: "Inspect this second page" },
      signal(),
      waiting
    )
    await vi.waitFor(() => expect(waiting).toHaveBeenCalledWith(true))
    const generation = (await service.preview("a")).generation
    await context.entries[1].close()
    context.entries[0].snapshot.mockClear()
    await service.giveBack("a", generation)
    const result = JSON.parse(await help)
    expect(result.closed).toBe(second.pageId)
    expect(result.pageId).toBeUndefined()
    expect(result.content).toBeUndefined()
    expect(result.pages.map((page: { id: string }) => page.id)).toEqual([first.pageId])
    expect(result.note).toContain("Do not assume the requested user action was completed")
    expect(context.entries[0].snapshot).not.toHaveBeenCalled()
  })
  it("promotes an existing manual lease to help and keeps its first instruction on native hide", async () => {
    const { pageId } = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    await service.takeOver("a", pageId)
    const lease = await service.preview("a", pageId)
    const waiting = vi.fn()
    let completed = 0
    const help = (instruction: string) =>
      service.act("a", { action: "request_help", pageId, instruction }, signal(), waiting).then((value) => {
        completed++
        return value
      })
    const first = help("Confirm this exact form")
    const duplicate = help("A later instruction must not replace it")
    await vi.waitFor(() => expect(waiting).toHaveBeenCalledTimes(2))
    expect(await service.preview("a", pageId)).toMatchObject({
      generation: lease.generation,
      control: "human",
      helpInstruction: "Confirm this exact form"
    })
    hidden!(context.entries[0], lease.generation)
    expect(await service.preview("a", pageId)).toMatchObject({
      generation: lease.generation,
      control: "human",
      helpInstruction: "Confirm this exact form"
    })
    expect(completed).toBe(0)
    expect(context.entries[0].isClosed()).toBe(false)
    await service.giveBack("a", lease.generation)
    for (const value of await Promise.all([first, duplicate]))
      expect(JSON.parse(value).pageId).toBe(pageId)
    expect(completed).toBe(2)
    expect(context.entries).toHaveLength(1)
  })

  it("rejects help while a manual lease is being returned without changing that lease", async () => {
    const { pageId } = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    await service.takeOver("a", pageId)
    const lease = await service.preview("a", pageId)
    const engine = (await launch.mock.results[0].value) as BotBrowserEngine
    const entered = deferred(),
      finish = deferred()
    engine.hide = vi.fn(async () => {
      entered.resolve()
      await finish.promise
    })
    const returned = service.giveBack("a", lease.generation)
    await entered.promise
    const waiting = vi.fn()
    await expect(
      service.act("a", { action: "request_help", pageId, instruction: "A new help request" }, signal(), waiting)
    ).rejects.toThrow("正在切换")
    expect(waiting).not.toHaveBeenCalled()
    finish.resolve()
    await returned
    expect(await service.preview("a", pageId)).toMatchObject({
      control: "bot",
      generation: lease.generation + 1
    })
    expect((await service.preview("a", pageId)).helpInstruction).toBeUndefined()
  })
  it("reports actual file controls even when the ARIA snapshot calls them buttons", async () => {
    const { pageId } = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    const page = context.entries[0]
    page.snapshot.mockResolvedValue('- button "合成附件"')
    const controls = [{ label: "合成附件", multiple: false, accept: ".csv", disabled: false }]
    page.fileInputs.mockResolvedValue({ controls, truncated: false })
    const observed = JSON.parse(await service.act("a", { action: "observe", pageId }, signal()))
    expect(observed.fileInputs).toEqual({ controls, truncated: false })
    expect(observed.content).toBe('- button "合成附件"')
    expect(observed.note).toContain("Native file inputs may have the ARIA role button")
    expect(page.click).not.toHaveBeenCalled()
    expect(page.setInputFiles).not.toHaveBeenCalled()
  })
  it("keeps the exact second help page when the help card previews and reopens without a target", async () => {
    const first = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    const second = JSON.parse(
      await service.act(
        "a",
        { action: "navigate", newTab: true, url: "https://example.test/help" },
        signal()
      )
    )
    const waiting = vi.fn()
    const help = service.act(
      "a",
      { action: "request_help", pageId: second.pageId, instruction: "Inspect the second page" },
      signal(),
      waiting
    )
    await vi.waitFor(() => expect(waiting).toHaveBeenCalledWith(true))
    try {
      expect(context.entries[1].bringToFront).toHaveBeenCalledTimes(1)
      hidden!(context.entries[1], (await service.preview("a", second.pageId)).generation)
      const cardState = await service.preview("a")
      expect(cardState.pageId).toBe(second.pageId)
      expect(cardState.pageId).not.toBe(first.pageId)
      await service.takeOver("a", cardState.pageId ?? undefined)
      expect(context.entries[0].bringToFront).not.toHaveBeenCalled()
      expect(context.entries[1].bringToFront).toHaveBeenCalledTimes(2)
    } finally {
      await service.giveBack("a")
      await help
    }
  })
  it("shows the second requested page when promoting an existing first-page manual lease to help", async () => {
    const first = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    const second = JSON.parse(
      await service.act(
        "a",
        { action: "navigate", newTab: true, url: "https://example.test/help" },
        signal()
      )
    )
    await service.takeOver("a", first.pageId)
    const generation = (await service.preview("a")).generation
    const waiting = vi.fn()
    const help = service.act(
      "a",
      { action: "request_help", pageId: second.pageId, instruction: "Inspect the second page" },
      signal(),
      waiting
    )
    await vi.waitFor(() => expect(waiting).toHaveBeenCalledWith(true))
    try {
      expect(context.entries[1].bringToFront).toHaveBeenCalledTimes(1)
      expect(await service.preview("a")).toMatchObject({
        pageId: second.pageId,
        generation,
        helpInstruction: "Inspect the second page",
        control: "human"
      })
    } finally {
      await service.giveBack("a", generation)
      await help
    }
  })
  it("does not reopen the first page when the exact human target has closed", async () => {
    const first = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    const second = JSON.parse(
      await service.act(
        "a",
        { action: "navigate", newTab: true, url: "https://example.test/help" },
        signal()
      )
    )
    await service.takeOver("a", second.pageId)
    const lease = await service.preview("a")
    await context.entries[1].close()
    expect(await service.preview("a")).toMatchObject({ pageId: null, control: "human" })
    await expect(service.takeOver("a")).rejects.toThrow("页面已关闭")
    expect(context.entries[0].bringToFront).not.toHaveBeenCalled()
    await expect(
      service.operateAsHuman("a", { action: "reload", pageId: first.pageId }, lease.generation - 1)
    ).rejects.toThrow("控制权")
    expect(context.entries[0].reload).not.toHaveBeenCalled()
    await service.takeOver("a", first.pageId)
    expect(await service.preview("a")).toMatchObject({
      pageId: first.pageId,
      generation: lease.generation
    })
    await service.giveBack("a", lease.generation)
  })
  it("preserves the original manual target and instruction if promotion cannot show the requested page", async () => {
    const first = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    const second = JSON.parse(
      await service.act(
        "a",
        { action: "navigate", newTab: true, url: "https://example.test/help" },
        signal()
      )
    )
    await service.takeOver("a", first.pageId)
    const lease = await service.preview("a")
    context.entries[1].bringToFront.mockRejectedValueOnce(new Error("native focus failed"))
    await expect(
      service.act(
        "a",
        { action: "request_help", pageId: second.pageId, instruction: "Inspect the second page" },
        signal()
      )
    ).rejects.toThrow("native focus failed")
    expect(await service.preview("a")).toMatchObject({
      pageId: first.pageId,
      generation: lease.generation,
      control: "human"
    })
    expect((await service.preview("a")).helpInstruction).toBeUndefined()
    await service.giveBack("a", lease.generation)
  })
  it("reopens human control without replacing its instruction, generation or pending help", async () => {
    const { pageId } = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => {
      entered = resolve
    })
    let returned = false
    const help = service
      .act("a", { action: "request_help", pageId, instruction: "手动输入" }, signal(), (active) => {
        if (active) entered()
      })
      .then(() => {
        returned = true
      })
    await waiting
    const before = await service.preview("a")
    await service.takeOver("a", pageId)
    const after = await service.preview("a")
    expect(after.generation).toBe(before.generation)
    expect(after.helpInstruction).toBe("手动输入")
    expect(after.control).toBe("human")
    expect(returned).toBe(false)
    expect(context.entries[0].bringToFront).toHaveBeenCalledTimes(2)
    await expect(service.takeOver("b", pageId)).rejects.toThrow("另一 Bot")
    context.entries[0].bringToFront.mockRejectedValueOnce(new Error("native focus failed"))
    await expect(service.takeOver("a", pageId)).rejects.toThrow("native focus failed")
    expect((await service.preview("a")).generation).toBe(before.generation)
    await service.giveBack("a", before.generation)
    await help
    expect(returned).toBe(true)
  })
  it("keeps the handoff pending beyond five minutes until the user returns control", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    try {
      const { pageId } = JSON.parse(
        await service.act("a", { action: "observe" }, controller.signal)
      )
      let entered!: () => void
      const waiting = new Promise<void>((resolve) => {
        entered = resolve
      })
      let outcome = "pending"
      const help = service
        .act(
          "a",
          { action: "request_help", pageId, instruction: "确认页面" },
          controller.signal,
          (active) => {
            if (active) entered()
          }
        )
        .then(
          () => {
            outcome = "returned"
          },
          () => {
            outcome = "failed"
          }
        )
      await waiting
      const reads = context.entries[0].snapshot.mock.calls.length
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      expect(outcome).toBe("pending")
      expect(context.entries[0].snapshot).toHaveBeenCalledTimes(reads)
      expect((await service.preview("a")).control).toBe("human")
      await service.giveBack("a")
      await help
      expect(outcome).toBe("returned")
    } finally {
      controller.abort()
      vi.useRealTimers()
    }
  })
  it("hands an observed page to the user with a private instruction and resumes with fresh evidence", async () => {
    const { pageId } = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    const waiting = vi.fn()
    let settled = false
    const help = service
      .act(
        "a",
        { action: "request_help", pageId, instruction: "完成合成页面确认" },
        signal(),
        waiting
      )
      .then((result) => {
        settled = true
        return JSON.parse(result)
      })
    await vi.waitFor(() => expect(waiting).toHaveBeenCalledWith(true))
    expect(settled).toBe(false)
    const state = await service.preview("a")
    expect(state.control).toBe("human")
    expect(state.helpInstruction).toBe("完成合成页面确认")
    expect((await service.preview("b")).helpInstruction).toBeUndefined()
    const duplicate = service.act(
      "a",
      { action: "request_help", pageId, instruction: "重复请求" },
      signal()
    )
    await expect(
      service.act("b", { action: "request_help", instruction: "另一 Bot" }, signal())
    ).rejects.toThrow()
    expect(context.entries[0].bringToFront).toHaveBeenCalledTimes(1)
    expect((await service.preview("a")).helpInstruction).toBe("完成合成页面确认")
    context.entries[0].address = "https://example.test/confirmed"
    await expect(service.giveBack("a", state.generation - 1)).rejects.toThrow("已改变")
    expect((await service.preview("a")).control).toBe("human")
    await service.giveBack("a", state.generation)
    const observed = await help
    await duplicate
    expect(observed.url).toBe("https://example.test/confirmed")
    expect(waiting).toHaveBeenLastCalledWith(false)
    expect((await service.preview("a")).helpInstruction).toBeUndefined()
  })
  it("skips only the current help step, observes the same page and does not replay input or leak that decision", async () => {
    const { pageId } = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    const waiting = vi.fn()
    const help = service.act(
      "a", { action: "request_help", pageId, instruction: "填写合成备注" }, signal(), waiting
    )
    await vi.waitFor(() => expect(waiting).toHaveBeenCalledWith(true))
    const lease = await service.preview("a")
    await expect(service.giveBack("a", undefined, "skipped")).rejects.toThrow("控制版本")
    await expect(service.giveBack("a", lease.generation - 1, "skipped")).rejects.toThrow("已改变")
    await expect(service.giveBack("b", lease.generation, "skipped")).rejects.toThrow("没有可归还")
    await service.giveBack("a", lease.generation, "skipped")
    const observed = JSON.parse(await help)
    expect(observed).toMatchObject({ pageId, helpSkipped: true, control: "bot" })
    expect(observed.note).toContain("declined")
    expect(context.entries[0].closed).toBe(false)
    expect(context.entries[0].fill).not.toHaveBeenCalled()
    expect(context.entries[0].click).not.toHaveBeenCalled()
    expect(waiting).toHaveBeenLastCalledWith(false)
    waiting.mockClear()
    const next = service.act(
      "a", { action: "request_help", pageId, instruction: "另一项合成协助" }, signal(), waiting
    )
    await vi.waitFor(() => expect(waiting).toHaveBeenCalledWith(true))
    await service.giveBack("a", (await service.preview("a")).generation)
    const completed = JSON.parse(await next)
    expect(completed.helpSkipped).toBeUndefined()
    expect(completed.note).not.toContain("declined")
  })
  it("does not treat an ordinary manual return as a skipped help request", async () => {
    await service.act("a", { action: "observe" }, signal())
    await service.takeOver("a")
    const lease = await service.preview("a")
    await expect(service.giveBack("a", lease.generation, "skipped")).rejects.toThrow("没有可跳过")
    expect((await service.preview("a")).control).toBe("human")
    await service.giveBack("a", lease.generation)
    expect((await service.preview("a")).control).toBe("bot")
  })
  it("rejects help on foreign targets and aborts the wait without replaying browser input", async () => {
    await expect(
      service.act("a", { action: "request_help", instruction: "确认" }, signal())
    ).rejects.toThrow("先观察")
    const { pageId } = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    await expect(
      service.act("b", { action: "request_help", pageId, instruction: "确认" }, signal())
    ).rejects.toThrow("先观察")
    expect(context.entries[0].bringToFront).not.toHaveBeenCalled()
    const controller = new AbortController(),
      waiting = vi.fn()
    const help = service.act(
      "a",
      { action: "request_help", pageId, instruction: "确认" },
      controller.signal,
      waiting
    )
    const rejected = expect(help).rejects.toThrow("cancel help")
    await vi.waitFor(() => expect(waiting).toHaveBeenCalledWith(true))
    controller.abort(new Error("cancel help"))
    await rejected
    expect(waiting).toHaveBeenLastCalledWith(false)
    expect(context.entries[0].click).not.toHaveBeenCalled()
    // Cancellation leaves the user's active browser alone until they explicitly return it.
    expect((await service.preview("a")).control).toBe("human")
    await service.giveBack("a")
  })
  it("keeps group member pages separate, restricts uploads to group files and retires the whole group", async () => {
    const group = join(directory, "group-g"),
      privateWorkspace = join(directory, "a")
    mkdirSync(group)
    mkdirSync(privateWorkspace)
    const shared = join(group, "shared.txt"),
      secret = join(privateWorkspace, "private.txt")
    writeFileSync(shared, "shared")
    writeFileSync(secret, "private")
    service = new BotBrowserService(launch, (scope) =>
      scope.startsWith("group-g--") ? group : privateWorkspace
    )
    const a = JSON.parse(await service.act("group-g--a", { action: "observe" }, signal()))
    const b = JSON.parse(await service.act("group-g--b", { action: "observe" }, signal()))
    await service.act("a", { action: "observe" }, signal())
    expect(a.pageId).not.toBe(b.pageId)
    await expect(
      service.act(
        "group-g--b",
        { action: "fill", pageId: a.pageId, role: "textbox", name: "Name", text: "wrong" },
        signal()
      )
    ).rejects.toThrow("不属于")
    await expect(
      service.act("group-g--a", { action: "upload", name: "Upload", fileId: secret }, signal())
    ).rejects.toMatchObject({ name: "BotError", code: "INVALID_INPUT" })
    expect(context.entries.every((page) => page.setInputFiles.mock.calls.length === 0)).toBe(true)
    await service.act("group-g--a", { action: "upload", name: "Upload", fileId: shared }, signal())
    expect(context.entries[0].setInputFiles).toHaveBeenCalledWith(realpathSync(shared))
    const groupAlias = join(directory, "old-group-g")
    symlinkSync(group, groupAlias, process.platform === "win32" ? "junction" : "dir")
    await service.act(
      "group-g--b",
      { action: "upload", name: "Upload", fileId: join(groupAlias, "shared.txt") },
      signal()
    )
    expect(context.entries[1].setInputFiles).toHaveBeenCalledExactlyOnceWith(realpathSync(shared))
    expect(context.entries[2].setInputFiles).not.toHaveBeenCalled()
    await service.removeBot("a")
    expect(context.entries[0].closed).toBe(true)
    expect(context.entries[1].closed).toBe(false)
    expect(context.entries[2].closed).toBe(true)
    await expect(service.preview("group-other--a")).rejects.toThrow("已删除")
    await service.removeGroup("g")
    expect(context.entries[0].closed).toBe(true)
    expect(context.entries[1].closed).toBe(true)
    expect(context.entries[2].closed).toBe(true)
    await expect(service.preview("group-g--c")).rejects.toThrow("已删除")
  })
  it("clears a dialog consumed by Electron and observes the result without replaying submission", async () => {
    await service.act("a", { action: "observe" }, signal())
    const page = context.entries[0]
    const accept = vi
      .fn()
      .mockRejectedValue(
        new Error("Protocol error (Page.handleJavaScriptDialog): No dialog is showing")
      )
    page.click.mockImplementationOnce(async () => {
      page.emit("dialog", { type: () => "alert", message: () => "Synthetic", accept })
    })
    const opened = JSON.parse(
      await service.act("a", { action: "click", role: "button", name: "Submit" }, signal())
    )
    expect(opened.dialog.message).toBe("Synthetic")
    await expect(
      service.act("a", { action: "navigate", url: "https://example.test" }, signal())
    ).rejects.toThrow("操作未执行")
    expect(page.goto).not.toHaveBeenCalled()
    const handled = JSON.parse(await service.act("a", { action: "dialog", accept: true }, signal()))
    expect(handled.dialog).toBeUndefined()
    expect(handled.note).toContain("outcome is unknown")
    expect(
      JSON.parse(await service.act("a", { action: "observe" }, signal())).dialog
    ).toBeUndefined()
    expect(page.click).toHaveBeenCalledTimes(1)
    expect(accept).toHaveBeenCalledTimes(1)
  })
  it("recovers a stale target by observation and uploads a Runtime path without opening a native chooser", async () => {
    service = new BotBrowserService(launch, () => directory)
    const file = join(directory, "资料.json")
    writeFileSync(file, "{}")
    await expect(service.act("a", { action: "observe", pageId: "main" }, signal())).rejects.toThrow(
      "省略 pageId"
    )
    const { pageId } = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    await expect(
      service.act("a", { action: "upload", pageId, fileId: file }, signal())
    ).rejects.toThrow("name")
    const result = JSON.parse(
      await service.act("a", { action: "upload", pageId, fileId: file, name: "合成附件" }, signal())
    )
    expect(result.upload).toEqual({ filename: "资料.json", state: "attached" })
    expect(result.note).toContain("has not been submitted")
    expect(JSON.stringify(result)).not.toContain(realpathSync(directory))
    expect(context.entries[0].getByLabel).toHaveBeenCalledWith("合成附件", { exact: true })
    expect(context.entries[0].setInputFiles).toHaveBeenCalledWith(realpathSync(file))
    expect(context.entries[0].click).not.toHaveBeenCalled()
    context.entries[0].setInputFiles.mockRejectedValueOnce(
      new Error("Input no longer accepts files")
    )
    await expect(
      service.act("a", { action: "upload", pageId, fileId: file, name: "合成附件" }, signal())
    ).rejects.toThrow("no longer accepts files")
  })
  it("closes only the deleted Bot's pages and rejects a late preview recreating them", async () => {
    await service.act("a", { action: "observe" }, signal())
    await service.act("b", { action: "observe" }, signal())
    await service.takeOver("a")
    await service.removeBot("a")
    expect(context.entries[0].closed).toBe(true)
    expect(context.entries[1].closed).toBe(false)
    await expect(service.preview("a")).rejects.toThrow("已删除")
    await service.takeOver("b")
    await service.giveBack("b")
  })
  it("allows manual navigation only while the matching Bot owns human control", async () => {
    const state = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    await expect(
      service.navigateAsHuman("a", state.pageId, "https://example.test")
    ).rejects.toThrow("接管")
    await service.takeOver("a", state.pageId)
    await expect(
      service.navigateAsHuman("b", state.pageId, "https://example.test")
    ).rejects.toThrow("接管")
    await expect(service.navigateAsHuman("a", state.pageId, "file:///etc/passwd")).rejects.toThrow(
      "HTTP"
    )
    await expect(
      service.navigateAsHuman("a", state.pageId, "https://user:password@example.test")
    ).rejects.toThrow("凭据")
    await service.navigateAsHuman("a", state.pageId, "https://example.test")
    expect(context.entries[0].goto).toHaveBeenCalledTimes(1)
    await service.giveBack("a")
    await expect(
      service.navigateAsHuman("a", state.pageId, "https://example.test")
    ).rejects.toThrow("接管")
  })
  it("owns targets by page identity even when two Bots use the same URL", async () => {
    const a = JSON.parse(
      await service.act("a", { action: "navigate", url: "https://example.test/" }, signal())
    )
    const b = JSON.parse(
      await service.act("b", { action: "navigate", url: "https://example.test/" }, signal())
    )
    expect(a.pageId).not.toBe(b.pageId)
    await expect(
      service.act(
        "b",
        { action: "fill", pageId: a.pageId, role: "textbox", name: "Name", text: "wrong" },
        signal()
      )
    ).rejects.toThrow("不属于")
    expect(context.entries[0].fill).not.toHaveBeenCalled()
    expect(launch).toHaveBeenCalledTimes(1)
  })

  it("opens an additional owned page without replacing the form or sharing a group member's pages", async () => {
    const owner = "group-g--a"
    const form = JSON.parse(
      await service.act(owner, { action: "navigate", url: "https://example.test/form" }, signal())
    )
    const preview = JSON.parse(
      await service.act(
        owner,
        { action: "navigate", newTab: true, url: "https://example.test/preview" },
        signal()
      )
    )
    expect(preview.pageId).not.toBe(form.pageId)
    expect(preview.pages).toMatchObject([
      { id: form.pageId, url: "https://example.test/form", title: "Test page" },
      { id: preview.pageId, url: "https://example.test/preview", title: "Test page" }
    ])
    const original = JSON.parse(
      await service.act(owner, { action: "observe", pageId: form.pageId }, signal())
    )
    expect(original.url).toBe("https://example.test/form")
    expect(context.entries[0].goto).toHaveBeenCalledTimes(1)
    await expect(
      service.act("group-g--b", { action: "observe", pageId: preview.pageId }, signal())
    ).rejects.toThrow("不属于")
    expect(context.entries).toHaveLength(2)
    await service.removeGroup("g")
    await expect(
      service.act(
        owner,
        { action: "navigate", newTab: true, url: "https://example.test" },
        signal()
      )
    ).rejects.toThrow("已删除")
    expect(context.entries).toHaveLength(2)
  })

  it.each([undefined, false])(
    "keeps navigate newTab=%s reusing the existing page",
    async (newTab) => {
      const form = JSON.parse(
        await service.act("a", { action: "navigate", url: "https://example.test/form" }, signal())
      )
      const reused = JSON.parse(
        await service.act(
          "a",
          { action: "navigate", newTab, url: "https://example.test/next" },
          signal()
        )
      )
      expect(reused.pageId).toBe(form.pageId)
      expect(reused.url).toBe("https://example.test/next")
      expect(context.entries).toHaveLength(1)
    }
  )

  it("rejects ambiguous new-tab actions and invalid addresses before creating any page", async () => {
    const { pageId } = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    for (const action of [
      { action: "observe" as const, newTab: true },
      { action: "navigate" as const, newTab: true, pageId, url: "https://example.test" },
      { action: "navigate" as const, newTab: true, pageId: "", url: "https://example.test" },
      { action: "navigate" as const, newTab: true, pageId: "foreign", url: "https://example.test" },
      { action: "navigate" as const, newTab: true, url: "file:///private" },
      { action: "navigate" as const, newTab: true, url: "https://user:password@example.test" }
    ]) {
      await expect(service.act("a", action, signal())).rejects.toMatchObject({
        code: "INVALID_INPUT"
      })
    }
    expect(context.entries).toHaveLength(1)
    expect(context.entries[0].goto).not.toHaveBeenCalled()
  })

  it.each([1, 4])(
    "keeps page capacity bounded for %s owner(s) opening new tabs",
    async (owners) => {
      for (let owner = 0; owner < owners; owner++) {
        for (let page = 0; page < 6; page++) {
          await service.act(
            `bot-${owner}`,
            { action: "navigate", newTab: true, url: `https://example.test/${page}` },
            signal()
          )
        }
      }
      await expect(
        service.act(
          owners === 1 ? "bot-0" : "bot-extra",
          { action: "navigate", newTab: true, url: "https://example.test/overflow" },
          signal()
        )
      ).rejects.toThrow("上限")
      expect(context.entries).toHaveLength(owners * 6)
    }
  )

  it("does not open or replay a requested new tab across human control", async () => {
    const form = JSON.parse(
      await service.act("a", { action: "navigate", url: "https://example.test/form" }, signal())
    )
    await service.takeOver("a", form.pageId)
    const waiting = vi.fn()
    const pending = service.act(
      "a",
      { action: "navigate", newTab: true, url: "https://example.test/must-not-open" },
      signal(),
      waiting
    )
    expect(waiting).toHaveBeenCalledWith(true)
    expect(context.entries).toHaveLength(1)
    await service.giveBack("a")
    const returned = JSON.parse(await pending)
    expect(returned.pageId).toBe(form.pageId)
    expect(returned.url).toBe("https://example.test/form")
    expect(returned.control).toBe("bot")
    expect(context.entries).toHaveLength(1)
    expect(context.entries[0].goto).toHaveBeenCalledTimes(1)
  })

  it("waits for the current input boundary before granting human control", async () => {
    await service.act("a", { action: "observe" }, signal())
    let finish!: () => void
    context.entries[0].fill.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const input = service.act(
      "a",
      { action: "fill", role: "textbox", name: "Name", text: "before" },
      signal()
    )
    const rejected = expect(input).rejects.toThrow("控制权已改变")
    await vi.waitFor(() => expect(context.entries[0].fill).toHaveBeenCalled())
    let granted = false
    const takeover = service.takeOver("a").then(() => {
      granted = true
    })
    await Promise.resolve()
    expect(granted).toBe(false)
    await expect(service.takeOver("a")).rejects.toThrow("正在切换")
    finish()
    await rejected
    await takeover
    expect((await service.preview("a")).control).toBe("human")
  })

  it("pauses model observation during takeover and never replays an old input after return", async () => {
    await service.takeOver("a")
    const waiting = vi.fn()
    const action = service.act(
      "a",
      { action: "fill", role: "textbox", name: "Name", text: "stale" },
      signal(),
      waiting
    )
    await Promise.resolve()
    expect(context.entries[0].snapshot).not.toHaveBeenCalled()
    expect(context.entries[0].fill).not.toHaveBeenCalled()
    await service.giveBack("a")
    expect(JSON.parse(await action).content).toContain("textbox")
    expect(context.entries[0].fill).not.toHaveBeenCalled()
    expect(waiting.mock.calls).toEqual([[true], [false]])
  })

  it("keeps a peer's own page usable without changing the user's current lease", async () => {
    const a = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    const b = JSON.parse(await service.act("b", { action: "observe" }, signal()))
    await service.takeOver("a", a.pageId)
    const lease = await service.preview("a")
    const observed = context.entries[0].snapshot.mock.calls.length
    const waiting = vi.fn()
    let completed = false
    const input = service
      .act(
        "b",
        { action: "fill", pageId: b.pageId, role: "textbox", name: "Name", text: "peer input" },
        signal(),
        waiting
      )
      .then(() => {
        completed = true
      })
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(completed).toBe(true)
      expect(waiting).not.toHaveBeenCalled()
      expect(context.entries[1].fill).toHaveBeenCalledWith("peer input")
      expect(context.entries[0].fill).not.toHaveBeenCalled()
      expect(context.entries[0].snapshot).toHaveBeenCalledTimes(observed)
      await expect(
        service.act("b", { action: "observe", pageId: a.pageId }, signal())
      ).rejects.toThrow("不属于")
      await service.act("b", { action: "close", pageId: b.pageId }, signal())
      expect((await service.preview("a")).generation).toBe(lease.generation)
      expect((await service.preview("a")).control).toBe("human")
      await service.giveBack("a", lease.generation)
    } finally {
      if ((await service.preview("a")).control === "human") await service.giveBack("a")
      await input
    }
  })

  it("keeps a queued peer input valid when another Bot closes its page", async () => {
    const a = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    const b = JSON.parse(await service.act("b", { action: "observe" }, signal()))
    const results = await Promise.allSettled([
      service.act("a", { action: "close", pageId: a.pageId }, signal()),
      service.act(
        "b",
        { action: "fill", pageId: b.pageId, role: "textbox", name: "Name", text: "peer input" },
        signal()
      )
    ])
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"])
    expect(context.entries[1].fill).toHaveBeenCalledExactlyOnceWith("peer input")
    expect(context.entries[1].closed).toBe(false)
  })

  it.each(["close", "remove"] as const)(
    "keeps an in-flight peer observation valid when another Bot's page is subject to %s",
    async (action) => {
      await service.act("a", { action: "observe" }, signal())
      const b = JSON.parse(await service.act("b", { action: "observe" }, signal()))
      const entered = deferred()
      const finish = deferred()
      context.entries[1].snapshot.mockImplementationOnce(async () => {
        entered.resolve()
        await finish.promise
        return '- textbox "Peer field"'
      })
      const pending = service.act("b", { action: "observe", pageId: b.pageId }, signal())
      const settled = Promise.allSettled([pending])
      await entered.promise
      const closing = action === "close" ? context.entries[0].close() : service.removeBot("a")
      finish.resolve()
      const [result] = await settled
      await closing
      expect(result.status).toBe("fulfilled")
      if (result.status !== "fulfilled") throw result.reason
      expect(JSON.parse(result.value)).toMatchObject({
        pageId: b.pageId,
        content: '- textbox "Peer field"'
      })
      expect(context.entries[0].closed).toBe(true)
      expect(context.entries[1].closed).toBe(false)
    }
  )

  it.each(["close", "remove"] as const)(
    "rejects an observation whose own page is subject to %s before its result is returned",
    async (action) => {
      const a = JSON.parse(await service.act("a", { action: "observe" }, signal()))
      const entered = deferred()
      const finish = deferred()
      context.entries[0].snapshot.mockImplementationOnce(async () => {
        entered.resolve()
        await finish.promise
        return '- textbox "Stale field"'
      })
      const pending = service.act("a", { action: "observe", pageId: a.pageId }, signal())
      const rejected = expect(pending).rejects.toThrow()
      await entered.promise
      const closing = action === "close" ? context.entries[0].close() : service.removeBot("a")
      finish.resolve()
      await rejected
      await closing
      if (action === "close") expect((await service.preview("a")).pages).toEqual([])
      else await expect(service.preview("a")).rejects.toThrow("已删除")
      expect(context.entries).toHaveLength(1)
    }
  )

  it("rejects a target closed while its page metadata is being read", async () => {
    const engine = await launch()
    launch.mockResolvedValue(engine)
    const a = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    const entered = deferred()
    const finish = deferred()
    engine.getPageState = async () => {
      entered.resolve()
      await finish.promise
      return { title: "Closed target", canGoBack: false, canGoForward: false }
    }
    const pending = service.act("a", { action: "observe", pageId: a.pageId }, signal())
    const settled = Promise.allSettled([pending])
    await entered.promise
    await context.entries[0].close()
    finish.resolve()
    const [result] = await settled
    expect(result.status).toBe("rejected")
    expect(context.entries).toHaveLength(1)
  })

  it("registers a newly created peer page before applying human-tab ownership", async () => {
    const a = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    await service.takeOver("a", a.pageId)
    const lease = await service.preview("a")
    let result: { pageId: string; url: string } | undefined
    const navigate = service
      .act("b", { action: "navigate", url: "https://example.test/peer" }, signal())
      .then((value) => {
        result = JSON.parse(value)
      })
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(result?.url).toBe("https://example.test/peer")
      const peer = await service.preview("b")
      const human = await service.preview("a")
      expect(peer.pages.map((page) => page.id)).toEqual([result?.pageId])
      expect(human.pages.map((page) => page.id)).toEqual([a.pageId])
      expect(human.generation).toBe(lease.generation)
      expect(context.entries[0].goto).not.toHaveBeenCalled()
      expect(context.entries[1].goto).toHaveBeenCalledWith("https://example.test/peer", {
        waitUntil: "domcontentloaded"
      })
      await service.giveBack("a", lease.generation)
    } finally {
      if ((await service.preview("a")).control === "human") await service.giveBack("a")
      await navigate
    }
  })

  it("preserves manually opened human tabs during a pending peer page creation", async () => {
    const a = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    await service.takeOver("a", a.pageId)
    const engine = (await launch.mock.results[0].value) as BotBrowserEngine
    const created = deferred()
    const finish = deferred()
    vi.spyOn(engine, "createPage").mockImplementationOnce(async () => {
      const page = await context.newPage()
      created.resolve()
      await finish.promise
      return page as unknown as Awaited<ReturnType<BotBrowserEngine["createPage"]>>
    })
    const peer = service.act("b", { action: "observe" }, signal())
    await created.promise
    const manual = await context.newPage()
    finish.resolve()
    const b = JSON.parse(await peer)
    const human = await service.preview("a")
    expect(human.pages).toHaveLength(2)
    expect(human.pages.some((page) => page.id === a.pageId)).toBe(true)
    expect(human.pages.some((page) => page.id === b.pageId)).toBe(false)
    expect((await service.preview("b")).pages.map((page) => page.id)).toEqual([b.pageId])
    await service.removeBot("b")
    expect(manual.closed).toBe(false)
    expect(context.entries[0].closed).toBe(false)
    expect(context.entries[1].closed).toBe(true)
    await service.giveBack("a", human.generation)
  })

  it.each(["takeover", "cancel"] as const)(
    "rechecks %s after waiting for the upload file lock without holding the browser lock",
    async (transition) => {
      service = new BotBrowserService(launch, () => directory)
      const controller = new AbortController()
      writeFileSync(join(directory, "upload.txt"), "synthetic")
      const { pageId } = JSON.parse(await service.act("a", { action: "observe" }, signal()))
      const entered = deferred(),
        finish = deferred()
      const fileLock = vi.fn(async (operation: () => Promise<string>) => {
        entered.resolve()
        await finish.promise
        return operation()
      })
      const upload = service.act(
        "a",
        { action: "upload", pageId, fileId: "upload.txt", name: "Upload" },
        controller.signal,
        () => {},
        fileLock
      )
      const outcome = upload.then(
        () => null,
        (error: unknown) => error
      )
      try {
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(fileLock).toHaveBeenCalledTimes(1)
        expect(context.entries[0].setInputFiles).not.toHaveBeenCalled()
        // Acquiring human control must not be behind an upload's pending file lock.
        if (transition === "takeover") await service.takeOver("a", pageId)
        else controller.abort(new Error("cancelled upload"))
      } finally {
        finish.resolve()
        await outcome
        if ((await service.preview("a")).control === "human") await service.giveBack("a")
      }
      expect(await outcome).toBeInstanceOf(Error)
      expect(((await outcome) as Error).message).toContain(
        transition === "takeover" ? "控制权已改变" : "cancelled upload"
      )
      expect(context.entries[0].setInputFiles).not.toHaveBeenCalled()
    }
  )

  it("waits for human control without taking an upload lock or replaying the old upload", async () => {
    service = new BotBrowserService(launch, () => directory)
    const file = join(directory, "upload.txt")
    writeFileSync(file, "synthetic")
    const { pageId } = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    await service.takeOver("a", pageId)
    const fileLock = vi.fn(async (operation: () => Promise<string>) => operation())
    const action = { action: "upload" as const, pageId, fileId: "upload.txt", name: "Upload" }
    const waiting = vi.fn()
    const pending = service.act("a", action, signal(), waiting, fileLock)
    expect(waiting).toHaveBeenCalledWith(true)
    expect(fileLock).not.toHaveBeenCalled()
    await service.giveBack("a")
    const resumed = JSON.parse(await pending)
    expect(resumed.upload).toBeUndefined()
    expect(resumed.control).toBe("bot")
    expect(resumed.note).toContain("Human control ended")
    expect(resumed.note).toContain("it was not replayed")
    expect(fileLock).not.toHaveBeenCalled()
    expect(context.entries[0].setInputFiles).not.toHaveBeenCalled()
    const uploaded = JSON.parse(await service.act("a", action, signal(), waiting, fileLock))
    expect(fileLock).toHaveBeenCalledTimes(1)
    expect(uploaded.upload).toEqual({ filename: "upload.txt", state: "attached" })
    expect(context.entries[0].setInputFiles).toHaveBeenCalledExactlyOnceWith(realpathSync(file))
  })

  it("reobserves this Bot's replacement page when a queued target expired before human return", async () => {
    const old = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    await context.entries[0].close()
    const other = JSON.parse(await service.act("b", { action: "observe" }, signal()))
    await service.takeOver("a")
    const current = await service.preview("a")
    const waiting = vi.fn()
    const queued = service.act(
      "a",
      {
        action: "fill",
        pageId: old.pageId,
        role: "textbox",
        name: "Name",
        text: "stale input"
      },
      signal(),
      waiting
    )
    await service.giveBack("a")
    const observed = JSON.parse(await queued)
    expect(observed.pageId).toBe(current.pageId)
    expect(observed.pageId).not.toBe(other.pageId)
    expect(observed.content).toContain("textbox")
    for (const page of context.entries) expect(page.fill).not.toHaveBeenCalled()
    expect(waiting.mock.calls).toEqual([[true], [false]])
  })

  it("assigns tabs opened during human control and cleans up waiters on cancellation", async () => {
    await service.takeOver("a")
    await context.newPage()
    await Promise.resolve()
    expect((await service.preview("a")).pages).toHaveLength(2)
    const controller = new AbortController(),
      waiting = vi.fn()
    const action = service.act("a", { action: "observe" }, controller.signal, waiting)
    controller.abort(new Error("cancelled"))
    await expect(action).rejects.toThrow("cancelled")
    expect(waiting.mock.calls).toEqual([[true], [false]])
    await service.giveBack("a")
  })

  it("releases pending help when its final page closes without replaying input or touching a peer", async () => {
    const original = JSON.parse(
      await service.act("a", { action: "navigate", url: "https://example.test/original" }, signal())
    )
    const peer = JSON.parse(await service.act("b", { action: "observe" }, signal()))
    const waiting = vi.fn()
    let entered!: () => void
    const suspended = new Promise<void>((resolve) => {
      entered = resolve
    })
    const help = service.act(
      "a",
      { action: "request_help", pageId: original.pageId, instruction: "Inspect the test page" },
      signal(),
      (active) => {
        waiting(active)
        if (active) entered()
      }
    )
    await suspended
    const lease = await service.preview("a")
    await context.entries[0].close()
    const observed = JSON.parse(await help)
    expect(observed.closed).toBe(original.pageId)
    expect(observed.pages).toEqual([])
    expect(observed.pageId).toBeUndefined()
    expect(observed.url).toBeUndefined()
    expect(observed.note).toContain("No replacement page was opened")
    expect(context.entries).toHaveLength(2)
    expect(context.entries[1].closed).toBe(false)
    expect((await service.preview("b")).pages.map((page) => page.id)).toEqual([peer.pageId])
    expect((await service.preview("a")).control).toBe("bot")
    await expect(service.giveBack("a", lease.generation)).rejects.toThrow("控制权已改变")
    await expect(
      service.act(
        "a",
        { action: "fill", pageId: original.pageId, role: "textbox", name: "Name", text: "stale" },
        signal()
      )
    ).rejects.toThrow("页面已关闭")
    for (const page of context.entries) expect(page.fill).not.toHaveBeenCalled()
    expect(context.entries[0].goto).toHaveBeenCalledTimes(1)
    expect(waiting.mock.calls).toEqual([[true], [false]])
  })

  it.each(["observe", "navigate", "fill", "upload"] as const)(
    "returns the closed state without replaying queued %s or creating a replacement",
    async (action) => {
      const { pageId } = JSON.parse(await service.act("a", { action: "observe" }, signal()))
      await service.takeOver("a", pageId)
      const waiting = vi.fn()
      const fileLock = vi.fn(async (operation: () => Promise<string>) => operation())
      const pending = service.act(
        "a",
        {
          action,
          ...(action === "fill" || action === "upload" ? { pageId } : {}),
          url: "https://example.test/must-not-reopen",
          role: "textbox",
          name: "Name",
          text: "must not be replayed",
          fileId: "missing-file.txt"
        },
        signal(),
        waiting,
        fileLock
      )
      await context.entries[0].close()
      const closed = JSON.parse(await pending)
      expect(closed.closed).toBe(action === "fill" || action === "upload" ? pageId : null)
      expect(closed.pages).toEqual([])
      expect(closed.note).toContain("Do not assume the requested user action was completed")
      expect(context.entries).toHaveLength(1)
      expect(context.entries[0].goto).not.toHaveBeenCalled()
      expect(context.entries[0].fill).not.toHaveBeenCalled()
      expect(context.entries[0].setInputFiles).not.toHaveBeenCalled()
      expect(fileLock).not.toHaveBeenCalled()
      expect(waiting.mock.calls).toEqual([[true], [false]])
    }
  )

  it.each(["abort", "shutdown"] as const)(
    "does not turn %s during human control into a successful closed receipt",
    async (reason) => {
      const { pageId } = JSON.parse(await service.act("a", { action: "observe" }, signal()))
      await service.takeOver("a", pageId)
      const controller = new AbortController()
      const result = service.act("a", { action: "observe", pageId }, controller.signal).then(
        () => "succeeded",
        (error: Error) => error.message
      )
      if (reason === "abort") {
        const closing = context.entries[0].close()
        controller.abort(new Error("acceptance cancelled"))
        await closing
      } else await service.close()
      expect(await result).toBe(reason === "abort" ? "acceptance cancelled" : "浏览器正在退出")
      expect(context.entries).toHaveLength(1)
    }
  )

  it("keeps the exact owned target on an operation failure without waiting for another DOM observation", async () => {
    const owned = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    const peer = JSON.parse(await service.act("b", { action: "observe" }, signal()))
    const page = context.entries[0]
    page.address = "https://example.test/previous"
    page.snapshot.mockClear()
    const cause = new Error("page.goto: Timeout 20000ms exceeded")
    page.goto.mockRejectedValueOnce(cause)
    const failure = await service
      .act("a", { action: "navigate", url: "https://example.test/pending" }, signal())
      .catch((error) => error)
    expect(failure).toMatchObject({
      message: cause.message,
      cause,
      pageId: owned.pageId,
      url: "https://example.test/previous"
    })
    expect(page.snapshot).not.toHaveBeenCalled()
    const closed = JSON.parse(
      await service.act("a", { action: "close", pageId: failure.pageId }, signal())
    )
    expect(closed.closed).toBe(owned.pageId)
    expect((await service.preview("b")).pages.map((entry) => entry.id)).toEqual([peer.pageId])
    expect(context.entries).toHaveLength(2)
  })

  it("does not attach page metadata to validation errors or failures overtaken by human control", async () => {
    const { pageId } = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    const invalid = await service
      .act("a", { action: "navigate", pageId, url: "file:///private" }, signal())
      .catch((error) => error)
    expect(invalid.code).toBe("INVALID_INPUT")
    expect(invalid.pageId).toBeUndefined()
    const entered = deferred(),
      gate = deferred()
    const cause = new Error("native operation failed")
    context.entries[0].goto.mockImplementationOnce(async () => {
      entered.resolve()
      await gate.promise
      throw cause
    })
    const pending = service.act(
      "a",
      { action: "navigate", pageId, url: "https://example.test" },
      signal()
    )
    await entered.promise
    const takeover = service.takeOver("a", pageId)
    gate.resolve()
    await expect(pending).rejects.toBe(cause)
    await takeover
    expect((await service.preview("a")).control).toBe("human")
    await service.giveBack("a")
  })

  it("does not retain stale pages after a crash or let a failed takeover block future work", async () => {
    const result = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    await context.close()
    context = new TestContext()
    await expect(service.takeOver("a", result.pageId)).rejects.toThrow("已关闭")
    const fresh = JSON.parse(await service.act("a", { action: "observe" }, signal()))
    expect(fresh.pageId).not.toBe(result.pageId)
    expect((await service.preview("a")).control).toBe("bot")
  })
})
