const failures = new WeakSet<Error>()

/** Native provenance, never inferred from a guest's code or exception text. */
export function markFunctionGuestLoadFailure(error: Error): Error {
  failures.add(error)
  return error
}

export function isFunctionGuestLoadFailure(error: unknown): error is Error {
  return error instanceof Error && failures.has(error)
}

/** Only wrap actual VM creation, after source/grant/transport admission. */
export async function functionGuestLoad<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof Error) markFunctionGuestLoadFailure(error)
    throw error
  }
}
