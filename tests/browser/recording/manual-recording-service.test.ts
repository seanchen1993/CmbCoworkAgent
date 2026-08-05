import { beforeEach, describe, expect, it } from "vitest"
import type { WebFrameMain } from "electron"
import { buildManualRecorderInjectionScript } from "../../../src/main/browser/recording/manual-recorder-script.js"
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

  it("treats datalist inputs as comboboxes in the injected recorder", () => {
    const script = buildManualRecorderInjectionScript()
    expect(script).toMatch(/tag === "input"[\s\S]*hasAttribute\("list"\)[\s\S]*return "combobox";/u)
  })

  it("treats numeric inputs as spinbuttons in the injected recorder", () => {
    const script = buildManualRecorderInjectionScript()
    expect(script).toMatch(/tag === "input"[\s\S]*type === "number"[\s\S]*return "spinbutton";/u)
  })

  it("treats range inputs as sliders in the injected recorder", () => {
    const script = buildManualRecorderInjectionScript()
    expect(script).toMatch(/tag === "input"[\s\S]*type === "range"[\s\S]*return "slider";/u)
  })

  it("ignores IME composition input until commit", () => {
    const script = buildManualRecorderInjectionScript()
    expect(script).toMatch(/compositionstart/u)
    expect(script).toMatch(/compositionend/u)
    expect(script).toMatch(/event\.isComposing/u)
    expect(script).toMatch(/IME_ENTER_SUPPRESS_WINDOW_MS/u)
    expect(script).toMatch(/pendingCommittedFillTimers/u)
    expect(script).toMatch(/markCompositionEnd\(event\.target\)/u)
    expect(script).toMatch(/const timerId = window\.setTimeout\(\(\) => \{/u)
    expect(script).toMatch(/emitTextFill\(target\);/u)
  })

  it("captures occurrence hints for duplicate role locators in the injected recorder", () => {
    const script = buildManualRecorderInjectionScript()
    expect(script).toMatch(/matches\.length > 1/u)
    expect(script).toMatch(/matchCount = matches\.length/u)
    expect(script).toMatch(/nth = candidateIndex/u)
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
      'await page.getByRole("textbox", { name: "邮箱", exact: true }).fill("final@example.com");'
    )
    expect(session.script).toContain(
      'await page.getByRole("button", { name: "登录", exact: true }).click();'
    )
  })

  it("clicks radio cards through their visible label instead of the hidden input", () => {
    startManualRecording({ threadId: "thread-1" })
    const frame = createFrame({ url: "https://example.com/register" })

    emitRecorderMessage(frame, {
      type: "click",
      locator: {
        role: "radio",
        label: "🎨 设计师 做设计的人",
        target: "🎨 设计师 做设计的人",
        selector: 'input[name="role"][value="designer"]',
        tagName: "input",
        inputType: "radio"
      }
    })

    const session = stopManualRecording()
    expect(session.script).toContain(
      'await page.locator("label:has(input[name=\\"role\\"][value=\\"designer\\"])").click();'
    )
    expect(session.script).not.toContain('getByLabel("🎨 设计师 做设计的人").click()')
    expect(session.script).not.toContain('getByRole("radio"')
  })

  it("clicks switch-style checkboxes through their label wrapper", () => {
    startManualRecording({ threadId: "thread-1" })
    const frame = createFrame({ url: "https://example.com/register" })

    emitRecorderMessage(frame, {
      type: "click",
      locator: {
        role: "checkbox",
        target: "emailNotif",
        selector: 'input[name="emailNotif"]',
        tagName: "input",
        inputType: "checkbox"
      }
    })

    const session = stopManualRecording()
    expect(session.script).toContain(
      'await page.locator("label:has(input[name=\\"emailNotif\\"])").click();'
    )
    expect(session.script).not.toContain('getByText("emailNotif", { exact: true }).click()')
  })

  it("clicks menuitem radio options through their semantic role", () => {
    startManualRecording({ threadId: "thread-1" })
    const frame = createFrame({ url: "https://example.com/register" })

    emitRecorderMessage(frame, {
      type: "click",
      locator: {
        role: "menuitemradio",
        accessibleName: "fix/bug-doc-qyang",
        target: "fix/bug-doc-qyang",
        selector: 'button[name="branch"]',
        tagName: "button"
      }
    })

    const session = stopManualRecording()
    expect(session.script).toContain(
      'await page.getByRole("menuitemradio", { name: "fix/bug-doc-qyang", exact: true }).click();'
    )
    expect(session.script).not.toContain('locator("button[name=\\"branch\\"]")')
  })

  it("keeps the committed branch filter fill before selecting a menuitem radio option", () => {
    startManualRecording({ threadId: "thread-1" })
    const frame = createFrame({ url: "https://example.com/branches" })

    emitRecorderMessage(frame, {
      type: "click",
      locator: {
        role: "textbox",
        accessibleName: "Select branch",
        placeholder: "Select branch",
        target: "Select branch",
        selector: "#context-commitish-filter-field",
        tagName: "input",
        inputType: "text"
      }
    })
    emitRecorderMessage(frame, {
      type: "fill",
      locator: {
        role: "textbox",
        accessibleName: "Select branch",
        placeholder: "Select branch",
        target: "Select branch",
        selector: "#context-commitish-filter-field",
        tagName: "input",
        inputType: "text"
      },
      value: "qyang"
    })
    emitRecorderMessage(frame, {
      type: "click",
      locator: {
        role: "menuitemradio",
        accessibleName: "UAT_qyang2",
        target: "UAT_qyang2",
        selector: 'button[name="branch"]',
        tagName: "button"
      }
    })

    const session = stopManualRecording()
    expect(session.script).toContain(
      'await page.getByRole("textbox", { name: "Select branch", exact: true }).click();'
    )
    expect(session.script).toContain(
      'await page.getByRole("textbox", { name: "Select branch", exact: true }).fill("qyang");'
    )
    expect(session.script).toContain(
      'await page.getByRole("menuitemradio", { name: "UAT_qyang2", exact: true }).click();'
    )
    expect(session.script.indexOf('.fill("qyang")')).toBeLessThan(
      session.script.indexOf('getByRole("menuitemradio", { name: "UAT_qyang2", exact: true }).click()')
    )
  })

  it("keeps literal values for sensitive manual fills", () => {
    startManualRecording({ threadId: "thread-1" })
    const frame = createFrame({ url: "https://example.com/register" })

    emitRecorderMessage(frame, {
      type: "fill",
      locator: {
        role: "textbox",
        accessibleName: "密码",
        target: "密码"
      },
      value: "12345678"
    })

    const session = stopManualRecording()
    expect(session.actions).toEqual([
      expect.objectContaining({
        kind: "fill",
        source: "manual",
        target: "密码",
        value: "12345678",
        sensitive: true
      })
    ])
    expect(session.script).toContain(
      'await page.getByRole("textbox", { name: "密码", exact: true }).fill("12345678");'
    )
  })

  it("renders combobox fills for datalist-backed inputs", () => {
    startManualRecording({ threadId: "thread-1" })
    const frame = createFrame({ url: "https://example.com/register" })

    emitRecorderMessage(frame, {
      type: "fill",
      locator: {
        role: "combobox",
        label: "用户名 (支持自动补全)",
        target: "用户名 (支持自动补全)"
      },
      value: "你好"
    })

    const session = stopManualRecording()
    expect(session.script).toContain(
      'await page.getByRole("combobox", { name: "用户名 (支持自动补全)", exact: true }).fill("你好");'
    )
  })

  it("renders spinbutton fills for numeric inputs", () => {
    startManualRecording({ threadId: "thread-1" })
    const frame = createFrame({ url: "https://example.com/register" })

    emitRecorderMessage(frame, {
      type: "fill",
      locator: {
        label: "年龄",
        target: "年龄",
        tagName: "input",
        inputType: "number"
      },
      value: "11"
    })

    const session = stopManualRecording()
    expect(session.script).toContain(
      'await page.getByRole("spinbutton", { name: "年龄", exact: true }).fill("11");'
    )
  })

  it("renders slider fills for range inputs", () => {
    startManualRecording({ threadId: "thread-1" })
    const frame = createFrame({ url: "https://example.com/register" })

    emitRecorderMessage(frame, {
      type: "fill",
      locator: {
        label: "编程经验（年）",
        target: "编程经验（年）",
        tagName: "input",
        inputType: "range"
      },
      value: "6"
    })

    const session = stopManualRecording()
    expect(session.script).toContain(
      'await page.getByRole("slider", { name: "编程经验（年）", exact: true }).fill("6");'
    )
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
      'await page.getByRole("textbox", { name: "Search", exact: true }).fill("你好");'
    )
    expect(session.script).toContain(
      'await page.getByRole("textbox", { name: "Search", exact: true }).fill("哈哈");'
    )
    expect(session.script).toContain(
      'await page.getByRole("textbox", { name: "Search", exact: true }).press("Enter");'
    )
    expect(session.script.indexOf('.fill("你好")')).toBeLessThan(
      session.script.indexOf('.press("Enter")')
    )
    expect(session.script.indexOf('.press("Enter")')).toBeLessThan(
      session.script.lastIndexOf('.press("Enter")')
    )
  })

  it("keeps duplicate role targets distinct by recording their occurrence index", () => {
    startManualRecording({ threadId: "thread-1" })
    const frame = createFrame({ url: "https://example.com/search" })

    emitRecorderMessage(frame, {
      type: "click",
      locator: {
        role: "button",
        accessibleName: "Search",
        target: "Search",
        tagName: "button",
        selector: "button",
        matchCount: 2,
        nth: 0
      }
    })
    emitRecorderMessage(frame, {
      type: "click",
      locator: {
        role: "button",
        accessibleName: "Search",
        target: "Search",
        tagName: "button",
        selector: "button",
        matchCount: 2,
        nth: 1
      }
    })

    const session = stopManualRecording()
    expect(session.actions).toHaveLength(2)
    expect(session.actions[0]).toMatchObject({
      kind: "click",
      locator: expect.objectContaining({
        matchCount: 2,
        nth: 0
      })
    })
    expect(session.actions[1]).toMatchObject({
      kind: "click",
      locator: expect.objectContaining({
        matchCount: 2,
        nth: 1
      })
    })
    expect(session.script).toContain(
      'await page.getByRole("button", { name: "Search", exact: true }).nth(0).click();'
    )
    expect(session.script).toContain(
      'await page.getByRole("button", { name: "Search", exact: true }).nth(1).click();'
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
      'await page.getByRole("textbox", { name: "What needs to be done?", exact: true }).click();'
    )
    expect(session.script).toContain(
      'await page.getByRole("textbox", { name: "What needs to be done?", exact: true }).fill("buy milk");'
    )
    expect(session.script).toContain(
      'await page.getByRole("textbox", { name: "What needs to be done?", exact: true }).press("Enter");'
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
      'await page.getByRole("textbox", { name: "What needs to be done?", exact: true }).fill("保存后的内容");'
    )
    expect(session.script).toContain(
      'await page.getByRole("textbox", { name: "What needs to be done?", exact: true }).press("Enter");'
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
      'await page.getByRole("link", { name: "Open detail", exact: true }).click();'
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
    expect(session.script).toContain(
      'await page.getByRole("tab", { name: "Reposts", exact: true }).click();'
    )
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
      'page.frameLocator("iframe[src*=\\"https://pay.example.com/embedded-card\\"]").getByRole("textbox", { name: "Card number", exact: true }).fill("4242424242424242");'
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
      'await page.getByRole("button", { name: "Upload document", exact: true }).click();'
    )
    expect(session.script).toContain("const fileChooser1 = await fileChooserPromise1;")
    expect(session.script).toContain('await fileChooser1.setFiles("/tmp/fixtures/contract.pdf");')
    expect(session.script).not.toContain("TODO_FILE_INPUT_SELECTOR")
  })

  it("replays direct file-input uploads without clicking a textbox locator first", () => {
    startManualRecording({ threadId: "thread-1" })
    const frame = createFrame({ url: "https://example.com/profile" })

    emitRecorderMessage(frame, {
      type: "click",
      locator: {
        target: "avatar",
        accessibleName: "avatar",
        selector: 'input[name="avatar"]',
        tagName: "input",
        inputType: "file"
      }
    })
    emitRecorderMessage(frame, {
      type: "fileUpload",
      locator: {
        target: "avatar",
        accessibleName: "avatar",
        selector: 'input[name="avatar"]',
        tagName: "input",
        inputType: "file"
      },
      paths: ["think.webp"]
    })

    const session = stopManualRecording()

    expect(session.script).not.toContain('page.waitForEvent("filechooser")')
    expect(session.script).not.toContain(
      'getByRole("textbox", { name: "avatar", exact: true }).click()'
    )
    expect(session.script).toContain(
      'await page.locator("input[name=\\"avatar\\"]").setInputFiles("think.webp");'
    )
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
