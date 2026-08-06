import { beforeEach, describe, expect, it } from "vitest"
import {
  generateAiRecordingScript,
  getAiRecording,
  recordSuccessfulAiBrowserToolCall,
  resetAiRecordingForTests,
  startAiRecording,
  stopAiRecording
} from "../../../../src/main/browser/record/ai-record/ai-recording-service"
import {
  extractAiRecordingVariableNames,
  parseAiRecordingScript
} from "../../../../src/shared/browser-ai-recording-script"

const LOGIN_SNAPSHOT_RESULT = `### Snapshot
\`\`\`yaml
- generic [ref=e5]:
  - generic [ref=e24]:
    - generic [ref=e25]: 用户名
    - combobox "用户名 (支持自动补全)" [ref=e27]:
      - /placeholder: 输入你的用户名
    - generic [ref=e29]: 邮箱
    - textbox "邮箱" [ref=e31]:
      - /placeholder: you@example.com
\`\`\``

const BRANCH_SNAPSHOT_RESULT = `### Snapshot
\`\`\`yaml
- generic [ref=e1]:
  - generic [ref=e2]:
    - generic [ref=e3]: 分支
    - combobox "分支" [ref=e10]:
      - option "release" [ref=e11]
\`\`\``

describe("AI recording service", () => {
  beforeEach(() => {
    resetAiRecordingForTests()
  })

  it("records supported browser actions and generates a Playwright draft", () => {
    startAiRecording({ threadId: "thread-1" })

    recordSuccessfulAiBrowserToolCall({
      toolName: "browser_navigate",
      threadId: "thread-1",
      args: { url: "https://example.com/login" }
    })
    recordSuccessfulAiBrowserToolCall({
      toolName: "browser_click",
      threadId: "thread-2",
      args: { element: "Login button" }
    })
    recordSuccessfulAiBrowserToolCall({
      toolName: "browser_type",
      threadId: "thread-1",
      args: { element: "Email input", text: "first@example.com" }
    })
    recordSuccessfulAiBrowserToolCall({
      toolName: "browser_type",
      threadId: "thread-1",
      args: { element: "Email input", text: "final@example.com" }
    })
    recordSuccessfulAiBrowserToolCall({
      toolName: "browser_type",
      threadId: "thread-1",
      args: { element: "Password input", text: "super-secret" }
    })
    recordSuccessfulAiBrowserToolCall({
      toolName: "browser_select_option",
      threadId: "thread-1",
      args: { element: "Role select", values: ["admin"] }
    })

    const session = stopAiRecording()

    expect(session.status).toBe("completed")
    expect(session.actions).toHaveLength(5)
    expect(session.actions[2]).toMatchObject({
      kind: "fill",
      target: "Email input",
      value: "final@example.com",
      sensitive: false
    })
    expect(session.actions[3]).toMatchObject({
      kind: "fill",
      target: "Password input",
      value: "super-secret",
      sensitive: true
    })
    expect(session.script).toContain("await page.goto('https://example.com/login');")
    expect(session.script).toContain(
      "await page.getByRole('button', { name: 'Login', exact: true }).click();"
    )
    expect(session.script).toContain(
      "await page.getByRole('textbox', { name: 'Email', exact: true }).fill('final@example.com');"
    )
    expect(session.script).toContain(
      "await page.getByRole('textbox', { name: 'Password', exact: true }).fill('super-secret');"
    )
  })

  it("ignores unsupported tools but records calls from any thread", () => {
    startAiRecording({ threadId: "thread-1" })

    recordSuccessfulAiBrowserToolCall({
      toolName: "browser_snapshot",
      threadId: "thread-1",
      args: {}
    })
    recordSuccessfulAiBrowserToolCall({
      toolName: "browser_navigate",
      threadId: "thread-2",
      args: { url: "https://should-not-record.test" }
    })

    const session = getAiRecording()
    expect(session.actions).toEqual([
      expect.objectContaining({
        kind: "navigate",
        url: "https://should-not-record.test"
      })
    ])
  })

  it("reuses the current recording session across repeated starts", () => {
    const firstSession = startAiRecording({ threadId: "thread-a" })
    const secondSession = startAiRecording({ threadId: "thread-b" })

    expect(secondSession).toMatchObject({
      id: firstSession.id,
      status: "recording"
    })
  })

  it("dedupes consecutive identical click, select, and press actions", () => {
    startAiRecording({ threadId: "thread-1" })

    recordSuccessfulAiBrowserToolCall({
      toolName: "browser_click",
      threadId: "thread-1",
      args: { element: "Actions tab in repository navigation" }
    })
    recordSuccessfulAiBrowserToolCall({
      toolName: "browser_click",
      threadId: "thread-1",
      args: { element: "Actions tab in repository navigation" }
    })
    recordSuccessfulAiBrowserToolCall({
      toolName: "browser_select_option",
      threadId: "thread-1",
      args: { element: "Branch selector", values: ["main"] }
    })
    recordSuccessfulAiBrowserToolCall({
      toolName: "browser_select_option",
      threadId: "thread-1",
      args: { element: "Branch selector", values: ["main"] }
    })
    recordSuccessfulAiBrowserToolCall({
      toolName: "browser_press_key",
      threadId: "thread-1",
      args: { element: "Search input", key: "Enter" }
    })
    recordSuccessfulAiBrowserToolCall({
      toolName: "browser_press_key",
      threadId: "thread-1",
      args: { element: "Search input", key: "Enter" }
    })

    const session = stopAiRecording()

    expect(session.actions).toHaveLength(3)
    expect(session.script).toContain(
      "await page.getByRole('tab', { name: 'Actions', exact: true }).click();"
    )
    expect(session.script.match(/getByRole\('tab', \{ name: 'Actions', exact: true \}\)/g)).toHaveLength(1)
    expect(session.script.match(/Branch selector/g)).toHaveLength(1)
    expect(session.script).toContain(
      "await page.getByRole('textbox', { name: 'Search', exact: true }).press('Enter');"
    )
  })

  it("records browser_fill_form as individual fill actions", () => {
    startAiRecording({ threadId: "thread-1" })

    recordSuccessfulAiBrowserToolCall({
      toolName: "browser_fill_form",
      threadId: "thread-1",
      args: {
        fields: [
          { name: "Username input", type: "textbox", value: "john.doe" },
          { name: "Email input", type: "textbox", value: "john@example.com" },
          { name: "Password input", type: "textbox", value: "my-secret" }
        ]
      }
    })

    const session = stopAiRecording()

    expect(session.status).toBe("completed")
    expect(session.actions).toHaveLength(3)
    expect(session.actions[0]).toMatchObject({
      kind: "fill",
      target: "Username input",
      value: "john.doe",
      sensitive: false
    })
    expect(session.actions[1]).toMatchObject({
      kind: "fill",
      target: "Email input",
      value: "john@example.com",
      sensitive: false
    })
    expect(session.actions[2]).toMatchObject({
      kind: "fill",
      target: "Password input",
      value: "my-secret",
      sensitive: true
    })
    expect(session.script).toContain(
      "await page.getByRole('textbox', { name: 'Username', exact: true }).fill('john.doe');"
    )
    expect(session.script).toContain(
      "await page.getByRole('textbox', { name: 'Email', exact: true }).fill('john@example.com');"
    )
    expect(session.script).toContain(
      "await page.getByRole('textbox', { name: 'Password', exact: true }).fill('my-secret');"
    )
  })

  it("infers spinbutton locators for numeric fill fields", () => {
    startAiRecording({ threadId: "thread-1" })

    recordSuccessfulAiBrowserToolCall({
      toolName: "browser_fill_form",
      threadId: "thread-1",
      args: {
        fields: [
          {
            label: "年龄",
            name: "年龄",
            tagName: "input",
            inputType: "number",
            value: "11"
          }
        ]
      }
    })

    const session = stopAiRecording()

    expect(session.actions).toEqual([
      expect.objectContaining({
        kind: "fill",
        target: "年龄",
        value: "11",
        locator: expect.objectContaining({
          role: "spinbutton",
          inputType: "number"
        })
      })
    ])
    expect(session.script).toContain(
      "await page.getByRole('spinbutton', { name: '年龄', exact: true }).fill('11');"
    )
  })

  it("infers slider locators for range fill fields", () => {
    startAiRecording({ threadId: "thread-1" })

    recordSuccessfulAiBrowserToolCall({
      toolName: "browser_fill_form",
      threadId: "thread-1",
      args: {
        fields: [
          {
            label: "编程经验（年）",
            name: "编程经验（年）",
            tagName: "input",
            type: "range",
            value: "6"
          }
        ]
      }
    })

    const session = stopAiRecording()

    expect(session.actions).toEqual([
      expect.objectContaining({
        kind: "fill",
        target: "编程经验（年）",
        value: "6",
        locator: expect.objectContaining({
          role: "slider",
          inputType: "range"
        })
      })
    ])
    expect(session.script).toContain(
      "await page.getByRole('slider', { name: '编程经验（年）', exact: true }).fill('6');"
    )
  })

  it("clicks radio-card choices with their semantic role", () => {
    startAiRecording({ threadId: "thread-1" })

    recordSuccessfulAiBrowserToolCall({
      toolName: "browser_click",
      threadId: "thread-1",
      args: {
        target: "🎨 设计师 做设计的人",
        role: "radio",
        label: "🎨 设计师 做设计的人",
        selector: 'input[name="role"][value="designer"]',
        tagName: "input",
        inputType: "radio"
      }
    })

    const session = stopAiRecording()

    expect(session.actions).toEqual([
      expect.objectContaining({
        kind: "click",
        target: "🎨 设计师 做设计的人",
        locator: expect.objectContaining({
          role: "radio",
          selector: 'input[name="role"][value="designer"]',
          inputType: "radio"
        })
      })
    ])
    expect(session.script).toContain(
      "await page.getByRole('radio', { name: '🎨 设计师 做设计的人', exact: true }).click();"
    )
    expect(session.script).not.toContain(`label:has(input[name="role"][value="designer"])`)
  })

  it("uses richer locator metadata when available", () => {
    startAiRecording({ threadId: "thread-1" })

    recordSuccessfulAiBrowserToolCall({
      toolName: "browser_click",
      threadId: "thread-1",
      args: {
        target: "Login button",
        role: "button",
        testId: "login-submit",
        label: "登录"
      }
    })
    recordSuccessfulAiBrowserToolCall({
      toolName: "browser_fill",
      threadId: "thread-1",
      args: {
        target: "Card number input",
        placeholder: "Card number",
        framePath: ['iframe[name="payment"]'],
        text: "4242424242424242"
      }
    })

    const session = stopAiRecording()

    expect(session.script).toContain("await page.getByTestId('login-submit').click();")
    expect(session.script).toContain(
      `await page.locator('iframe[name="payment"]').contentFrame().getByPlaceholder('Card number', { exact: true }).fill('4242424242424242');`
    )
  })

  it("resolves snapshot refs into semantic locators for AI-recorded fills", () => {
    startAiRecording({ threadId: "thread-1" })

    recordSuccessfulAiBrowserToolCall({
      toolName: "browser_snapshot",
      threadId: "thread-1",
      args: {},
      resultText: LOGIN_SNAPSHOT_RESULT
    })
    recordSuccessfulAiBrowserToolCall({
      toolName: "browser_type",
      threadId: "thread-1",
      args: { target: "e27", text: "mktui" },
      resultText: `### Ran Playwright code
\`\`\`js
await page.getByRole('combobox', { name: '用户名 (支持自动补全)' }).fill('mktui');
\`\`\``
    })
    recordSuccessfulAiBrowserToolCall({
      toolName: "browser_type",
      threadId: "thread-1",
      args: { target: "e31", text: "test@qq.com" },
      resultText: `### Ran Playwright code
\`\`\`js
await page.getByRole('textbox', { name: '邮箱' }).fill('test@qq.com');
\`\`\``
    })

    const session = stopAiRecording()

    expect(session.actions[0]).toMatchObject({
      kind: "fill",
      target: "用户名 (支持自动补全)",
      locator: expect.objectContaining({
        role: "combobox",
        accessibleName: "用户名 (支持自动补全)"
      })
    })
    expect(session.script).toContain(
      "await page.getByRole('combobox', { name: '用户名 (支持自动补全)', exact: true }).fill('mktui');"
    )
    expect(session.script).toContain(
      "await page.getByRole('textbox', { name: '邮箱', exact: true }).fill('test@qq.com');"
    )
    expect(session.script).not.toContain("TODO_SELECTOR")
  })

  it("uses semantic role locators for clicked dropdown options", () => {
    startAiRecording({ threadId: "thread-1" })

    recordSuccessfulAiBrowserToolCall({
      toolName: "browser_snapshot",
      threadId: "thread-1",
      args: {},
      resultText: BRANCH_SNAPSHOT_RESULT
    })
    recordSuccessfulAiBrowserToolCall({
      toolName: "browser_click",
      threadId: "thread-1",
      args: { target: "e11", element: "分支选项 release" },
      resultText: `### Ran Playwright code
\`\`\`js
await page.getByText('分支选项 release', { exact: true }).click();
\`\`\``
    })

    const session = stopAiRecording()

    expect(session.actions).toHaveLength(1)
    expect(session.actions[0]).toMatchObject({
      kind: "click",
      target: "release",
      locator: expect.objectContaining({
        role: "option",
        accessibleName: "release"
      })
    })
    expect(session.script).toContain(
      "await page.getByRole('option', { name: 'release', exact: true }).click();"
    )
  })

  it("uses semantic role locators for menuitem radio options", () => {
    startAiRecording({ threadId: "thread-1" })

    recordSuccessfulAiBrowserToolCall({
      toolName: "browser_click",
      threadId: "thread-1",
      args: {
        role: "menuitemradio",
        element: "fix/bug-doc-qyang",
        ariaLabel: "fix/bug-doc-qyang",
        selector: 'button[name="branch"]'
      }
    })

    const session = stopAiRecording()

    expect(session.actions).toHaveLength(1)
    expect(session.actions[0]).toMatchObject({
      kind: "click",
      target: "fix/bug-doc-qyang",
      locator: expect.objectContaining({
        role: "menuitemradio",
        accessibleName: "fix/bug-doc-qyang"
      })
    })
    expect(session.script).toContain(
      "await page.getByRole('menuitemradio', { name: 'fix/bug-doc-qyang', exact: true }).click();"
    )
    expect(session.script).not.toContain('locator("button[name=\\"branch\\"]")')
  })

  it("records file chooser uploads and replays them after the triggering click", () => {
    startAiRecording({ threadId: "thread-1" })

    recordSuccessfulAiBrowserToolCall({
      toolName: "browser_click",
      threadId: "thread-1",
      args: { element: "Upload document button" }
    })
    recordSuccessfulAiBrowserToolCall({
      toolName: "browser_file_upload",
      threadId: "thread-1",
      args: { paths: ["/tmp/fixtures/contract.pdf"] },
      resultText: `### Ran Playwright code
\`\`\`js
await fileChooser.setFiles(["/tmp/fixtures/contract.pdf"]);
\`\`\``
    })

    const session = stopAiRecording()

    expect(session.actions).toHaveLength(2)
    expect(session.actions[1]).toMatchObject({
      kind: "fileUpload",
      paths: ["/tmp/fixtures/contract.pdf"]
    })
    expect(session.script).toContain(
      "await page.getByRole('button', { name: 'Upload document', exact: true }).click();"
    )
    expect(session.script).toContain(
      "await page.locator('input[type=file]').setInputFiles('/tmp/fixtures/contract.pdf');"
    )
    expect(session.script).not.toContain("TODO_FILE_INPUT_SELECTOR")
  })

  it("supports a variable for recorded file upload paths", () => {
    const script = generateAiRecordingScript(
      [
        {
          id: "upload-report",
          timestamp: "2026-07-31T00:00:00.000Z",
          kind: "fileUpload" as const,
          paths: ["/tmp/fixtures/report.csv"]
        }
      ],
      {
        variableActionIds: ["upload-report"],
        variableActionNames: { "upload-report": "上传文件路径" }
      }
    )

    expect(script).toContain('const 变量_上传文件路径 = ""; // 变量-上传文件路径')
    expect(script).toContain(
      'await page.locator("input[type=\\"file\\"]").setInputFiles(变量_上传文件路径);'
    )
  })

  it("ignores an immediately repeated browser_fill_form batch", () => {
    startAiRecording({ threadId: "thread-1" })

    const args = {
      fields: [
        { name: "Email input", type: "textbox", value: "test@qq.com" },
        { name: "Password input", type: "textbox", value: "123456" }
      ]
    }

    recordSuccessfulAiBrowserToolCall({
      toolName: "browser_fill_form",
      threadId: "thread-1",
      args
    })
    recordSuccessfulAiBrowserToolCall({
      toolName: "browser_fill_form",
      threadId: "thread-1",
      args
    })

    const session = stopAiRecording()

    expect(session.actions).toHaveLength(2)
    expect(session.script.match(/test@qq\.com/g)).toHaveLength(1)
    expect(session.script.match(/123456/g)).toHaveLength(1)
  })

  it("returns a placeholder script when no actions were captured", () => {
    const script = generateAiRecordingScript([])
    expect(script).toContain("No supported Playwright browser actions were recorded")
  })

  it("replaces marked fill values with semantic variables", () => {
    const actions = [
      {
        id: "fill-email",
        timestamp: "2026-07-30T00:00:00.000Z",
        kind: "fill" as const,
        target: "用户名输入框",
        value: "recorded@example.com",
        sensitive: false
      },
      {
        id: "fill-password",
        timestamp: "2026-07-30T00:00:01.000Z",
        kind: "fill" as const,
        target: "密码输入框",
        value: "123456",
        sensitive: true
      }
    ]

    const script = generateAiRecordingScript(actions, {
      variableActionIds: ["fill-email", "fill-password"],
      variableActionNames: {
        "fill-email": "用户名",
        "fill-password": "密码"
      }
    })

    expect(script).toContain('const 变量_用户名 = ""; // 变量-用户名')
    expect(script).toContain('const 变量_密码 = ""; // 变量-密码')
    expect(script).toContain(
      'await page.getByRole("textbox", { name: "用户名输入框", exact: true }).fill(变量_用户名);'
    )
    expect(script).toContain(
      'await page.getByRole("textbox", { name: "密码输入框", exact: true }).fill(变量_密码);'
    )
    expect(script).not.toContain("recorded@example.com")
    expect(extractAiRecordingVariableNames(script)).toEqual(["变量-用户名", "变量-密码"])
  })

  it("replaces click target text and clicked dropdown options with semantic variables", () => {
    const actions = [
      {
        id: "click-pipeline",
        timestamp: "2026-07-31T00:00:00.000Z",
        kind: "click" as const,
        target: "流水线 PL616946LF39.05_bcpcmktui_UAT_GCH（市场PC国产）",
        doubleClick: false,
        locator: {
          textContent: "流水线 PL616946LF39.05_bcpcmktui_UAT_GCH（市场PC国产）",
          textExact: true
        }
      },
      {
        id: "click-branch",
        timestamp: "2026-07-31T00:00:01.000Z",
        kind: "click" as const,
        target: "release",
        doubleClick: false,
        locator: {
          role: "option",
          accessibleName: "release"
        }
      }
    ]

    const script = generateAiRecordingScript(actions, {
      variableActionIds: ["click-pipeline", "click-branch"],
      variableActionNames: {
        "click-pipeline": "流水线名称",
        "click-branch": "分支名"
      }
    })

    expect(script).toContain('const 变量_流水线名称 = ""; // 变量-流水线名称')
    expect(script).toContain('const 变量_分支名 = ""; // 变量-分支名')
    expect(script).toContain("await page.getByText(变量_流水线名称, { exact: true }).click();")
    expect(script).toContain(
      'await page.getByRole("option", { name: 变量_分支名, exact: true }).click();'
    )
    expect(extractAiRecordingVariableNames(script)).toEqual(["变量-流水线名称", "变量-分支名"])
  })

  it("parses generated exact role locators with literal fill values back into recording actions", () => {
    const script = `import { test } from "@playwright/test";

test("manual recorded flow", async ({ page }) => {
  // Review generated locators before committing this test.
  await page.getByRole("textbox", { name: "密码", exact: true }).click();
  await page.getByRole("textbox", { name: "密码", exact: true }).fill("12345678");
  await page.getByRole("textbox", { name: "确认密码", exact: true }).fill("12345678");
});
`

    const parsed = parseAiRecordingScript(script, "manual")

    expect(parsed.actions).toEqual([
      expect.objectContaining({
        kind: "click",
        target: "密码",
        locator: expect.objectContaining({
          role: "textbox",
          accessibleName: "密码"
        })
      }),
      expect.objectContaining({
        kind: "fill",
        target: "密码",
        value: "12345678",
        sensitive: true,
        locator: expect.objectContaining({
          role: "textbox",
          accessibleName: "密码"
        })
      }),
      expect.objectContaining({
        kind: "fill",
        target: "确认密码",
        value: "12345678",
        sensitive: true,
        locator: expect.objectContaining({
          role: "textbox",
          accessibleName: "确认密码"
        })
      })
    ])
  })
})
