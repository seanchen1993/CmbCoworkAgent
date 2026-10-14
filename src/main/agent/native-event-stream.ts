import { IterableReadableStream } from "@langchain/core/utils/stream"
import { FUNCTION_STREAM_TERMINAL } from "../mods/v2/host-stream-lifetime"

interface Options<T> {
  readonly prepared: Promise<unknown>
  readonly cut: AbortController
  readonly signal: AbortSignal
  open(input: unknown): AsyncIterable<T>
  assertCurrent(): void
}

/** Public native stream API; cancellation is separate from actual iterator/preparation cleanup. */
export function createNativeEventStream<T>(options: Options<T>): IterableReadableStream<T> & {
  readonly signal: AbortSignal
  readonly [FUNCTION_STREAM_TERMINAL]: Promise<void>
} {
  let finishSource: () => void = () => undefined
  const sourceSettled = new Promise<void>(resolve => { finishSource = resolve })
  // Observe preparation even if a caller closes before the first pull. Keep the original error.
  const preparationSettled = options.prepared.then(() => undefined, () => undefined)
  const terminal = Promise.all([preparationSettled, sourceSettled]).then(() => undefined)
  let readable: ReadableStreamDefaultController<T> | undefined
  let closed = false
  let closing: Promise<void> | undefined
  const assertCurrent = () => {
    options.signal.throwIfAborted()
    options.assertCurrent()
  }
  const source = (async function* () {
    let inner: AsyncIterator<T> | undefined
    let ended = false
    try {
      const input = await options.prepared
      assertCurrent()
      inner = options.open(input)[Symbol.asyncIterator]()
      while (true) {
        assertCurrent()
        const item = await inner.next()
        if (item.done) { ended = true; return }
        assertCurrent()
        yield item.value
      }
    } finally {
      try {
        if (inner && !ended && inner.return) {
          let item = await inner.return()
          // An actual generator can yield from finally. Discard cleanup events, then reach done.
          while (!item.done) item = await inner.next()
        }
      } finally { finishSource() }
    }
  })()
  const closeActual = (): Promise<void> => {
    if (!closing) {
      closing = (async () => {
        try {
          let item = await source.return(undefined)
          while (!item.done) item = await source.next()
          await preparationSettled
        } finally {
          // return-before-first-next does not enter an async generator's finally.
          finishSource()
        }
      })()
      void closing.catch(() => undefined)
    }
    return closing
  }
  const cancel = (reason: unknown, closeReadable: boolean): Promise<void> => {
    if (!closed) {
      closed = true
      if (closeReadable) readable?.close()
    }
    if (!options.cut.signal.aborted)
      options.cut.abort(reason ?? new DOMException("Event stream cancelled", "AbortError"))
    return closeActual()
  }
  const abort = () => {
    if (!closed) {
      closed = true
      readable?.error(options.signal.reason)
    }
    void closeActual().catch(() => undefined)
  }
  class NativeEventStream extends IterableReadableStream<T> {
    readonly signal = options.signal
    readonly [FUNCTION_STREAM_TERMINAL] = terminal

    constructor() {
      super({
        start(controller) {
          readable = controller
          options.signal.addEventListener("abort", abort, { once: true })
          if (options.signal.aborted) abort()
        },
        async pull(controller) {
          try {
            const item = await source.next()
            if (closed) return
            if (item.done) { closed = true; controller.close() }
            else controller.enqueue(item.value)
          } catch (error) {
            if (!closed) { closed = true; controller.error(error) }
          }
        },
        cancel: reason => cancel(reason, false)
      })
    }

    override cancel(reason?: unknown): Promise<void> {
      return cancel(reason, true)
    }

    override async return(): Promise<IteratorResult<T>> {
      await cancel(undefined, true)
      this.reader?.releaseLock()
      return { done: true, value: undefined }
    }

    override async throw(error: unknown): Promise<IteratorResult<T>> {
      try { await cancel(error, true) }
      finally { this.reader?.releaseLock() }
      throw error
    }
  }
  void terminal.then(() => options.signal.removeEventListener("abort", abort))
  return new NativeEventStream()
}
