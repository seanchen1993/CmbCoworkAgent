import { Children, createElement, isValidElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, expect, it, vi } from "vitest"
import { MemorySessionSwitcher } from "../components/chat/MemorySessionSwitcher"

const state = vi.hoisted(() => ({
  currentThreadId: "workbench",
  threads: [
    { thread_id: "workbench", metadata: { memoryEnabled: false } },
    { thread_id: "task", metadata: { memoryEnabled: true } }
  ],
  patchThreadMetadata: vi.fn(async () => {})
}))
const capture = vi.hoisted(() => vi.fn<(children: ReactNode) => void>())

vi.mock("@/lib/store", () => ({ useAppStore: (select: (value: typeof state) => unknown) => select(state) }))
vi.mock("@/components/ui/popover", () => {
  const passthrough = ({ children }: { children: ReactNode }) => children
  return {
    Popover: passthrough,
    PopoverTrigger: passthrough,
    PopoverContent: ({ children }: { children: ReactNode }) => {
      capture(children)
      return children
    }
  }
})

function findCloseAction(children: ReactNode): (() => Promise<void> | void) | undefined {
  for (const child of Children.toArray(children)) {
    if (!isValidElement<{ children?: ReactNode; onClick?: () => Promise<void> | void }>(child)) continue
    if (child.type === "button" &&
        renderToStaticMarkup(createElement("span", null, child.props.children)).includes("关闭当前会话"))
      return child.props.onClick
    const nested = findCloseAction(child.props.children)
    if (nested) return nested
  }
  return undefined
}

beforeEach(() => vi.clearAllMocks())

it.each([
  { threadId: "task", label: "记忆暂停", target: "task" },
  { threadId: undefined, label: "记忆关", target: "workbench" }
])("reads and writes the same session when threadId=$threadId", async ({ threadId, label, target }) => {
  const html = renderToStaticMarkup(createElement(MemorySessionSwitcher, { threadId }))
  expect(html).toContain(`aria-label="当前会话记忆：${label}"`)
  const close = findCloseAction(capture.mock.lastCall![0])
  expect(close).toBeDefined()
  await close!()
  expect(state.patchThreadMetadata).toHaveBeenCalledExactlyOnceWith(target, { set: { memoryEnabled: false } })
})
