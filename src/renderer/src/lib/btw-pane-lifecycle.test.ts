import { readFileSync } from "node:fs"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it, vi } from "vitest"
import { isBtwThreadId } from "../../../shared/btw-chat"
import { BTW_LAUNCHER_TAB, BtwPane } from "../components/panels/BtwPane"
import type { useBtwChat } from "./btw-chat"

const fixture = vi.hoisted(() => ({
  tabs: [] as ReturnType<typeof useBtwChat.getState>["tabs"],
  selected: {} as ReturnType<typeof useBtwChat.getState>["selected"],
  initializeThread: vi.fn()
}))

vi.mock("./btw-chat", () => ({
  useBtwChat: (select: (store: typeof fixture) => unknown) => select(fixture),
  closeBtw: vi.fn(),
  loadBtwThread: vi.fn(),
  openBtw: vi.fn(),
  retryBtwSkillGeneration: vi.fn()
}))
vi.mock("./thread-context", () => ({
  useThreadContext: () => ({
    getThreadState: vi.fn(() => { throw new Error("rendering a tab badge read its thread state") }),
    initializeThread: fixture.initializeThread
  })
}))
vi.mock("../components/chat/ChatContainer", () => ({ ChatContainer: fixture.initializeThread }))

it("renders pending interactions on background tabs without initializing their chat state", () => {
  const parentId = "parent"
  fixture.tabs = [
    { id: "approval", parentId, number: 1, pending: true },
    { id: "question", parentId, number: 2, pending: true },
    { id: "skill", parentId, number: 3, skillRequests: [{
      kind: "confirm",
      request: { requestId: "confirmation", skillId: "skill", name: "技能", description: "摘要", content: "正文" }
    }] },
    { id: "cold", parentId, number: 4 }
  ]
  fixture.selected = { [parentId]: BTW_LAUNCHER_TAB }

  const html = renderToStaticMarkup(createElement(BtwPane, { parentId, full: false, toggleFull: vi.fn() }))

  expect(html).toContain("辅助对话 4")
  expect(html.match(/aria-label="等待处理"/g)).toHaveLength(3)
  expect(fixture.initializeThread).not.toHaveBeenCalled()
})

it.each(["closing", "failed"] as const)("renders a blocked auxiliary tab during %s", closeState => {
  const parentId = "parent"
  fixture.tabs = [{ id: "auxiliary", parentId, number: 1, closeState }]
  fixture.selected = { [parentId]: "auxiliary" }
  fixture.initializeThread.mockClear()

  const html = renderToStaticMarkup(createElement(BtwPane, { parentId, full: false, toggleFull: vi.fn() }))

  expect(html).toContain(closeState === "closing" ? "正在关闭辅助对话" : "重试关闭")
  expect(fixture.initializeThread).not.toHaveBeenCalled()
})

it("drops the stream loading record when a side conversation is closed", () => {
  const source = readFileSync(new URL("./thread-context.tsx", import.meta.url), "utf8")
  const cleanupStart = source.indexOf("const cleanupThread = useCallback")
  const disposal = source.indexOf("const handleStreamHolderDispose", cleanupStart)
  expect(source.slice(cleanupStart, disposal)).toContain("clearThreadLoadingState(threadId)")
})

it("releases the history generation of retired side tabs and advances it for reusable IDs", () => {
  const source = readFileSync(new URL("./thread-context.tsx", import.meta.url), "utf8")
  const cleanupStart = source.indexOf("const cleanupThread = useCallback")
  const start = source.indexOf("const historyGenerations =", cleanupStart)
  const end = source.indexOf("messageWindowIntentCoordinator.cancel(threadId)", cleanupStart)
  expect(start).toBeGreaterThan(cleanupStart)
  expect(end).toBeGreaterThan(start)
  const invalidateHistory = new Function(
    "threadId", "threadHistoryLoadGenerationRef", "isBtwThreadId", "isThreadRetired",
    source.slice(start, end)
  )
  const parent = "a51423d3-0101-4502-b250-3cd170f07629"
  const side = `btw-${parent}-1231584a-8487-4f1f-a9bf-f8b292143c77`
  const coldSide = `btw-${parent}-7ada2986-7d3a-4cf0-9822-6b324602b07f`
  const generations = { current: { [side]: 4, [parent]: 5 } }
  for (const id of [side, coldSide, parent]) {
    invalidateHistory(id, generations, isBtwThreadId, () => true)
  }
  expect(generations.current).toEqual({ [parent]: 6 })
})
