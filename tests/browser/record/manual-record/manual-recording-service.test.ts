import { beforeEach, describe, expect, it } from "vitest"
import type { WebFrameMain } from "electron"
import type { BrowserLocatorMetadata } from "../../../../src/shared/browser-types"
import { buildPlaywrightLocator } from "../../../../src/main/browser/record/common/playwright-codegen/projectLocatorAdapter"
import { PLAYWRIGHT_MANUAL_RECORDER_EVENT_PREFIX } from "../../../../src/main/browser/record/manual-record/manual-recorder-playwright-adapter"
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
} from "../../../../src/main/browser/record/manual-record/manual-recording-service"

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

type LegacyRecorderPayload = {
  type: "click" | "fill" | "select" | "press" | "fileUpload"
  locator?: BrowserLocatorMetadata
  locatorCandidates?: BrowserLocatorMetadata[]
  value?: string
  values?: string[]
  key?: string
  paths?: string[]
  doubleClick?: boolean
  toggle?: "check" | "uncheck"
}

function buildTestFramePath(frame: WebFrameMain): string[] {
  const chain: string[] = []
  let current: WebFrameMain | null = frame
  while (current?.parent) {
    const frameUrl = current.url || current.origin || current.frameToken
    chain.unshift(`iframe[src*=${JSON.stringify(frameUrl)}]`)
    current = current.parent
  }
  return chain
}

function buildTestLocatorPayload(
  frame: WebFrameMain,
  locator: BrowserLocatorMetadata | undefined
): Record<string, unknown> | undefined {
  if (!locator) return undefined
  const framePath = buildTestFramePath(frame)
  const playwrightLocator = buildPlaywrightLocator({
    ...locator,
    framePath
  } as Parameters<typeof buildPlaywrightLocator>[0]).replace(/^page\./u, "")

  return {
    ...locator,
    framePath,
    playwrightLocator
  }
}

