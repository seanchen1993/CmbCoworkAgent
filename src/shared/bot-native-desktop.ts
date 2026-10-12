import { z } from "zod"
import type { BotBrowserTarget } from "./bot-computer"

export const BOT_NATIVE_DESKTOP_PROTOCOL = "cmb-native-desktop-v1" as const
export const BOT_NATIVE_DESKTOP_INPUT_BYTES = 64 * 1024
export const BOT_NATIVE_DESKTOP_OUTPUT_BYTES = 8 * 1024 * 1024
const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\w:.-]+$/)
const uuid = z.string().uuid()
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const pid = z.number().int().positive().max(0x7fffffff)
const decimal = z.string().regex(/^[1-9][0-9]{0,18}$/)
const hwnd = z.string().regex(/^-?[1-9][0-9]{0,18}$/)
const boundedText = z
  .string()
  .max(512)
  .refine((value) => !value.includes("\0"))

export const nativeDesktopScope = z
  .object({
    hostId: id,
    dataEpoch: id,
    botId: id,
    taskRunId: id.nullish(),
    generation: uuid,
    controlEpoch: counter,
    control: z.enum(["bot", "human", "handoff"])
  })
  .strict()
  .transform(({ taskRunId, ...scope }) => ({
    ...scope,
    ...(taskRunId == null ? {} : { taskRunId })
  }))
export type NativeDesktopScope = z.infer<typeof nativeDesktopScope>
export const nativeDesktopWindow = z
  .object({
    hwnd,
    pid,
    startTicks: decimal,
    sessionId: z.number().int().nonnegative().max(0xffffffff),
    desktop: boundedText.min(1)
  })
  .strict()
export type NativeDesktopWindow = z.infer<typeof nativeDesktopWindow>

export const nativeDesktopCapabilities = z
  .object({
    capture: z.boolean(),
    semanticInput: z.boolean(),
    pointerInput: z.literal(false),
    keyboardInput: z.literal(false),
    messagePointer: z.boolean(),
    messageDrag: z.boolean().optional(),
    messageKeyboard: z.boolean(),
    /** Limited HWND message sequences; never physical input, RawInput or target IME. */
    messageChords: z.boolean().optional(),
    // This worker does not attest a Windows acceptance result. Production admission
    // additionally needs the trusted installation/runtime verification gate.
    independentDesktopVerified: z.literal(false)
  })
  .strict()
export type NativeDesktopCapabilities = z.infer<typeof nativeDesktopCapabilities>
export const nativeDesktopOperation = z.enum([
  "open",
  "windows",
  "admit_window",
  "approved_launch",
  "admit_launch",
  "invalidate",
  "review",
  "secret_review",
  "set_secret",
  "observe",
  "has_sensitive_input",
  "review_message",
  "frame",
  "set_value",
  "invoke",
  "scroll",
  "message_pointer",
  "message_keyboard",
  "select_window",
  "revoke",
  "grant",
  "close"
])
export type NativeDesktopOperation = z.infer<typeof nativeDesktopOperation>
export const nativeDesktopRequest = z
  .object({
    type: z.literal("request"),
    protocol: z.literal(BOT_NATIVE_DESKTOP_PROTOCOL),
    version: z.literal(1),
    id: uuid,
    sequence: counter.refine((value) => value > 0),
    nonce: uuid,
    scope: nativeDesktopScope,
    operation: nativeDesktopOperation,
    window: nativeDesktopWindow.optional(),
    params: z.record(z.string(), z.unknown())
  })
  .strict()
export type NativeDesktopRequest = z.infer<typeof nativeDesktopRequest>
export const nativeDesktopReady = z
  .object({
    type: z.literal("ready"),
    protocol: z.literal(BOT_NATIVE_DESKTOP_PROTOCOL),
    version: z.literal(1),
    nonce: uuid,
    worker: z
      .object({
        pid,
        startTicks: decimal,
        sessionId: z.number().int().nonnegative().max(0xffffffff),
        desktop: boundedText.min(1)
      })
      .strict(),
    capabilities: nativeDesktopCapabilities
  })
  .strict()
