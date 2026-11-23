import { Children, isValidElement, type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it, vi } from "vitest"
import { BotWorkQuestions } from "@/components/bots/BotWorkQuestions"
import { DialogContent } from "@/components/ui/dialog"
import { UserInputRequestDialog } from "@/components/chat/UserInputRequestDialog"
import type { UserInputResponse } from "@/types"
import type { BotClient } from "../../../../shared/bots/contracts"
import type { BotWorkApproval, BotWorkInteraction, BotWorkQuestion } from "../../../../shared/bots/work"

const hooks = vi.hoisted(() => ({ cursor: 0, refCursor: 0, refs: [] as { current: unknown }[], state: [] as unknown[], showError: vi.fn() }))
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: () => {},
  useRef: (initial: unknown) => hooks.refs[hooks.refCursor++] ?? (hooks.refs[hooks.refCursor - 1] = { current: initial }),
  useState(initial: unknown) {
    const index = hooks.cursor++
    if (!(index in hooks.state)) hooks.state[index] = initial
    return [hooks.state[index], (value: unknown) => {
      hooks.state[index] = typeof value === "function" ? value(hooks.state[index]) : value
    }]
  }
}))
vi.mock("sonner", () => ({ toast: { error: hooks.showError } }))

const approval: BotWorkApproval = {
  kind: "approval", workId: "review", taskId: "review-task", workTitle: "核对账本",
  askedBy: "财务 Bot", projectName: "财务项目", requestId: "approval-request",
  target: { botId: "owner", threadId: "review-thread", workId: "review" }
}
const question: BotWorkQuestion = {
  kind: "question", workId: "export", taskId: "export-task", workTitle: "导出账本",
  askedBy: "财务 Bot", projectName: "财务项目",
  request: { requestId: "question-request", threadId: "export-thread", createdAt: "",
    questions: [{ id: "format", header: "格式", question: "要导出哪种格式？", options: [] }] }
}
const anotherApproval: BotWorkApproval = {
  ...approval, workId: "summary", taskId: "summary-task", requestId: "summary-approval",
  workTitle: "提交摘要", target: { botId: "owner", threadId: "summary-thread", workId: "summary" }
}

function* elements(node: ReactNode): Generator<ReactElement<{ children?: ReactNode }>> {
  if (!isValidElement<{ children?: ReactNode }>(node)) return
  yield node
  for (const child of Children.toArray(node.props.children)) yield* elements(child)
}

function fixture(pending: BotWorkInteraction[] = [approval, question]) {
  hooks.state = [pending]
  hooks.refs = []
  hooks.showError.mockClear()
  const pendingQuestions = vi.fn(async () => pending)
  const answerQuestion = vi.fn()
  const onOpenApproval = vi.fn<(item: BotWorkApproval, isCurrent: () => boolean) => Promise<void>>().mockResolvedValue(undefined)
  const client = { works: { pendingQuestions, answerQuestion } } as unknown as BotClient
  const render = () => {
    hooks.cursor = 0
    hooks.refCursor = 0
    return BotWorkQuestions({ client, botId: "owner", tasks: [], onOpenApproval })
  }
  const buttons = (tree: ReactNode) => [...elements(tree)].filter((element) => element.type === "button")
    .map((element) => element as ReactElement<{ onClick: (event?: { currentTarget: HTMLButtonElement }) => void }>)
  return { render, buttons, pendingQuestions, answerQuestion, onOpenApproval }
}

function focusFixture() {
  const header = { focus: vi.fn() }
  const rows: { focus: ReturnType<typeof vi.fn> }[] = []
  const conversation = {
    isConnected: true,
    closest: () => null,
    querySelectorAll: () => rows,
    querySelector: () => header
  }
  const trigger = { isConnected: true, focus: vi.fn(), closest: () => conversation }
  const click = { currentTarget: trigger as unknown as HTMLButtonElement }
  return { trigger, click, header, rows }
}

function dialogCloseFocus(tree: ReactNode) {
  const dialog = [...elements(tree)].find(element => element.type === DialogContent)
  return (dialog!.props as { onCloseAutoFocus: (event: { preventDefault(): void }) => void }).onCloseAutoFocus
}

it("offers every pending item in the list and opens a question for review before sending", () => {
  const f = fixture()
  const tree = f.render()
  const html = renderToStaticMarkup(tree)
  expect(html).toContain("2 项待处理")
  expect(html).toContain("核对账本")
  expect(html).toContain("等待批准")
  expect(html).toContain("导出账本")
  expect(html).toContain("要导出哪种格式？")
  expect(html).not.toContain("财务 Bot")
  expect(html.match(/查看/g)).toHaveLength(2)
  const buttons = f.buttons(tree)
  expect(buttons).toHaveLength(2)
  buttons[1].props.onClick(focusFixture().click)
  const dialog = [...elements(f.render())].find((element) => element.type === UserInputRequestDialog)
  expect(dialog?.props).toMatchObject({ request: question.request })
  expect(f.answerQuestion).not.toHaveBeenCalled()
  expect(f.onOpenApproval).not.toHaveBeenCalled()
})

