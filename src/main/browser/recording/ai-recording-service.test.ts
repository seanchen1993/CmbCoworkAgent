import { beforeEach, describe, expect, it } from "vitest"
import {
  generateAiRecordingScript,
  getAiRecording,
  recordSuccessfulAiBrowserToolCall,
  resetAiRecordingForTests,
  startAiRecording,
  stopAiRecording
} from "./ai-recording-service"

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
      threadId: "thread-1",
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
      value: "",
      sensitive: true
    })
    expect(session.script).toContain('await page.goto("https://example.com/login");')
    expect(session.script).toContain('await page.getByRole("button", { name: "Login" }).click();')
    expect(session.script).toContain('await page.getByRole("textbox", { name: "Email" }).fill("final@example.com");')
    expect(session.script).toContain('process.env.PLAYWRIGHT_TEST_PASSWORD ?? ""')
    expect(session.script).not.toContain("super-secret")
  })

  it("ignores unsupported tools and calls from other threads", () => {
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
    expect(session.actions).toHaveLength(0)
  })

  it("prevents another thread from taking over an active recording session", () => {
    startAiRecording({ threadId: "thread-a" })

    expect(() => startAiRecording({ threadId: "thread-b" })).toThrow(
      "已有其他任务正在进行 AI 录制，请先停止当前录制。"
    )
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
      'await page.getByText("Actions tab in repository navigation", { exact: true }).click();'
    )
    expect(session.script.match(/Actions tab in repository navigation/g)).toHaveLength(1)
    expect(session.script.match(/Branch selector/g)).toHaveLength(1)
    expect(session.script).toContain(
      'await page.getByRole("textbox", { name: "Search" }).press("Enter");'
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
      value: "",
      sensitive: true
    })
    expect(session.script).toContain(
      'await page.getByRole("textbox", { name: "Username" }).fill("john.doe");'
    )
    expect(session.script).toContain(
      'await page.getByRole("textbox", { name: "Email" }).fill("john@example.com");'
    )
    expect(session.script).toContain(
      'await page.getByRole("textbox", { name: "Password" }).fill(process.env.PLAYWRIGHT_TEST_PASSWORD ?? "");'
    )
    expect(session.script).not.toContain("my-secret")
  })

  it("returns a placeholder script when no actions were captured", () => {
    const script = generateAiRecordingScript([])
    expect(script).toContain("No supported Playwright browser actions were recorded")
  })
})
