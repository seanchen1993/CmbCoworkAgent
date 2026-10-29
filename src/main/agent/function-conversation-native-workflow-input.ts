import type { HumanMessage } from "@langchain/core/messages"
import { types } from "node:util"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { WORKFLOW_NOTIFICATION_MARKER_PREFIX } from "../../shared/checkpoint-transcript"
import { captureFunctionConversationNativeInput } from "./function-conversation-native-input"

/** Main-only source supplied after the original run-manager notification claim, never message JSON. */
export interface NativeWorkflowNotificationInputSource {
  readonly runId: string
  readonly startedAt: string
  readonly ownerRunToken: string
  readonly content: string
  assertCurrent(): void
  /** Main-only full byte validation at initial capture, not a repeated owner read. */
  assertSourceCurrent?(): void
}

/** Keep the original result as checkpoint plumbing, without inventing a human-authored UI row. */
export function captureFunctionConversationNativeWorkflowInput(input: {
  readonly message: HumanMessage
  readonly threadId: string
  readonly physicalRunId: string
  readonly workspace: string
  readonly signal: AbortSignal
  readonly visible?: string
  readonly notification: NativeWorkflowNotificationInputSource
  assertCurrent(): void
}) {
  const { notification, message, threadId, physicalRunId, workspace, signal } = input
  const { runId, startedAt, ownerRunToken, content } = notification
  const originalGuard = notification.assertCurrent
  const originalSourceGuard = notification.assertSourceCurrent
  const originalCurrent = input.assertCurrent
  if (
    typeof originalGuard !== "function" ||
    (originalSourceGuard !== undefined && typeof originalSourceGuard !== "function")
  )
    throw new ModFunctionError("MODS_CONVERSATION_WORKFLOW_INPUT_INVALID")
  const guard = originalGuard.bind(notification)
  const sourceGuard = originalSourceGuard?.bind(notification) ?? guard
  const current = originalCurrent.bind(input)
  const invalid = () => {
    throw new ModFunctionError("MODS_CONVERSATION_WORKFLOW_INPUT_INVALID")
  }
  if (
    !runId ||
    !startedAt ||
    ownerRunToken !== physicalRunId ||
    typeof content !== "string" ||
    !content.startsWith(`${WORKFLOW_NOTIFICATION_MARKER_PREFIX}${runId}]]\n`) ||
    message.content !== content ||
    !message.id
  )
    invalid()
  const assertIdentity = () => {
    if (
      input.notification !== notification ||
      input.message !== message ||
      input.threadId !== threadId ||
      input.physicalRunId !== physicalRunId ||
      input.workspace !== workspace ||
      input.signal !== signal ||
      input.assertCurrent !== originalCurrent ||
      notification.runId !== runId ||
      notification.startedAt !== startedAt ||
      notification.ownerRunToken !== ownerRunToken ||
      notification.content !== content ||
      notification.assertCurrent !== originalGuard ||
      notification.assertSourceCurrent !== originalSourceGuard ||
      message.content !== content
    )
      invalid()
  }
  const assertCurrent = () => {
    signal.throwIfAborted()
    assertIdentity()
    current()
    guard()
    assertIdentity()
  }
  assertCurrent()
  // The full byte guard belongs to this original capture, before native retention can write.
  // Subsequent keeper reads retain their exact source/owner checks without rescanning files.
  const checked: unknown = sourceGuard()
  if (checked !== undefined) {
    if (
      checked &&
      typeof checked === "object" &&
      !types.isProxy(checked) &&
      types.isPromise(checked) &&
      Object.getPrototypeOf(checked) === Promise.prototype
    )
      void Promise.prototype.then.call(checked, undefined, () => undefined)
    invalid()
  }
  assertCurrent()
  return captureFunctionConversationNativeInput({
    message,
    threadId,
    physicalRunId,
    workspace,
    signal,
    origin: { kind: "task-notification" },
    ...(input.visible === undefined ? {} : { visible: input.visible }),
    // The full original result stays in the protected native payload. This intent only
    // authorizes its existing non-visible projection through the original keeper/ACK chain.
    transcript: {
      write: { id: message.id!, role: "user", content: "", created_at: new Date() },
      disposition: "plumbing"
    },
    assertCurrent
  })
}