function emitRecorderMessage(frame: WebFrameMain, payload: LegacyRecorderPayload): void {
  const locator = buildTestLocatorPayload(frame, payload.locator)
  const selector = typeof locator?.selector === "string" ? locator.selector : undefined

  const action =
    payload.type === "click"
      ? {
          name: payload.toggle ?? "click",
          selector,
          clickCount: payload.doubleClick ? 2 : 1
        }
      : payload.type === "fill"
        ? {
            name: "fill",
            selector,
            text: payload.value ?? ""
          }
        : payload.type === "select"
          ? {
              name: "select",
              selector,
              options: payload.values ?? []
            }
          : payload.type === "press"
            ? {
                name: "press",
                selector,
                key: payload.key
              }
            : {
                name: "setInputFiles",
                selector,
                files: payload.paths ?? []
              }

  recordManualRecorderConsoleMessage(
    frame,
    `${PLAYWRIGHT_MANUAL_RECORDER_EVENT_PREFIX}${JSON.stringify({
      type: "action",
      action,
      locator
    })}`
  )
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
    expect(stopped.script).toContain("await page.goto('https://example.com/dashboard');")
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
        selector: 'internal:role=textbox[name="邮箱"s]'
      },
      value: "first@example.com"
    })
    emitRecorderMessage(frame, {
      type: "fill",
      locator: {
        role: "textbox",
        label: "邮箱",
        target: "邮箱",
        selector: 'internal:role=textbox[name="邮箱"s]'
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
      "await page.getByRole('textbox', { name: '邮箱', exact: true }).fill('final@example.com');"
    )
    expect(session.script).toContain(
      "await page.getByRole('button', { name: '登录', exact: true }).click();"
    )
  })

  it("uses the recorded href selector with its embedded codegen nth", () => {
    startManualRecording({ threadId: "thread-1" })
    const frame = createFrame({ url: "https://github.com/seanchen1993/CmbCoworkAgent/actions" })

    emitRecorderMessage(frame, {
      type: "click",
      locator: {
        role: "link",
        accessibleName: "Build Electron App",
        target: "Build Electron App",
        selector:
          'a[href="/seanchen1993/CmbCoworkAgent/actions/workflows/build-electron.yml"] >> nth=1',
        tagName: "a"
      }
    })

    const session = stopManualRecording()
    expect(session.script).toContain(
      `await page.locator('a[href="/seanchen1993/CmbCoworkAgent/actions/workflows/build-electron.yml"]').nth(1).click();`
    )
    expect(session.script).toContain(".nth(1)")
  })

  it("uses the codegen label-text selector to click hidden radio cards", () => {
    startManualRecording({ threadId: "thread-1" })
    const frame = createFrame({ url: "https://example.com/register" })

    emitRecorderMessage(frame, {
      type: "click",
      locator: {
        role: "radio",
        label: "🎨 设计师 做设计的人",
        target: "🎨 设计师 做设计的人",
        selector: 'internal:text="🎨 设计师 做设计的人"s',
        tagName: "input",
        inputType: "radio",
        isVisible: false
      }
    })

    const session = stopManualRecording()
    expect(session.script).toContain(
      "await page.getByText('🎨 设计师 做设计的人', { exact: true }).click();"
    )
    expect(session.script).not.toContain("getByRole('radio'")
    expect(session.script).not.toContain("getByLabel('🎨 设计师 做设计的人'")
  })

  it("falls back to the visible label text when a hidden radio has no codegen selector", () => {
    startManualRecording({ threadId: "thread-1" })
    const frame = createFrame({ url: "https://example.com/register" })

    emitRecorderMessage(frame, {
      type: "click",
      locator: {
        role: "radio",
        label: "🎨 设计师 做设计的人",
        target: "🎨 设计师 做设计的人",
        tagName: "input",
        inputType: "radio",
        isVisible: false
      }
    })

    const session = stopManualRecording()
    expect(session.script).toContain(
      "await page.getByText('🎨 设计师 做设计的人', { exact: true }).click();"
    )
    expect(session.script).not.toContain("getByRole('radio'")
    expect(session.script).not.toContain("getByLabel('🎨 设计师 做设计的人'")
  })

  it("keeps the codegen radio role selector for visible radio inputs", () => {
    startManualRecording({ threadId: "thread-1" })
    const frame = createFrame({ url: "https://example.com/register" })

    emitRecorderMessage(frame, {
      type: "click",
      locator: {
        role: "radio",
        label: "🎨 设计师 做设计的人",
        target: "🎨 设计师 做设计的人",
        selector: 'internal:role=radio[name="🎨 设计师 做设计的人"s]',
        tagName: "input",
        inputType: "radio"
      }
    })

    const session = stopManualRecording()
    expect(session.script).toContain(
      "await page.getByRole('radio', { name: '🎨 设计师 做设计的人', exact: true }).click();"
    )
  })

  it("keeps check semantics when the recorder targets a checkbox directly", () => {
    startManualRecording({ threadId: "thread-1" })
    const frame = createFrame({ url: "https://example.com/register" })

    emitRecorderMessage(frame, {
      type: "click",
      toggle: "check",
      locator: {
        role: "checkbox",
        accessibleName: "愿意接收产品更新和活动邮件通知",
        target: "愿意接收产品更新和活动邮件通知",
        selector: 'internal:role=checkbox[name="愿意接收产品更新和活动邮件通知"i]',
        tagName: "input",
        inputType: "checkbox"
      }
    })

    const session = stopManualRecording()
    expect(session.actions[0]).toMatchObject({
      kind: "click",
      toggle: "check"
    })
    expect(session.script).toContain(
      "await page.getByRole('checkbox', { name: '愿意接收产品更新和活动邮件通知' }).check();"
    )
    expect(session.script).not.toContain(".click();")
  })

  it("keeps uncheck semantics when unchecking a checkbox", () => {
    startManualRecording({ threadId: "thread-1" })
    const frame = createFrame({ url: "https://example.com/register" })

    emitRecorderMessage(frame, {
      type: "click",
      toggle: "uncheck",
      locator: {
        role: "checkbox",
        accessibleName: "愿意接收产品更新和活动邮件通知",
        target: "愿意接收产品更新和活动邮件通知",
        selector: 'internal:role=checkbox[name="愿意接收产品更新和活动邮件通知"i]',
        tagName: "input",
        inputType: "checkbox"
      }
    })

    const session = stopManualRecording()
    expect(session.actions[0]).toMatchObject({
      kind: "click",
      toggle: "uncheck"
    })
    expect(session.script).toContain(
      "await page.getByRole('checkbox', { name: '愿意接收产品更新和活动邮件通知' }).uncheck();"
    )
  })

  it("clicks switch-style checkboxes through their label wrapper", () => {
    startManualRecording({ threadId: "thread-1" })
    const frame = createFrame({ url: "https://example.com/register" })

    emitRecorderMessage(frame, {
      type: "click",
      locator: {
        role: "checkbox",
        target: "emailNotif",
        selector: 'internal:role=checkbox[name="emailNotif"s]',
        tagName: "input",
        inputType: "checkbox"
      }
    })

    const session = stopManualRecording()
    expect(session.script).toContain(
      "await page.getByRole('checkbox', { name: 'emailNotif', exact: true }).click();"
    )
    expect(session.script).not.toContain("getByText('emailNotif', { exact: true }).click()")
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
        selector: 'internal:role=menuitemradio[name="fix/bug-doc-qyang"s]',
        tagName: "button"
      }
    })

    const session = stopManualRecording()
    expect(session.script).toContain(
      "await page.getByRole('menuitemradio', { name: 'fix/bug-doc-qyang', exact: true }).click();"
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
        selector: 'internal:role=textbox[name="Select branch"s]',
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
        selector: 'internal:role=textbox[name="Select branch"s]',
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
        selector: 'internal:role=menuitemradio[name="UAT_qyang2"s]',
        tagName: "button"
      }
    })

    const session = stopManualRecording()
    expect(session.script).toContain(
      "await page.getByRole('textbox', { name: 'Select branch', exact: true }).click();"
    )
    expect(session.script).toContain(
      "await page.getByRole('textbox', { name: 'Select branch', exact: true }).fill('qyang');"
    )
    expect(session.script).toContain(
      "await page.getByRole('menuitemradio', { name: 'UAT_qyang2', exact: true }).click();"
    )
    expect(session.script.indexOf('.fill("qyang")')).toBeLessThan(
      session.script.indexOf("getByRole('menuitemradio', { name: 'UAT_qyang2', exact: true }).click()")
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
      "await page.getByRole('textbox', { name: '密码', exact: true }).fill('12345678');"
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
      "await page.getByRole('combobox', { name: '用户名 (支持自动补全)', exact: true }).fill('你好');"
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
      "await page.getByRole('spinbutton', { name: '年龄', exact: true }).fill('11');"
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
      "await page.getByRole('slider', { name: '编程经验（年）', exact: true }).fill('6');"
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
      "await page.getByRole('textbox', { name: 'Search', exact: true }).fill('你好');"
    )
    expect(session.script).toContain(
      "await page.getByRole('textbox', { name: 'Search', exact: true }).fill('哈哈');"
    )
    expect(session.script).toContain(
      "await page.getByRole('textbox', { name: 'Search', exact: true }).press('Enter');"
    )
    expect(session.script.indexOf('.fill("你好")')).toBeLessThan(
      session.script.indexOf(".press('Enter')")
    )
    expect(session.script.indexOf(".press('Enter')")).toBeLessThan(
      session.script.lastIndexOf(".press('Enter')")
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
        selector: 'internal:role=button[name="Search"s] >> nth=0',
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
        selector: 'internal:role=button[name="Search"s] >> nth=1',
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
      "await page.getByRole('button', { name: 'Search', exact: true }).first().click();"
    )
    expect(session.script).toContain(
      "await page.getByRole('button', { name: 'Search', exact: true }).nth(1).click();"
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
      "await page.getByRole('textbox', { name: 'What needs to be done?', exact: true }).click();"
    )
    expect(session.script).toContain(
      "await page.getByRole('textbox', { name: 'What needs to be done?', exact: true }).fill('buy milk');"
    )
    expect(session.script).toContain(
      "await page.getByRole('textbox', { name: 'What needs to be done?', exact: true }).press('Enter');"
    )
  })

  it("prefers the nearest meaningful ancestor when clicking inside decorative icons", () => {
    startManualRecording({ threadId: "thread-1" })
    const frame = createFrame({ url: "https://example.com/detail" })

    emitRecorderMessage(frame, {
      type: "click",
      locator: {
        tagName: "div",
        target: "编辑",
        accessibleName: "编辑",
        textContent: "编辑",
        selector: 'internal:text="编辑"s'
      }
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
    expect(session.script).toContain("await page.getByText('编辑', { exact: true }).click();")
    expect(session.script).not.toContain('getByTestId("operation-area")')
  })

  it("keeps svg targets when ancestor text is volatile", () => {
    startManualRecording({ threadId: "thread-1" })
    const frame = createFrame({ url: "https://example.com/detail" })

    emitRecorderMessage(frame, {
      type: "click",
      locator: {
        tagName: "svg",
        selector: "svg >> nth=3",
        isTarget: true,
        matchCount: 6,
        nth: 3
      },
      locatorCandidates: [
        {
          tagName: "svg",
          selector: "svg >> nth=3",
          isTarget: true,
          matchCount: 6,
          nth: 3
        },
        {
          tagName: "div",
          target: "一键报工 数据获取时间：08-05 16:33",
          accessibleName: "一键报工 数据获取时间：08-05 16:33",
          textContent: "一键报工 数据获取时间：08-05 16:33",
          selector: "div"
        }
      ]
    })

    const session = stopManualRecording()
    expect(session.actions).toHaveLength(1)
    expect(session.actions[0]).toMatchObject({
      kind: "click",
      locator: expect.objectContaining({
        tagName: "svg",
        selector: "svg >> nth=3",
        nth: 3
      })
    })
    expect(session.script).toContain("await page.locator('svg').nth(3).click();")
    expect(session.script).not.toContain('getByText("一键报工 数据获取时间：08-05 16:33"')
  })

  it("persists paused draft edits before continuing recording", () => {
    startManualRecording({ threadId: "thread-1" })
    pauseManualRecording()

    const editedScript = `import { test } from "@playwright/test";

test("manual recorded flow", async ({ page }) => {
  // Review generated locators before committing this test.
  await page.goto('https://demo.playwright.dev/todomvc/#/');
  await page.getByRole('textbox', { name: 'What needs to be done?' }).fill('保存后的内容');
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
      "await page.getByRole('textbox', { name: 'What needs to be done?', exact: true }).fill('保存后的内容');"
    )
    expect(session.script).toContain(
      "await page.getByRole('textbox', { name: 'What needs to be done?', exact: true }).press('Enter');"
    )
    expect(session.script.indexOf('fill("保存后的内容")')).toBeLessThan(
      session.script.indexOf("press('Enter')")
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
      "await page.getByRole('link', { name: 'Open detail', exact: true }).click();"
    )
    expect(session.script).not.toContain("await page.goto('https://example.com/detail');")
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
      "await page.getByRole('tab', { name: 'Reposts', exact: true }).click();"
    )
    expect(session.script).not.toContain("await page.goto('https://medium.com/@tastejs/reposts');")
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
      "page.locator('iframe[src*=\"https://pay.example.com/embedded-card\"]').contentFrame().getByRole('textbox', { name: 'Card number', exact: true }).fill('4242424242424242');"
    )
  })

  it("records file uploads as direct setInputFiles calls", () => {
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
    expect(session.script).not.toContain("Upload document")
    expect(session.script).toContain(
      "await page.locator('input[type=\"file\"]').setInputFiles('/tmp/fixtures/contract.pdf');"
    )
    expect(session.script).not.toContain("TODO_FILE_INPUT_SELECTOR")
  })

  it("normalizes Playwright fakepath fills on file inputs into setInputFiles", () => {
    startManualRecording({ threadId: "thread-1" })
    const frame = createFrame({ url: "https://example.com/profile" })
    const locator: BrowserLocatorMetadata = {
      target: "avatar",
      selector: 'internal:role=button[name="Choose File"i]',
      tagName: "input",
      inputType: "file"
    }

    emitRecorderMessage(frame, {
      type: "click",
      locator
    })
    emitRecorderMessage(frame, {
      type: "fill",
      locator,
      value: "C:\\fakepath\\think.webp"
    })

    const session = stopManualRecording()

    expect(session.actions).toHaveLength(2)
    expect(session.actions[1]).toMatchObject({
      kind: "fileUpload",
      source: "manual",
      paths: ["think.webp"],
      locator: expect.objectContaining({
        selector: 'internal:role=button[name="Choose File"i]',
        inputType: "file"
      })
    })
    expect(session.script).toMatch(
      /await page\.getByRole\('button', \{ name: 'Choose File'(?:, exact: true)? \}\)\.setInputFiles\('think\.webp'\);/u
    )
    expect(session.script).not.toContain(".fill('C:\\fakepath")
    expect(session.script).not.toContain(".click();")
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
      "getByRole('textbox', { name: 'avatar', exact: true }).click()"
    )
    expect(session.script).not.toContain(
      "await page.locator('input[name=\"avatar\"]').click();"
    )
    expect(session.script).toContain(
      "await page.locator('input[name=\"avatar\"]').setInputFiles('think.webp');"
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
