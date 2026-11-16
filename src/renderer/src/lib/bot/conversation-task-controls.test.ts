import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, expect, it, vi } from "vitest"
import type { BotWorkConversationResolution } from "../../../../shared/bots/conversation"
import { ConversationTaskControls } from "@/components/bots/ConversationTaskControls"
import { bindBotConversationDraft } from "../bot-conversation-draft"
import type { FileAttachment } from "../../../../shared/file-attachment"
import type { ThreadDraftSkill } from "../thread-context"

type MenuButton = ReactElement<{ children: string; onClick: () => void }>
type Route = { mainView: string; currentThreadId: string; showCustomizeView: boolean }
const captureMenuButton = vi.hoisted(() => vi.fn<(button: MenuButton) => void>())
const controls = vi.hoisted(() => ({
  slots: undefined as unknown[] | undefined,
  cursor: 0,
  context: {},
  route: { mainView: "thread", currentThreadId: "thread-a", showCustomizeView: false },
  routeListeners: new Set<(route: Route) => void>(),
  loadThreads: vi.fn(async () => {}),
  setMainView: vi.fn(),
  showError: vi.fn()
}))
const views = vi.hoisted(() => ({
  hosts: {} as Record<string, { activeWorkIdByBot: Record<string, string | null> }>,
  update: vi.fn()
}))

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>()
  return {
    ...react,
    useState(initial: unknown) {
      const slots = controls.slots
      if (!slots) return react.useState(initial)
      const index = controls.cursor++
      if (!(index in slots)) slots[index] = initial
      return [slots[index], (next: unknown) => { slots[index] = next }]
    },
    useRef(initial: unknown) {
      if (!controls.slots) return react.useRef(initial)
      return (controls.slots[controls.cursor++] ??= { current: initial })
    },
    useEffect: (...args: Parameters<typeof react.useEffect>) => {
      if (!controls.slots) react.useEffect(...args)
    },
    useId: () => controls.slots ? "test-form" : react.useId()
  }
})

vi.mock("@/components/ui/popover", () => {
  const passthrough = ({ children }: { children: ReactNode }) => children
  return { Popover: passthrough, PopoverContent: passthrough, PopoverTrigger: passthrough }
})
vi.mock("@radix-ui/react-popover", () => ({
  Close: ({ children }: { children: MenuButton }) => {
    captureMenuButton(children)
    return children
  }
}))
vi.mock("@/components/ui/dialog", () => ({
  Dialog: () => null,
  DialogContent: () => null,
  DialogDescription: () => null,
  DialogHeader: () => null,
  DialogTitle: () => null
}))
vi.mock("@/components/bots/BotAvatar", () => ({ BotAvatar: () => null }))
vi.mock("@/components/bots/BotExecutionDetailsToggle", () => ({ BotExecutionDetailsToggle: () => null }))
vi.mock("@/components/bots/BotUnlinkDialog", () => ({ BotUnlinkDialog: () => null }))
vi.mock("@/components/bots/view-store", () => ({ useBotViewStore: { getState: () => views } }))
vi.mock("@/lib/store", () => ({
  isThreadRetired: () => false,
  useAppStore: {
    getState: () => ({ ...controls.route, threads: [], loadThreads: controls.loadThreads, setMainView: controls.setMainView }),
    subscribe: (listener: (route: Route) => void) => {
      controls.routeListeners.add(listener)
      return () => controls.routeListeners.delete(listener)
    }
  }
}))
vi.mock("@/lib/thread-context", () => ({ useThreadContext: () => controls.context }))
vi.mock("sonner", () => ({ toast: { error: controls.showError } }))

afterEach(() => {
  captureMenuButton.mockClear()
  controls.slots = undefined
  controls.context = {}
  controls.route = { mainView: "thread", currentThreadId: "thread-a", showCustomizeView: false }
  controls.routeListeners.clear()
  controls.loadThreads.mockClear()
  controls.setMainView.mockClear()
  controls.showError.mockClear()
  views.hosts = {}
  views.update.mockClear()
  vi.unstubAllGlobals()
})