it("starts guarded approval navigation immediately and blocks duplicate requests until it succeeds or fails", async () => {
  const f = fixture()
  let failOpening!: (error: Error) => void
  f.onOpenApproval.mockReturnValueOnce(new Promise<void>((_resolve, reject) => { failOpening = reject }))
  const [button] = f.buttons(f.render())
  button.props.onClick()
  await vi.waitFor(() => expect(f.onOpenApproval).toHaveBeenCalledExactlyOnceWith(approval, expect.any(Function)))
  button.props.onClick()
  expect(f.onOpenApproval).toHaveBeenCalledOnce()
  failOpening(new Error("审批会话不可用"))
  await vi.waitFor(() => expect(hooks.showError).toHaveBeenCalledExactlyOnceWith("审批会话不可用"))
  button.props.onClick()
  await vi.waitFor(() => expect(f.onOpenApproval).toHaveBeenCalledTimes(2))
  expect(f.answerQuestion).not.toHaveBeenCalled()
})

it("invalidates an in-flight approval when the user opens a question instead", async () => {
  const f = fixture()
  f.onOpenApproval.mockReturnValue(new Promise<void>(() => {}))
  const [approvalButton, questionButton] = f.buttons(f.render())
  approvalButton.props.onClick()
  const isCurrent = f.onOpenApproval.mock.calls[0][1]
  expect(isCurrent()).toBe(true)
  questionButton.props.onClick(focusFixture().click)
  expect(isCurrent()).toBe(false)
  expect(f.answerQuestion).not.toHaveBeenCalled()
})

it("uses the latest approval click even when it returns to the first request", async () => {
  const f = fixture([approval, anotherApproval])
  let rejectFirst!: (error: Error) => void
  let finishSecond!: () => void
  let finishLast!: () => void
  f.onOpenApproval
    .mockReturnValueOnce(new Promise<void>((_resolve, reject) => { rejectFirst = reject }))
    .mockReturnValueOnce(new Promise<void>(resolve => { finishSecond = resolve }))
    .mockReturnValueOnce(new Promise<void>(resolve => { finishLast = resolve }))
  const [first, second] = f.buttons(f.render())
  first.props.onClick()
  second.props.onClick()
  first.props.onClick()
  first.props.onClick()
  expect(f.onOpenApproval.mock.calls.map(([item]) => item)).toEqual([approval, anotherApproval, approval])
  const isCurrent = f.onOpenApproval.mock.calls.map(([, current]) => current)
  expect(isCurrent.map(check => check())).toEqual([false, false, true])
  rejectFirst(new Error("过时的审批错误"))
  finishSecond()
  await Promise.resolve()
  expect(hooks.showError).not.toHaveBeenCalled()
  expect(isCurrent[2]()).toBe(true)
  finishLast()
  await Promise.resolve()
  expect(isCurrent[2]()).toBe(false)
})

it("returns keyboard focus to the unanswered question row when its dialog closes", () => {
  const f = fixture()
  const { click, trigger } = focusFixture()
  f.buttons(f.render())[1].props.onClick(click)
  const preventDefault = vi.fn()
  dialogCloseFocus(f.render())({ preventDefault })
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(trigger.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
  expect(f.answerQuestion).not.toHaveBeenCalled()
})

it.each([false, true])("restores focus after an answer removes its row (has next row: %s)", async (hasNext) => {
  const f = fixture(hasNext ? [approval, question, anotherApproval] : [question])
  const { click, trigger, header, rows } = focusFixture()
  if (hasNext) rows.push({ focus: vi.fn() }, { focus: vi.fn() })
  f.buttons(f.render())[hasNext ? 1 : 0].props.onClick(click)
  const tree = f.render()
  const dialog = [...elements(tree)].find(element => element.type === UserInputRequestDialog)
  const response: UserInputResponse = {
    requestId: question.request.requestId,
    answers: { format: { type: "other", questionId: "format", text: "CSV" } }
  }
  const submit = (dialog!.props as { onSubmit(response: UserInputResponse): void }).onSubmit
  submit(response)
  await vi.waitFor(() => expect(f.buttons(f.render())).toHaveLength(hasNext ? 2 : 0))
  expect(f.answerQuestion).toHaveBeenCalledExactlyOnceWith("owner", question.taskId, response)
  trigger.isConnected = false
  const preventDefault = vi.fn()
  dialogCloseFocus(tree)({ preventDefault })
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(trigger.focus).not.toHaveBeenCalled()
  if (hasNext) {
    expect(rows[1].focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
    expect(rows[0].focus).not.toHaveBeenCalled()
    expect(header.focus).not.toHaveBeenCalled()
  } else {
    expect(header.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
  }
})
