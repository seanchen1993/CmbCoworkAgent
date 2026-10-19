import { EventEmitter } from "node:events"
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

const launch = vi.fn()
class TestPage extends EventEmitter {
  closed = false
  address = "about:blank"
  goto = vi.fn(async (url: string) => {
    this.address = url
  })
  fill = vi.fn(async () => {})
  click = vi.fn(async () => {})
  press = vi.fn(async () => {})
  setInputFiles = vi.fn<(file: string) => Promise<void>>(async () => {})
  getByLabel = vi.fn(() => ({ count: async () => 1, setInputFiles: this.setInputFiles }))
  snapshot = vi.fn(async () => '- textbox "Name"')
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
  opener = async () => null
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
  launch.mockReset().mockImplementation(
    async () =>
      ({
        context,
        createPage: () => context.newPage(),
        getTitle: async () => "Test page",
        show: (page: TestPage) => page.bringToFront(),
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
      const capture = vi.spyOn(page, "screenshot")
      let preview: Awaited<ReturnType<BotBrowserService["preview"]>> | undefined
      const pending = service.preview("a", pageId).then((value) => {
        preview = value
      })
      await vi.waitFor(() => expect(preview).toBeDefined(), { timeout: 300 })
      await pending
      expect(preview!.pages).toEqual([{ id: pageId, url: "about:blank", title: "Test page" }])
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
    engine.getTitle = async () => {
      entered.resolve()
      await finish.promise
      return "Closed target"
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
