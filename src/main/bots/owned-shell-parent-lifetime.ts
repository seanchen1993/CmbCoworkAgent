/** Install before the first async operation in a trusted lifetime witness.
 * IPC EOF may occur during path/artifact validation. It remains latched until
 * validation finishes; this object is never evidence that a kernel scope closed. */
export function observeOwnedShellParentEOF(): {
  readonly disconnected: Promise<void>
  ready(message: Record<string, true>): void
} {
  if (!process.send) throw new Error("Owned shell witness IPC is unavailable")
  const send = process.send.bind(process)
  let ended = false
  let complete!: () => void
  const disconnected = new Promise<void>((resolve) => {
    complete = resolve
  })
  const finish = (): void => {
    if (ended) return
    ended = true
    process.removeListener("disconnect", finish)
    complete()
  }
  process.once("disconnect", finish)
  if (!process.connected) finish()
  const failedSend = (): void => {
    finish()
    // Make the failed readiness channel visible to its still-live parent too.
    // Exact identity validation and actual kernel close still precede any proof.
    try {
      if (process.connected) process.disconnect?.()
    } catch {
      /* EOF already won. */
    }
  }
  return {
    disconnected,
    ready(message) {
      if (ended || !process.connected) {
        finish()
        return
      }
      try {
        send(message, (error) => {
          if (error) failedSend()
        })
      } catch {
        failedSend()
      }
    }
  }
}
