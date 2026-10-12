/** Await a read-only Host/configuration guard with the existing cancellation
 * and deadline. Never race an operation that can already have external effects. */
export async function assertBotShellCurrent(
  check: (signal: AbortSignal) => Promise<void>,
  signal: AbortSignal
): Promise<void> {
  // Trusted configuration ports may still be backed by an uncancellable I/O
  // promise. Do not retain a stopped resource while waiting for that promise.
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
  deadline.throwIfAborted()
  let abort!: () => void
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(deadline.reason ?? new Error("Shell guard cancelled"))
    deadline.addEventListener("abort", abort, { once: true })
  })
  try {
    await Promise.race([check(deadline), cancelled])
    deadline.throwIfAborted()
  } finally {
    deadline.removeEventListener("abort", abort)
  }
}
