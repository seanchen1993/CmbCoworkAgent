import { BotDomainError } from "../../shared/bot-types"
import {
  botNativeDesktopModelMessageInput,
  type BotNativeDesktopFrame,
  type BotNativeDesktopMessageAction,
  type BotNativeDesktopModelMessageInput,
  type BotNativeDesktopTarget,
  type NativeDesktopMessageReviewed
} from "../../shared/bot-native-desktop"
import { canonicalJson } from "./validation"

/** Images go to the existing multimodal ToolMessage, never to approval/effect
 * JSON or retained broker review state. Only the last published ticket is held. */
function modelTarget(target: BotNativeDesktopTarget): BotNativeDesktopTarget {
  return {
    backend: target.backend,
    botId: target.botId,
    ...(target.taskRunId !== undefined ? { taskRunId: target.taskRunId } : {}),
    viewId: target.viewId,
    generation: target.generation,
    controlEpoch: target.controlEpoch,
    control: target.control
  }
}
export function nativeDesktopModelFrame(frame: BotNativeDesktopFrame) {
  return {
    target: modelTarget(frame),
    window: { ...frame.window },
    title: frame.title,
    frameSeq: frame.frameSeq,
    captureId: frame.captureId,
    frameVersion: frame.frameVersion,
    width: frame.width,
    height: frame.height,
    ...(frame.sourceWidth !== undefined ? { sourceWidth: frame.sourceWidth } : {}),
    ...(frame.sourceHeight !== undefined ? { sourceHeight: frame.sourceHeight } : {}),
    coordinateSpace: "preview" as const,
    inputTicketIssued: frame.inputTicketIssued,
    messageGeometryReady: frame.messageGeometryReady,
    capabilities: { ...frame.capabilities }
  }
}
export type NativeDesktopModelFrame = ReturnType<typeof nativeDesktopModelFrame>

/** Match the model's displayed frame before any authority-bearing review. */
export function nativeDesktopModelMessageAction(
  target: BotNativeDesktopTarget,
  submitted: unknown,
  frame: NativeDesktopModelFrame | undefined
): {
  input: BotNativeDesktopModelMessageInput
  action: BotNativeDesktopMessageAction
} {
  const input = botNativeDesktopModelMessageInput.parse(submitted)
  if (
    !frame ||
    frame.frameSeq !== input.frameSeq ||
    frame.captureId !== input.captureId ||
    frame.frameVersion !== input.frameVersion ||
    canonicalJson(frame.target) !== canonicalJson(modelTarget(target))
  )
    throw new BotDomainError("native_review_changed", "画面已变化，请重新截图后选择操作")
  const action = input.action
  if (
    !frame.inputTicketIssued ||
    !frame.messageGeometryReady ||
    !frame.sourceWidth ||
    !frame.sourceHeight ||
    (action.op === "message_pointer" && !frame.capabilities.messagePointer) ||
    (action.op === "message_pointer" &&
      action.kind === "drag" &&
      frame.capabilities.messageDrag !== true) ||
    (action.op === "message_keyboard" &&
      (!frame.capabilities.messageKeyboard ||
        (action.modifiers !== undefined && frame.capabilities.messageChords !== true)))
  )
    throw new BotDomainError(
      "native_input_unavailable",
      "当前画面不能执行窗口消息输入，请使用应用控件"
    )
  if (action.op === "message_keyboard") return { input, action }
  const { sourceWidth, sourceHeight } = frame
  const point = (position: { x: number; y: number }) => {
    if (position.x >= frame.width || position.y >= frame.height)
      throw new BotDomainError("native_input_point", "坐标超出截图范围")
    const x = Math.floor((position.x * sourceWidth) / frame.width)
    const y = Math.floor((position.y * sourceHeight) / frame.height)
    if (x > 4095 || y > 4095)
      throw new BotDomainError(
        "native_input_point",
        "该坐标超出当前窗口消息输入范围，请使用应用控件"
      )
    return { x, y }
  }
  const start = point(action)
  return {
    input,
    action: { ...action, ...start, ...(action.path ? { path: action.path.map(point) } : {}) }
  }
}

export interface NativeDesktopMessageReview {
  readonly context: {
    backend: "windows-native"
    transport: "window-messages"
    effectVerified: false
    target: BotNativeDesktopTarget
    description: string
    action: BotNativeDesktopMessageAction
    displayedAction: BotNativeDesktopMessageAction
    frame: NativeDesktopModelFrame
    observation: NativeDesktopMessageReviewed
  }
}
export interface FrozenNativeDesktopMessageReview {
  target: BotNativeDesktopTarget
  input: BotNativeDesktopModelMessageInput
  action: BotNativeDesktopMessageAction
  frame: NativeDesktopModelFrame
  observed: NativeDesktopMessageReviewed
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

/** An unforgeable single-operation capability. All comparisons use the exact
 * scope/action/ticket; description is untrusted purpose, never authorization. */
export class NativeDesktopMessageReviews {
  private readonly entries = new WeakMap<
    NativeDesktopMessageReview,
    FrozenNativeDesktopMessageReview
  >()
  freeze(review: FrozenNativeDesktopMessageReview): NativeDesktopMessageReview {
    const frozen = deepFreeze(
      JSON.parse(JSON.stringify(review)) as FrozenNativeDesktopMessageReview
    )
    const capability = Object.freeze({
      context: deepFreeze({
        backend: "windows-native" as const,
        transport: "window-messages" as const,
        effectVerified: false as const,
        target: frozen.target,
        description: frozen.input.description,
        action: frozen.action,
        displayedAction: frozen.input.action,
        frame: frozen.frame,
        observation: frozen.observed
      })
    })
    this.entries.set(capability, frozen)
    return capability
  }
  require(
    target: BotNativeDesktopTarget,
    submitted: unknown,
    frame: NativeDesktopModelFrame | undefined,
    capability: NativeDesktopMessageReview
  ): FrozenNativeDesktopMessageReview {
    const current = nativeDesktopModelMessageAction(target, submitted, frame)
    const frozen = this.entries.get(capability)
    if (
      !frozen ||
      canonicalJson(frozen.target) !== canonicalJson(target) ||
      canonicalJson(frozen.input) !== canonicalJson(current.input) ||
      canonicalJson(frozen.action) !== canonicalJson(current.action) ||
      canonicalJson(frozen.frame) !== canonicalJson(frame)
    )
      throw new BotDomainError("native_review_changed", "批准的原生窗口、画面或操作已变化")
    return frozen
  }
  discard(capability: NativeDesktopMessageReview): void {
    this.entries.delete(capability)
  }
}
