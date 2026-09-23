import { getModCallContext } from "../context"
import {
  getPendingUserInputForThread,
  isUserInputRequestAcknowledged,
  subscribePendingUserInput,
  subscribeRemovedUserInput
} from "../../services/user-input"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { FunctionNoticeDialog, FunctionNoticeDialogAccess } from "./ui-notice"

/** Tracks native service events, never plugin-provided request IDs or renderer metadata. */
export function nativeFunctionDialogAccess(
  workspace: string,
  threadId: string
): FunctionNoticeDialogAccess {
  let active = false
  let current: { dialog: FunctionNoticeDialog; live: () => boolean } | undefined
  return {
    lookup(toolUseId) {
      if (
        !active ||
        !current ||
        current.dialog.toolUseId !== toolUseId ||
        !current.live() ||
        getPendingUserInputForThread(threadId)?.requestId !== current.dialog.requestId ||
        !isUserInputRequestAcknowledged(current.dialog.requestId, threadId)
      )
        return undefined
      return { ...current.dialog }
    },
    subscribeClosed(listener) {
      if (active) throw new ModFunctionError("MODS_UI_NOTICE_SUBSCRIPTION")
      active = true
      const pending = subscribePendingUserInput((request) => {
        const context = getModCallContext()
        if (
          !active ||
          request.threadId !== threadId ||
          !context ||
          context.toolId !== "host:request_user_input" ||
          context.identity.threadId !== threadId ||
          context.identity.workspace !== workspace ||
          !(context.identity.toolCallId ?? context.identity.callId)
        )
          return
        current = {
          dialog: {
            requestId: request.requestId,
            toolUseId: context.identity.toolCallId ?? context.identity.callId,
            owner:
              context.originMod ??
              (context.identity.origin === "mod" ? context.identity.modId : undefined)
          },
          live: () => {
            try {
              context.signal?.throwIfAborted()
              context.assertLive?.()
              return active
            } catch {
              return false
            }
          }
        }
      })
      const removed = subscribeRemovedUserInput((requestId, removedThread) => {
        if (removedThread !== threadId || requestId !== current?.dialog.requestId) return
        current = undefined
        listener(requestId)
      })
      return () => {
        if (!active) return
        active = false
        current = undefined
        pending()
        removed()
      }
    }
  }
}
