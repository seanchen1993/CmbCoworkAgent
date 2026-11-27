import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import React from "react"
import { chatUploadLabel, MAX_ATTACHMENT_PICKER_FILES, MAX_ATTACHMENT_TOTAL_CHARS } from "../../../shared/file-attachment"
import { renderToStaticMarkup } from "react-dom/server"
import ts from "typescript"
import { describe, expect, it, vi } from "vitest"
import { runFrozenImageOutbox, imageDeliveryAction, isActiveImageReceipt } from "./image-outbox"
import { canClaimQueuedMessage } from "./queued-message-content"
import { appendBtwReferences, readBtwReferences } from "../../../shared/btw-references"
import { BUILTIN_BROWSER_COMMAND } from "../features/builtin-browser/builtin-browser"
import {
  BTW_SLASH_COMMANDS,
  GENERAL_SLASH_COMMANDS,
  buildSlashPopoverMode
} from "../features/slash-commands/useSlashCommands"
import {
  hasImageGenerationComposer,
  imageGenerationCommand
} from "../features/slash-commands/image-generation-command"

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

it.each([
  ["accepted", "old-A"],
  ["missing", "new-B"]
])("uses the correct frozen image model when its receipt is %s and the catalogue changes", async (initialStatus, modelId) => {
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
  let status = initialStatus
  let current = queued
  const send = vi.fn(async () => { status = "succeeded" })
  const deleted = vi.fn()
  const bindings = { threadId: "thread", workspacePath: "/work", currentThread: {}, managedTurn: null,
    isBtwSubmissionBlocked: () => false,
    currentThreadIdRef: { current: "thread" }, chatViewMountedRef: { current: true }, readOnlyRef: { current: false },
    managedTurnRef: { current: null }, getQueuedMessage: () => current, stream: { submit: send },
    workspacePathRef: { current: "/work" },
    useAppStore: { getState: () => ({ threads: [{ thread_id: "thread" }] }) },
    window: { api: { file: { chatImageSubmissionStatus: async () => status, updateImageOwners: vi.fn() } } },
    updateQueuedMessage: (_id: string, edits: Partial<typeof queued>, callback: (error: null) => void) => {
      current = { ...current, ...edits }
      callback(null)
    }, canClaimQueuedMessage,
    threadDraftIncarnation: () => ({}), threadIncarnationKey: () => "inc", isSameGitWorkspacePath: (a: string, b: string) => a === b,
    imageDeliveryAction, runFrozenImageOutbox, deleteQueuedMessage: deleted, setActiveTurnStartTime: vi.fn(),
    imageSendPhases: new Map(), editingImageIds: new Set(), setQueuePumpTick: vi.fn(),
    isActiveImageReceipt, setObservedImageReceipt: vi.fn(), setImageQueueError: vi.fn(),
    clearFinishedWorkflowRun: vi.fn(), setError: vi.fn(), currentModel: "new-B", models: [{ id: "new-B", available: true, inputModalities: ["text", "image"] }],
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
      model_id: modelId, agent_mode: "workflow", chat_images: queued.chatImages } } }))
  expect(bindings.revalidateOrdinaryBotReply).not.toHaveBeenCalled()
  expect(bindings.loadResolvedAgentMode).not.toHaveBeenCalled()
  expect(deleted).toHaveBeenCalledWith(queued.id)
})

