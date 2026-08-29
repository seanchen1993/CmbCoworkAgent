import { beforeEach, describe, expect, it } from "vitest"
import type { WebFrameMain } from "electron"
import type { BrowserLocatorMetadata } from "../../../../src/shared/browser-types"
import { buildPlaywrightLocator } from "../../../../src/main/browser/record/common/playwright-codegen/projectLocatorAdapter"
import {
  buildPlaywrightScriptRecorderInjectionScript,
  inspectPlaywrightScriptRecorderMessage,
  PLAYWRIGHT_SCRIPT_RECORDER_EVENT_PREFIX,
  PLAYWRIGHT_SCRIPT_RECORDER_FRAME_CHANNEL_KEY,
  PLAYWRIGHT_SCRIPT_RECORDER_FRAME_SELECTOR_HELPER,
  PLAYWRIGHT_SCRIPT_RECORDER_INJECTION_FLAG,
  PLAYWRIGHT_SCRIPT_RECORDER_ISOLATED_WORLD_ID
} from "../../../../src/main/browser/record/script-record/script-recorder-playwright-adapter"
import {
  getScriptRecording,
  installScriptRecorder,
  markNextScriptNavigationExplicit,
  installScriptRecorderForSubtree,
  pauseScriptRecording,
  recordScriptNavigation,
  recordScriptRecorderConsoleMessage,
  resetScriptRecordingForTests,
  resumeScriptRecording,
  startScriptRecording,
  stopScriptRecording,
  updateScriptRecordingDraft
} from "../../../../src/main/browser/record/script-record/script-recording-service"

function createFrame(input: {
  executeJavaScript?: (code: string) => Promise<unknown>
  executeJavaScriptInIsolatedWorld?: (
    worldId: number,
    scripts: Array<{ code: string }>
  ) => Promise<unknown>
  frames?: WebFrameMain[]
  framesInSubtree?: WebFrameMain[]
  frameToken?: string
  origin?: string
  processId?: number
  parent?: WebFrameMain | null
  routingId?: number
  detached?: boolean
  name?: string
  url: string
}): WebFrameMain {
  const frame = {
    detached: input.detached ?? false,
    executeJavaScript: input.executeJavaScript ?? (async () => true),
    executeJavaScriptInIsolatedWorld: input.executeJavaScriptInIsolatedWorld,
    frameToken: input.frameToken ?? input.url,
    frames: input.frames ?? [],
    origin: input.origin ?? input.url,
    parent: input.parent ?? null,
    processId: input.processId ?? 1,
    routingId: input.routingId ?? 1,
    name: input.name ?? "",
    url: input.url,
    isDestroyed: () => false
  } as WebFrameMain
  ;(frame as WebFrameMain & { framesInSubtree: WebFrameMain[] }).framesInSubtree =
    input.framesInSubtree ?? [frame, ...(input.frames ?? [])]
  return frame
}

