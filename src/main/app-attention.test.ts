import { describe, expect, it } from "vitest"
import {
  AppAttentionStore,
  getAgentStreamAttentionKind,
  isAppAttentionPayload,
  isRendererAppAttentionPayload
} from "../shared/app-attention"
import {
  getTrayIconFileName,
  getTrayIconSize,
  shouldHideMainWindowOnClose,
  shouldFlashTaskbar
} from "./app-tray"

describe("app attention events", () => {
  it("validates renderer attention payloads", () => {
    expect(isAppAttentionPayload({ kind: "approval", threadId: "thread-1" })).toBe(true)
    expect(
      isAppAttentionPayload({
        action: "resolve",
        kind: "approval",
        key: "approval:request-1"
      })
    ).toBe(true)
    expect(isAppAttentionPayload({ action: "resolve", kind: "approval" })).toBe(false)
    expect(isAppAttentionPayload({ kind: "unknown" })).toBe(false)
    expect(isAppAttentionPayload({ kind: "task-complete", threadId: 1 })).toBe(false)
  })

  it("maps stream errors but leaves completion to explicit business terminals", () => {
    expect(getAgentStreamAttentionKind({ type: "done" })).toBeNull()
    expect(getAgentStreamAttentionKind({ type: "error" })).toBe("task-error")
    expect(getAgentStreamAttentionKind({ type: "interrupt" })).toBeNull()
    expect(getAgentStreamAttentionKind({ type: "message" })).toBeNull()
  })

  it("limits renderer attention to transient raise events", () => {
    expect(isRendererAppAttentionPayload({ kind: "task-error" })).toBe(true)
    expect(isRendererAppAttentionPayload({ kind: "task-error", key: "renderer:key" })).toBe(false)
    expect(isRendererAppAttentionPayload({ kind: "approval", key: "approval:1" })).toBe(false)
    expect(
      isRendererAppAttentionPayload({
        action: "resolve",
        kind: "task-error",
        key: "error:1"
      })
    ).toBe(false)
  })

  it("keeps pending interactions above later task notifications", () => {
    const store = new AppAttentionStore()
    store.raise({ kind: "approval", key: "approval:1" })
    store.raise({ kind: "task-complete", key: "task:1" })
    expect(store.highestPriority()?.kind).toBe("approval")

    store.resolve("approval:1")
    expect(store.highestPriority()?.kind).toBe("task-complete")
  })

  it("acknowledges transient notices but retains unresolved interactions", () => {
    const store = new AppAttentionStore()
    store.raise({ kind: "user-input", key: "input:1" })
    store.raise({ kind: "task-error", key: "task:1" })
    store.acknowledgeVisible()
    expect(store.highestPriority()?.kind).toBe("user-input")
    store.resolve("input:1")
    expect(store.highestPriority()).toBeNull()
  })

  it("keeps only the newest transient notice of each kind", () => {
    const store = new AppAttentionStore()
    store.raise({ kind: "task-error", key: "error:old" })
    store.raise({ kind: "task-error", key: "error:new" })

    store.resolve("error:new")
    expect(store.highestPriority()).toBeNull()
  })

  it("uses platform-appropriate tray assets and sizes", () => {
    expect(getTrayIconFileName("win32")).toBe("icon.ico")
    expect(getTrayIconFileName("darwin")).toBe("icon.png")
    expect(getTrayIconFileName("linux")).toBe("icon.png")
    expect(getTrayIconSize("win32")).toBe(16)
    expect(getTrayIconSize("darwin")).toBe(22)
    expect(getTrayIconSize("linux")).toBe(24)
  })

  it("keeps macOS attention in the menu bar while flashing taskbars elsewhere", () => {
    expect(shouldFlashTaskbar("win32")).toBe(true)
    expect(shouldFlashTaskbar("linux")).toBe(true)
    expect(shouldFlashTaskbar("darwin")).toBe(false)
  })

  it("hides on close only when the app is not quitting and a tray exists", () => {
    expect(shouldHideMainWindowOnClose(false, true)).toBe(true)
    expect(shouldHideMainWindowOnClose(true, true)).toBe(false)
    expect(shouldHideMainWindowOnClose(false, false)).toBe(false)
  })
})
