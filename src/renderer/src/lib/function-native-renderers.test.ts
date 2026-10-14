import { createElement, isValidElement, type ComponentProps, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { ModObject } from "../../../shared/mods/types"
import type { Message, UserInputRequest } from "../types"

const host = vi.hoisted(() => ({
  safe: new Map<string, ModObject>(),
  trees: new Map<string, ReactNode>(),
  expectedRequests: [] as string[],
  wait: false,
  inactive: false,
  preview: vi.fn()
}))
vi.mock("../components/tabs/code-highlight-client", () => ({ requestCodeHighlight: vi.fn() }))
vi.mock("./thread-context", () => ({
  useThreadStateSelector: (
    _threadId: string | null,
    select: (state: { workspacePath: null; workspaceFiles: unknown[] }) => unknown
  ) => select({ workspacePath: null, workspaceFiles: [] })
}))
vi.mock("./resource-preview-events", () => ({
  beginOpenResourcePreviewIntent: () => 1,
  emitOpenResourcePreview: host.preview
}))
// The suite checks the original renderer factories with host-provided safe props.
// Actual main publication, engine resolution and first-frame blocking have separate tests.
vi.mock("../components/chat/FunctionSite", () => ({
  FunctionSite: (props: {
    component: string
    facts: ModObject
    fallback?: ReactNode
    expectedRequestId?: string
    renderNative?(safe: ModObject): ReactNode
  }) => {
    if (props.expectedRequestId) host.expectedRequests.push(props.expectedRequestId)
    const tree = host.wait
      ? null
      : host.inactive
        ? props.fallback
        : (props.renderNative?.(host.safe.get(props.component) ?? props.facts) ?? null)
    host.trees.set(props.component, tree)
    return createElement("section", { "data-native-owner": props.component }, tree)
  }
}))
import { FunctionToolGroup } from "../components/chat/FunctionToolGroup"
import { FunctionQuestionSite } from "../components/chat/FunctionQuestionSite"
import { MessageBubble } from "../components/chat/MessageBubble"
import { ToolCallRenderer } from "../components/chat/ToolCallRenderer"
import { UserInputRequestDialog } from "../components/chat/UserInputRequestDialog"
import { getWorkerToolUiKey } from "./worker-tool-result-key"

beforeEach(() => {
  host.safe.clear()
  host.trees.clear()
  host.expectedRequests.length = 0
  host.wait = false
  host.inactive = false
  host.preview.mockClear()
})
afterEach(() => vi.unstubAllGlobals())

it.each(["user", "assistant"] as const)(
  "renders protected %s text through the original rich/search renderer and keeps source",
  (role) => {
    const message: Message = {
      id: "original-id",
      role,
      content: "SECRET_BODY",
      created_at: new Date(1),
      ...(role === "user"
        ? {
            prompt_origin: { kind: "plugin", name: "original-component" }
          }
        : {})
    }
    const before = JSON.stringify(message)
    host.safe.set(role === "user" ? "UserMessage" : "AssistantMessage", {
      text: role === "user" ? "Safe user words" : "**Safe markdown**"
    })
    const html = renderToStaticMarkup(
      createElement(MessageBubble, {
        message,
        threadId: "thread",
        isLoading: false,
        isStreaming: false
      })
    )
    expect(html).not.toContain("SECRET_BODY")
    expect(html).toContain("data-chat-search-text")
    if (role === "assistant") expect(html).toContain("<strong>Safe markdown</strong>")
    else expect(html).toContain('data-plugin-prompt-source="original-component"')
    expect(JSON.stringify(message)).toBe(before)
  }
)

const call = {
  tool_use_id: "original-call",
  tool: "execute",
  input: { command: "SECRET_CMD" },
  output: "SECRET_OUTPUT",
  isRunning: false,
  isErrored: false,
  isInterrupted: false
}

it("renders one real ToolGroup at its native position and passes protected row data", () => {
  host.safe.set("ToolGroup", {
    calls: [{ ...call, input: { command: "Safe command" }, output: "Safe output" }],
    isActive: false,
    isExpanded: true
  })
  const children = vi.fn((expanded: boolean, calls?: ModObject[]) =>
    createElement("pre", {}, expanded ? JSON.stringify(calls) : "RAW_FALLBACK")
  )
  const props: ComponentProps<typeof FunctionToolGroup> = {
    threadId: "thread",
    calls: [call],
    blocked: false,
    isActive: false,
    children
  }
  const html = renderToStaticMarkup(createElement(FunctionToolGroup, props))
  expect(html).toContain("Safe command")
  expect(html).toContain("Safe output")
  expect(html).not.toContain("RAW_FALLBACK")
  expect(html).not.toContain("SECRET_")
  expect((html.match(/data-native-owner="ToolGroup"/g) ?? []).length).toBe(1)
})

it("rejects altered or malformed protected ToolGroup identity without adopting raw rows", () => {
  const children = vi.fn(() => createElement("pre", {}, "RAW_ROWS"))
  for (const calls of [[{ ...call, tool_use_id: "other-call" }], []]) {
    host.safe.set("ToolGroup", { calls, isActive: false, isExpanded: true })
    const props: ComponentProps<typeof FunctionToolGroup> = {
      threadId: "thread",
      calls: [call],
      blocked: false,
      isActive: false,
      children
    }
    const html = renderToStaticMarkup(createElement(FunctionToolGroup, props))
    expect(html).not.toContain("RAW_ROWS")
  }
  // The inactive fallback is built once per surface but never appears in an active frame.
  expect(children).toHaveBeenCalledTimes(2)
})

it("retains actual tool identity and preview authorization when a group masks the file path", async () => {
  const toolCall = {
    id: "original-file",
    name: "write_file",
    args: {
      file_path: "/actual/original.md",
      content: "SECRET_FILE"
    }
  }
  const message: Message = {
    id: "message",
    role: "assistant",
    content: "",
    created_at: new Date(1),
    tool_calls: [toolCall]
  }
  const key = getWorkerToolUiKey(message.id, toolCall.id, 0)
  host.safe.set("ToolGroup", {
    calls: [
      {
        ...call,
        tool_use_id: toolCall.id,
        tool: toolCall.name,
        input: { file_path: "/masked/safe.md", content: "Safe contents" },
        output: "Safe output"
      }
    ],
    isActive: false,
    isExpanded: true
  })
  const authorize = vi.fn(async () => ({ success: true, filePath: "/actual/original.md" }))
  vi.stubGlobal("window", { api: { workspace: { authorizeToolFilePreview: authorize } } })
  const html = renderToStaticMarkup(
    createElement(MessageBubble, {
      message,
      threadId: "thread",
      isLoading: false,
      isStreaming: false,
      toolResults: new Map([[key, { content: "SECRET_RESULT" }]])
    })
  )
  expect(html).toContain("safe.md")
  expect(html).not.toContain("original.md")
  expect(html).not.toContain("SECRET_")
  const findPreview = (node: ReactNode): (() => void) | undefined => {
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = findPreview(child)
        if (found) return found
      }
    } else if (isValidElement<Record<string, unknown>>(node)) {
      if (node.props["aria-label"] === "在右侧资源预览中打开")
        return () =>
          (node.props.onClick as (event: { stopPropagation(): void }) => void)({
            stopPropagation: () => {}
          })
      return findPreview(node.props.children as ReactNode)
    }
    return undefined
  }
  const preview = findPreview(host.trees.get("ToolGroup"))
  expect(preview).toBeTypeOf("function")
  preview?.()
  await vi.waitFor(() => expect(host.preview).toHaveBeenCalled())
  expect(authorize).toHaveBeenCalledTimes(1)
  expect(authorize).toHaveBeenCalledWith({ threadId: "thread", toolCallId: toolCall.id })
  expect(host.preview).toHaveBeenCalledWith(
    expect.objectContaining({
      filePath: "/actual/original.md",
      toolCallId: toolCall.id
    })
  )
  expect(toolCall.args.file_path).toBe("/actual/original.md")
})

