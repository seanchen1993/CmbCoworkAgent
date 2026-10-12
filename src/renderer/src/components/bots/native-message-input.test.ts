import { describe, expect, it } from "vitest"
import {
  appendNativeDragPoint,
  nativeMessageKey,
  nativeTextSelectionShortcut,
  nativeCommittedMessageText,
  nativeMessagePoint,
  sameNativeClick,
  type NativeMessageFrame
} from "./native-message-input"

const frame: NativeMessageFrame = {
  width: 800,
  height: 600,
  sourceWidth: 1600,
  sourceHeight: 1200,
  inputTicketIssued: true,
  messageGeometryReady: true
}
const rect = { left: 20, top: 40, width: 400, height: 300 }
const key = (value: string, modifiers: Partial<Parameters<typeof nativeMessageKey>[0]> = {}) =>
  nativeMessageKey({
    key: value,
    isComposing: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers
  })

describe("native window message view mapping", () => {
  it("retains the exact drag start/end and rejects overflow or invalid samples", () => {
    const path = [
      { x: 10, y: 20 },
      { x: 30, y: 40 }
    ]
    expect(appendNativeDragPoint(path, { x: 30, y: 40 })).toEqual(path)
    expect(appendNativeDragPoint(path, { x: 50, y: 60 })).toEqual([...path, { x: 50, y: 60 }])
    expect(path).toHaveLength(2)
    const full = Array.from({ length: 32 }, (_, x) => ({ x, y: 20 }))
    expect(appendNativeDragPoint(full, { x: 100, y: 20 })).toBeNull()
    for (const next of [
      { x: -1, y: 20 },
      { x: 4096, y: 20 },
      { x: 1.5, y: 20 },
      { x: NaN, y: 20 }
    ])
      expect(appendNativeDragPoint(path, next)).toBeNull()
  })
  it("maps a displayed image into the original source dimensions, not encoded preview pixels", () => {
    expect(nativeMessagePoint(220, 190, rect, frame)).toEqual({ x: 800, y: 600 })
    expect(nativeMessagePoint(419.9, 339.9, rect, frame)).toEqual({ x: 1599, y: 1199 })
  })
  it("excludes letterbox space and outside points rather than clamping a click into the app", () => {
    const wide = { left: 0, top: 0, width: 800, height: 300 }
    expect(nativeMessagePoint(10, 150, wide, frame)).toBeNull()
    expect(nativeMessagePoint(400, 150, wide, frame)).toEqual({ x: 800, y: 600 })
    expect(nativeMessagePoint(420, 190, rect, frame)).toBeNull()
    expect(nativeMessagePoint(220, 340, rect, frame)).toBeNull()
  })
  it("requires a real issued input ticket, trusted geometry and explicit bounded source dimensions", () => {
    for (const change of [
      { inputTicketIssued: false },
      { messageGeometryReady: false },
      { sourceWidth: undefined },
      { sourceHeight: undefined },
      { sourceWidth: 4097 },
      { sourceHeight: 0 }
    ])
      expect(nativeMessagePoint(220, 190, rect, { ...frame, ...change })).toBeNull()
    expect(nativeMessagePoint(NaN, 190, rect, frame)).toBeNull()
    expect(nativeMessagePoint(220, 190, { ...rect, width: 0 }, frame)).toBeNull()
  })
  it("does not turn unsupported modifiers or composition into an unmodified remote key", () => {
    expect(key("Tab", { shiftKey: true })).toBeNull()
    expect(key("a", { ctrlKey: true })).toBeNull()
    expect(key("Escape", { ctrlKey: true, altKey: true })).toBeNull()
    expect(key("a", { isComposing: true })).toBeNull()
    expect(key("Process")).toBeNull()
    expect(key("\0")).toBeNull()
  })
  it("supports the exact worker key subset and literal unicode without claiming IME/global keyboard support", () => {
    expect(key("Enter")).toEqual({ op: "message_keyboard", key: "Enter" })
    expect(key("ArrowLeft")).toEqual({ op: "message_keyboard", key: "ArrowLeft" })
    expect(key("A", { shiftKey: true })).toEqual({ op: "message_keyboard", text: "A" })
    expect(key("中")).toEqual({ op: "message_keyboard", text: "中" })
    expect(key("🙂")).toEqual({ op: "message_keyboard", text: "🙂" })
  })
  it("allows only unmodified function keys and never drops modifiers or composition", () => {
    for (let number = 1; number <= 12; number++) {
      const functionKey = `F${number}`
      expect(key(functionKey)).toEqual({ op: "message_keyboard", key: functionKey })
      for (const modifier of ["ctrlKey", "altKey", "metaKey", "shiftKey", "isComposing"] as const)
        expect(key(functionKey, { [modifier]: true })).toBeNull()
    }
    for (const unsupported of ["F0", "F13", "f1", "Ctrl+F5", "Alt+F4", "Shift+F12"])
      expect(key(unsupported)).toBeNull()
  })
  it("merges clicks only near the same source point and on the exact displayed ticket and visibility epoch", () => {
    const first = { ticket: "surface:generation:epoch:view:seq1", epoch: 3, x: 100, y: 200 }
    expect(sameNativeClick(first, { ...first, x: 108, y: 192 })).toBe(true)
    expect(sameNativeClick(first, { ...first, x: 109 })).toBe(false)
    expect(sameNativeClick(first, { ...first, ticket: "surface:generation:epoch:view:seq2" })).toBe(
      false
    )
    expect(sameNativeClick(first, { ...first, epoch: 4 })).toBe(false)
  })
})

