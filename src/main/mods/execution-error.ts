import { getModCallContext } from "./context"
import { ModError, ModPermissionError, modErrorCode } from "./errors"

/** Host-only evidence that this particular tool's side effect has not started. */
const notStarted = new WeakMap<Error, string>()

export async function beforeModToolExecution<T>(check: () => Promise<T> | T): Promise<T> {
  const callId = getModCallContext()?.identity.callId
  try {
    return await check()
  } catch (error) {
    if (!callId) throw error
    const failure = error instanceof ModPermissionError ? error : new ModError(modErrorCode(error))
    notStarted.set(failure, callId)
    throw failure
  }
}

export function modToolHasNotStarted(error: unknown, callId: string): boolean {
  return error instanceof Error && notStarted.get(error) === callId
}