export type NativeDesktopReady = z.infer<typeof nativeDesktopReady>
export const nativeDesktopResult = z
  .object({
    type: z.literal("result"),
    protocol: z.literal(BOT_NATIVE_DESKTOP_PROTOCOL),
    version: z.literal(1),
    id: uuid,
    sequence: counter.refine((value) => value > 0),
    nonce: uuid,
    scope: nativeDesktopScope,
    status: z.enum(["ok", "rejected", "unknown"]),
    result: z.unknown().optional(),
    code: z.string().min(1).max(160).nullish()
  })
  .strict()
export type NativeDesktopResult = z.infer<typeof nativeDesktopResult>
export const nativeDesktopElement = z
  .object({
    id: id,
    name: z.string().max(2048).nullish(),
    controlType: z.string().max(100),
    value: z.string().max(16000).nullish(),
    password: z.boolean(),
    enabled: z.boolean(),
    offscreen: z.boolean(),
    depth: z.number().int().nonnegative().max(6),
    valueTruncated: z.boolean(),
    supportedActions: z
      .array(
        z.enum([
          "invoke",
          "select",
          "toggle",
          "expand",
          "collapse",
          "select_all_text",
          "set_value",
          "scroll"
        ])
      )
      .max(8)
  })
  .strict()
  .refine(
    (element) => !element.password || element.value == null,
    "Password contents must not leave the worker"
  )
  .transform(({ name, value, ...element }) => ({
    ...element,
    name: name ?? "",
    ...(value == null ? {} : { value })
  }))
export type NativeDesktopElement = z.infer<typeof nativeDesktopElement>
export const nativeDesktopObservation = z
  .object({
    window: nativeDesktopWindow,
    title: z.string().max(2048),
    elements: z.array(nativeDesktopElement).max(256),
    truncated: z.boolean()
  })
  .strict()
export type NativeDesktopObservation = z.infer<typeof nativeDesktopObservation>
export const nativeDesktopImage = z
  .object({
    window: nativeDesktopWindow,
    title: z.string().max(2048),
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
    image: z
      .string()
      .max(BOT_NATIVE_DESKTOP_OUTPUT_BYTES)
      .regex(/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+=*$/),
    sourceWidth: z.number().int().positive().max(8192).optional(),
    sourceHeight: z.number().int().positive().max(8192).optional(),
    inputTicketIssued: z.boolean(),
    messageGeometryReady: z.boolean(),
    captureId: uuid,
    frameVersion: decimal
  })
  .strict()
  .refine((frame) => frame.width * frame.height <= 16_777_216, "Capture exceeds pixel budget")
export const nativeDesktopWindows = z
  .object({
    windows: z
      .array(z.object({ window: nativeDesktopWindow, title: z.string().max(2048) }).strict())
      .max(128),
    truncated: z.boolean()
  })
  .strict()
export const nativeDesktopSensitivity = z
  .object({
    window: nativeDesktopWindow,
    passwordDetected: z.boolean(),
    complete: z.boolean()
  })
  .strict()

/** Password-only metadata; this path never exposes a current Value or ordinary action. */
export const nativeDesktopSecretReviewed = z
  .object({
    window: nativeDesktopWindow,
    title: z.string().max(2048),
    element: z
      .object({
        id: uuid,
        name: z.string().max(1024).nullable(),
        controlType: z.string().max(128),
        password: z.literal(true),
        enabled: z.literal(true),
        offscreen: z.literal(false)
      })
      .strict()
  })
  .strict()
export type NativeDesktopSecretReviewed = z.infer<typeof nativeDesktopSecretReviewed>