type ScriptRecorderPayload = {
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

function emitRecorderMessage(frame: WebFrameMain, payload: ScriptRecorderPayload): void {
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

  recordScriptRecorderConsoleMessage(
    frame,
    `${PLAYWRIGHT_SCRIPT_RECORDER_EVENT_PREFIX}${JSON.stringify({
      type: "action",
      action,
      locator
    })}`
  )
}

describe("script recording service", () => {
  beforeEach(() => {
    resetScriptRecordingForTests()
  })

  it("reports frame diagnostics without exposing recorded fill values", () => {
    const diagnostic = inspectPlaywrightScriptRecorderMessage(
      `${PLAYWRIGHT_SCRIPT_RECORDER_EVENT_PREFIX}${JSON.stringify({
        type: "action",
        action: {
          name: "fill",
          selector: 'internal:role=textbox[name="密码"s]',
          text: "do-not-log-this-value"
        },
        frameUrl: "https://example.com/embedded",
        frameContext: {
          instanceId: "frame-instance-1",
          channelId: "frame-channel-1",
          isTop: false,
          depth: 1,
          frameElementIndex: 2,
          frameElementSrc: "/embedded"
        }
      })}`
    )

    expect(diagnostic).toEqual({
      actionName: "fill",
      clickCount: undefined,
      frameUrl: "https://example.com/embedded",
      selector: 'internal:role=textbox[name="密码"s]',
      frameContext: {
        instanceId: "frame-instance-1",
        channelId: "frame-channel-1",
        isTop: false,
        depth: 1,
        frameElementIndex: 2,
        frameElementSrc: "/embedded"
      }
    })
    expect(JSON.stringify(diagnostic)).not.toContain("do-not-log-this-value")
  })

  it("starts with the current page and generates a script recording draft", () => {
    const session = startScriptRecording({
      currentUrl: "https://example.com/dashboard",
      threadId: "thread-1"
    })

    expect(session.source).toBe("script")
    expect(session.status).toBe("recording")
    expect(session.actions).toEqual([
      expect.objectContaining({
        kind: "navigate",
        source: "script",
        url: "https://example.com/dashboard"
      })
    ])

    const stopped = stopScriptRecording()
    expect(stopped.script).toContain('test("recorded script flow", async ({ page }) => {')
    expect(stopped.script).toContain("await page.goto('https://example.com/dashboard');")
  })

  it("records script fill and click actions and dedupes repeated fills", () => {
    startScriptRecording({ threadId: "thread-1" })
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

    const session = stopScriptRecording()
    expect(session.actions).toHaveLength(2)
    expect(session.actions[0]).toMatchObject({
      kind: "fill",
      source: "script",
      value: "final@example.com"
    })
    expect(session.actions[1]).toMatchObject({
      kind: "click",
      source: "script"
    })
    expect(session.script).toContain(
      "await page.getByRole('textbox', { name: '邮箱', exact: true }).fill('final@example.com');"
    )
    expect(session.script).toContain("await page.getByRole('button', { name: '登录' }).click();")
  })

  it("uses the recorded href selector with its embedded codegen nth", () => {
    startScriptRecording({ threadId: "thread-1" })
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

    const session = stopScriptRecording()
    expect(session.script).toContain(
      `await page.locator('a[href="/seanchen1993/CmbCoworkAgent/actions/workflows/build-electron.yml"]').nth(1).click();`
    )
    expect(session.script).toContain(".nth(1)")
  })

  it("uses the codegen label-text selector to click hidden radio cards", () => {
    startScriptRecording({ threadId: "thread-1" })
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

    const session = stopScriptRecording()
    expect(session.script).toContain(
      "await page.getByText('🎨 设计师 做设计的人', { exact: true }).click();"
    )
    expect(session.script).not.toContain("getByRole('radio'")
    expect(session.script).not.toContain("getByLabel('🎨 设计师 做设计的人'")
  })

  it("falls back to the visible label text when a hidden radio has no codegen selector", () => {
    startScriptRecording({ threadId: "thread-1" })
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

    const session = stopScriptRecording()
    expect(session.script).toContain(
      "await page.getByText('🎨 设计师 做设计的人', { exact: true }).click();"
    )
    expect(session.script).not.toContain("getByRole('radio'")
    expect(session.script).not.toContain("getByLabel('🎨 设计师 做设计的人'")
  })

  it("keeps the codegen radio role selector for visible radio inputs", () => {
    startScriptRecording({ threadId: "thread-1" })
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

    const session = stopScriptRecording()
    expect(session.script).toContain(
      "await page.getByRole('radio', { name: '🎨 设计师 做设计的人', exact: true }).click();"
    )
  })

  it("keeps check semantics when the recorder targets a checkbox directly", () => {
    startScriptRecording({ threadId: "thread-1" })
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

    const session = stopScriptRecording()
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
    startScriptRecording({ threadId: "thread-1" })
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

    const session = stopScriptRecording()
    expect(session.actions[0]).toMatchObject({
      kind: "click",
      toggle: "uncheck"
    })
    expect(session.script).toContain(
      "await page.getByRole('checkbox', { name: '愿意接收产品更新和活动邮件通知' }).uncheck();"
    )
  })

  it("clicks switch-style checkboxes through their label wrapper", () => {
    startScriptRecording({ threadId: "thread-1" })
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

    const session = stopScriptRecording()
    expect(session.script).toContain(
      "await page.getByRole('checkbox', { name: 'emailNotif', exact: true }).click();"
    )
    expect(session.script).not.toContain("getByText('emailNotif', { exact: true }).click()")
  })

  it("clicks menuitem radio options through their semantic role", () => {
    startScriptRecording({ threadId: "thread-1" })
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

    const session = stopScriptRecording()
    expect(session.script).toContain(
      "await page.getByRole('menuitemradio', { name: 'fix/bug-doc-qyang', exact: true }).click();"
    )
    expect(session.script).not.toContain('locator("button[name=\\"branch\\"]")')
  })

  it("keeps the committed branch filter fill before selecting a menuitem radio option", () => {
    startScriptRecording({ threadId: "thread-1" })
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

    const session = stopScriptRecording()
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
      session.script.indexOf(
        "getByRole('menuitemradio', { name: 'UAT_qyang2', exact: true }).click()"
      )
    )
  })

  it("keeps literal values for sensitive script fills", () => {
    startScriptRecording({ threadId: "thread-1" })
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

    const session = stopScriptRecording()
    expect(session.actions).toEqual([
      expect.objectContaining({
        kind: "fill",
        source: "script",
        target: "密码",
        value: "12345678",
        sensitive: true
      })
    ])
    expect(session.script).toContain(
      "await page.getByRole('textbox', { name: '密码' }).fill('12345678');"
    )
  })

  it("renders combobox fills for datalist-backed inputs", () => {
    startScriptRecording({ threadId: "thread-1" })
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

    const session = stopScriptRecording()
    expect(session.script).toContain(
      "await page.getByRole('combobox', { name: '用户名 (支持自动补全)' }).fill('你好');"
    )
  })

  it("renders spinbutton fills for numeric inputs", () => {
    startScriptRecording({ threadId: "thread-1" })
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

    const session = stopScriptRecording()
    expect(session.script).toContain(
      "await page.getByRole('spinbutton', { name: '年龄' }).fill('11');"
    )
  })

  it("renders slider fills for range inputs", () => {
    startScriptRecording({ threadId: "thread-1" })
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

    const session = stopScriptRecording()
    expect(session.script).toContain(
      "await page.getByRole('slider', { name: '编程经验（年）' }).fill('6');"
    )
  })

  it("keeps alternating fill and enter actions in the generated script", () => {
    startScriptRecording({ threadId: "thread-1" })
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

    const session = stopScriptRecording()
    expect(session.script).toContain(
      "await page.getByRole('textbox', { name: 'Search' }).fill('你好');"
    )
    expect(session.script).toContain(
      "await page.getByRole('textbox', { name: 'Search' }).fill('哈哈');"
    )
    expect(session.script).toContain(
      "await page.getByRole('textbox', { name: 'Search' }).press('Enter');"
    )
    expect(session.script.indexOf('.fill("你好")')).toBeLessThan(
      session.script.indexOf(".press('Enter')")
    )
    expect(session.script.indexOf(".press('Enter')")).toBeLessThan(
      session.script.lastIndexOf(".press('Enter')")
    )
  })

  it("supersedes a fill replayed with the same value after Enter", () => {
    startScriptRecording({ threadId: "thread-1" })
    const frame = createFrame({ url: "https://example.com/branches" })
    const branchFilter = {
      role: "textbox" as const,
      accessibleName: "Select branch",
      placeholder: "Select branch",
      target: "Select branch",
      selector: 'internal:role=textbox[name="Select branch"s]',
      tagName: "input",
      inputType: "text"
    }

    emitRecorderMessage(frame, {
      type: "fill",
      locator: branchFilter,
      value: "record"
    })
    emitRecorderMessage(frame, {
      type: "press",
      locator: branchFilter,
      key: "Enter"
    })
    emitRecorderMessage(frame, {
      type: "fill",
      locator: branchFilter,
      value: "record"
    })
    emitRecorderMessage(frame, {
      type: "click",
      locator: {
        role: "menuitemradio",
        accessibleName: "codex/recover-in-app-browser-",
        target: "codex/recover-in-app-browser-",
        selector: 'internal:role=menuitemradio[name="codex/recover-in-app-browser-"s]',
        tagName: "button"
      }
    })

    const session = stopScriptRecording()
    expect(session.actions.map((action) => action.kind)).toEqual(["press", "fill", "click"])
    expect(session.script).toContain(
      "await page.getByRole('textbox', { name: 'Select branch', exact: true }).press('Enter');"
    )
    expect(session.script).toContain(
      "await page.getByRole('textbox', { name: 'Select branch', exact: true }).fill('record');"
    )
    expect(session.script).toContain(
      "await page.getByRole('menuitemradio', { name: 'codex/recover-in-app-browser-', exact: true }).click();"
    )
    expect(session.script.indexOf(".press('Enter')")).toBeLessThan(
      session.script.indexOf(".fill('record')")
    )
  })

  it("keeps duplicate role targets distinct by recording their occurrence index", () => {
    startScriptRecording({ threadId: "thread-1" })
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

    const session = stopScriptRecording()
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
    startScriptRecording({ threadId: "thread-1" })
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

    const session = stopScriptRecording()
    expect(session.script).toContain(
      "await page.getByRole('textbox', { name: 'What needs to be done?' }).click();"
    )
    expect(session.script).toContain(
      "await page.getByRole('textbox', { name: 'What needs to be done?' }).fill('buy milk');"
    )
    expect(session.script).toContain(
      "await page.getByRole('textbox', { name: 'What needs to be done?' }).press('Enter');"
    )
  })

  it("prefers the nearest meaningful ancestor when clicking inside decorative icons", () => {
    startScriptRecording({ threadId: "thread-1" })
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

    const session = stopScriptRecording()
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
    startScriptRecording({ threadId: "thread-1" })
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

    const session = stopScriptRecording()
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
    startScriptRecording({ threadId: "thread-1" })
    pauseScriptRecording()

    const editedScript = `import { test } from "@playwright/test";

test("recorded script flow", async ({ page }) => {
  // Review generated locators before committing this test.
  await page.goto('https://demo.playwright.dev/todomvc/#/');
  await page.getByRole('textbox', { name: 'What needs to be done?' }).fill('保存后的内容');
});
`

    const pausedSession = updateScriptRecordingDraft({
      script: editedScript
    })
    expect(pausedSession.script).toBe(editedScript)

    resumeScriptRecording()
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

    const session = stopScriptRecording()
    expect(session.script).toContain(
      "await page.getByRole('textbox', { name: 'What needs to be done?' }).fill('保存后的内容');"
    )
    expect(session.script).toContain(
      "await page.getByRole('textbox', { name: 'What needs to be done?' }).press('Enter');"
    )
    expect(session.script.indexOf('fill("保存后的内容")')).toBeLessThan(
      session.script.indexOf("press('Enter')")
    )
  })

  it("does not record implicit navigation after link clicks", () => {
    startScriptRecording({ threadId: "thread-1" })
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

    const session = stopScriptRecording()
    expect(session.actions).toHaveLength(1)
    expect(session.script).toContain(
      "await page.getByRole('link', { name: 'Open detail' }).click();"
    )
    expect(session.script).not.toContain("await page.goto('https://example.com/detail');")
  })

  it("does not record implicit navigation after tab clicks", () => {
    startScriptRecording({ threadId: "thread-1" })
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

    const session = stopScriptRecording()
    expect(session.actions).toHaveLength(1)
    expect(session.script).toContain("await page.getByRole('tab', { name: 'Reposts' }).click();")
    expect(session.script).not.toContain("await page.goto('https://medium.com/@tastejs/reposts');")
  })

  it("builds frame locators for script-recorded iframe actions", () => {
    startScriptRecording({ threadId: "thread-1" })
    const topFrame = createFrame({ url: "https://example.com/checkout" })
    const childFrame = createFrame({
      parent: topFrame,
      url: "https://pay.example.com/embedded-card"
    })
    topFrame.frames = [childFrame]
    topFrame.framesInSubtree = [topFrame, childFrame]

    emitRecorderMessage(childFrame, {
      type: "fill",
      locator: {
        placeholder: "Card number",
        role: "textbox",
        target: "Card number"
      },
      value: "4242424242424242"
    })

    const session = stopScriptRecording()
    expect(session.script).toContain(
      "page.locator('iframe').contentFrame().getByRole('textbox', { name: 'Card number' }).fill('4242424242424242');"
    )
  })

  it("uses the parent frame selector helper when available", async () => {
    startScriptRecording({ threadId: "thread-1" })

    const topFrame = createFrame({ url: "https://example.com/checkout" })
    const childFrame = createFrame({
      parent: topFrame,
      url: "https://example.com/payment"
    })
    topFrame.frames = [childFrame]
    topFrame.framesInSubtree = [topFrame, childFrame]
    childFrame.framesInSubtree = [childFrame]

    topFrame.executeJavaScript = async (code: string) => {
      if (code.includes(PLAYWRIGHT_SCRIPT_RECORDER_FRAME_SELECTOR_HELPER)) {
        return 'iframe[name="payment"]'
      }
      return undefined
    }
    childFrame.executeJavaScript = async () => undefined

    await installScriptRecorderForSubtree(topFrame)

    emitRecorderMessage(childFrame, {
      type: "fill",
      locator: {
        role: "textbox",
        placeholder: "Card number",
        target: "Card number"
      },
      value: "4242"
    })

    const session = stopScriptRecording()
    expect(session.script).toContain(
      "page.locator('iframe[name=\"payment\"]').contentFrame().getByRole('textbox', { name: 'Card number' }).fill('4242');"
    )
  })

  it("prefers isolated-world injection before page-world execution", async () => {
    startScriptRecording({ threadId: "thread-1" })

    const pageExecutions: string[] = []
    const isolatedExecutions: Array<{ worldId: number; code: string }> = []
    const frame = createFrame({
      url: "https://github.com/seanchen1993/CmbCoworkAgent/actions",
      executeJavaScript: async (code: string) => {
        pageExecutions.push(code)
        return undefined
      },
      executeJavaScriptInIsolatedWorld: async (
        worldId: number,
        scripts: Array<{ code: string }>
      ) => {
        isolatedExecutions.push({ worldId, code: scripts[0]?.code ?? "" })
        return true
      }
    })

    await installScriptRecorderForSubtree(frame)

    expect(pageExecutions).toHaveLength(0)
    expect(isolatedExecutions).toHaveLength(1)
    expect(isolatedExecutions[0]?.worldId).toBe(PLAYWRIGHT_SCRIPT_RECORDER_ISOLATED_WORLD_ID)
    expect(isolatedExecutions[0]?.code).toContain("__cmbPlaywrightScriptRecorderInstalled")
  })

  it("falls back to page-world injection when isolated-world execution fails", async () => {
    startScriptRecording({ threadId: "thread-1" })

    let pageExecutions = 0
    let isolatedExecutions = 0
    const frame = createFrame({
      url: "https://example.com/fallback",
      executeJavaScript: async () => {
        pageExecutions += 1
        return undefined
      },
      executeJavaScriptInIsolatedWorld: async () => {
        isolatedExecutions += 1
        throw new Error("isolated world unavailable")
      }
    })

    await installScriptRecorderForSubtree(frame)

    expect(isolatedExecutions).toBe(1)
    expect(pageExecutions).toBe(1)
  })

  it("falls back to page-world injection when isolated-world execution returns undefined", async () => {
    startScriptRecording({ threadId: "thread-1" })

    let pageExecutions = 0
    let isolatedExecutions = 0
    const frame = createFrame({
      url: "file:///tmp/register.html",
      executeJavaScript: async () => {
        pageExecutions += 1
        return true
      },
      executeJavaScriptInIsolatedWorld: async () => {
        isolatedExecutions += 1
        return undefined
      }
    })

    await installScriptRecorderForSubtree(frame)

    expect(isolatedExecutions).toBe(1)
    expect(pageExecutions).toBe(1)
  })

  it("serializes concurrent injections for the same frame", async () => {
    startScriptRecording({ threadId: "thread-1" })

    let isolatedExecutions = 0
    let releaseExecution: (() => void) | undefined
    const frame = createFrame({
      url: "https://example.com/payment",
      executeJavaScriptInIsolatedWorld: async () => {
        isolatedExecutions += 1
        await new Promise<void>((resolve) => {
          releaseExecution = resolve
        })
        return true
      }
    })

    const pendingInjection = Promise.all([
      installScriptRecorder(frame),
      installScriptRecorder(frame)
    ])
    await Promise.resolve()
    expect(isolatedExecutions).toBe(1)
    releaseExecution?.()
    await pendingInjection
  })

  it("marks the frame only after the recorder is initialized", () => {
    const script = buildPlaywrightScriptRecorderInjectionScript("frame-channel-1")
    const recorderInitialization = script.indexOf("const recorder = new PollingRecorder")
    const installedMarker = script.lastIndexOf(
      `window.${PLAYWRIGHT_SCRIPT_RECORDER_INJECTION_FLAG} = true`
    )

    expect(script).toContain(
      `const FRAME_CHANNEL_KEY = ${JSON.stringify(PLAYWRIGHT_SCRIPT_RECORDER_FRAME_CHANNEL_KEY)}`
    )
    expect(script).toContain('const RECORDER_FRAME_CHANNEL_ID = "frame-channel-1"')
    expect(script).toContain("channelId: RECORDER_FRAME_CHANNEL_ID")
    expect(installedMarker).toBeGreaterThan(recorderInitialization)
    expect(script.slice(installedMarker)).toContain("return RECORDER_FRAME_CHANNEL_ID")
  })

  it("uses the injected frame channel when Electron reports a same-process iframe as root", async () => {
    startScriptRecording({ threadId: "thread-1" })

    const rootFrame = createFrame({ url: "http://localhost:8000/register.html" })
    let childInjectionScript = ""
    const childFrame = createFrame({
      parent: rootFrame,
      url: "http://localhost:8000/login.html",
      executeJavaScriptInIsolatedWorld: async (_worldId, scripts) => {
        childInjectionScript = scripts[0]?.code ?? ""
        return true
      }
    })
    rootFrame.frames = [childFrame]
    rootFrame.framesInSubtree = [rootFrame, childFrame]

    await installScriptRecorderForSubtree(rootFrame)

    const channelMatch = /const RECORDER_FRAME_CHANNEL_ID = ("(?:\\.|[^"])*");/u.exec(
      childInjectionScript
    )
    expect(channelMatch?.[1]).toBeTruthy()
    const channelId = JSON.parse(channelMatch![1]!)

    recordScriptRecorderConsoleMessage(
      rootFrame,
      `${PLAYWRIGHT_SCRIPT_RECORDER_EVENT_PREFIX}${JSON.stringify({
        type: "action",
        action: {
          name: "click",
          selector: 'internal:role=tab[name="个人资料"s]',
          clickCount: 1
        },
        locator: {
          role: "tab",
          accessibleName: "个人资料",
          target: "个人资料",
          selector: 'internal:role=tab[name="个人资料"s]'
        },
        frameContext: { channelId }
      })}`
    )

    const session = stopScriptRecording()
    expect(session.script).toContain(
      "await page.locator('iframe').contentFrame().getByRole('tab', { name: '个人资料', exact: true }).click();"
    )
  })

  it("keeps nested iframe paths aligned with Playwright codegen order", () => {
    startScriptRecording({ threadId: "thread-1" })

    const topFrame = createFrame({
      url: "file:///Users/qiyang/Downloads/qyang-openwork/test/register.html"
    })
    const topRegisterFrame = createFrame({
      parent: topFrame,
      url: "file:///Users/qiyang/Downloads/qyang-openwork/test/register.html"
    })
    const topLoginFrame = createFrame({
      parent: topFrame,
      url: "http://localhost:8765/login.html"
    })
    const topTailwindFrame = createFrame({
      parent: topFrame,
      url: "https://tailwindcss.com/docs/scale"
    })
    topFrame.frames = [topRegisterFrame, topLoginFrame, topTailwindFrame]
    topFrame.framesInSubtree = [topFrame, topRegisterFrame, topLoginFrame, topTailwindFrame]

    const nestedRegisterFrame = createFrame({
      parent: topRegisterFrame,
      url: "file:///Users/qiyang/Downloads/qyang-openwork/test/register.html"
    })
    const nestedLoginFrame = createFrame({
      parent: topRegisterFrame,
      url: "http://localhost:8765/login.html"
    })
    const nestedTailwindFrame = createFrame({
      parent: topRegisterFrame,
      url: "https://tailwindcss.com/docs/scale"
    })
    topRegisterFrame.frames = [nestedRegisterFrame, nestedLoginFrame, nestedTailwindFrame]
    topRegisterFrame.framesInSubtree = [
      topRegisterFrame,
      nestedRegisterFrame,
      nestedLoginFrame,
      nestedTailwindFrame
    ]

    emitRecorderMessage(topFrame, {
      type: "click",
      locator: {
        role: "tab",
        accessibleName: "个人资料",
        target: "个人资料",
        selector: 'internal:role=tab[name="个人资料"s]',
        tagName: "button"
      }
    })
    emitRecorderMessage(topRegisterFrame, {
      type: "click",
      locator: {
        role: "tab",
        accessibleName: "个人资料",
        target: "个人资料",
        selector: 'internal:role=tab[name="个人资料"s]',
        tagName: "button"
      }
    })
    emitRecorderMessage(nestedLoginFrame, {
      type: "fill",
      locator: {
        role: "textbox",
        accessibleName: "姓名(input文本框)：",
        target: "姓名(input文本框)：",
        selector: 'internal:role=textbox[name="姓名(input文本框)："s]',
        tagName: "input",
        inputType: "text"
      },
      value: "ha"
    })
    emitRecorderMessage(nestedTailwindFrame, {
      type: "click",
      locator: {
        role: "button",
        accessibleName: "Show more",
        target: "Show more",
        selector: 'internal:role=button[name="Show more"s]',
        tagName: "button"
      }
    })

    const session = stopScriptRecording()
    expect(session.script).toContain(
      "page.locator('iframe').first().contentFrame().getByRole('tab', { name: '个人资料', exact: true }).click();"
    )
    expect(session.script).toContain(
      "page.locator('iframe').first().contentFrame().locator('iframe').nth(1).contentFrame().getByRole('textbox', { name: '姓名(input文本框)：', exact: true }).fill('ha');"
    )
    expect(session.script).toContain(
      "page.locator('iframe').first().contentFrame().locator('iframe').nth(2).contentFrame().getByRole('button', { name: 'Show more', exact: true }).click();"
    )
  })

  it("records file uploads as direct setInputFiles calls", () => {
    startScriptRecording({ threadId: "thread-1" })
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

    const session = stopScriptRecording()

    expect(session.actions).toHaveLength(2)
    expect(session.actions[1]).toMatchObject({
      kind: "fileUpload",
      source: "script",
      paths: ["/tmp/fixtures/contract.pdf"]
    })
    expect(session.script).not.toContain("Upload document")
    expect(session.script).toContain(
      "await page.locator('input[type=\"file\"]').setInputFiles('/tmp/fixtures/contract.pdf');"
    )
    expect(session.script).not.toContain("TODO_FILE_INPUT_SELECTOR")
  })

  it("normalizes Playwright fakepath fills on file inputs into setInputFiles", () => {
    startScriptRecording({ threadId: "thread-1" })
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

    const session = stopScriptRecording()

    expect(session.actions).toHaveLength(2)
    expect(session.actions[1]).toMatchObject({
      kind: "fileUpload",
      source: "script",
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
    startScriptRecording({ threadId: "thread-1" })
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

    const session = stopScriptRecording()

    expect(session.script).not.toContain('page.waitForEvent("filechooser")')
    expect(session.script).not.toContain("getByRole('textbox', { name: 'avatar' }).click()")
    expect(session.script).not.toContain("await page.locator('input[name=\"avatar\"]').click();")
    expect(session.script).toContain(
      "await page.locator('input[name=\"avatar\"]').setInputFiles('think.webp');"
    )
  })

  it("records script navigation updates only while recording", () => {
    recordScriptNavigation("https://should-not-record.test")
    expect(getScriptRecording().actions).toHaveLength(0)

    startScriptRecording({ threadId: "thread-1" })
    recordScriptNavigation("https://example.com/first")
    recordScriptNavigation("https://example.com/second")

    const session = stopScriptRecording()
    expect(session.actions).toEqual([
      expect.objectContaining({
        kind: "navigate",
        url: "https://example.com/second"
      })
    ])
  })

  it("records implicit navigation only after an explicit navigation mark", () => {
    startScriptRecording({ threadId: "thread-1" })

    recordScriptNavigation("https://should-not-record.test", "implicit")
    markNextScriptNavigationExplicit("https://example.com/dashboard")
    recordScriptNavigation("https://example.com/dashboard", "implicit")

    const session = stopScriptRecording()
    expect(session.actions).toHaveLength(1)
    expect(session.actions[0]).toMatchObject({
      kind: "navigate",
      url: "https://example.com/dashboard"
    })
  })

  it("records implicit navigation after an untargeted explicit navigation mark", () => {
    startScriptRecording({ threadId: "thread-1" })

    markNextScriptNavigationExplicit()
    recordScriptNavigation("https://example.com/history-entry", "implicit")

    const session = stopScriptRecording()
    expect(session.actions).toHaveLength(1)
    expect(session.actions[0]).toMatchObject({
      kind: "navigate",
      url: "https://example.com/history-entry"
    })
  })
})
