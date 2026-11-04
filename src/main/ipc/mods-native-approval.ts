import type { MessageBoxOptions } from "electron"
import type { NativePlatformCallContext } from "../mods/v2/platform-capabilities-types"
import { withTrustedFunctionWait } from "../mods/v2/trusted-function-wait"
import type { ModApprovalInbox } from "./mods-approval-inbox"

/** All plugin-initiated platform confirmations share the non-modal native inbox. */
export function confirmNativeModApproval(
  inbox: ModApprovalInbox,
  context: NativePlatformCallContext,
  options: Pick<MessageBoxOptions, "title" | "message" | "detail"> & { allowLabel: string },
  assertCurrent = () => context.assertCurrent()
): Promise<boolean> {
  const source = {
    workspace: context.workspace,
    threadId: context.threadId,
    modId: `function:${context.caller.name}`
  }
  context.assertCurrent()
  inbox.assertAllowed(source)
  return withTrustedFunctionWait("user-approval", context.signal, async () => {
    const result = await inbox.request(
      source,
      {
        ...options,
        signal: context.signal,
        buttons: ["拒绝", options.allowLabel]
      },
      () => {
        context.assertCurrent()
        assertCurrent()
      }
    )
    context.assertCurrent()
    assertCurrent()
    return result.response === 1
  })
}
