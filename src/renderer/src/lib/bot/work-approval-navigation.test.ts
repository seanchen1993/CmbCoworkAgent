import { readFileSync } from "node:fs"
import { Children, isValidElement, type ReactElement, type ReactNode } from "react"
import ts from "typescript"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { BotWorkQuestions } from "@/components/bots/BotWorkQuestions"
import type { BotClient } from "../../../../shared/bots/contracts"
import type { BotWorkApproval, BotWorkInteraction, BotWorkItem, BotWorkQuestion } from "../../../../shared/bots/work"
import type { Thread } from "../../types"
import { useAppStore } from "../store"
import { openBotWorkThreadChat, resolveBotWorkThreadForNavigation } from "./work-thread-summary"

const hooks = vi.hoisted(() => ({
  stateIndex: 0,
  refIndex: 0,
  state: [] as unknown[],
  refs: [] as Array<{ current: unknown }>
}))
const store = vi.hoisted(() => ({
  mainView: "bots",
  showCustomizeView: false,
  threads: [] as Thread[],
  loadThreads: vi.fn(async () => {}),
  selectThread: vi.fn(async (_id: string) => {})
}))
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: () => {},
  useRef(initial: unknown) {
    return hooks.refs[hooks.refIndex++] ??= { current: initial }
  },
  useState(initial: unknown) {
    const index = hooks.stateIndex++
    if (!(index in hooks.state)) hooks.state[index] = initial
    return [hooks.state[index], (value: unknown) => { hooks.state[index] = value }]
  }
}))
vi.mock("../store", () => ({
  isThreadRetired: () => false,
  useAppStore: { getState: () => store }
}))

const approval: BotWorkApproval = {
  kind: "approval", workId: "approval-work", taskId: "approval-run", workTitle: "核对账本",
  askedBy: "财务 Bot", requestId: "approval-request",
  target: { botId: "owner", threadId: "approval-thread", workId: "approval-work" }
}
const question: BotWorkQuestion = {
  kind: "question", workId: "question-work", taskId: "question-run", workTitle: "导出账本",
  askedBy: "财务 Bot",
  request: { requestId: "question-request", threadId: "question-thread", createdAt: "",
    questions: [{ id: "format", header: "格式", question: "要导出哪种格式？", options: [] }] }
}
const work: BotWorkItem = {
  id: approval.workId, botId: approval.target.botId, threadId: approval.target.threadId,
  parentThreadId: "main-thread", title: approval.workTitle, goal: "核对两张表格",
  state: "active", audienceKey: "desktop", version: 1, createdAt: 1, updatedAt: 2,
  threadInitialized: true, executionState: "waiting_user", pendingPeers: 0, backgroundBusy: false,
  conversation: {
    origin: "created", state: "bound",
    ref: { kind: "local_thread", threadId: approval.target.threadId, incarnation: { token: "original", legacyCreatedAt: 1 } }
  }
}
const thread: Thread = {
  thread_id: work.threadId, created_at: new Date(1), updated_at: new Date(2), status: "idle",
  metadata: {
    botLocalConversation: true, botHostId: "local", botId: work.botId, botWorkId: work.id,
    botAudienceKey: "desktop", botWorkOrigin: "created", cmb_thread_incarnation: "original"
  },
  thread_values: {}
}

