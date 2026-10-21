/** Poll read-only IPC from the test process; a Promise itself is never success evidence. */
export async function waitForAsyncEvidence<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  label: string,
  timeoutMs = 15_000
): Promise<T> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const remaining = deadline - performance.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    let value: T
    try {
      value = await Promise.race([
        read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error(`Timeout: ${label}`)), remaining)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
    if (performance.now() >= deadline) break
    if (accept(value)) return value
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - performance.now())))
  }
  throw Error(`Timeout: ${label}`)
}
