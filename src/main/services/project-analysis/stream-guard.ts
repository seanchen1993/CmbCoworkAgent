import type { AIMessageChunk, BaseMessage } from "@langchain/core/messages"
import type { ProjectAnalysisModel } from "./model-stream"

// An inactivity guard, not a task/response deadline. Reasoning and tool fragments also reset it.
export const PROJECT_STREAM_IDLE_MS = 180_000
export class ProjectStreamIdleError extends Error {
  constructor() {
    super("模型连续 3 分钟未返回新片段，本次连接已中止")
  }
}

/** Settle cancellation even if a compatible SDK/iterator ignores the abort signal. */
export async function* guardedProjectStream(
  model: ProjectAnalysisModel,
  messages: BaseMessage[],
  parent: AbortSignal
): AsyncGenerator<AIMessageChunk> {
  parent.throwIfAborted()
  const controller = new AbortController()
  const signal = AbortSignal.any([parent, controller.signal])
  let onAbort!: () => void
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const resetIdle = () => {
    clearTimeout(timer)
    timer = setTimeout(() => controller.abort(new ProjectStreamIdleError()), PROJECT_STREAM_IDLE_MS)
    timer.unref()
  }
  let iterator: AsyncIterator<AIMessageChunk> | undefined
  let completed = false
  try {
    resetIdle()
    const stream = await Promise.race([model.stream(messages, { signal }), interrupted])
    signal.throwIfAborted()
    iterator = stream[Symbol.asyncIterator]()
    for (;;) {
      const next = await Promise.race([iterator.next(), interrupted])
      signal.throwIfAborted()
      if (next.done) {
        completed = true
        return
      }
      resetIdle()
      yield next.value
    }
  } catch (error) {
    throw signal.aborted ? signal.reason : error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", onAbort)
    if (!completed) {
      controller.abort()
      // Never wait for a stalled iterator to acknowledge cleanup. Observe late failures.
      void Promise.resolve()
        .then(() => iterator?.return?.())
        .catch(() => undefined)
    }
  }
}
