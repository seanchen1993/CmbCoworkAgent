export interface BrowserPerformanceBudget {
  maxRuntimeInstancesPerSession: number
  maxActiveBackendsPerSession: number
  maxOpenTabsPerSession: number
  maxConcurrentOperations: number
  maxMessageBytes: number
  maxResponseMetaBytes: number
  maxScreenshotBytes: number
  maxScreenshotsPerMinute: number
  maxDomSnapshotBytes: number
  maxLogEntriesPerSession: number
  bootstrapTimeoutMs: number
  operationTimeoutMs: number
  idleShutdownMs: number
}

export const DEFAULT_BROWSER_PERFORMANCE_BUDGET: BrowserPerformanceBudget = {
  maxRuntimeInstancesPerSession: 1,
  maxActiveBackendsPerSession: 1,
  maxOpenTabsPerSession: 8,
  maxConcurrentOperations: 4,
  maxMessageBytes: 256_000,
  maxResponseMetaBytes: 64_000,
  maxScreenshotBytes: 4_000_000,
  maxScreenshotsPerMinute: 12,
  maxDomSnapshotBytes: 512_000,
  maxLogEntriesPerSession: 200,
  bootstrapTimeoutMs: 10_000,
  operationTimeoutMs: 30_000,
  idleShutdownMs: 5 * 60_000
}

export function estimateBrowserJsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8")
  } catch {
    return Buffer.byteLength(String(value), "utf8")
  }
}

export function assertBrowserBudgetBytes(
  label: string,
  value: unknown,
  maxBytes: number
): void {
  const size = estimateBrowserJsonBytes(value)
  if (size > maxBytes) {
    throw new Error(`${label} exceeds Browser budget (${size} bytes > ${maxBytes} bytes)`)
  }
}

export function truncateBrowserString(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value

  let remaining = maxBytes
  let output = ""
  for (const char of value) {
    const bytes = Buffer.byteLength(char, "utf8")
    if (remaining - bytes <= 0) break
    output += char
    remaining -= bytes
  }
  return `${output}\n[truncated to ${maxBytes} bytes]`
}