/** Ephemeral human destination. A ticket is bound to one authenticated connection and observation. */
export interface BotNativeDesktopSecretDestination {
  token: string
  windowTitle: string
  field: string
}
export interface BotNativeDesktopTarget extends BotBrowserTarget {
  backend: "windows-native"
}
/** Public target projection also accepts a displayed frame. Extra frame fields
 * are discarded; the broker validates these identities against its live owner. */
export const botNativeDesktopTarget = z.object({
  backend: z.literal("windows-native"),
  botId: id,
  taskRunId: id.optional(),
  generation: uuid,
  controlEpoch: counter,
  control: z.enum(["bot", "human", "handoff"]),
  viewId: uuid
})
export interface BotNativeDesktopFrame extends BotNativeDesktopTarget {
  controlOwner?: "self" | "other"
  controlOwnerConnected?: boolean
  frameSeq: number
  width: number
  height: number
  sourceWidth?: number
  sourceHeight?: number
  inputTicketIssued: boolean
  messageGeometryReady: boolean
  title: string
  image: string
  captureId: string
  frameVersion: string
  window: NativeDesktopWindow
  capabilities: NativeDesktopCapabilities
}
export const botNativeDesktopSemanticAction = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("set_value"),
      elementId: id,
      value: z
        .string()
        .max(16000)
        .refine((text) => !text.includes("\0"))
    })
    .strict(),
  z
    .object({
      op: z.literal("invoke"),
      elementId: id,
      action: z
        .enum(["invoke", "select", "toggle", "expand", "collapse", "select_all_text"])
        .default("invoke")
    })
    .strict(),
  z
    .object({
      op: z.literal("scroll"),
      elementId: id,
      direction: z.enum(["up", "down", "left", "right"]),
      amount: z.enum(["small", "large"])
    })
    .strict()
])
export type BotNativeDesktopSemanticAction = z.infer<typeof botNativeDesktopSemanticAction>
/** Exact-HWND messages; optional chords require the worker's separate messageChords capability. */
export const NATIVE_MESSAGE_DRAG_MAX_POINTS = 32
export const botNativeDesktopMessagePoint = z
  .object({ x: z.number().int().min(0).max(4095), y: z.number().int().min(0).max(4095) })
  .strict()
