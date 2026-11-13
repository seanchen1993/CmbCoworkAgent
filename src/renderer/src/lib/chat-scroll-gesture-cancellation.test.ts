import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { describe, expect, it, vi } from "vitest"
import {
  createChatScrollState,
  transitionChatScroll,
  type ChatScrollEvent
} from "../../../shared/chat-scroll-controller"

// Execute the actual component callbacks with a delayed native scroll event. Rendering a
// synthetic wheel alone cannot model the browser moving its viewport between animation frames.
const source = ts.createSourceFile(
  "ChatContainer.tsx",
  readFileSync(new URL("../components/chat/ChatContainer.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true
)
const gestureSource = ts.createSourceFile(
  "chat-scroll-gesture.ts",
  readFileSync(new URL("../components/chat/chat-scroll-gesture.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true
)
const gestureHelpers = gestureSource.statements
  .filter(ts.isFunctionDeclaration)
  .map((node) => node.getText(gestureSource).replace(/^export\s+/, ""))
const names = [
  "clearSessionRestore",
  "clearHistoryRestore",
  "runChatScrollTransition",
  "dispatchChatScrollEvent",
  "cancelPendingHistoryAnchorFromUserGesture",
  "recordDirectionalScrollGesture",
  "detachFromExplicitWheel",
  "rememberTouchPosition",
  "detachFromTouchScroll",
  "detachFromKeyboardScroll"
]
const callbacks = new Map<string, string>()
const visit = (node: ts.Node): void => {
  if (
    ts.isVariableDeclaration(node) &&
    names.includes(node.name.getText(source)) &&
    node.initializer
  ) {
    const expression = ts.isCallExpression(node.initializer)
      ? node.initializer.arguments[0]
      : node.initializer
    callbacks.set(node.name.getText(source), expression.getText(source))
  }
  ts.forEachChild(node, visit)
}
visit(source)
const compiled = ts.transpileModule(
  gestureHelpers.join("\n") +
    "\n" +
    names
      .map((name) => {
        const callback = callbacks.get(name)
        if (!callback) throw Error("Missing actual scroll callback: " + name)
        return `const ${name}=${callback}`
      })
      .join("\n") +
    `
let lastTouchY = null
const handlers = {wheel: detachFromExplicitWheel, touchStart: rememberTouchPosition,
  touch: detachFromTouchScroll, key: detachFromKeyboardScroll}
handlers`,
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }
).outputText

class ScrollElement {
  scrollTop = 0
  clientHeight = 600
  scrollHeight = 5000
  overflowY = "auto"
  overscrollBehaviorY = "auto"
  isContentEditable = false
  ownerDocument = { defaultView: { getComputedStyle: (element: ScrollElement) => element } }
  closest(): null {
    return null
  }
}

function fixture(top: number) {
  const state = {
    current: transitionChatScroll(createChatScrollState("chat"), {
      type: "DATA_READY",
      messageCount: 160
    }).state
  }
  const viewport = new ScrollElement()
  viewport.scrollTop = top
  const queued = new Map([
    [
      1,
      () => {
        viewport.scrollTop = 4400
      }
    ]
  ])
  const frame = { current: 1 as number | null }
  const pending = { current: { reason: "initial-position", generation: state.current.generation } }
  const sessionAnchor = { current: { messageId: "old-position" } as object | null }
  const durableAnchor = { current: null as { generation: number } | null }
  const clearPresentationWait = vi.fn()
  const invalidateReveal = vi.fn()
  const cancelNativePosition = vi.fn(),
    releaseSessionAnchor = vi.fn()
  const callbacks = runInNewContext(compiled, {
    chatScrollStateRef: state,
    pendingBottomScrollEffectRef: pending,
    bottomScrollFrameRef: frame,
    pendingChatSessionAnchorRef: sessionAnchor,
    correctSessionAnchorLayoutRef: { current: null },
    sessionRestorePositionRef: { current: null },
    setSessionRestoreSeed: vi.fn(),
    releaseSessionAnchorRef: { current: releaseSessionAnchor },
    pendingDurableHistoryAnchorRef: durableAnchor,
    correctHistoryAnchorLayoutRef: { current: null },
    releaseHistoryAnchorRef: { current: null },
    virtuosoRef: { current: { cancelScrollToIndex: cancelNativePosition } },
    upwardUserScrollIntentUntilRef: { current: 0 },
    downwardUserScrollIntentUntilRef: { current: 0 },
    CHAT_USER_SCROLL_INTENT_WINDOW_MS: 250,
    performance: { now: () => 100 },
    scrollParent: viewport,
    bottomPresentationWait: { clear: clearPresentationWait },
    invalidateDurableMessageReveal: invalidateReveal,
    window: {
      cancelAnimationFrame: (id: number) => queued.delete(id),
      getComputedStyle: (target: ScrollElement) => target
    },
    HTMLElement: ScrollElement,
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    document: { activeElement: viewport },
    chatRootRef: { current: { offsetParent: {}, contains: () => true } },
    useAppStore: { getState: () => ({ showCustomizeView: false }) },
    isChatScrollDetached: (value: typeof state.current) => value.mode === "detached",
    applyChatScrollEvent: (event: ChatScrollEvent) => {
      const transition = transitionChatScroll(state.current, event)
      state.current = transition.state
      return transition
    },
    scheduleBottomScrollEffect: () => {
      throw Error("User navigation must not reschedule bottom")
    }
  }) as Record<"wheel" | "touchStart" | "touch" | "key", (event: object) => void>
  const gesture = (kind: "wheel" | "touch" | "key", deltaY: number, nested?: ScrollElement) => {
    const event = {
      target: nested ?? viewport,
      composedPath: () => (nested ? [nested, viewport] : [viewport])
    }
    if (kind === "wheel") callbacks.wheel({ ...event, deltaY })
    else if (kind === "key") callbacks.key({ ...event, key: deltaY < 0 ? "PageUp" : "PageDown" })
    else {
      callbacks.touchStart({ ...event, touches: [{ clientY: 100 }] })
      callbacks.touch({ ...event, touches: [{ clientY: 100 - deltaY }] })
    }
  }
  return {
    gesture,
    state,
    viewport,
    pending,
    sessionAnchor,
    clearPresentationWait,
    cancelNativePosition,
    releaseSessionAnchor,
    flushFrames: () => {
      for (const run of queued.values()) run()
    }
  }
}

describe("user input during pending chat positioning", () => {
  it.each(["wheel", "touch", "key"] as const)("%s yields before a delayed scroll event", (kind) => {
    for (const deltaY of [-1050, 1050]) {
      const f = fixture(2000)
      f.gesture(kind, deltaY)
      f.viewport.scrollTop += deltaY
      f.flushFrames()
      expect(f.viewport.scrollTop).toBe(2000 + deltaY)
      expect(f.state.current.mode).toBe("detached")
      expect(f.state.current.programmaticScrollGuard).toBe(false)
      expect(f.pending.current).toBeNull()
      expect(f.sessionAnchor.current).toBeNull()
      expect(f.clearPresentationWait).toHaveBeenCalled()
      expect(f.cancelNativePosition).toHaveBeenCalledOnce()
      expect(f.releaseSessionAnchor).toHaveBeenCalledOnce()
      const growth = transitionChatScroll(f.state.current, { type: "CONTENT_GROWN" })
      expect(growth.effects).toEqual([])
      expect(growth.state.hasUnread).toBe(true)
    }
  })

  it.each([
    [0, -1050],
    [4400, 1050]
  ])("does not detach a nonmoving boundary gesture at %s with delta %s", (top, deltaY) => {
    const f = fixture(top)
    f.gesture("wheel", deltaY)
    expect(f.state.current.mode).toBe("initializing")
    expect(f.pending.current).not.toBeNull()
    expect(f.clearPresentationWait).not.toHaveBeenCalled()
  })

  it.each(["wheel", "touch", "key"] as const)(
    "%s leaves a nested scrollable pane in control",
    (kind) => {
      const f = fixture(2000)
      const nested = new ScrollElement()
      nested.scrollTop = 1000
      for (const deltaY of [-1050, 1050]) {
        f.gesture(kind, deltaY, nested)
        expect(f.pending.current).not.toBeNull()
        expect(f.state.current.mode).toBe("initializing")
        expect(f.sessionAnchor.current).not.toBeNull()
      }
      nested.scrollTop = 0
      nested.overscrollBehaviorY = "contain"
      f.gesture(kind, -1050, nested)
      expect(f.pending.current).not.toBeNull()
      nested.overscrollBehaviorY = "auto"
      f.gesture(kind, -1050, nested)
      expect(f.pending.current).toBeNull()
      expect(f.state.current.mode).toBe("detached")
    }
  )
})