describe("scoped native shortcuts and committed local Unicode", () => {
  const event = (changes: Partial<Parameters<typeof nativeMessageKey>[0]> = {}) => ({
    key: "a",
    isComposing: false,
    ctrlKey: true,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...changes
  })
  const selected = {
    id: "selected-control",
    name: "备注",
    controlType: "Edit",
    value: "hello 中文",
    password: false,
    enabled: true,
    offscreen: false,
    depth: 1,
    valueTruncated: false,
    supportedActions: ["set_value", "select_all_text"] as ("set_value" | "select_all_text")[]
  }
  it("maps Ctrl+A/Cmd+A only to an explicitly selected complete UIA text provider", () => {
    const action = { op: "invoke", elementId: selected.id, action: "select_all_text" }
    expect(nativeTextSelectionShortcut(event(), selected, true, false)).toEqual(action)
    expect(
      nativeTextSelectionShortcut(event({ ctrlKey: false, metaKey: true }), selected, true, false)
    ).toEqual(action)
    for (const element of [
      undefined,
      { ...selected, password: true },
      { ...selected, value: undefined },
      { ...selected, valueTruncated: true },
      { ...selected, offscreen: true },
      { ...selected, enabled: false },
      { ...selected, supportedActions: [] }
    ])
      expect(nativeTextSelectionShortcut(event(), element, true, false)).toBeNull()
    expect(nativeTextSelectionShortcut(event(), selected, false, false)).toBeNull()
    expect(nativeTextSelectionShortcut(event(), selected, true, true)).toBeNull()
    for (const changes of [
      { ctrlKey: false },
      { altKey: true },
      { shiftKey: true },
      { isComposing: true },
      { metaKey: true },
      { key: "c" }
    ])
      expect(nativeTextSelectionShortcut(event(changes), selected, true, false)).toBeNull()
  })
  it("never drops modifiers or emits system/secure chords and requires the worker capability", () => {
    expect(nativeMessageKey(event())).toBeNull()
    expect(nativeMessageKey(event(), true)).toEqual({
      op: "message_keyboard",
      key: "A",
      modifiers: ["Control"]
    })
    expect(nativeMessageKey(event({ key: "z", shiftKey: true }), true)).toEqual({
      op: "message_keyboard",
      key: "Z",
      modifiers: ["Control", "Shift"]
    })
    expect(nativeMessageKey(event({ key: "F4", ctrlKey: false, altKey: true }), true)).toEqual({
      op: "message_keyboard",
      key: "F4",
      modifiers: ["Alt"]
    })
    expect(nativeMessageKey(event({ key: "Tab", ctrlKey: false, shiftKey: true }), true)).toEqual({
      op: "message_keyboard",
      key: "Tab",
      modifiers: ["Shift"]
    })
    for (const changes of [
      { key: "Delete", altKey: true },
      { key: "Tab", ctrlKey: false, altKey: true },
      { key: "Escape", ctrlKey: false, altKey: true },
      { metaKey: true },
      { isComposing: true }
    ])
      expect(nativeMessageKey(event(changes), true)).toBeNull()
    expect(nativeMessageKey(event({ key: "€", altKey: true, altGraph: true }), true)).toEqual({
      op: "message_keyboard",
      text: "€"
    })
  })
  it("keeps Unicode composition local until completion and rejects malformed/oversized scalar text", () => {
    expect(nativeCommittedMessageText("中文🙂", true)).toBeNull()
    expect(nativeCommittedMessageText("中文🙂", false)).toEqual({
      op: "message_keyboard",
      text: "中文🙂"
    })
    for (const text of ["", "a\0b", "\ud800", "\udc00", "x".repeat(4097), "🙂".repeat(2049)])
      expect(nativeCommittedMessageText(text, false)).toBeNull()
    expect(nativeCommittedMessageText("🙂".repeat(2048), false)?.text).toHaveLength(4096)
  })
})
