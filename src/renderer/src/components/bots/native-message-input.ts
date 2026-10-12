import {
  botNativeDesktopMessageKey,
  botNativeDesktopChordKey,
  nativeMessageTextIsValid,
  type NativeDesktopElement,
  type BotNativeDesktopSemanticAction,
  NATIVE_MESSAGE_DRAG_MAX_POINTS,
  type BotNativeDesktopFrame,
  type BotNativeDesktopAction
} from "../../../../shared/bot-native-desktop"

export const NATIVE_MESSAGE_DRAG_DURATION_MS = 2400
export const NATIVE_MESSAGE_DRAG_SAMPLE_MS = 80
export type NativeDragPoint = { x: number; y: number }

/** Preserve the start and requested path. Overflow cancels the local gesture;
 * a silently shortened trajectory must never become a different remote action. */
export function appendNativeDragPoint(
  path: readonly NativeDragPoint[],
  next: NativeDragPoint
): NativeDragPoint[] | null {
  if (
    !Number.isInteger(next.x) ||
    !Number.isInteger(next.y) ||
    next.x < 0 ||
    next.y < 0 ||
    next.x > 4095 ||
    next.y > 4095
  )
    return null
  const last = path.at(-1)
  if (last?.x === next.x && last.y === next.y) return [...path]
  if (path.length >= NATIVE_MESSAGE_DRAG_MAX_POINTS) return null
  return [...path, { ...next }]
}

export type NativeMessageAction = Extract<
  BotNativeDesktopAction,
  { op: "message_pointer" | "message_keyboard" }
>

export type NativeMessageFrame = Pick<
  BotNativeDesktopFrame,
  "width" | "height" | "sourceWidth" | "sourceHeight" | "messageGeometryReady" | "inputTicketIssued"
>

/** Message coordinates address the original capture, never the preview's encoded pixels. */
export function nativeMessagePoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  frame: NativeMessageFrame
): { x: number; y: number } | null {
  const { sourceWidth, sourceHeight } = frame
  if (
    !frame.messageGeometryReady ||
    !frame.inputTicketIssued ||
    sourceWidth == null ||
    sourceHeight == null ||
    !Number.isInteger(sourceWidth) ||
    !Number.isInteger(sourceHeight) ||
    sourceWidth < 1 ||
    sourceHeight < 1 ||
    sourceWidth > 4096 ||
    sourceHeight > 4096 ||
    ![
      clientX,
      clientY,
      rect.left,
      rect.top,
      rect.width,
      rect.height,
      frame.width,
      frame.height
    ].every(Number.isFinite) ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    frame.width <= 0 ||
    frame.height <= 0
  )
    return null
  const scale = Math.min(rect.width / frame.width, rect.height / frame.height)
  const width = frame.width * scale
  const height = frame.height * scale
  const left = rect.left + (rect.width - width) / 2
  const top = rect.top + (rect.height - height) / 2
  if (clientX < left || clientY < top || clientX >= left + width || clientY >= top + height)
    return null
  return {
    x: Math.min(sourceWidth - 1, Math.floor(((clientX - left) / width) * sourceWidth)),
    y: Math.min(sourceHeight - 1, Math.floor(((clientY - top) / height) * sourceHeight))
  }
}

export interface NativeMessageKeyEvent {
  key: string
  isComposing: boolean
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altGraph?: boolean
}
/** Read the local cooked character without converting AltGr/IME into a shortcut.
 * HWND chords are gated separately and never create physical keyboard state. */
export function nativeMessageKey(
  event: NativeMessageKeyEvent,
  messageChords = false
): Extract<NativeMessageAction, { op: "message_keyboard" }> | null {
  if (event.isComposing || event.metaKey) return null
  if (event.altGraph) {
    return Array.from(event.key).length === 1 && nativeMessageTextIsValid(event.key)
      ? { op: "message_keyboard", text: event.key }
      : null
  }
  const basic = botNativeDesktopMessageKey.options.find((key) => key === event.key)
  const chord = event.ctrlKey || event.altKey || (event.shiftKey && basic !== undefined)
  if (chord) {
    if (!messageChords) return null
    const key =
      botNativeDesktopChordKey.options.find((key) => key === event.key.toUpperCase()) ?? basic
    if (
      !key ||
      (event.altKey && ["Tab", "Escape"].includes(key)) ||
      (event.ctrlKey && event.altKey && key === "Delete")
    )
      return null
    const modifiers: ("Control" | "Shift" | "Alt")[] = []
    if (event.ctrlKey) modifiers.push("Control")
    if (event.shiftKey) modifiers.push("Shift")
    if (event.altKey) modifiers.push("Alt")
    return { op: "message_keyboard", key, modifiers }
  }
  if (basic !== undefined) return { op: "message_keyboard", key: basic }
  if (Array.from(event.key).length === 1 && nativeMessageTextIsValid(event.key))
    return { op: "message_keyboard", text: event.key }
  return null
}
/** Only a user-selected complete TextPattern provider may receive the intent.
 * This is semantic selection, not modifier/key delivery, and never replaces
 * Ctrl+A inside the local editor or password inputs. */
export function nativeTextSelectionShortcut(
  event: NativeMessageKeyEvent,
  element: NativeDesktopElement | undefined,
  ready: boolean,
  localEditable: boolean
): BotNativeDesktopSemanticAction | null {
  if (
    !ready ||
    localEditable ||
    event.isComposing ||
    event.altKey ||
    event.shiftKey ||
    event.altGraph ||
    event.ctrlKey === event.metaKey ||
    event.key.toLowerCase() !== "a" ||
    !element ||
    element.password ||
    !element.enabled ||
    element.offscreen ||
    element.valueTruncated ||
    element.value === undefined ||
    !element.supportedActions.includes("select_all_text")
  )
    return null
  return { op: "invoke", elementId: element.id, action: "select_all_text" }
}
/** A local IME commits text into the local draft only. Sending remains explicit,
 * finalized, scalar-valid and bound to the original application ownership. */
export function nativeCommittedMessageText(
  text: string,
  composing: boolean
): Extract<NativeMessageAction, { op: "message_keyboard" }> | null {
  return !composing && nativeMessageTextIsValid(text) ? { op: "message_keyboard", text } : null
}

export interface NativeClick {
  ticket: string
  epoch: number
  x: number
  y: number
}
/** Distinct locations/frames must never be merged into one remote double click. */
export function sameNativeClick(first: NativeClick, next: NativeClick): boolean {
  return (
    first.ticket === next.ticket &&
    first.epoch === next.epoch &&
    Math.abs(first.x - next.x) <= 8 &&
    Math.abs(first.y - next.y) <= 8
  )
}
