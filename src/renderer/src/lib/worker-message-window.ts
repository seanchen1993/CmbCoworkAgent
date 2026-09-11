export const WORKER_MESSAGE_WINDOW_SIZE = 240

export interface WorkerMessageWindow<T> {
  start: number
  end: number
  messages: T[]
}

export function buildWorkerMessageWindow<T>(
  messages: readonly T[],
  requestedEnd: number | null
): WorkerMessageWindow<T> {
  const end =
    requestedEnd === null
      ? messages.length
      : Math.max(0, Math.min(Math.floor(requestedEnd), messages.length))
  const start = Math.max(0, end - WORKER_MESSAGE_WINDOW_SIZE)
  return {
    start,
    end,
    messages: messages.slice(start, end)
  }
}
