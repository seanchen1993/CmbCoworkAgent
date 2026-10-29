import { getModCallContext } from "../mods/context"
import { withTrustedFunctionWait } from "../mods/v2/trusted-function-wait"

/** Native approval only: waiting refunds no execution/CPU or inherited hard-cut budget. */
export async function withNativeApprovalWait<T>(
  threadId: string,
  runSignal: AbortSignal | undefined,
  wait: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const operation = getModCallContext()
  const operationSignal = operation?.identity.threadId === threadId ? operation.signal : undefined
  const lifetime = new AbortController()
  const signal = AbortSignal.any([
    lifetime.signal,
    ...[runSignal, operationSignal].filter((value): value is AbortSignal => !!value)
  ])
  try {
    signal.throwIfAborted()
    const result = await withTrustedFunctionWait("user-approval", signal, () => wait(signal))
    signal.throwIfAborted()
    return result
  } finally {
    // Closing a trusted owner or exhausting its allowance also removes the native
    // dialog. A late click must never resume the operation after its caller left.
    lifetime.abort(new Error("NATIVE_APPROVAL_WAIT_ENDED"))
  }
}
