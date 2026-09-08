const MAX_CAPTURED_THREADS = 3

const rawApiCallsByThread = new Map<string, string>()

function clearRawApiCall(threadId: string): void {
  rawApiCallsByThread.delete(threadId)
}

function captureRawApiCall(threadId: string, body: BodyInit | null | undefined): void {
  if (typeof body !== "string") {
    clearRawApiCall(threadId)
    return
  }

  rawApiCallsByThread.delete(threadId)
  rawApiCallsByThread.set(threadId, body)

  while (rawApiCallsByThread.size > MAX_CAPTURED_THREADS) {
    const oldestThreadId = rawApiCallsByThread.keys().next().value
    if (typeof oldestThreadId !== "string") break
    rawApiCallsByThread.delete(oldestThreadId)
  }
}

export function getCapturedRawApiCall(threadId: string): string {
  return rawApiCallsByThread.get(threadId) ?? ""
}

export function withRawApiCallCapture(fetchImpl: typeof fetch, threadId: string): typeof fetch {
  return async (input, init) => {
    captureRawApiCall(threadId, init?.body)
    return fetchImpl(input, init)
  }
}