it("keeps pending approval on the original arguments and decision controls", () => {
  host.safe.set("ToolUse", { input: { command: "FORGED_COMMAND" } })
  const html = renderToStaticMarkup(
    createElement(ToolCallRenderer, {
      threadId: "thread",
      toolCall: { id: "approval", name: "execute", args: { command: "Original approval" } },
      status: "awaiting_approval",
      needsApproval: true,
      onApprovalDecision: () => {},
      presentation: { input: { command: "FORGED_COMMAND" } }
    })
  )
  expect(html).toContain("Original approval")
  expect(html).toContain("本会话允许")
  expect(html).not.toContain("FORGED_COMMAND")
  expect(html).not.toContain("data-native-owner")
})

it("does not restore original formatter values when a protected tool field is omitted", () => {
  host.safe.set("ToolUse", {})
  host.safe.set("ToolResult", {})
  renderToStaticMarkup(
    createElement(ToolCallRenderer, {
      threadId: "thread",
      toolCall: { id: "command", name: "execute", args: { command: "SECRET_COMMAND" } },
      result: "SECRET_OUTPUT",
      status: "completed"
    })
  )
  for (const component of ["ToolUse", "ToolResult"]) {
    expect(host.trees.has(component)).toBe(true)
    expect(renderToStaticMarkup(host.trees.get(component))).not.toContain("SECRET_")
  }
})

it("opens Mods-expanded tool details once using safe fields while direct tools keep their default", () => {
  host.safe.set("ToolUse", { input: { label: "SAFE_EXPANDED_INPUT" } })
  host.safe.set("ToolResult", { output: "SAFE_EXPANDED_OUTPUT" })
  const props = {
    threadId: "thread",
    toolCall: { id: "read", name: "read_file", args: { file_path: "SECRET_PATH" } },
    result: "SECRET_RESULT",
    status: "completed" as const
  }
  const ordinary = renderToStaticMarkup(createElement(ToolCallRenderer, props))
  expect(ordinary).not.toContain("RAW ARGUMENTS")
  const expanded = renderToStaticMarkup(
    createElement(ToolCallRenderer, {
      ...props,
      initialExpanded: true
    })
  )
  expect(expanded).toContain("RAW ARGUMENTS")
  expect(expanded).toContain("SAFE_EXPANDED_INPUT")
  expect(expanded).toContain("SAFE_EXPANDED_OUTPUT")
  for (const component of ["ToolUse", "ToolResult"])
    expect(renderToStaticMarkup(host.trees.get(component))).not.toContain("SECRET_")
  // The original header remains outside the detail hook and still names the actual file.
  expect(expanded).toContain("SECRET_PATH")
})

