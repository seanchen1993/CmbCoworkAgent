import CodeHighlightWorker from "./code-highlight-worker?worker"

interface PendingHighlight {
  resolve: (html: string) => void
  reject: (error: Error) => void
}

interface HighlightWorkerResponse {
  type: "result"
  requestId: number
  ok: boolean
  html?: string
  error?: string
}

let worker: Worker | null = null
let nextRequestId = 1
const pending = new Map<number, PendingHighlight>()

function rejectAll(error: Error): void {
  for (const request of pending.values()) request.reject(error)
  pending.clear()
}

function getWorker(): Worker {
  if (worker) return worker
  const created = new CodeHighlightWorker({ name: "code-highlight" })
  created.onmessage = (event: MessageEvent<HighlightWorkerResponse>) => {
    const response = event.data
    const request = pending.get(response.requestId)
    if (!request) return
    pending.delete(response.requestId)
    if (response.ok && typeof response.html === "string") {
      request.resolve(response.html)
    } else {
      request.reject(new Error(response.error || "Code highlighting failed"))
    }
  }
  created.onerror = () => {
    rejectAll(new Error("Code highlight worker stopped unexpectedly"))
    created.terminate()
    if (worker === created) worker = null
  }
  worker = created
  return created
}

export function requestCodeHighlight(
  content: string,
  language: string
): { promise: Promise<string>; cancel: () => void } {
  const requestId = nextRequestId++
  const activeWorker = getWorker()
  const promise = new Promise<string>((resolve, reject) => {
    pending.set(requestId, { resolve, reject })
    activeWorker.postMessage({ type: "highlight", requestId, content, language })
  })
  return {
    promise,
    cancel: () => {
      const request = pending.get(requestId)
      if (!request) return
      pending.delete(requestId)
      request.reject(new Error("Code highlighting was cancelled"))
      activeWorker.postMessage({ type: "cancel", requestId })
    }
  }
}
