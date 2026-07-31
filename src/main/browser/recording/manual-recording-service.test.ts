import { beforeEach, describe, expect, it } from "vitest"
import type { WebFrameMain } from "electron"
import {
  getManualRecording,
  recordManualNavigation,
  recordManualRecorderConsoleMessage,
  resetManualRecordingForTests,
  startManualRecording,
  stopManualRecording
} from "./manual-recording-service"

function createFrame(input: {
  frameToken?: string
  origin?: string
  parent?: WebFrameMain | null
  url: string
}): WebFrameMain {
  return {
    frameToken: input.frameToken ?? input.url,
    origin: input.origin ?? input.url,
    parent: input.parent ?? null,
    url: input.url
  } as WebFrameMain
}

function emitRecorderMessage(frame: WebFrameMain, payload: Record<string, unknown>): void {
  recordManualRecorderConsoleMessage(frame, `[ManualRecorder]${JSON.stringify(payload)}`)
}

describe("manual recording service", () => {
  beforeEach(() => {
    resetManualRecordingForTests()
  })

  it("starts with the current page and generates a manual recording draft", () => {
    const session = startManualRecording({
      currentUrl: "https://example.com/dashboard",
      threadId: "thread-1"
    })

    expect(session.source).toBe("manual")
    expect(session.status).toBe("recording")
    expect(session.actions).toEqual([
      expect.objectContaining({
        kind: "navigate",
        source: "manual",
        url: "https://example.com/dashboard"
      })
    ])

    const stopped = stopManualRecording()
    expect(stopped.script).toContain('test("manual recorded flow", async ({ page }) => {')
    expect(stopped.script).toContain('await page.goto("https://example.com/dashboard");')
  })

  it("records manual fill and click actions and dedupes repeated fills", () => {
    startManualRecording({ threadId: "thread-1" })
    const frame = createFrame({ url: "https://example.com/login" })

    emitRecorderMessage(frame, {
      type: "fill",
      locator: {
        role: "textbox",
        label: "邮箱",
        target: "邮箱",
        selector: "#email"
      },
      value: "first@example.com"
    })
    emitRecorderMessage(frame, {
      type: "fill",
      locator: {
        role: "textbox",
        label: "邮箱",
        target: "邮箱",
        selector: "#email"
      },
      value: "final@example.com"
    })
    emitRecorderMessage(frame, {
      type: "click",
      locator: {
        role: "button",
        accessibleName: "登录",
        target: "登录"
      }
    })

    const session = stopManualRecording()
    expect(session.actions).toHaveLength(2)
    expect(session.actions[0]).toMatchObject({
      kind: "fill",
      source: "manual",
      value: "final@example.com"
    })
    expect(session.actions[1]).toMatchObject({
      kind: "click",
      source: "manual"
    })
    expect(session.script).toContain(
      'await page.getByRole("textbox", { name: "邮箱" }).fill("final@example.com");'
    )
    expect(session.script).toContain('await page.getByRole("button", { name: "登录" }).click();')
  })

  it("builds frame locators for manually recorded iframe actions", () => {
    startManualRecording({ threadId: "thread-1" })
    const topFrame = createFrame({ url: "https://example.com/checkout" })
    const childFrame = createFrame({
      parent: topFrame,
      url: "https://pay.example.com/embedded-card"
    })

    emitRecorderMessage(childFrame, {
      type: "fill",
      locator: {
        placeholder: "Card number",
        role: "textbox",
        target: "Card number"
      },
      value: "4242424242424242"
    })

    const session = stopManualRecording()
    expect(session.script).toContain(
      'page.frameLocator("iframe[src*=\\"https://pay.example.com/embedded-card\\"]").getByRole("textbox", { name: "Card number" }).fill("4242424242424242");'
    )
  })

  it("records file uploads and replays them after the triggering click", () => {
    startManualRecording({ threadId: "thread-1" })
    const frame = createFrame({ url: "https://example.com/upload" })

    emitRecorderMessage(frame, {
      type: "click",
      locator: {
        role: "button",
        accessibleName: "Upload document",
        target: "Upload document"
      }
    })
    emitRecorderMessage(frame, {
      type: "fileUpload",
      locator: {
        selector: 'input[type="file"]',
        tagName: "input",
        inputType: "file"
      },
      paths: ["/tmp/fixtures/contract.pdf"]
    })

    const session = stopManualRecording()

    expect(session.actions).toHaveLength(2)
    expect(session.actions[1]).toMatchObject({
      kind: "fileUpload",
      source: "manual",
      paths: ["/tmp/fixtures/contract.pdf"]
    })
    expect(session.script).toContain(
      'const fileChooserPromise1 = page.waitForEvent("filechooser");'
    )
    expect(session.script).toContain(
      'await page.getByRole("button", { name: "Upload document" }).click();'
    )
    expect(session.script).toContain("const fileChooser1 = await fileChooserPromise1;")
    expect(session.script).toContain('await fileChooser1.setFiles("/tmp/fixtures/contract.pdf");')
    expect(session.script).not.toContain("TODO_FILE_INPUT_SELECTOR")
  })

  it("records manual navigation updates only while recording", () => {
    recordManualNavigation("https://should-not-record.test")
    expect(getManualRecording().actions).toHaveLength(0)

    startManualRecording({ threadId: "thread-1" })
    recordManualNavigation("https://example.com/first")
    recordManualNavigation("https://example.com/second")

    const session = stopManualRecording()
    expect(session.actions).toEqual([
      expect.objectContaining({
        kind: "navigate",
        url: "https://example.com/second"
      })
    ])
  })
})