function productionWorkspaceHandlers() {
  const contents = readFileSync(new URL("../../components/bots/BotsWorkspace.tsx", import.meta.url), "utf8")
  const source = ts.createSourceFile("BotsWorkspace.tsx", contents, ts.ScriptTarget.Latest)
  const workspace = source.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === "BotWorkspaceForHost")
  const names = [
    "setDetailOpen", "setDetailTab", "captureWorkNavigation", "approvalNavigation",
    "dismissWorkPreview", "openWorkPreview", "openWorkApproval"
  ]
  const handlers = workspace?.body?.statements.filter(statement =>
    ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration =>
      ts.isIdentifier(declaration.name) && names.includes(declaration.name.text))) ?? []
  if (handlers.length !== names.length) throw new Error("Bot workspace navigation handlers are missing")
  return ts.transpileModule(handlers.map(statement => statement.getText(source)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
}

type ButtonProps = {
  children?: ReactNode
  "data-kind"?: string
  onClick(event: { currentTarget: object }): void
}

function findButton(node: ReactNode, kind: "approval" | "question"): ReactElement<ButtonProps> | undefined {
  if (!isValidElement<ButtonProps>(node)) return undefined
  if (node.type === "button" && node.props["data-kind"] === kind) return node
  for (const child of Children.toArray(node.props.children)) {
    const button = findButton(child, kind)
    if (button) return button
  }
  return undefined
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const pending = new Promise<T>(finish => { resolve = finish })
  return { pending, resolve }
}

function fixture() {
  const pendingQuestions = vi.fn<() => Promise<BotWorkInteraction[]>>().mockResolvedValue([approval, question])
  const get = vi.fn<() => Promise<BotWorkItem>>().mockResolvedValue(work)
  const expose = vi.fn<() => Promise<BotWorkItem>>().mockResolvedValue(work)
  const answerQuestion = vi.fn()
  const client = { hostId: "local", works: { pendingQuestions, get, answerQuestion }, conversations: { expose } } as unknown as BotClient
  const setWorkPreview = vi.fn()
  const setActiveTab = vi.fn()
  const threadContext = { getThreadActions: vi.fn(() => ({ setActiveTab })) }
  const toast = { info: vi.fn() }
  const view = { detailOpen: true, detailTab: "details" }
  const scope = {
    client, selected: { id: work.botId }, selectedIm: null, activeWorkId: null,
    currentBotId: work.botId, canPreviewWork: true, detailOpen: view.detailOpen,
    view, updateView: (patch: Partial<typeof view>) => Object.assign(view, patch),
    document: { activeElement: null }, profileMenuTrigger: { current: null },
    workPreviewNavigation: { current: null }, workPreviewReturn: { current: null },
    setWorkPreview, useAppStore, resolveBotWorkThreadForNavigation, openBotWorkThreadChat, threadContext, toast,
    useRef: <T,>(current: T) => ({ current }), useCallback: (callback: unknown) => callback
  }
  // Drive the handlers wired by BotsWorkspace, with only React state and IPC substituted.
  const handlers = new Function(...Object.keys(scope), `
    ${productionWorkspaceHandlers()}
    return { openWorkApproval, openWorkPreview, setDetailOpen, setDetailTab }
  `)(...Object.values(scope)) as {
    openWorkApproval: NonNullable<Parameters<typeof BotWorkQuestions>[0]["onOpenApproval"]>
    openWorkPreview(id: string, trigger: object, title: string): void
    setDetailOpen(open: boolean): void
    setDetailTab(tab: string): void
  }
  const onOpenApproval = vi.fn(handlers.openWorkApproval)
  const surface = BotWorkQuestions({ client, botId: work.botId, tasks: [], onOpenApproval })
  const click = (kind: "approval" | "question") => {
    const button = findButton(surface, kind)
    if (!button) throw new Error(`Missing ${kind} action`)
    button.props.onClick({ currentTarget: { closest: () => null } })
  }
  return {
    pendingQuestions, get, expose, answerQuestion, onOpenApproval, setWorkPreview, click, setActiveTab, toast, view,
    closeDetails: () => handlers.setDetailOpen(false),
    openComputer: () => handlers.setDetailTab("computer"),
    previewAnotherWork: () => handlers.openWorkPreview("another-work", {}, "另一项任务")
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  hooks.stateIndex = 0
  hooks.refIndex = 0
  hooks.state = [[approval, question]]
  hooks.refs = []
  store.mainView = "bots"
  store.showCustomizeView = false
  store.threads = [thread]
})

describe("opening the original work approval", () => {
  it("rechecks the same approval and selects its original chat", async () => {
    const f = fixture()
    f.click("approval")
    await vi.waitFor(() => expect(f.onOpenApproval).toHaveBeenCalledOnce())
    await f.onOpenApproval.mock.results[0].value
    expect(f.pendingQuestions).toHaveBeenCalledExactlyOnceWith(work.botId)
    expect(f.get).toHaveBeenCalledExactlyOnceWith(work.botId, work.id)
    expect(f.expose).toHaveBeenCalledExactlyOnceWith(work.botId, work.id)
    expect(f.setActiveTab).toHaveBeenCalledExactlyOnceWith("agent")
    expect(store.selectThread).toHaveBeenCalledExactlyOnceWith(work.threadId)
    expect(f.answerQuestion).not.toHaveBeenCalled()
  })

  it("leaves the user in the main conversation if the requested approval was replaced", async () => {
    const f = fixture()
    f.pendingQuestions.mockResolvedValueOnce([{ ...approval, requestId: "replacement" }])
    f.click("approval")
    await f.onOpenApproval.mock.results[0].value
    expect(f.get).not.toHaveBeenCalled()
    expect(f.expose).not.toHaveBeenCalled()
    expect(store.selectThread).not.toHaveBeenCalled()
    expect(f.toast.info).toHaveBeenCalledOnce()
  })

  it("does not let an earlier opening of the same row clear a later attempt", async () => {
    const f = fixture()
    const old = deferred<BotWorkInteraction[]>(), current = deferred<BotWorkItem>()
    f.pendingQuestions.mockReturnValueOnce(old.pending)
    f.get.mockReturnValueOnce(current.pending)
    const first = f.onOpenApproval(approval, () => false)
    // A is selected again after another interaction; it is the same directory row.
    const latest = f.onOpenApproval(approval, () => true)
    await vi.waitFor(() => expect(f.get).toHaveBeenCalledOnce())
    old.resolve([approval, question])
    await first
    current.resolve(work)
    await latest
    expect(f.expose).toHaveBeenCalledOnce()
    expect(store.selectThread).toHaveBeenCalledExactlyOnceWith(work.threadId)
  })

  const inFlight = [
    { name: "pendingQuestions", pause(f: ReturnType<typeof fixture>) {
      const pending = deferred<BotWorkInteraction[]>()
      f.pendingQuestions.mockReturnValueOnce(pending.pending)
      return { entered: f.pendingQuestions, release: () => pending.resolve([approval, question]) }
    } },
    { name: "get", pause(f: ReturnType<typeof fixture>) {
      const pending = deferred<BotWorkItem>()
      f.get.mockReturnValueOnce(pending.pending)
      return { entered: f.get, release: () => pending.resolve(work) }
    } },
    { name: "expose", pause(f: ReturnType<typeof fixture>) {
      const pending = deferred<BotWorkItem>()
      f.expose.mockReturnValueOnce(pending.pending)
      return { entered: f.expose, release: () => pending.resolve(work) }
    } }
  ]

  describe.each(inFlight)("while $name is in flight", ({ pause }) => {
    it.each(["another preview", "a question", "leaving Bots", "settings", "the computer tab", "closing details"] as const)(
      "keeps the later choice of %s",
      async (choice) => {
        const f = fixture()
        const { entered, release } = pause(f)
        f.click("approval")
        await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
        if (choice === "another preview") {
          f.previewAnotherWork()
          expect(f.setWorkPreview).toHaveBeenCalledWith(expect.objectContaining({ workId: "another-work" }))
        } else if (choice === "a question") {
          f.click("question")
          expect(hooks.state).toContain(question)
        } else if (choice === "settings") {
          store.showCustomizeView = true
        } else if (choice === "the computer tab") {
          f.openComputer()
          expect(f.view.detailTab).toBe("computer")
        } else if (choice === "closing details") {
          f.closeDetails()
          expect(f.view.detailOpen).toBe(false)
        } else {
          store.mainView = "thread"
        }
        release()
        await vi.waitFor(() => expect(f.onOpenApproval).toHaveBeenCalledOnce())
        await f.onOpenApproval.mock.results[0].value
        expect(store.loadThreads).not.toHaveBeenCalled()
        expect(f.setActiveTab).not.toHaveBeenCalled()
        expect(store.selectThread).not.toHaveBeenCalled()
        expect(f.answerQuestion).not.toHaveBeenCalled()
      }
    )
  })
})