it.each([
  { state: "active", dispatchStopped: true, label: "继续处理", action: "continue" },
  { state: "completed", label: "继续处理", action: "continue" },
  { state: "active", label: "完成任务", action: "complete" }
] as const)("sends $action from the workbench menu for $state ($dispatchStopped)", async (scenario) => {
  const lifecycle = vi.fn().mockResolvedValue(undefined)
  const refresh = vi.fn()
  vi.stubGlobal("window", { api: { bots: { works: { lifecycle } } } })
  const link = {
    bot: { id: "bot-a", name: "Bot A" },
    work: {
      id: "work-a", version: 4, title: "原任务", state: scenario.state,
      dispatchStopped: "dispatchStopped" in scenario ? scenario.dispatchStopped : undefined
    },
    workspacePath: "/project"
  } as BotWorkConversationResolution

  const html = renderToStaticMarkup(createElement(ConversationTaskControls, {
    threadId: "thread-a", link, refresh
  }))
  expect(html).toContain(`>${scenario.label}</button>`)
  expect(lifecycle).not.toHaveBeenCalled()
  const button = captureMenuButton.mock.calls.map(([item]) => item)
    .find(item => item.props.children === scenario.label)
  expect(button).toBeDefined()
  button!.props.onClick()
  expect(lifecycle).toHaveBeenCalledExactlyOnceWith({
    botId: "bot-a", workId: "work-a", expectedVersion: 4,
    operationId: expect.any(String), action: scenario.action
  })
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce())
})

function controlElement<Props>(
  root: unknown,
  match: (element: ReactElement<Props & { children?: ReactNode }>) => boolean
) {
  const find = (node: unknown): ReactElement<Props> | undefined => {
    if (!isValidElement<Props & { children?: ReactNode }>(node)) return undefined
    if (match(node)) return node
    return Children.toArray(node.props.children).map(find).find(Boolean)
  }
  const found = find(root)
  if (!found) throw new Error("Missing association control")
  return found.props
}

const boundTask = {
  bot: { hostId: "local", id: "bot-a", name: "Bot A", archived: false },
  work: {
    botId: "bot-a", id: "work-a", threadId: "thread-a", version: 4, title: "原任务", state: "active",
    audienceKey: "desktop", executionState: "running",
    conversation: { origin: "created", state: "bound", ref: {
      kind: "local_thread", threadId: "thread-a", incarnation: { token: "incarnation-a", legacyCreatedAt: 10 }
    } }
  },
  workspacePath: "/project"
} as BotWorkConversationResolution

it("opens the linked task's original computer directly from the workbench menu", () => {
  const stop = vi.fn()
  vi.stubGlobal("window", { api: { bots: { works: { stop } } } })
  views.hosts.local = { activeWorkIdByBot: { "bot-b": "another-work" } }
  const html = renderToStaticMarkup(createElement(ConversationTaskControls, {
    threadId: "thread-a", link: boundTask, refresh: vi.fn()
  }))
  expect(html).toContain(">打开原电脑</button>")
  const button = captureMenuButton.mock.calls.map(([item]) => item)
    .find(item => item.props.children === "打开原电脑")
  button!.props.onClick()
  expect(views.update).toHaveBeenCalledExactlyOnceWith("local", {
    selectedId: "bot-a", groupId: null, showArchived: false, detailOpen: true, detailTab: "computer",
    activeWorkIdByBot: { "bot-a": "work-a", "bot-b": "another-work" }
  })
  expect(controls.setMainView).toHaveBeenCalledExactlyOnceWith("bots")
  expect(stop).not.toHaveBeenCalled()
})

it("stops the exact work and keeps its menu actions disabled until acknowledgement", async () => {
  let finish!: () => void
  const stop = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  const stopConversation = vi.fn()
  vi.stubGlobal("window", { api: { bots: { works: { stop }, stopConversation } } })
  const refresh = vi.fn()
  controls.slots = []
  const menuAction = (label: string) => {
    controls.cursor = 0
    const tree = ConversationTaskControls({ threadId: "thread-a", link: boundTask, refresh })
    return controlElement<{ disabled?: boolean; onClick(): void }>(tree, element =>
      element.type === "button" && element.props.children === label)
  }
  menuAction("停止任务").onClick()
  expect(stop).toHaveBeenCalledExactlyOnceWith("bot-a", "work-a")
  expect(stopConversation).not.toHaveBeenCalled()
  expect(menuAction("停止任务").disabled).toBe(true)
  expect(menuAction("打开原电脑").disabled).toBe(true)
  expect(menuAction("完成任务").disabled).toBe(true)
  expect(refresh).not.toHaveBeenCalled()
  finish()
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce())
})

it("keeps task-specific actions out of an ordinary workbench conversation", () => {
  const html = renderToStaticMarkup(createElement(ConversationTaskControls, {
    threadId: "ordinary-thread", link: null, refresh: vi.fn()
  }))
  expect(html).toContain("关联为 Bot 任务")
  expect(html).not.toContain("打开原电脑")
  expect(html).not.toContain("停止任务")
})