export const botNativeDesktopMessageKey = z.enum([
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
  "PageDown",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12"
])
/** Message chord keys are separate from ordinary text and the basic single-key subset. */
export const botNativeDesktopChordKey = z.enum([
  ...botNativeDesktopMessageKey.options,
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "L",
  "M",
  "N",
  "O",
  "P",
  "Q",
  "R",
  "S",
  "T",
  "U",
  "V",
  "W",
  "X",
  "Y",
  "Z",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9"
])
export const NATIVE_MESSAGE_MODIFIERS = ["Control", "Shift", "Alt"] as const
export function nativeMessageTextIsValid(text: string): boolean {
  if (!text || text.length > 4096 || text.includes("\0")) return false
  for (let index = 0; index < text.length; index++) {
    const value = text.charCodeAt(index)
    if (value >= 0xd800 && value <= 0xdbff) {
      const next = text.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (value >= 0xdc00 && value <= 0xdfff) return false
  }
  return true
}
export const botNativeDesktopMessageAction = z
  .discriminatedUnion("op", [
    z
      .object({
        op: z.literal("message_pointer"),
        x: z.number().int().min(0).max(4095),
        y: z.number().int().min(0).max(4095),
        kind: z.enum(["move", "click", "double_click", "wheel", "drag"]),
        button: z.enum(["left", "right"]).default("left"),
        delta: z.number().int().min(-1200).max(1200).default(0),
        path: z
          .array(botNativeDesktopMessagePoint)
          .min(2)
          .max(NATIVE_MESSAGE_DRAG_MAX_POINTS)
          .optional()
      })
      .strict(),
    z
      .object({
        op: z.literal("message_keyboard"),
        key: botNativeDesktopChordKey.optional(),
        modifiers: z.array(z.enum(NATIVE_MESSAGE_MODIFIERS)).min(1).max(3).optional(),
        text: z
          .string()
          .min(1)
          .max(4096)
          .refine(nativeMessageTextIsValid, "Text must contain complete Unicode scalars")
          .optional()
      })
      .strict()
      .superRefine((input, context) => {
        if ((input.key !== undefined) === (input.text !== undefined))
          context.addIssue({ code: "custom", message: "Choose key or text" })
        if (input.modifiers && (!input.key || input.text !== undefined))
          context.addIssue({ code: "custom", message: "Only a key accepts modifiers" })
        if (input.modifiers) {
          const order = input.modifiers.map((modifier) =>
            NATIVE_MESSAGE_MODIFIERS.indexOf(modifier)
          )
          if (order.some((value, index) => index > 0 && value <= order[index - 1]))
            context.addIssue({
              code: "custom",
              message: "Modifiers must be unique and canonically ordered"
            })
          if (input.modifiers.includes("Alt") && (input.key === "Tab" || input.key === "Escape"))
            context.addIssue({
              code: "custom",
              message: "System window switching is not HWND input"
            })
          if (
            input.key === "Delete" &&
            input.modifiers.includes("Control") &&
            input.modifiers.includes("Alt")
          )
            context.addIssue({ code: "custom", message: "Secure attention is unavailable" })
        } else if (
          input.key &&
          !botNativeDesktopMessageKey.options.some((key) => key === input.key)
        )
          context.addIssue({ code: "custom", message: "Use literal text for ordinary characters" })
      })
  ])
  .superRefine((action, context) => {
    if (action.op !== "message_pointer") return
    if (action.kind === "drag") {
      if (
        !action.path ||
        action.path[0].x !== action.x ||
        action.path[0].y !== action.y ||
        action.delta !== 0
      )
        context.addIssue({
          code: "custom",
          message: "Drag needs a bounded path anchored at x/y and delta zero"
        })
    } else if (action.path !== undefined) {
      context.addIssue({ code: "custom", message: "Only drag accepts a path" })
    }
  })
export type BotNativeDesktopMessageAction = z.infer<typeof botNativeDesktopMessageAction>
/** Model coordinates use the returned screenshot's preview pixels. Host maps
 * those pixels to the exact source geometry; models cannot invent a worker ticket. */
export const botNativeDesktopModelMessageInput = z
  .object({
    frameSeq: counter.refine((value) => value > 0),
    captureId: uuid,
    frameVersion: z.string().regex(/^(0|[1-9][0-9]{0,18})$/),
    description: z.string().trim().min(1).max(500),
    action: botNativeDesktopMessageAction
  })
  .strict()
export type BotNativeDesktopModelMessageInput = z.infer<typeof botNativeDesktopModelMessageInput>
export const nativeDesktopMessageTarget = z
  .object({
    targetHwnd: nativeDesktopWindow.shape.hwnd,
    thread: z.number().int().positive().max(0xffffffff),
    dragClient: z
      .object({
        left: z.number().int().min(-2147483648).max(2147483647),
        top: z.number().int().min(-2147483648).max(2147483647),
        width: z.number().int().positive().max(2147483647),
        height: z.number().int().positive().max(2147483647)
      })
      .strict()
      .optional(),
    geometry: z
      .object({
        left: z.number().int().min(-2147483648).max(2147483647),
        top: z.number().int().min(-2147483648).max(2147483647),
        width: z.number().int().positive().max(8192),
        height: z.number().int().positive().max(8192),
        clientLeft: z.number().int().min(-2147483648).max(2147483647),
        clientTop: z.number().int().min(-2147483648).max(2147483647),
        clientWidth: z.number().int().positive().max(2147483647),
        clientHeight: z.number().int().positive().max(2147483647)
      })
      .strict()
  })
  .strict()
export const nativeDesktopMessageReviewed = z
  .object({
    window: nativeDesktopWindow,
    title: z.string().max(2048),
    target: nativeDesktopMessageTarget
  })
  .strict()
export type NativeDesktopMessageReviewed = z.infer<typeof nativeDesktopMessageReviewed>
export const botNativeDesktopAction = z.union([
  botNativeDesktopSemanticAction,
  botNativeDesktopMessageAction
])
export type BotNativeDesktopAction = z.infer<typeof botNativeDesktopAction>
export const botNativeDesktopHumanInput = z
  .object({
    frameSeq: counter.refine((value) => value > 0),
    action: botNativeDesktopAction
  })
  .strict()
export interface BotNativeDesktopHumanInput {
  frameSeq: number
  action: BotNativeDesktopAction
}

const nativeDesktopProcessIdentity = z
  .object({
    pid,
    startTicks: decimal,
    sessionId: z.number().int().nonnegative().max(0xffffffff),
    desktop: boundedText.min(1)
  })
  .strict()
export const nativeDesktopPendingLaunch = z
  .object({
    launchId: uuid,
    process: nativeDesktopProcessIdentity,
    suspended: z.literal(true)
  })
  .strict()
export const nativeDesktopAdmittedLaunch = z
  .object({
    launchId: uuid,
    process: nativeDesktopProcessIdentity,
    resumed: z.literal(true)
  })
  .strict()
const windowsLocalPath = z
  .string()
  .min(3)
  .max(4096)
  .regex(/^[A-Za-z]:\\/)
  .refine((path) => !path.includes("\0"))
export const botNativeDesktopLaunch = z
  .object({
    executable: windowsLocalPath,
    cwd: windowsLocalPath,
    arguments: z
      .array(
        z
          .string()
          .max(8192)
          .refine((text) => !text.includes("\0"))
      )
      .max(128)
  })
  .strict()
export type BotNativeDesktopLaunch = z.infer<typeof botNativeDesktopLaunch>

export const nativeDesktopReviewedElement = z
  .object({
    id: id,
    name: z.string().max(2048).nullable(),
    controlType: z.string().max(100),
    value: z.string().max(4096).nullable(),
    password: z.boolean(),
    supportedActions: z
      .array(
        z.enum([
          "invoke",
          "select",
          "toggle",
          "expand",
          "collapse",
          "select_all_text",
          "set_value",
          "scroll"
        ])
      )
      .max(8),
    enabled: z.boolean(),
    offscreen: z.boolean(),
    depth: z.number().int().nonnegative().max(6),
    valueTruncated: z.literal(false)
  })
  .strict()
/** One bounded, original TextPattern range; never a keyboard/modifier receipt. */
export const nativeDesktopTextSelection = z
  .object({
    token: uuid,
    textSha256: z.string().regex(/^[a-f0-9]{64}$/),
    utf16Length: z.number().int().nonnegative().max(4096)
  })
  .strict()
export type NativeDesktopTextSelection = z.infer<typeof nativeDesktopTextSelection>
export const nativeDesktopReviewed = z
  .object({
    window: nativeDesktopWindow,
    title: z.string().max(2048),
    element: nativeDesktopReviewedElement,
    textSelection: nativeDesktopTextSelection.optional()
  })
  .strict()
  .refine(
    (review) =>
      !review.textSelection ||
      (!review.element.password &&
        review.element.value !== null &&
        review.element.value.length === review.textSelection.utf16Length &&
        review.element.supportedActions.includes("select_all_text")),
    "Text selection needs complete non-secret value evidence"
  )
export type NativeDesktopReviewed = z.infer<typeof nativeDesktopReviewed>

/** Strict secret admission reports fixed errors at RPC, never parser details from values. */
export const botNativeDesktopSecretPreparation = z
  .object({
    target: botNativeDesktopTarget,
    elementId: uuid
  })
  .strict()
export const botNativeDesktopSecretSubmission = z
  .object({
    target: botNativeDesktopTarget,
    token: uuid,
    value: z
      .string()
      .min(1)
      .max(16000)
      .refine((value) => !value.includes("\0"))
  })
  .strict()
