import { describe, expect, it } from "vitest"
import {
  botNativeDesktopMessageAction,
  botNativeDesktopMessageKey,
  type BotNativeDesktopFrame,
  type NativeDesktopMessageReviewed
} from "../../shared/bot-native-desktop"
import {
  NativeDesktopMessageReviews,
  nativeDesktopModelFrame,
  nativeDesktopModelMessageAction
} from "./native-desktop-message-review"

const uuid = "12345678-1234-4123-8123-123456789012"
function fixture() {
  // Current broker targets contain worker owner fields as well as public fields.
  const target = {
    backend: "windows-native" as const,
    botId: uuid,
    generation: uuid,
    viewId: uuid,
    controlEpoch: 0,
    control: "bot" as const,
    hostId: "host",
    dataEpoch: "epoch"
  }
  const window = {
    hwnd: "123",
    pid: 42,
    startTicks: "1234",
    sessionId: 1,
    desktop: "CMB-native"
  }
  const full: BotNativeDesktopFrame = {
    ...target,
    frameSeq: 1,
    width: 800,
    height: 600,
    sourceWidth: 1600,
    sourceHeight: 1200,
    inputTicketIssued: true,
    messageGeometryReady: true,
    title: "Editor",
    image: "data:image/jpeg;base64,PRIVATE_IMAGE",
    captureId: uuid,
    frameVersion: "0",
    window,
    capabilities: {
      capture: true,
      semanticInput: true,
      pointerInput: false,
      keyboardInput: false,
      messagePointer: true,
      messageKeyboard: true,
      independentDesktopVerified: false
    }
  }
  const frame = nativeDesktopModelFrame(full)
  const input = {
    frameSeq: 1,
    captureId: uuid,
    frameVersion: "0",
    description: "点击保存按钮",
    action: botNativeDesktopMessageAction.parse({
      op: "message_pointer",
      x: 12,
      y: 15,
      kind: "click"
    })
  }
  const observed: NativeDesktopMessageReviewed = {
    window,
    title: "Editor",
    target: {
      targetHwnd: "124",
      thread: 123,
      geometry: {
        left: 10,
        top: 20,
        width: 1600,
        height: 1200,
        clientLeft: 10,
        clientTop: 44,
        clientWidth: 1600,
        clientHeight: 1176
      }
    }
  }
  return { target, full, frame, input, observed }
}
describe("native window-message model review", () => {
  it("bounds and anchors complete drag paths before any physical review", () => {
    const drag = {
      op: "message_pointer",
      kind: "drag",
      x: 12,
      y: 15,
      path: [
        { x: 12, y: 15 },
        { x: 40, y: 50 }
      ]
    }
    expect(botNativeDesktopMessageAction.safeParse(drag).success).toBe(true)
    for (const invalid of [
      { ...drag, path: undefined },
      { ...drag, path: [{ x: 12, y: 15 }] },
      { ...drag, path: Array.from({ length: 33 }, () => ({ x: 12, y: 15 })) },
      { ...drag, x: 13 },
      { ...drag, delta: 120 },
      { ...drag, kind: "click" },
      {
        ...drag,
        path: [
          { x: 12, y: 15 },
          { x: 4096, y: 50 }
        ]
      }
    ])
      expect(botNativeDesktopMessageAction.safeParse(invalid).success).toBe(false)
  })
  it("maps every path point from the displayed frame and freezes the exact approved trajectory", () => {
    const f = fixture()
    f.frame.capabilities.messageDrag = true
    const submitted = {
      ...f.input,
      action: {
        op: "message_pointer",
        kind: "drag",
        x: 12,
        y: 15,
        path: [
          { x: 12, y: 15 },
          { x: 40, y: 50 },
          { x: 80, y: 75 }
        ]
      }
    }
    const mapped = nativeDesktopModelMessageAction(f.target, submitted, f.frame)
    expect(mapped.action).toMatchObject({
      x: 24,
      y: 30,
      path: [
        { x: 24, y: 30 },
        { x: 80, y: 100 },
        { x: 160, y: 150 }
      ]
    })
    const reviews = new NativeDesktopMessageReviews()
    const capability = reviews.freeze({
      ...mapped,
      target: f.target,
      frame: f.frame,
      observed: f.observed
    })
    expect(Object.isFrozen(capability.context.action)).toBe(true)
    expect(Object.isFrozen((capability.context.action as { path: unknown[] }).path[1])).toBe(true)
    expect(() =>
      reviews.require(
        f.target,
        {
          ...submitted,
          action: {
            ...submitted.action,
            path: [
              { x: 12, y: 15 },
              { x: 41, y: 50 },
              { x: 80, y: 75 }
            ]
          }
        },
        f.frame,
        capability
      )
    ).toThrow()
    expect(() =>
      nativeDesktopModelMessageAction(f.target, submitted, {
        ...f.frame,
        capabilities: { ...f.frame.capabilities, messageDrag: undefined }
      })
    ).toThrow()
    expect(() =>
      nativeDesktopModelMessageAction(
        f.target,
        {
          ...submitted,
          action: {
            ...submitted.action,
            path: [
              { x: 12, y: 15 },
              { x: 800, y: 50 }
            ]
          }
        },
        f.frame
      )
    ).toThrow()
  })
  it("maps displayed preview pixels once and never retains image payload in review", () => {
    const f = fixture()
    const mapped = nativeDesktopModelMessageAction(f.target, f.input, f.frame)
    expect(mapped.action).toMatchObject({ x: 24, y: 30 })
    expect(f.frame).not.toHaveProperty("image")
    const reviews = new NativeDesktopMessageReviews()
    const capability = reviews.freeze({
      ...mapped,
      target: f.target,
      frame: f.frame,
      observed: f.observed
    })
    expect(JSON.stringify(capability.context)).not.toContain("PRIVATE_IMAGE")
    expect(capability.context.frame.coordinateSpace).toBe("preview")
    expect(capability.context.effectVerified).toBe(false)
    expect(reviews.require(f.target, f.input, f.frame, capability).action).toEqual(mapped.action)
    expect(Object.isFrozen(capability.context.observation.target.geometry)).toBe(true)
  })
  it.each([
    "frameSeq",
    "captureId",
    "frameVersion",
    "generation",
    "controlEpoch",
    "viewId",
    "control"
  ] as const)("rejects a changed displayed frame or ownership identity (%s)", (field) => {
    const f = fixture()
    const changed = { ...f.frame, target: { ...f.frame.target } }
    if (field === "frameSeq") changed.frameSeq++
    if (field === "captureId") changed.captureId = "87654321-4321-4321-8321-210987654321"
    if (field === "frameVersion") changed.frameVersion = "1"
    if (field === "generation" || field === "viewId")
      changed.target[field] = "87654321-4321-4321-8321-210987654321"
    if (field === "controlEpoch") changed.target.controlEpoch++
    if (field === "control") changed.target.control = "human"
    expect(() => nativeDesktopModelMessageAction(f.target, f.input, changed)).toThrow()
  })
  it("requires a physically actionable issued frame and bounded coordinates", () => {
    const f = fixture()
    for (const frame of [
      undefined,
      { ...f.frame, inputTicketIssued: false },
      { ...f.frame, messageGeometryReady: false },
      { ...f.frame, sourceWidth: undefined },
      {
        ...f.frame,
        capabilities: { ...f.frame.capabilities, messagePointer: false }
      }
    ])
      expect(() => nativeDesktopModelMessageAction(f.target, f.input, frame)).toThrow()
    expect(() =>
      nativeDesktopModelMessageAction(
        f.target,
        { ...f.input, action: { ...f.input.action, x: 800 } },
        f.frame
      )
    ).toThrow()
    expect(() =>
      nativeDesktopModelMessageAction(
        f.target,
        { ...f.input, action: { ...f.input.action, x: 700 } },
        { ...f.frame, sourceWidth: 8192 }
      )
    ).toThrow()
  })
  it("rejects changed purpose/action/physical target and consumes its private capability", () => {
    const f = fixture(),
      reviews = new NativeDesktopMessageReviews()
    const mapped = nativeDesktopModelMessageAction(f.target, f.input, f.frame)
    const capability = reviews.freeze({
      ...mapped,
      target: f.target,
      frame: f.frame,
      observed: f.observed
    })
    expect(() =>
      reviews.require(f.target, { ...f.input, description: "删除所有数据" }, f.frame, capability)
    ).toThrow()
    expect(() =>
      reviews.require(
        f.target,
        { ...f.input, action: { ...f.input.action, x: 13 } },
        f.frame,
        capability
      )
    ).toThrow()
    expect(() =>
      reviews.require(
        f.target,
        f.input,
        { ...f.frame, window: { ...f.frame.window, hwnd: "999" } },
        capability
      )
    ).toThrow()
    expect(() =>
      reviews.require(f.target, f.input, f.frame, {
        context: capability.context
      })
    ).toThrow()
    reviews.discard(capability)
    expect(() => reviews.require(f.target, f.input, f.frame, capability)).toThrow()
  })
  it("binds one function key to its original reviewed frame without granting full keyboard capability", () => {
    const f = fixture(),
      reviews = new NativeDesktopMessageReviews()
    const input = {
      ...f.input,
      description: "向原窗口发送 F5 并核对画面",
      action: { op: "message_keyboard" as const, key: "F5" as const }
    }
    const mapped = nativeDesktopModelMessageAction(f.target, input, f.frame)
    const capability = reviews.freeze({
      ...mapped,
      target: f.target,
      frame: f.frame,
      observed: f.observed
    })
    expect(f.frame.capabilities.keyboardInput).toBe(false)
    expect(capability.context.effectVerified).toBe(false)
    expect(reviews.require(f.target, input, f.frame, capability).action).toEqual(input.action)
    expect(() =>
      reviews.require(
        f.target,
        { ...input, action: { ...input.action, key: "F6" } },
        f.frame,
        capability
      )
    ).toThrow()
    expect(() =>
      nativeDesktopModelMessageAction(f.target, input, {
        ...f.frame,
        capabilities: { ...f.frame.capabilities, messageKeyboard: false }
      })
    ).toThrow()
    reviews.discard(capability)
    expect(() => reviews.require(f.target, input, f.frame, capability)).toThrow()
  })
  it("retains the worker's basic single keys and rejects untyped chords, target IME, dual input and secrets through extras", () => {
    expect(botNativeDesktopMessageKey.options.slice(0, 15)).toEqual([
      "Enter",
      "Tab",
      "Escape",
      "Backspace",
      "Space",
      "Insert",
      "Delete",
      "ArrowLeft",
      "ArrowUp",
      "ArrowRight",
      "ArrowDown",
      "Home",
      "End",
      "PageUp",
      "PageDown"
    ])
    expect(botNativeDesktopMessageKey.options).toHaveLength(27)
    for (const key of botNativeDesktopMessageKey.options)
      expect(botNativeDesktopMessageAction.safeParse({ op: "message_keyboard", key }).success).toBe(
        true
      )
    for (const key of ["Ctrl+A", "Alt+F4", "Shift+F1", "F13", "f1", "a", "IME", ""]) {
      expect(botNativeDesktopMessageAction.safeParse({ op: "message_keyboard", key }).success).toBe(
        false
      )
    }
    for (const input of [
      { key: "Enter", text: "x" },
      {},
      { text: "a\0b" },
      { text: "\ud800" },
      { text: "\udc00" },
      { text: "x", modifiers: ["Control"] },
      { key: "A", modifiers: ["Control", "Control"] },
      { key: "A", modifiers: ["Shift", "Control"] },
      { key: "A", modifiers: ["Meta"] },
      { key: "Delete", modifiers: ["Control", "Alt"] },
      { key: "Tab", modifiers: ["Alt"] },
      { text: "x".repeat(4097) },
      { text: "x", password: true },
      { text: "x", shell: "anything" }
    ])
      expect(
        botNativeDesktopMessageAction.safeParse({
          op: "message_keyboard",
          ...input
        }).success
      ).toBe(false)
  })
  it("requires the separate HWND chord capability and binds every modifier to the original review", () => {
    const f = fixture()
    const frame = { ...f.frame, capabilities: { ...f.frame.capabilities, messageChords: true } }
    const submitted = {
      frameSeq: frame.frameSeq,
      captureId: frame.captureId,
      frameVersion: frame.frameVersion,
      description: "保存当前文档",
      action: { op: "message_keyboard", key: "S", modifiers: ["Control"] }
    }
    expect(() => nativeDesktopModelMessageAction(f.target, submitted, f.frame)).toThrow()
    const mapped = nativeDesktopModelMessageAction(f.target, submitted, frame)
    const reviews = new NativeDesktopMessageReviews()
    const review = reviews.freeze({ ...mapped, target: f.target, frame, observed: f.observed })
    expect(reviews.require(f.target, submitted, frame, review).action).toEqual(submitted.action)
    expect(frame.capabilities.keyboardInput).toBe(false)
    expect(() =>
      reviews.require(
        f.target,
        { ...submitted, action: { ...submitted.action, modifiers: ["Control", "Shift"] } },
        frame,
        review
      )
    ).toThrow()
    expect(() =>
      reviews.require(
        { ...f.target, controlEpoch: f.target.controlEpoch + 1 },
        submitted,
        frame,
        review
      )
    ).toThrow()
    reviews.discard(review)
    expect(() => reviews.require(f.target, submitted, frame, review)).toThrow()
  })
})