it.each([
  { label: "opening and closing settings", change: { showCustomizeView: true } },
  { label: "switching threads and returning", change: { currentThreadId: "thread-b" } },
  { label: "leaving the workbench and returning", change: { mainView: "bots" } }
])("discards an in-flight unlink inspection after $label", async ({ change }) => {
  let finish!: (hasOpenPages: boolean) => void
  const unlinkHasOpenPages = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
  const unlink = vi.fn()
  vi.stubGlobal("window", { api: { bots: { conversations: { unlink, unlinkHasOpenPages } } } })
  controls.slots = []
  const refresh = vi.fn()
  const render = () => {
    controls.cursor = 0
    return ConversationTaskControls({ threadId: "thread-a", link: boundTask, refresh })
  }
  const unlinkButton = () => controlElement<{ disabled?: boolean; onClick(): void }>(
    render(), element => element.type === "button" && element.props.children === "解除任务关联"
  )
  unlinkButton().onClick()
  expect(unlinkHasOpenPages).toHaveBeenCalledExactlyOnceWith("bot-a", "work-a")
  expect(unlinkButton().disabled).toBe(true)
  expect(controls.routeListeners.size).toBe(1)

  const originalRoute = controls.route
  controls.route = { ...originalRoute, ...change }
  for (const listener of controls.routeListeners) listener(controls.route)
  expect(controls.routeListeners.size).toBe(0)
  controls.route = originalRoute
  finish(true)

  await vi.waitFor(() => expect(unlinkButton().disabled).toBeFalsy())
  expect(() => controlElement<{ onConfirm(): void }>(render(), element =>
    typeof element.props.onConfirm === "function"
  )).toThrow("Missing association control")
  expect(unlink).not.toHaveBeenCalled()
  expect(refresh).not.toHaveBeenCalled()
})

it.each(["matching", "changed", "failed"] as const)("reconciles the saved Bots selection after workbench unlink (%s)", async scenario => {
  const threadId = "thread-a"
  const link = {
    bot: { hostId: "local", id: "bot-a", name: "Bot A" },
    work: {
      botId: "bot-a", id: "work-a", threadId, version: 4, title: "原任务", state: "active",
      audienceKey: "desktop",
      conversation: { origin: "created", state: "bound", ref: {
        kind: "local_thread", threadId, incarnation: { token: "incarnation-a", legacyCreatedAt: 10 }
      } }
    },
    workspacePath: "/project"
  } as BotWorkConversationResolution
  const activeWorkIdByBot = { "bot-a": "work-a", "bot-b": "work-a" }
  views.hosts = {
    local: { activeWorkIdByBot },
    another: { activeWorkIdByBot: { "bot-a": "work-a" } }
  }
  controls.context = {
    initializeThread: vi.fn(),
    getThreadState: () => ({
      draftInput: "", draftAttachments: [], draftMentionedWorkspaceFiles: [], queuedMessages: []
    }),
    getThreadActions: () => ({
      setQueueAutoDrainSuppressed: vi.fn(),
      syncDurableTranscript: vi.fn(async () => true)
    })
  }
  vi.stubGlobal("localStorage", { getItem: () => null })
  let finish!: (work: BotWorkConversationResolution["work"]) => void
  let fail!: (error: Error) => void
  const pending = new Promise<BotWorkConversationResolution["work"]>((resolve, reject) => {
    finish = resolve
    fail = reject
  })
  const unlink = vi.fn(() => pending)
  vi.stubGlobal("window", { api: { bots: { conversations: { unlink, unlinkHasOpenPages: async () => false } } } })
  controls.slots = []
  const refresh = vi.fn()
  const render = () => {
    controls.cursor = 0
    return ConversationTaskControls({ threadId, link, refresh })
  }
  controlElement<{ onClick(): void }>(render(), element => element.type === "button" &&
    element.props.children === "解除任务关联").onClick()
  const dialog = await vi.waitFor(() => controlElement<{ onConfirm(): void }>(
    render(), element => typeof element.props.onConfirm === "function"
  ))
  dialog.onConfirm()
  await vi.waitFor(() => expect(unlink).toHaveBeenCalledExactlyOnceWith("bot-a", "work-a", 4))
  expect(views.update).not.toHaveBeenCalled()

  if (scenario === "failed") {
    fail(new Error("解除关联未成功"))
    await vi.waitFor(() => expect(controls.showError).toHaveBeenCalledWith("解除关联未成功"))
    expect(views.update).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    return
  }
  if (scenario === "changed") {
    views.hosts.local = { activeWorkIdByBot: { ...activeWorkIdByBot, "bot-a": "new-work" } }
  }
  finish({ ...link.work, conversation: { ...link.work.conversation!, state: "detached" } })
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce())
  if (scenario === "matching") {
    expect(views.update).toHaveBeenCalledExactlyOnceWith("local", {
      activeWorkIdByBot: { "bot-a": null, "bot-b": "work-a" }
    })
  } else {
    expect(views.update).not.toHaveBeenCalled()
  }
})

