import { beforeEach, describe, expect, it } from "vitest"
import type { WebFrameMain } from "electron"
import {
  getManualRecording,
  markNextManualNavigationExplicit,
  pauseManualRecording,
  recordManualNavigation,
  recordManualRecorderConsoleMessage,
  resetManualRecordingForTests,
  resumeManualRecording,
  startManualRecording,
  stopManualRecording,
  updateManualRecordingDraft
} from "../../../src/main/browser/recording/manual-recording-service"

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

  it("keeps alternating fill and enter actions in the generated script", () => {
    startManualRecording({ threadId: "thread-1" })
    const frame = createFrame({ url: "https://example.com/search" })

    emitRecorderMessage(frame, {
      type: "fill",
      locator: {
        role: "textbox",
        label: "Search",
        target: "Search"
      },
      value: "你好"
    })
    emitRecorderMessage(frame, {
      type: "press",
      locator: {
        role: "textbox",
        label: "Search",
        target: "Search"
      },
      key: "Enter"
    })
    emitRecorderMessage(frame, {
      type: "fill",
      locator: {
        role: "textbox",
        label: "Search",
        target: "Search"
      },
      value: "哈哈"
    })
    emitRecorderMessage(frame, {
      type: "press",
      locator: {
        role: "textbox",
        label: "Search",
        target: "Search"
      },
      key: "Enter"
    })

    const session = stopManualRecording()
    expect(session.script).toContain(
      'await page.getByRole("textbox", { name: "Search" }).fill("你好");'
    )
    expect(session.script).toContain(
      'await page.getByRole("textbox", { name: "Search" }).fill("哈哈");'
    )
    expect(session.script).toContain(
      'await page.getByRole("textbox", { name: "Search" }).press("Enter");'
    )
    expect(session.script.indexOf('.fill("你好")')).toBeLessThan(
      session.script.indexOf('.press("Enter")')
    )
    expect(session.script.indexOf('.press("Enter")')).toBeLessThan(
      session.script.lastIndexOf('.press("Enter")')
    )
  })

  it("records typed text between focusing a textbox and pressing Enter", () => {
    startManualRecording({ threadId: "thread-1" })
    const frame = createFrame({ url: "https://demo.playwright.dev/todomvc/#/" })

    emitRecorderMessage(frame, {
      type: "click",
      locator: {
        role: "textbox",
        accessibleName: "What needs to be done?",
        target: "What needs to be done?"
      }
    })
    emitRecorderMessage(frame, {
      type: "fill",
      locator: {
        role: "textbox",
        accessibleName: "What needs to be done?",
        target: "What needs to be done?"
      },
      value: "buy milk"
    })
    emitRecorderMessage(frame, {
      type: "press",
      locator: {
        role: "textbox",
        accessibleName: "What needs to be done?",
        target: "What needs to be done?"
      },
      key: "Enter"
    })

    const session = stopManualRecording()
    expect(session.script).toContain(
      'await page.getByRole("textbox", { name: "What needs to be done?" }).click();'
    )
    expect(session.script).toContain(
      'await page.getByRole("textbox", { name: "What needs to be done?" }).fill("buy milk");'
    )
    expect(session.script).toContain(
      'await page.getByRole("textbox", { name: "What needs to be done?" }).press("Enter");'
    )
  })

  it("prefers the nearest meaningful ancestor when clicking inside decorative icons", () => {
    startManualRecording({ threadId: "thread-1" })
    const frame = createFrame({ url: "https://example.com/detail" })

    emitRecorderMessage(frame, {
      type: "click",
      locator: {
        role: "img",
        tagName: "span",
        selector: "span"
      },
      locatorCandidates: [
        {
          role: "img",
          tagName: "span",
          selector: "span"
        },
        {
          tagName: "div",
          target: "编辑",
          accessibleName: "编辑",
          textContent: "编辑",
          selector: "div"
        },
        {
          tagName: "div",
          testId: "operation-area",
          target: "operation-area",
          accessibleName: "编辑",
          textContent: "编辑",
          selector: '[data-testid="operation-area"]'
        }
      ]
    })

    const session = stopManualRecording()
    expect(session.actions).toHaveLength(1)
    expect(session.actions[0]).toMatchObject({
      kind: "click",
      target: "编辑",
      locator: expect.objectContaining({
        tagName: "div",
        accessibleName: "编辑",
        textContent: "编辑"
      })
    })
    expect(session.script).toContain('await page.getByText("编辑", { exact: true }).click();')
    expect(session.script).not.toContain('getByTestId("operation-area")')
  })

  it("persists paused draft edits before continuing recording", () => {
    startManualRecording({ threadId: "thread-1" })
    pauseManualRecording()

    const editedScript = `import { test } from "@playwright/test";

test("manual recorded flow", async ({ page }) => {
  // Review generated locators before committing this test.
  await page.goto("https://demo.playwright.dev/todomvc/#/");
  await page.getByRole("textbox", { name: "What needs to be done?" }).fill("保存后的内容");
});
`

    const pausedSession = updateManualRecordingDraft({
      script: editedScript
    })
    expect(pausedSession.script).toBe(editedScript)

    resumeManualRecording()
    const frame = createFrame({ url: "https://demo.playwright.dev/todomvc/#/" })
    emitRecorderMessage(frame, {
      type: "press",
      locator: {
        role: "textbox",
        accessibleName: "What needs to be done?",
        target: "What needs to be done?"
      },
      key: "Enter"
    })

    const session = stopManualRecording()
    expect(session.script).toContain(
      'await page.getByRole("textbox", { name: "What needs to be done?" }).fill("保存后的内容");'
    )
    expect(session.script).toContain(
      'await page.getByRole("textbox", { name: "What needs to be done?" }).press("Enter");'
    )
    expect(session.script.indexOf('fill("保存后的内容")')).toBeLessThan(
      session.script.indexOf('press("Enter")')
    )
  })

  it("does not record implicit navigation after link clicks", () => {
    startManualRecording({ threadId: "thread-1" })
    const frame = createFrame({ url: "https://example.com/list" })

    emitRecorderMessage(frame, {
      type: "click",
      locator: {
        role: "link",
        accessibleName: "Open detail",
        target: "Open detail"
      }
    })
    emitRecorderMessage(frame, {
      type: "navigate",
      url: "https://example.com/detail"
    })

    const session = stopManualRecording()
    expect(session.actions).toHaveLength(1)
    expect(session.script).toContain(
      'await page.getByRole("link", { name: "Open detail" }).click();'
    )
    expect(session.script).not.toContain('await page.goto("https://example.com/detail");')
  })

  it("does not record implicit navigation after tab clicks", () => {
    startManualRecording({ threadId: "thread-1" })
    const frame = createFrame({ url: "https://todomvc.com/" })

    emitRecorderMessage(frame, {
      type: "click",
      locator: {
        role: "tab",
        accessibleName: "Reposts",
        target: "Reposts"
      }
    })
    emitRecorderMessage(frame, {
      type: "navigate",
      url: "https://medium.com/@tastejs/reposts"
    })

    const session = stopManualRecording()
    expect(session.actions).toHaveLength(1)
    expect(session.script).toContain('await page.getByRole("tab", { name: "Reposts" }).click();')
    expect(session.script).not.toContain('await page.goto("https://medium.com/@tastejs/reposts");')
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

  it("records implicit navigation only after an explicit navigation mark", () => {
    startManualRecording({ threadId: "thread-1" })

    recordManualNavigation("https://should-not-record.test", "implicit")
    markNextManualNavigationExplicit("https://example.com/dashboard")
    recordManualNavigation("https://example.com/dashboard", "implicit")

    const session = stopManualRecording()
    expect(session.actions).toHaveLength(1)
    expect(session.actions[0]).toMatchObject({
      kind: "navigate",
      url: "https://example.com/dashboard"
    })
  })

  it("records implicit navigation after an untargeted explicit navigation mark", () => {
    startManualRecording({ threadId: "thread-1" })

    markNextManualNavigationExplicit()
    recordManualNavigation("https://example.com/history-entry", "implicit")

    const session = stopManualRecording()
    expect(session.actions).toHaveLength(1)
    expect(session.actions[0]).toMatchObject({
      kind: "navigate",
      url: "https://example.com/history-entry"
    })
  })
})