const request: UserInputRequest = {
  requestId: "request-one",
  threadId: "thread",
  createdAt: "2026-10-04",
  questions: [
    {
      id: "question_one",
      header: "Raw header",
      question: "SECRET_QUESTION",
      options: [
        { label: "Keep", description: "SECRET_DESCRIPTION" },
        { label: "Change", description: "Original other description" }
      ]
    }
  ]
}

it("places the original radio/custom/navigation/submit controls only inside the protected Ask slot", () => {
  host.safe.set("AskUserQuestion", {
    tool: "request_user_input",
    questions: [
      {
        ...request.questions[0],
        header: "Safe header",
        question: "Safe question",
        options: request.questions[0].options.map((option) => ({
          ...option,
          description: "Safe description"
        }))
      }
    ]
  })
  const html = renderToStaticMarkup(
    createElement(UserInputRequestDialog, { request, onSubmit: () => {} })
  )
  expect(html).toContain("Safe question")
  expect(html).not.toContain("SECRET_")
  expect(html).not.toContain("Raw header")
  expect((html.match(/role="radiogroup"/g) ?? []).length).toBe(1)
  expect((html.match(/aria-label="自定义回答"/g) ?? []).length).toBe(1)
  expect((html.match(/跳过全部问题/g) ?? []).length).toBe(1)
  expect(html).toContain("问题导航")
  expect(host.expectedRequests).toEqual([request.requestId])
  expect(renderToStaticMarkup(host.trees.get("AskUserQuestion"))).toContain("跳过全部问题")
  const nativeBlock = host.trees.get("AskUserQuestion")
  expect(isValidElement(nativeBlock) && nativeBlock.type).toBe("div")
  if (isValidElement<{ className: string; children: ReactNode }>(nativeBlock))
    expect(nativeBlock.props.className).toContain("flex-col")
})

it("does not expose controls outside a waiting Ask frame and rejects a changed answer identity", () => {
  host.wait = true
  const waiting = renderToStaticMarkup(
    createElement(UserInputRequestDialog, { request, onSubmit: () => {} })
  )
  expect(waiting).not.toContain("SECRET_QUESTION")
  expect(waiting).not.toContain("跳过全部问题")
  host.wait = false
  host.safe.set("AskUserQuestion", {
    questions: [
      {
        id: "other_question",
        header: request.questions[0].header,
        question: request.questions[0].question,
        options: request.questions[0].options.map(({ label, description }) => ({
          label,
          description
        }))
      }
    ]
  })
  const renderer = vi.fn(() => createElement("button", {}, "FORGED_CONTROLS"))
  const html = renderToStaticMarkup(
    createElement(FunctionQuestionSite, { request, renderQuestions: renderer })
  )
  // Building the inactive fallback is harmless; it was never adopted into this active frame.
  expect(renderer).toHaveBeenCalledOnce()
  expect(html).not.toContain("FORGED_CONTROLS")
  expect(host.expectedRequests.at(-1)).toBe("request-one")
})

it("keeps ordinary question controls on an explicitly inactive host", () => {
  host.inactive = true
  const html = renderToStaticMarkup(
    createElement(UserInputRequestDialog, { request, onSubmit: () => {} })
  )
  expect(html).toContain("SECRET_QUESTION")
  expect(html).toContain("跳过全部问题")
  expect((html.match(/role="radiogroup"/g) ?? []).length).toBe(1)
})

it("keeps old question callbacks bound to R1 when R2 reuses the same question identity", () => {
  const submit = vi.fn()
  renderToStaticMarkup(createElement(UserInputRequestDialog, { request, onSubmit: submit }))
  const oldTree = host.trees.get("AskUserQuestion")
  const replacement = { ...request, requestId: "request-two" }
  renderToStaticMarkup(
    createElement(UserInputRequestDialog, {
      request: replacement,
      onSubmit: submit
    })
  )
  const findIgnore = (node: ReactNode): (() => void) | undefined => {
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = findIgnore(child)
        if (found) return found
      }
    } else if (isValidElement<Record<string, unknown>>(node)) {
      if (node.props.children === "跳过全部问题") return node.props.onClick as () => void
      return findIgnore(node.props.children as ReactNode)
    }
    return undefined
  }
  findIgnore(oldTree)?.()
  findIgnore(host.trees.get("AskUserQuestion"))?.()
  expect(submit.mock.calls.map(([response]) => response.requestId)).toEqual([
    "request-one",
    "request-two"
  ])
  expect(host.expectedRequests).toEqual(["request-one", "request-two"])
})
