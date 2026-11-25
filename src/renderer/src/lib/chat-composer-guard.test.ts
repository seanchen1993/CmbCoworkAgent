import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import React from "react"
import { chatUploadLabel, MAX_ATTACHMENT_PICKER_FILES, MAX_ATTACHMENT_TOTAL_CHARS } from "../../../shared/file-attachment"
import { renderToStaticMarkup } from "react-dom/server"
import ts from "typescript"
import { describe, expect, it, vi } from "vitest"
import { runFrozenImageOutbox, imageDeliveryAction } from "./image-outbox"
import { canClaimQueuedMessage } from "./queued-message-content"

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => children,
  PopoverAnchor: ({ children }: { children: React.ReactNode }) => children,
  PopoverContent: () => null
}))
import { IconPopoverButton } from "../components/ui/icon-popover-button"

const source = ts.createSourceFile(
  "ChatContainer.tsx",
  readFileSync(resolve("src/renderer/src/components/chat/ChatContainer.tsx"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
)

it("delivers an already accepted image using the exact frozen model after the renderer catalogue changes", async () => {
  let submission: ts.Expression | undefined
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "submitQueuedMessage" &&
        node.initializer && ts.isCallExpression(node.initializer)) submission = node.initializer.arguments[0]
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!submission) throw new Error("Cannot find queue submission callback")
  const now = new Date()
  const frozen = { modelId: "old-A", mode: "workflow", message: "original prepared message" }
  const queued = { id: "queue-1", created_at: now, updated_at: now, text: "original", modelId: "old-A",
    botReplyTo: { role: "user" }, chatImages: [{ id: "image", filename: "x.png", slot: 0 }],
    imageDelivery: { workspacePath: "/work", incarnation: "inc", source: "", frozen } }
  let status = "accepted"
  const send = vi.fn(async () => { status = "succeeded" })
  const deleted = vi.fn()
  const bindings = { threadId: "thread", workspacePath: "/work", currentThread: {}, managedTurn: null,
    currentThreadIdRef: { current: "thread" }, chatViewMountedRef: { current: true }, readOnlyRef: { current: false },
    managedTurnRef: { current: null }, getQueuedMessage: () => queued, stream: { submit: send },
    window: { api: { file: { chatImageSubmissionStatus: async () => status } } }, canClaimQueuedMessage,
    threadDraftIncarnation: () => ({}), threadIncarnationKey: () => "inc", isSameGitWorkspacePath: (a: string, b: string) => a === b,
    imageDeliveryAction, runFrozenImageOutbox, deleteQueuedMessage: deleted, setActiveTurnStartTime: vi.fn(),
    clearFinishedWorkflowRun: vi.fn(), setError: vi.fn(), currentModel: "new-B", models: [{ id: "new-B", available: true }],
    revalidateOrdinaryBotReply: vi.fn(() => { throw new Error("Unexpected first-submit quote validation") }),
    loadResolvedAgentMode: vi.fn(() => { throw new Error("Unexpected mode hydration") }) }
  const script = ts.transpileModule("const submit = " + submission.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  const submit = new Function(...Object.keys(bindings), script + "\nreturn submit")(...Object.values(bindings))
  await submit(queued)
  expect(send).toHaveBeenCalledOnce()
  expect(send).toHaveBeenCalledWith({ messages: [{ type: "human", content: frozen.message }] },
    expect.objectContaining({ config: { configurable: { thread_id: "thread", hook_turn_id: queued.id,
      model_id: "old-A", agent_mode: "workflow", chat_images: queued.chatImages } } }))
  expect(bindings.revalidateOrdinaryBotReply).not.toHaveBeenCalled()
  expect(bindings.loadResolvedAgentMode).not.toHaveBeenCalled()
  expect(deleted).toHaveBeenCalledWith(queued.id)
})

// Render the production controls and their actual initializer dependencies, not a copy of
// the guard formula. Derived names and inline/parenthesized expressions are unrestricted.
// The rest of ChatContainer (streams, history, tools) is outside this composer contract.
function renderComposer(overrides: Record<string, unknown> = {}): string {
  const bindings: Record<string, unknown> = {
    React,
    chatUploadLabel,
    MAX_ATTACHMENT_PICKER_FILES,
    MAX_ATTACHMENT_TOTAL_CHARS,
    IconPopoverButton,
    Plus: () => null,
    useHarnessNotifications: () => [],
    threadId: "thread",
    managedTurn: undefined,
    botReplyActions: undefined,
    draftBotReplyTo: null,
    historyOnly: false,
    historyLoading: false,
    inputDisabled: false,
    composerControlsDisabled: false,
    contextReminderPending: false,
    readOnly: false,
    input: "",
    inputPlaceholder: "输入消息",
    inputRef: { current: null },
    promptHistory: { cancelPending: () => undefined },
    handleKeyDown: () => undefined,
    handleAttachClick: () => undefined,
    attachmentLoading: false,
    totalPendingFileCount: 0,
    totalPendingFileChars: 0,
    hasPendingFilePayload: false,
    composerRightClearanceClass: "",
    cn: (...values: unknown[]) => values.filter((value) => typeof value === "string").join(" "),
    ...overrides
  }
  const initializers = new Map<string, ts.Expression>()
  const controls: ts.JsxSelfClosingElement[] = []
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      initializers.set(node.name.text, node.initializer)
    }
    if (ts.isJsxSelfClosingElement(node)) {
      const text = node.getText(source)
      if (
        (node.tagName.getText(source) === "textarea" && text.includes("composer-textarea")) ||
        (node.tagName.getText(source) === "IconPopoverButton" &&
          text.includes('aria-label="添加文件"'))
      ) {
        controls.push(node)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (controls.length !== 2) throw new Error("Composer input/attachment control was not found")
  const declarations: string[] = []
  const included = new Set<string>(Object.keys(bindings))
  function dependencies(node: ts.Node): void {
    if (
      ts.isIdentifier(node) &&
      ((ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
        (ts.isPropertyAssignment(node.parent) && node.parent.name === node))
    )
      return
    if (ts.isIdentifier(node) && !included.has(node.text)) {
      const expression = initializers.get(node.text)
      if (expression) {
        included.add(node.text)
        dependencies(expression)
        declarations.push(`const ${node.text} = ${expression.getText(source)};`)
      }
    }
    ts.forEachChild(node, dependencies)
  }
  // Only eager JSX values need evaluating. Event-handler closures are not invoked by SSR.
  for (const control of controls) {
    for (const attribute of control.attributes.properties) {
      if (
        ts.isJsxAttribute(attribute) &&
        !attribute.name.getText(source).startsWith("on") &&
        attribute.initializer
      ) {
        dependencies(attribute.initializer)
      }
    }
  }
  const code = ts.transpileModule(
    `${declarations.join("\n")} return <>${controls.map((node) => node.getText(source)).join("\n")}</>;`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.React,
        module: ts.ModuleKind.None
      }
    }
  ).outputText
  function ComposerSlice(): React.ReactElement {
    return new Function(...Object.keys(bindings), code)(...Object.values(bindings))
  }
  return renderToStaticMarkup(React.createElement(ComposerSlice))
}

function expectAvailability(markup: string, blocked: boolean): void {
  const textarea = markup.match(/<textarea\b[^>]*>/u)?.[0]
  const attachment = markup.match(/<button\b[^>]*aria-label="添加文件"[^>]*>/u)?.[0]
  expect(textarea).toBeDefined()
  expect(attachment).toBeDefined()
  expect(/\sdisabled=""/u.test(textarea!)).toBe(blocked)
  expect(attachment).toContain(`aria-disabled="${blocked}"`)
}

describe("Chat composer rendered decision guards", () => {
  it("keeps the existing decision guards when a Bot adds its composer callbacks", () => {
    const managedTurn = { submitDraft: async () => {}, attachFiles: async () => {} }
    expectAvailability(renderComposer({ managedTurn }), false)
    expectAvailability(renderComposer({ managedTurn, historyLoading: true }), true)
    expectAvailability(renderComposer({ managedTurn, readOnly: true }), true)
    expectAvailability(renderComposer({ managedTurn, contextReminderPending: true }), true)
    const notifications = [{ type: "biz_retry", status: "pending", sourceThreadId: "thread" }]
    expectAvailability(
      renderComposer({ managedTurn, useHarnessNotifications: () => notifications }),
      true
    )
  })
  it("disables both controls for a pending Biz Retry and releases them when it disappears", () => {
    const notifications = [{ type: "biz_retry", status: "pending", sourceThreadId: "thread" }]
    expectAvailability(renderComposer({ useHarnessNotifications: () => notifications }), true)
    expectAvailability(renderComposer(), false)
  })

  it.each([
    { type: "biz_retry", status: "pending", sourceThreadId: "other-thread" },
    { type: "biz_retry", status: "resolved", sourceThreadId: "thread" },
    { type: "human_gate", status: "pending", sourceThreadId: "thread" }
  ])(
    "does not treat unrelated or completed notifications as a Biz Retry blocker: %j",
    (notification) => {
      expectAvailability(renderComposer({ useHarnessNotifications: () => [notification] }), false)
    }
  )

  it.each(["readOnly", "contextReminderPending"])("retains the independent %s guard", (guard) => {
    expectAvailability(renderComposer({ [guard]: true }), true)
  })

  it("retains the independent input and attachment runtime guards", () => {
    const input = renderComposer({ inputDisabled: true })
    expect(input.match(/<textarea\b[^>]*>/u)?.[0]).toContain('disabled=""')
    expect(input.match(/<button\b[^>]*aria-label="添加文件"[^>]*>/u)?.[0]).toContain(
      'aria-disabled="false"'
    )
    const controls = renderComposer({ composerControlsDisabled: true })
    expect(controls.match(/<textarea\b[^>]*>/u)?.[0]).not.toContain('disabled=""')
    expect(controls.match(/<button\b[^>]*aria-label="添加文件"[^>]*>/u)?.[0]).toContain(
      'aria-disabled="true"'
    )
  })
})
