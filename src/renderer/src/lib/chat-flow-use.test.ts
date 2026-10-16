import { expect, it, vi } from "vitest"
import { consumeChatFlowChoice, currentChatFlowChoice, selectChatFlow } from "./chat-flow-choice"
import {
  CHAT_FLOW_USE_EVENT,
  consumeChatComposerFocus,
  requestChatComposerFocus,
  requestChatFlowUse
} from "./chat-flow-use"

it("hands off an explicit next-message selection without executing or changing any draft", () => {
  const dispatchEvent = vi.fn()
  vi.stubGlobal("window", { dispatchEvent })
  const request = {
    threadId: "use-a",
    workspace: "workspace",
    id: "flow",
    revision: 2,
    name: "检视"
  }
  try {
    requestChatFlowUse(request)
    expect(currentChatFlowChoice("use-a")).toEqual({
      workspace: "workspace",
      id: "flow",
      revision: 2,
      name: "检视"
    })
    expect(currentChatFlowChoice("use-b")).toBeNull()
    const event = dispatchEvent.mock.calls
      .map((call) => call[0] as CustomEvent)
      .find((event) => event.type === CHAT_FLOW_USE_EVENT)!
    expect(event.type).toBe(CHAT_FLOW_USE_EVENT)
    expect(event.detail).toEqual(request)
  } finally {
    selectChatFlow("use-a", null)
    consumeChatComposerFocus(request)
    vi.unstubAllGlobals()
  }
})

it("focus intents survive navigation, remain scoped, bounded and consume only once", () => {
  vi.stubGlobal("window", { dispatchEvent: vi.fn() })
  try {
    requestChatComposerFocus({ threadId: "focus", workspace: "/first" })
    expect(consumeChatComposerFocus({ threadId: "focus", workspace: "/other" })).toBe(false)
    expect(consumeChatComposerFocus({ threadId: "focus", workspace: "/first" })).toBe(true)
    expect(consumeChatComposerFocus({ threadId: "focus", workspace: "/first" })).toBe(false)
    for (let index = 0; index < 100; index++)
      requestChatComposerFocus({ threadId: `focus-${index}`, workspace: "/a" })
    expect(consumeChatComposerFocus({ threadId: "focus-0", workspace: "/a" })).toBe(false)
    expect(consumeChatComposerFocus({ threadId: "focus-99", workspace: "/a" })).toBe(true)
    for (let index = 0; index < 100; index++)
      consumeChatComposerFocus({ threadId: `focus-${index}`, workspace: "/a" })
  } finally {
    vi.unstubAllGlobals()
  }
})

it("consumes only the started selection and preserves a newer explicit intent", () => {
  const first = { workspace: "a", id: "flow", revision: 1, name: "first" }
  const next = { ...first, revision: 2 }
  selectChatFlow("consume", first)
  consumeChatFlowChoice("consume", first)
  expect(currentChatFlowChoice("consume")).toBeNull()
  selectChatFlow("consume", next)
  consumeChatFlowChoice("consume", first)
  expect(currentChatFlowChoice("consume")).toBe(next)
  selectChatFlow("consume", null)
})
