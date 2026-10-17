import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync, writeFileSync, realpathSync, mkdirSync } from "node:fs"
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
  setInputFiles = vi.fn(async (_file: string) => {})
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
  setDefaultTimeout() {}
  setDefaultNavigationTimeout() {}
  async close() {
    await Promise.all(this.entries.map((page) => page.close()))
    this.emit("close")
  }
}
let context: TestContext, service: BotBrowserService, directory: string
const signal = () => new AbortController().signal
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
    ).rejects.toThrow("不在")
    await service.act("group-g--a", { action: "upload", name: "Upload", fileId: shared }, signal())
    expect(context.entries[0].setInputFiles).toHaveBeenCalledWith(realpathSync(shared))
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
    const action = service.act("b", { action: "observe" }, controller.signal, waiting)
    controller.abort(new Error("cancelled"))
    await expect(action).rejects.toThrow("cancelled")
    expect(waiting.mock.calls).toEqual([[true], [false]])
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
