export type BestEffortResult = "settled" | "timed_out"

export async function waitBestEffort(
  work: Promise<unknown>,
  timeoutMs: number
): Promise<BestEffortResult> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  const result = await Promise.race<BestEffortResult>([
    work.then(
      () => "settled",
      () => "settled"
    ),
    new Promise<BestEffortResult>((resolve) => {
      timeout = setTimeout(() => resolve("timed_out"), timeoutMs)
    })
  ])
  if (timeout) clearTimeout(timeout)
  return result
}

export function scheduleHardDeadline(callback: () => void, timeoutMs: number): () => void {
  const timer = setTimeout(callback, timeoutMs)
  return () => clearTimeout(timer)
}
