import { useEffect } from "react"
import { createRoot } from "react-dom/client"
import { AppErrorBoundary } from "../../src/renderer/src/components/app/AppErrorBoundary"
import { CloseToTrayDialog } from "../../src/renderer/src/components/app/CloseToTrayDialog"
import { ToolCallRenderer } from "../../src/renderer/src/components/chat/ToolCallRenderer"
import type { ToolCall } from "../../src/renderer/src/types"
import type { CloseToTrayPromptEvent } from "../../src/shared/close-to-tray"

const root = createRoot(document.getElementById("root")!)
let listener: ((event: CloseToTrayPromptEvent) => void) | undefined
const responses: unknown[] = []
Object.defineProperty(window, "electron", {
  value: {
    onCloseToTrayPrompt(callback: typeof listener) {
      listener = callback
      return () => {
        listener = undefined
      }
    },
    respondCloseToTrayPrompt(...args: unknown[]) {
      responses.push(args)
    }
  }
})

export function EffectFailure() {
  useEffect(() => {
    throw new Error("fixture commitHookEffectListMount failure")
  }, [])
  return <div>before effect</div>
}

let generation = 0
const fixture = {
  tool(name: string, args: unknown, result: unknown) {
    root.render(
      <AppErrorBoundary key={++generation}>
        <div data-testid="healthy-sibling">会话仍可操作</div>
        <ToolCallRenderer
          threadId="fixture"
          toolCall={{ id: "fixture-tool", name, args } as ToolCall}
          result={result}
        />
      </AppErrorBoundary>
    )
  },
  failApp() {
    root.render(
      <>
        <AppErrorBoundary key={++generation}>
          <EffectFailure />
        </AppErrorBoundary>
        <CloseToTrayDialog />
      </>
    )
  },
  close() {
    listener?.({
      type: "open",
      requestId: 1,
      trayAreaName: "系统托盘",
      reason: "active-runs",
      canMinimizeToTray: true,
      rememberChoiceAllowed: false
    })
    return Boolean(listener)
  },
  responses
}
Object.assign(window, { whiteScreenFixture: fixture })
export type WhiteScreenFixture = typeof fixture
