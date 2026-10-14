const failures = new WeakSet<Error>()

/** Only actual VM execution/settlement can issue this native receipt. */
export function markFunctionGuestInvokeFailure(error: Error): Error {
  failures.add(error)
  return error
}

export function isFunctionGuestInvokeFailure(error: unknown): error is Error {
  return error instanceof Error && failures.has(error)
}