it.each(["unchanged", "replaced"] as const)("protects the file-tab composer during explicit association (%s thread)", async scenario => {
  const threadId = "ordinary-file-tab"
  const token = "original-incarnation"
  const row = { thread_id: threadId, metadata: { cmb_thread_incarnation: token }, created_at: new Date(10) }
  const attachment: FileAttachment = {
    filename: "report.txt", filePath: "/work/report.txt", content: "Report contents",
    mimeType: "text/plain", size: 15, truncated: false
  }
  const skill = { name: "Check data", path: "/skills/check/SKILL.md", restored: true as const }
  const draft = {
    draftInput: "Check this report",
    draftAttachments: [attachment],
    draftMentionedWorkspaceFiles: [],
    draftSkill: skill,
    queuedMessages: []
  }
  const unavailableAttachment = { ...attachment, originalUnavailable: true as const }
  let currentDraft = draft
  const setDraftAttachments = vi.fn((update: FileAttachment[] | ((previous: FileAttachment[]) => FileAttachment[])) => {
    const draftAttachments = typeof update === "function" ? update(currentDraft.draftAttachments) : update
    currentDraft = { ...currentDraft, draftAttachments }
  })
  const saved = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key)
  })
  const subscribe = vi.fn()
  controls.context = {
    initializeThread: vi.fn(),
    getThreadState: () => currentDraft,
    getThreadActions: () => ({ setQueueAutoDrainSuppressed: vi.fn(), setDraftAttachments }),
    subscribeToThreadState: subscribe
  }
  const link = vi.fn(async () => { expect(saved.size).toBe(1) })
  const get = vi.fn(async () => row)
  vi.stubGlobal("window", { api: {
    threads: { get },
    bots: { snapshot: async () => ({ bots: [{ id: "owner", name: "Owner" }] }), conversations: { link } }
  } })
  controls.slots = []
  const refresh = vi.fn()
  const render = () => {
    controls.cursor = 0
    return ConversationTaskControls({ threadId, link: null, refresh })
  }
  controlElement<{ onClick(): void }>(render(), element => element.type === "button" &&
    Children.toArray(element.props.children).includes("关联为 Bot 任务")
  ).onClick()
  await vi.waitFor(() => {
    expect(controlElement<{ open: boolean }>(render(), element => typeof element.props.open === "boolean").open).toBe(true)
  })
  controlElement<{ onChange(event: { target: { value: string } }): void }>(render(), element => element.type === "textarea")
    .onChange({ target: { value: "Check the report" } })
  const submit = () =>
    controlElement<{ onSubmit(event: { preventDefault(): void }): void }>(render(), element => element.type === "form")
      .onSubmit({ preventDefault() {} })
  if (scenario === "replaced") {
    get.mockResolvedValueOnce({ ...row, metadata: { cmb_thread_incarnation: "replacement" } })
    submit()
    await vi.waitFor(() => expect(controls.showError).toHaveBeenCalledWith(expect.stringContaining("身份已变化")))
    expect(link).not.toHaveBeenCalled()
    expect(setDraftAttachments).not.toHaveBeenCalled()
    expect(saved.size).toBe(0)
    return
  }

  submit()
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce())
  const ref = { kind: "local_thread" as const, threadId, incarnation: { token, legacyCreatedAt: 10 } }
  expect(link).toHaveBeenCalledExactlyOnceWith({
    botId: "owner", title: "会话任务", goal: "Check the report", conversation: ref, operationId: expect.any(String)
  })
  expect(setDraftAttachments).toHaveBeenCalledExactlyOnceWith([unavailableAttachment])
  expect(subscribe).not.toHaveBeenCalled()

  const reopened = { ...draft, draftInput: "", draftAttachments: [] as FileAttachment[], draftSkill: null as ThreadDraftSkill | null }
  const context = {
    initializeThread: vi.fn(),
    getThreadState: () => reopened,
    getThreadActions: () => ({
      setDraftInput: (value: string) => { reopened.draftInput = value },
      setDraftAttachments: (value: FileAttachment[]) => { reopened.draftAttachments = value },
      setDraftSkill: (value: ThreadDraftSkill) => { reopened.draftSkill = value }
    }),
    subscribeToThreadState: () => () => {}
  } as unknown as Parameters<typeof bindBotConversationDraft>[0]
  const unbind = bindBotConversationDraft(context, "local", "owner", threadId, vi.fn(), "new-work", ref)
  expect(reopened).toEqual({ ...draft, draftAttachments: [unavailableAttachment] })
  unbind()
})