function bindQueuedEdit(text: string, sideComposer = true) {
  const declarations: string[] = []
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (node.name.text === "MAX_INPUT_CHARS") declarations.push(`const ${node.getText(source)};`)
      if (["startEditingQueuedMessage", "saveEditingQueuedMessage"].includes(node.name.text) &&
          ts.isCallExpression(node.initializer)) {
        declarations.push(`const ${node.name.text} = ${node.initializer.arguments[0].getText(source)};`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  const code = ts.transpileModule(`
    const message = { id: "queued", text };
    const getQueuedMessage = () => message;
    const managedTurn = undefined;
    const guidingQueuedMessageIdsRef = { current: new Set() };
    let editingQueueId = null;
    let editingQueueText = "";
    const setEditingQueueId = id => { editingQueueId = id; };
    const setEditingQueueText = value => { editingQueueText = value; };
    ${declarations.join("\n")}
    return {
      open: () => { startEditingQueuedMessage(message); return editingQueueText; },
      save: saveEditingQueuedMessage,
      setText: setEditingQueueText
    };
  `, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const updateQueuedMessage = vi.fn()
  const toast = { error: vi.fn() }
  const edit = new Function("text", "sideComposer", "appendBtwReferences", "readBtwReferences", "updateQueuedMessage", "toast", code)
  return { ...edit(text, sideComposer, appendBtwReferences, readBtwReferences, updateQueuedMessage, toast), updateQueuedMessage, toast }
}

describe("queued auxiliary edits", () => {
  it("validates the body separately and preserves long references on save", async () => {
    const body = "问".repeat(12000)
    const refs = [{ text: "甲".repeat(7000) }, { text: "乙".repeat(7000) }]
    const encoded = appendBtwReferences(body, refs)
    expect(encoded.length).toBeGreaterThan(24000)
    const edit = bindQueuedEdit(encoded)
    expect(edit.open()).toBe(body)
    edit.setText("问".repeat(24001))
    await edit.save()
    expect(edit.toast.error).toHaveBeenCalledOnce()
    expect(edit.updateQueuedMessage).not.toHaveBeenCalled()
    edit.setText(body)
    await edit.save()
    expect(edit.updateQueuedMessage).toHaveBeenLastCalledWith("queued", { text: encoded })
    edit.open()
    edit.setText("改问这一句")
    await edit.save()
    expect(edit.updateQueuedMessage).toHaveBeenLastCalledWith("queued", { text: appendBtwReferences("改问这一句", refs) })
  })

  it("saves a reference-only side draft and leaves the ordinary editor unchanged", async () => {
    const encoded = appendBtwReferences("", [{ text: "引用" }])
    const side = bindQueuedEdit(encoded)
    expect(side.open()).toBe("")
    await side.save()
    expect(side.updateQueuedMessage).toHaveBeenCalledWith("queued", { text: encoded })

    const main = bindQueuedEdit(encoded, false)
    expect(main.open()).toBe(encoded)
    main.setText("更新正文")
    await main.save()
    expect(main.updateQueuedMessage).toHaveBeenCalledWith("queued", { text: "更新正文" })
  })
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
    surface: "default",
    managedTurn: undefined,
    botReplyActions: undefined,
    draftBotReplyTo: null,
    historyOnly: false,
    historyLoading: false,
    historyRestorationFailed: false,
    historyRestorationPending: false,
    inputDisabled: false,
    composerControlsDisabled: false,
    firstSideQuestionPending: false,
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

function bindSideSubmit(overrides: Record<string, unknown>, route: Record<string, unknown> = {}) {
  const openSideQuestion = vi.fn()
  const error = vi.fn()
  const bindings = {
    input: "/btw What changed?",
    surface: "default",
    desktopBtw: true,
    workspacePath: "/project",
    workspaceFiles: [],
    loadMoreWorkspaceMentionFiles: vi.fn(),
    inputCaret: 0,
    hasPendingFilePayload: false,
    selectedSkill: null,
    selectedBuiltinBrowser: false,
    draftBotReplyTo: null,
    managedTurn: undefined,
    managedTurnRef: { current: undefined },
    attachments: [],
    ordinaryUploadPending: { current: null },
    uploadDraft: {},
    restoredBotDraft: null,
    restoredBotDraftError: null,
    readOnly: false,
    composerReadOnly: false,
    historyLoading: false,
    contextReminderPending: false,
    bizRetryPending: false,
    sideReferences: [],
    sideRestoring: false,
    sideSlash: null,
    threadId: "thread",
    useAppStore: (select: (state: Record<string, unknown>) => unknown) =>
      select({ mainView: "thread", currentThreadId: "thread", ...route }),
    promptHistory: { browsing: false },
    enabledSkillsForSlash: [],
    useSlashCommands: (params: Parameters<typeof buildSlashPopoverMode>[0]) => ({ mode: buildSlashPopoverMode(params) }),
    useAtFileMentions: (params: { disabled: boolean }) => params,
    BUILTIN_BROWSER_COMMAND,
    BTW_SLASH_COMMANDS,
    GENERAL_SLASH_COMMANDS,
    hasImageGenerationComposer,
    imageGenerationCommand,
    supportsImageGeneration: true,
    currentThread: { metadata: {} },
    useImageGenerationAvailability: (enabled: boolean) =>
      enabled ? { available: true } : undefined,
    isBtwSubmissionBlocked: () => false,
    getSideQuestion: () => undefined,
    liveSubmitPreparingThreads: new Set<string>(),
    openSideQuestion,
    setError: error,
    ...overrides
  }
  const predicateNames = [
    "SIDE_COMPOSER_SLASH_COMMANDS",
    "sideComposer",
    "activeOrdinaryComposer",
    "sideEntryAvailable",
    "btwAvailable",
    "isBtwInput",
    "imageAvailability",
    "generalCommands",
    "slash",
    "allowWorkspaceImages",
    "atFileMentions"
  ]
  const predicates: string[] = []
  let submit: ts.ArrowFunction | undefined
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (predicateNames.includes(node.name.text)) predicates.push(`const ${node.getText(source)};`)
      if (node.name.text === "handleSubmit" && node.initializer && ts.isArrowFunction(node.initializer)) {
        submit = node.initializer
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!submit || !ts.isBlock(submit.body)) throw new Error("Composer submit handler was not found")
  const parentStart = submit.body.statements.findIndex(statement => statement.getText(source).startsWith("const submittedHistoryWorkspace"))
  if (parentStart < 0) throw new Error("Ordinary submission boundary was not found")
  const routing = submit.body.statements.slice(0, parentStart).map(statement => statement.getText(source))
  const evaluate = new Function(...Object.keys(bindings), `
    ${predicates.join("\n")}
    return { sideEntryAvailable, isBtwInput, slashMode: slash.mode, mentionPickerDisabled: atFileMentions.disabled, submit: async (e, defaultText = "") => {
      ${routing.join("\n")}
      return "parent";
    } };
  `)
  return { ...evaluate(...Object.values(bindings)), openSideQuestion, error }
}

function bindSideReceipt() {
  const declarations = new Map<string, string>()
  let send = ""
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
        ["clearSubmittedReply", "clearClaimedDraft", "sidePromptAccepted"].includes(node.name.text)) {
      declarations.set(node.name.text, node.parent.parent.getText(source))
    }
    if (ts.isTryStatement(node) && node.tryBlock.statements.some(statement =>
      statement.getText(source).startsWith("history?.preview()"))) send = node.getText(source)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!send || declarations.size !== 3) throw new Error("Composer receipt handler was not found")
  const input = "发送的草稿"
  const submittedReference = { text: "已经发送的引用" }
  const references = [submittedReference]
  const clearBtwReferences = vi.fn((_threadId, consumed: typeof references) => {
    for (const ref of consumed) references.splice(references.indexOf(ref), 1)
  })
  const claimedAttachments = [{ path: "/project/a.png" }]
  const claimedMentionedFiles = [{ path: "/project/a.ts" }]
  const draft = { draftInput: input, workspacePath: "/project",
    draftAttachments: claimedAttachments, draftMentionedWorkspaceFiles: claimedMentionedFiles }
  const setInput = vi.fn((value: string) => { draft.draftInput = value })
  const confirmBtwMessageDurable = vi.fn<(_threadId: string, _messageId: string) => Promise<boolean | undefined>>()
  const stream = { submit: vi.fn<(_value: unknown, options: {
    onPromptAccepted: (workspace: string) => void
    config: { configurable: { hook_turn_id: string } }
  }) => Promise<void>>() }
  const isBtwSubmissionBlocked = vi.fn(() => false)
  const appendVisibleUserMessageWithTime = vi.fn()
  const history = { preview: vi.fn(), accept: vi.fn(), discard: vi.fn() }
  const setError = vi.fn()
  const bindings = {
    input,
    sideComposer: true,
    sideUserMessageId: "message-id",
    defaultText: "",
    threadId: "side-id",
    submitsSideReferences: true,
    sideReferences: [submittedReference],
    clearBtwReferences,
    claimedReply: null,
    threadContext: { getThreadState: () => draft },
    trimmedInput: input,
    managedTurn: undefined,
    keepImageDraft: false,
    composedDraft: {},
    claimedAttachments,
    claimedMentionedFiles,
    setAttachments: (files: typeof claimedAttachments) => { draft.draftAttachments = files },
    setMentionedFiles: (files: typeof claimedMentionedFiles) => { draft.draftMentionedWorkspaceFiles = files },
    selectedSkill: null,
    browser: false,
    setInput,
    stream,
    confirmBtwMessageDurable,
    isBtwSubmissionBlocked,
    appendVisibleUserMessageWithTime,
    displayContent: input,
    fullMessage: input,
    hookTurnId: "message-id",
    currentModel: "model-id",
    submitAgentMode: "normal",
    liveSubmitPreparingThreads: new Set(["side-id"]),
    setActiveTurnStartTime: vi.fn(),
    submittedHistoryWorkspace: draft.workspacePath,
    isSameGitWorkspacePath: (left: string, right: string) => left === right,
    setError,
    history
  }
  const code = `return async () => { ${[...declarations.values()].join("\n")}\n${send} }`
  const submit = new Function(...Object.keys(bindings), code)(...Object.values(bindings)) as () => Promise<void>
  return { ...bindings, submit, draft, references }
}

function bindQueuedReceipt(sideComposer = true) {
  let submit = ""
  let recovery = ""
  let pump = ""
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (node.name.text === "submitQueuedMessage" && ts.isCallExpression(node.initializer)) {
        const callback = node.initializer.arguments[0]
        if (ts.isArrowFunction(callback) && ts.isBlock(callback.body)) {
          const start = callback.body.statements.findIndex(statement => statement.getText(source).startsWith("const startTime ="))
          if (start >= 0) submit = callback.body.statements.slice(start).map(statement => statement.getText(source)).join("\n")
        }
      }
      if (node.name.text === "recoverQueuedSubmission") recovery = node.parent.parent.getText(source)
    }
    if (ts.isExpressionStatement(node) && node.getText(source).startsWith("submitQueuedMessage(next)")) pump = node.getText(source)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!submit || !recovery || !pump) throw new Error("Queue receipt handler was not found")
  const state = { error: null as string | null, queueAutoDrainSuppressed: false }
  const next = { id: "queued-id", modelId: "model-id" }
  const reconcile = vi.fn<typeof window.api.agent.reconcileCurrentRunQueuedMessages>().mockResolvedValue({
    durableIds: [], pendingIds: [], injectedIds: []
  })
  const bindings = {
    next,
    sideComposer,
    threadId: "side-id",
    stream: { submit: vi.fn<(_value: unknown, options: { onPromptAccepted?: () => void }) => Promise<void>>().mockResolvedValue(undefined) },
    window: { api: { agent: { reconcileCurrentRunQueuedMessages: reconcile } } },
    console: { warn: vi.fn() },
    threadContext: { getThreadState: () => state },
    isBtwSubmissionBlocked: vi.fn(() => false),
    setError: vi.fn(),
    fullMessage: "排队消息",
    currentModel: next.modelId,
    queuedModelId: next.modelId,
    submitAgentMode: "normal",
    queued: next,
    draftForSubmission: next,
    imageSendPhases: new Map(),
    models: [{ id: next.modelId, available: true }],
    setActiveTurnStartTime: vi.fn(),
    clearFinishedWorkflowRun: vi.fn(),
    removeLocalMessage: vi.fn(),
    prependQueuedMessage: vi.fn(),
    submitInFlightRef: { current: new Set(["side-id"]) },
    releaseSubmitInFlightLock: vi.fn()
  }
  const code = ts.transpileModule(`
    const submitQueuedMessage = async () => { ${submit} };
    ${recovery}
    return () => ${pump};
  `, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const drain = new Function(...Object.keys(bindings), code)(...Object.values(bindings)) as () => Promise<void>
  return { ...bindings, drain, reconcile, state }
}

describe("Chat composer rendered decision guards", () => {
  it("offers the host's image command only in eligible local foreground composers", () => {
    const input = "/生成图片"
    const commandIds = (props: Record<string, unknown>) =>
      bindSideSubmit({ input, ...props }).slashMode.commands?.map(
        (item: { id: string }) => item.id
      ) ?? []
    expect(commandIds({})).toContain("generate-image")
    expect(
      commandIds({ surface: "bot", managedTurn: { supportsImageGeneration: true } })
    ).toContain("generate-image")
    for (const props of [
      { surface: "harness-project" },
      { currentThread: { metadata: { scheduledTaskId: "s" } } },
      { surface: "bot", managedTurn: { supportsImageGeneration: false } },
      { composerReadOnly: true }
    ]) {
      expect(commandIds(props)).not.toContain("generate-image")
    }
    const menu = bindSideSubmit({
      input,
      useImageGenerationAvailability: () => ({ available: false, reason: "尚未配置生图服务" })
    }).slashMode
    expect(menu.commands).toMatchObject([
      { id: "generate-image", disabledReason: "尚未配置生图服务" }
    ])
  })
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

  it("keeps the main attachment picker available for images when the text budget is exhausted", () => {
    const budget = { totalPendingFileChars: MAX_ATTACHMENT_TOTAL_CHARS }
    expectAvailability(renderComposer(budget), false)

    const sideMarkup = renderComposer({ ...budget, surface: "btw" })
    expect(sideMarkup.match(/<button\b[^>]*aria-label="添加文件"[^>]*>/u)?.[0])
      .toContain('aria-disabled="true"')
  })

  it("waits for the first auxiliary question to be accepted before enabling the composer", () => {
    expectAvailability(renderComposer({ surface: "btw", firstSideQuestionPending: true }), true)
    expectAvailability(renderComposer({ surface: "btw" }), false)
  })

  it.each(["historyRestorationFailed", "historyRestorationPending"])("locks a side composer until recovery completes: %s", flag => {
    expectAvailability(renderComposer({ surface: "btw", [flag]: true }), true)
    expectAvailability(renderComposer({ [flag]: true }), false)
  })

  it.each([
    { hasPendingFilePayload: true },
    { selectedSkill: { name: "review" } },
    { selectedBuiltinBrowser: true },
    { draftBotReplyTo: {} },
    { desktopBtw: false },
    { surface: "harness-project" },
    { managedTurn: { ownerConversation: true } },
    { workspacePath: null }
  ])("keeps text and its existing payload on the original route when auxiliary entry is unavailable: %j", async overrides => {
    const { isBtwInput, slashMode, submit, openSideQuestion, error } = bindSideSubmit(overrides)
    expect(isBtwInput).toBe(false)
    expect(slashMode.kind).toBe("closed")
    expect(await submit({ preventDefault: vi.fn() })).toBe("parent")
    expect(openSideQuestion).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it.each([{ desktopBtw: false }, { hasPendingFilePayload: true }])(
    "retains an existing /side skill when auxiliary entry is unavailable: %j",
    overrides => {
      const skill = { name: "side", source: "project", path: "/project/side/SKILL.md" }
      const parent = bindSideSubmit({ ...overrides, input: "/side", enabledSkillsForSlash: [skill] })
      expect(parent.isBtwInput).toBe(false)
      expect(parent.slashMode).toMatchObject({ kind: "slash", commands: [], skills: [skill] })
    }
  )

  it.each([
    "/btw 请读 @notes.txt 后回答",
    '/side Check @"release notes.md"',
    "/btw Compare @Makefile and the current build",
    "/btw How do I use @types/node?"
  ])("routes plain side questions to workspace file validation: %s", async input => {
    const { submit, openSideQuestion, error, mentionPickerDisabled } = bindSideSubmit({ input })
    expect(mentionPickerDisabled).toBe(true)
    expect(bindSideSubmit({ input, desktopBtw: false }).mentionPickerDisabled).toBe(false)
    await submit({ preventDefault: vi.fn() })
    expect(openSideQuestion).toHaveBeenCalledExactlyOnceWith(input.slice(input.indexOf(" ") + 1))
    expect(error).not.toHaveBeenCalled()
  })

  it("treats an email address in a side question as plain text", async () => {
    const side = bindSideSubmit({ input: "/btw Ask name@example.com for the report" })
    await side.submit({ preventDefault: vi.fn() })
    expect(side.openSideQuestion).toHaveBeenCalledExactlyOnceWith("Ask name@example.com for the report")
    expect(side.error).not.toHaveBeenCalled()
  })

  it("opens an eligible side command and leaves ordinary prompts on the parent submit path", async () => {
    const side = bindSideSubmit({ input: "/side What changed?" })
    expect(side.isBtwInput).toBe(true)
    expect(await side.submit({ preventDefault: vi.fn() })).toBeUndefined()
    expect(side.openSideQuestion).toHaveBeenCalledExactlyOnceWith("What changed?")
    expect(bindSideSubmit({ input: "/btw" }).slashMode).toMatchObject({
      kind: "slash", commands: [{ id: "btw" }]
    })
    for (const input of ["What changed?", "/goal status"]) {
      const parent = bindSideSubmit({ input })
      expect(parent.isBtwInput).toBe(false)
      expect(await parent.submit({ preventDefault: vi.fn() })).toBe("parent")
      expect(parent.error).not.toHaveBeenCalled()
    }
    expect(await side.submit({ preventDefault: vi.fn() }, "Suggested prompt")).toBe("parent")
    expect(side.openSideQuestion).toHaveBeenCalledOnce()
  })

  it.each(["workerFocusView", "subagentFocusView", "workflowAgentFocusView"])(
    "keeps auxiliary actions out of the active parent focus split: %s",
    async (focusView) => {
      const focused = { [focusView]: { threadId: "thread" } }
      const side = bindSideSubmit({}, focused)
      expect(side.sideEntryAvailable).toBe(false)
      expect(side.isBtwInput).toBe(false)
      expect(await side.submit({ preventDefault: vi.fn() })).toBe("parent")
      expect(side.openSideQuestion).not.toHaveBeenCalled()
      expect(side.error).not.toHaveBeenCalled()
      const other = bindSideSubmit({}, { [focusView]: { threadId: "another-thread" } })
      expect(other.sideEntryAvailable).toBe(true)
    }
  )

  it.each([{ currentThreadId: "another-thread" }, { mainView: "dashboard" }, { showCustomizeView: true }])(
    "only offers auxiliary chat for the active thread route: %j", route => {
      const parent = bindSideSubmit({ input: "/" }, route)
      expect(parent.sideEntryAvailable).toBe(false)
      expect(parent.slashMode).toMatchObject({
        kind: "slash", commands: [{ id: "goal" }, { id: BUILTIN_BROWSER_COMMAND.id }]
      })
    }
  )

  it("blocks a stale side submit handler as soon as closing begins", async () => {
    const side = bindSideSubmit({ surface: "btw", isBtwSubmissionBlocked: () => true, input: "后续问题" })
    expect(await side.submit({ preventDefault: vi.fn() })).toBeUndefined()
    expect(side.openSideQuestion).not.toHaveBeenCalled()
  })

  it("consumes a side draft on its stream receipt without another lookup", async () => {
    const side = bindSideReceipt()
    side.stream.submit.mockImplementation(async (_input, options) => options.onPromptAccepted("/project"))
    await side.submit()
    expect(side.confirmBtwMessageDurable).not.toHaveBeenCalled()
    expect(side.appendVisibleUserMessageWithTime).toHaveBeenCalledExactlyOnceWith(side.input, { id: "message-id" })
    expect(side.draft.draftInput).toBe("")
    expect(side.references).toEqual([])
  })

  it.each([false, true])("checks a lost side receipt by ID and consumes only the submitted draft (edited: %s)", async edited => {
    const side = bindSideReceipt()
    side.stream.submit.mockImplementation(async (_input, options) => {
      expect(options.config?.configurable.hook_turn_id).toBe("message-id")
      if (edited) {
        side.draft.draftInput += " "
        side.references.push({ text: "新引用" })
      }
    })
    side.confirmBtwMessageDurable.mockResolvedValue(true)
    await side.submit()
    expect(side.confirmBtwMessageDurable).toHaveBeenCalledExactlyOnceWith("side-id", "message-id")
    expect(side.appendVisibleUserMessageWithTime).not.toHaveBeenCalled()
    expect(side.history.accept).toHaveBeenCalledOnce()
    expect(side.draft.draftInput).toBe(edited ? side.input + " " : "")
    expect(side.references).toEqual(edited ? [{ text: "新引用" }] : [])
  })

  it("keeps only new attachments when a side receipt arrives after further editing", async () => {
    const side = bindSideReceipt()
    const nextImage = { path: "/project/b.png" }
    const nextMention = { path: "/project/b.ts" }
    side.stream.submit.mockImplementation(async (_input, options) => {
      side.draft.draftAttachments = [...side.draft.draftAttachments, nextImage]
      side.draft.draftMentionedWorkspaceFiles = [...side.draft.draftMentionedWorkspaceFiles, nextMention]
      options.onPromptAccepted("/project")
    })
    await side.submit()
    expect(side.draft.draftAttachments).toEqual([nextImage])
    expect(side.draft.draftMentionedWorkspaceFiles).toEqual([nextMention])
  })

  it.each([false, undefined])("keeps an unconfirmed side draft and its references (durable: %s)", async durable => {
    const side = bindSideReceipt()
    side.stream.submit.mockResolvedValue(undefined)
    side.confirmBtwMessageDurable.mockResolvedValue(durable)
    await side.submit()
    expect(side.setInput).not.toHaveBeenCalled()
    expect(side.clearBtwReferences).not.toHaveBeenCalled()
    expect(side.history.accept).not.toHaveBeenCalled()
    if (durable === undefined) expect(side.setError).toHaveBeenCalledWith(expect.stringContaining("核对对话记录"))
    else expect(side.setError).not.toHaveBeenCalled()
  })

  it("leaves the side draft untouched when its tab closes during receipt recovery", async () => {
    const side = bindSideReceipt()
    side.stream.submit.mockResolvedValue(undefined)
    side.confirmBtwMessageDurable.mockImplementation(async () => {
      side.isBtwSubmissionBlocked.mockReturnValue(true)
      return true
    })
    await side.submit()
    expect(side.setInput).not.toHaveBeenCalled()
    expect(side.clearBtwReferences).not.toHaveBeenCalled()
    expect(side.setError).not.toHaveBeenCalled()
  })

  it.each([false, true])("reconciles a stopped side queue entry by its stable ID (durable: %s)", async durable => {
    const queue = bindQueuedReceipt()
    queue.state.queueAutoDrainSuppressed = true
    queue.reconcile.mockResolvedValue({ pendingIds: [], injectedIds: [], durableIds: durable ? [queue.next.id] : [] })
    await queue.drain()
    expect(queue.reconcile).toHaveBeenCalledExactlyOnceWith("side-id", [queue.next.id])
    expect(queue.setError).not.toHaveBeenCalled()
    if (durable) {
      expect(queue.removeLocalMessage).not.toHaveBeenCalled()
      expect(queue.prependQueuedMessage).not.toHaveBeenCalled()
    } else {
      expect(queue.removeLocalMessage).toHaveBeenCalledExactlyOnceWith(queue.next.id)
      expect(queue.prependQueuedMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(queue.next))
    }
    expect(queue.releaseSubmitInFlightLock).toHaveBeenCalledOnce()
  })

  it("parks an ambiguous side queue entry for reconciliation and does not mutate a closing tab", async () => {
    const queue = bindQueuedReceipt()
    queue.reconcile.mockRejectedValue(new Error("disconnected"))
    await queue.drain()
    expect(queue.prependQueuedMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      ...queue.next, handoffRequestedAt: expect.any(Date)
    }))
    const closing = bindQueuedReceipt()
    closing.reconcile.mockImplementation(async () => {
      closing.isBtwSubmissionBlocked.mockReturnValue(true)
      return { pendingIds: [], injectedIds: [], durableIds: [] }
    })
    await closing.drain()
    expect(closing.removeLocalMessage).not.toHaveBeenCalled()
    expect(closing.prependQueuedMessage).not.toHaveBeenCalled()
    expect(closing.setError).not.toHaveBeenCalled()
  })

  it("skips queue recovery for a side receipt and preserves ordinary queue handling", async () => {
    const side = bindQueuedReceipt()
    side.stream.submit.mockImplementation(async (_input, options) => options.onPromptAccepted?.())
    await side.drain()
    const ordinary = bindQueuedReceipt(false)
    await ordinary.drain()
    expect(side.reconcile).not.toHaveBeenCalled()
    expect(ordinary.reconcile).not.toHaveBeenCalled()
  })

  function bindSideOpen(openBtw: (parentId: string, modelId: string, first?: { text: string }) => Promise<string>) {
    const moduleDeclarations: string[] = []
    const composerDeclarations: string[] = []
    function visit(node: ts.Node): void {
      if (ts.isVariableStatement(node) && node.declarationList.declarations.some(
        declaration => declaration.name.getText(source) === "openingSideRequests"
      )) {
        const scope = node.parent === source ? moduleDeclarations : composerDeclarations
        scope.push(node.getText(source))
      }
      if (ts.isFunctionDeclaration(node) &&
        (node.name?.text === "openSideQuestion" || node.name?.text === "addSideSelection")) {
        composerDeclarations.push(node.getText(source))
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    const { outputText } = ts.transpileModule(`
      ${moduleDeclarations.join("\n")}
      return ({ threadId, input, threadContext, setInput }) => {
        ${composerDeclarations.join("\n")}
        return { openSideQuestion, addSideSelection };
      };
    `, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } })
    const addBtwReference = vi.fn()
    const completeFocus = vi.fn()
    const preparePromptHistory = vi.fn(() => ({ accept: vi.fn(), discard: vi.fn() }))
    const bindings = {
      preparePromptHistory,
      historyWorkspace: "/project",
      isSameGitWorkspacePath: (left: string, right?: string) => left === right,
      useRef: (current: unknown) => ({ current }),
      currentModel: "model",
      models: [{ id: "model", available: true }],
      MAX_INPUT_CHARS: 16000,
      useAppStore: { getState: () => ({ rightModule: "work" }) },
      useBtwChat: { getState: () => ({ selected: {}, tabs: [] }) },
      prepareBtwComposerFocus: () => completeFocus,
      toast: { error: vi.fn() },
      openBtw,
      isBtwSubmissionBlocked: () => false,
      addBtwReference
    }
    const mount = new Function(...Object.keys(bindings), outputText)(...Object.values(bindings))
    return { mount, addBtwReference, completeFocus, preparePromptHistory }
  }

  it("deduplicates the same command across composer remounts while allowing a different question", async () => {
    const completions: Array<(id: string) => void> = []
    const openBtw = vi.fn(() => new Promise<string>(resolve => { completions.push(resolve) }))
    const { mount } = bindSideOpen(openBtw)
    const draft = { draftInput: "/btw First question" }
    const setInput = vi.fn((input: string) => { draft.draftInput = input })
    const threadContext = { getThreadState: () => draft }
    const initial = mount({ threadId: "parent", input: draft.draftInput, setInput, threadContext })
    const first = initial.openSideQuestion("First question")
    const remounted = mount({ threadId: "parent", input: draft.draftInput, setInput, threadContext })
    const repeated = remounted.openSideQuestion("First question")
    expect(openBtw).toHaveBeenCalledOnce()

    draft.draftInput = "/btw Second question"
    const changed = mount({ threadId: "parent", input: draft.draftInput, setInput, threadContext })
    const second = changed.openSideQuestion("Second question")
    expect(openBtw).toHaveBeenCalledTimes(2)
    completions[0]("first-tab")
    await expect(first).resolves.toBe("first-tab")
    await expect(repeated).resolves.toBe("first-tab")
    expect(draft.draftInput).toBe("/btw Second question")
    completions[1]("second-tab")
    await expect(second).resolves.toBe("second-tab")
    expect(draft.draftInput).toBe("")

    const reopened = remounted.openSideQuestion("First question")
    expect(openBtw).toHaveBeenCalledTimes(3)
    completions[2]("reopened-tab")
    await expect(reopened).resolves.toBe("reopened-tab")
  })

  it("keeps the parent draft and discards its history receipt when file validation refuses a side question", async () => {
    const { mount, preparePromptHistory } = bindSideOpen(vi.fn().mockRejectedValue(new Error("当前草稿已保留")))
    const draft = { draftInput: "/btw Please read @notes.txt" }
    const setInput = vi.fn()
    const { openSideQuestion } = mount({ threadId: "parent", input: draft.draftInput, setInput,
      threadContext: { getThreadState: () => draft } })

    await expect(openSideQuestion("Please read @notes.txt")).resolves.toBeUndefined()
    expect(setInput).not.toHaveBeenCalled()
    expect(preparePromptHistory.mock.results[0].value.discard).toHaveBeenCalledOnce()
  })

  it("consumes a submitted alias without creating another tab for the same question", async () => {
    let finishOpening!: (id: string) => void
    const openBtw = vi.fn(() => new Promise<string>(resolve => { finishOpening = resolve }))
    const { mount, completeFocus, preparePromptHistory } = bindSideOpen(openBtw)
    const draft = { draftInput: "/btw First question" }
    const setInput = vi.fn((input: string) => { draft.draftInput = input })
    const threadContext = { getThreadState: () => draft }
    const submit = () => mount({ threadId: "parent", input: draft.draftInput, setInput, threadContext })
      .openSideQuestion("First question")

    const first = submit()
    draft.draftInput = "/side First question"
    const alias = submit()
    expect(preparePromptHistory).toHaveBeenCalledExactlyOnceWith("/project", "/btw First question")
    expect(openBtw).toHaveBeenCalledOnce()
    finishOpening("side")
    await expect(Promise.all([first, alias])).resolves.toEqual(["side", "side"])
    expect(setInput).toHaveBeenCalledExactlyOnceWith("")
    expect(completeFocus).toHaveBeenLastCalledWith("side")
  })

  it("adds both transcript selections when the first side tab is still opening", async () => {
    let finishOpening!: (id: string) => void
    const openBtw = vi.fn(() => new Promise<string>(resolve => { finishOpening = resolve }))
    const { mount, addBtwReference } = bindSideOpen(openBtw)
    const { addSideSelection } = mount({ threadId: "parent", threadContext: { getThreadState: () => ({}) } })
    const first = { parentId: "parent", rowId: "one", role: "assistant", text: "First quote" }
    const second = { parentId: "parent", rowId: "two", role: "assistant", text: "Second quote" }
    const additions = [addSideSelection(first), addSideSelection(second)]
    expect(openBtw).toHaveBeenCalledOnce()
    finishOpening("side")
    await Promise.all(additions)
    expect(addBtwReference.mock.calls).toEqual([["side", first], ["side", second]])
  })

  it("consumes a submitted side command when a transcript selection is opening the tab", async () => {
    let finishOpening!: (id: string) => void
    const openBtw = vi.fn(() => new Promise<string>(resolve => { finishOpening = resolve }))
    const { mount, addBtwReference, completeFocus } = bindSideOpen(openBtw)
    const draft = { draftInput: "" }
    const setInput = vi.fn((input: string) => { draft.draftInput = input })
    const threadContext = { getThreadState: () => draft }
    const composer = () => mount({ threadId: "parent", input: draft.draftInput, setInput, threadContext })
    const reference = { parentId: "parent", rowId: "one", role: "assistant", text: "Quoted text" }

    const selection = composer().addSideSelection(reference)
    draft.draftInput = "/btw"
    const command = composer().openSideQuestion("")
    expect(openBtw).toHaveBeenCalledOnce()
    finishOpening("side")
    await Promise.all([selection, command])
    expect(addBtwReference).toHaveBeenCalledExactlyOnceWith("side", reference)
    expect(setInput).toHaveBeenCalledExactlyOnceWith("")
    expect(completeFocus).toHaveBeenLastCalledWith("side")
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
