import { readFileSync } from "fs"
import { resolve } from "path"
import { describe, expect, it } from "vitest"
import {
  closePromptActionToBehavior,
  isCloseToTrayPromptResponse,
  normalizeWindowCloseBehavior,
  reduceCloseToTrayPrompt,
  resolveWindowCloseRequest,
  type CloseToTrayPromptOpenEvent
} from "../src/shared/close-to-tray"

const readRepositoryFile = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), "utf8")

describe("window close behavior", () => {
  it("normalizes stored values and maps prompt actions", () => {
    expect(normalizeWindowCloseBehavior(undefined)).toBe("ask")
    expect(normalizeWindowCloseBehavior("not-a-behavior")).toBe("ask")
    expect(normalizeWindowCloseBehavior("minimize-to-tray")).toBe("minimize-to-tray")
    expect(closePromptActionToBehavior("minimize-to-tray")).toBe("minimize-to-tray")
    expect(closePromptActionToBehavior("direct-close")).toBe("quit")
    expect(closePromptActionToBehavior("cancel")).toBeNull()
  })

  it("requires an explicit remember flag on every prompt response", () => {
    expect(
      isCloseToTrayPromptResponse({
        requestId: 1,
        action: "direct-close",
        rememberChoice: true
      })
    ).toBe(true)
    expect(isCloseToTrayPromptResponse({ requestId: 1, action: "direct-close" })).toBe(false)
  })

  it("honors quit independently of tray availability", () => {
    expect(
      resolveWindowCloseRequest({
        behavior: "quit",
        isAppQuitting: false,
        trayAvailable: false,
        hasActiveForegroundRuns: false
      })
    ).toEqual({ action: "quit" })
  })

  it("requires a non-suppressible prompt before quitting with active work", () => {
    expect(
      resolveWindowCloseRequest({
        behavior: "quit",
        isAppQuitting: false,
        trayAvailable: true,
        hasActiveForegroundRuns: true
      })
    ).toEqual({ action: "prompt", reason: "active-runs" })
  })

  it("uses an explicit fallback prompt when minimizing is unavailable", () => {
    expect(
      resolveWindowCloseRequest({
        behavior: "minimize-to-tray",
        isAppQuitting: false,
        trayAvailable: false,
        hasActiveForegroundRuns: false
      })
    ).toEqual({ action: "prompt", reason: "tray-unavailable" })
  })

  it("allows the native close while the app is already quitting", () => {
    expect(
      resolveWindowCloseRequest({
        behavior: "ask",
        isAppQuitting: true,
        trayAvailable: true,
        hasActiveForegroundRuns: true
      })
    ).toEqual({ action: "allow-close" })
  })
})

describe("close prompt state", () => {
  const first: CloseToTrayPromptOpenEvent = {
    type: "open",
    requestId: 1,
    trayAreaName: "系统托盘",
    reason: "close-choice",
    canMinimizeToTray: true,
    rememberChoiceAllowed: true
  }

  it("ignores a stale dismiss event", () => {
    expect(reduceCloseToTrayPrompt(null, first)).toBe(first)
    expect(
      reduceCloseToTrayPrompt(first, { type: "dismiss", requestId: 2, reason: "timeout" })
    ).toBe(first)
  })

  it("closes the matching prompt on timeout", () => {
    expect(
      reduceCloseToTrayPrompt(first, { type: "dismiss", requestId: 1, reason: "timeout" })
    ).toBeNull()
  })
})

describe("close behavior UI integration", () => {
  const rendererMain = readRepositoryFile("src/renderer/src/main.tsx")
  const app = readRepositoryFile("src/renderer/src/App.tsx")
  const dialog = readRepositoryFile("src/renderer/src/components/app/CloseToTrayDialog.tsx")
  const generalPanel = readRepositoryFile("src/renderer/src/components/customize/GeneralPanel.tsx")
  const customizeView = readRepositoryFile(
    "src/renderer/src/components/customize/CustomizeView.tsx"
  )

  it("mounts exactly one process-lifetime prompt listener", () => {
    expect(rendererMain.match(/<CloseToTrayDialog\s*\/>/g)).toHaveLength(1)
    expect(app.includes("CloseToTrayDialog")).toBe(false)
    expect(/return\s*\(\)\s*=>[\s\S]{0,300}respondCloseToTrayPrompt/.test(dialog)).toBe(false)
  })

  it("offers remember choice only when the main process allows it", () => {
    expect(dialog.includes("记住我的选择，下次不再询问")).toBe(true)
    expect(dialog.includes("request.rememberChoiceAllowed")).toBe(true)
    expect(dialog.includes("任务运行期间每次退出都需要确认")).toBe(true)
    expect(/respondCloseToTrayPrompt\(activeRequest\.requestId, action, false\)/.test(dialog)).toBe(
      true
    )
  })

  it("does not offer minimize when the tray is unavailable", () => {
    expect(dialog.includes("request.canMinimizeToTray")).toBe(true)
    expect(dialog.includes("当前无法最小化到")).toBe(true)
  })

  it("keeps the close setting unknown and disabled after a load failure", () => {
    expect(generalPanel.includes("useState<WindowCloseBehavior | null>(null)")).toBe(true)
    expect(generalPanel.includes("disabled={loading || saving || closeBehavior === null}")).toBe(
      true
    )
  })

  it("exposes every behavior and a discoverable reset entry", () => {
    expect(
      generalPanel.includes('SelectItem value="ask"') &&
        generalPanel.includes('SelectItem value="minimize-to-tray"') &&
        generalPanel.includes('SelectItem value="quit"')
    ).toBe(true)
    expect(customizeView.includes('{ tab: "general", label: "通用"')).toBe(true)
  })
})
