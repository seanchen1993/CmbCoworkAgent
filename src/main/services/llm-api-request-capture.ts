import { redactCapturedImage } from "./capture-image-redaction"
import { captureSubagentRawApiCall } from "./subagent-session-capture"

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

/** Keep the copy used for session export free of model-visible image data. */
function captureBody(body: BodyInit | null | undefined): BodyInit | null | undefined {
  if (typeof body !== "string" || !/"image"|image_url|input_image|cmb_chat_images|chatImages|data:image\//i.test(body)) return body
  try {
    return JSON.stringify(JSON.parse(body), redactCapturedImage)
  } catch {
    return "[image request]"
  }
}

export function withRawApiCallCapture(fetchImpl: typeof fetch, threadId?: string): typeof fetch {
  return async (input, init) => {
    const diagnosticBody = captureBody(init?.body)
    if (!captureSubagentRawApiCall(diagnosticBody) && threadId) {
      captureRawApiCall(threadId, diagnosticBody)
    }
    return fetchImpl(input, init)
  }
}
