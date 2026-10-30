export function isDesignGraphRecursionLimit(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return (
    error.name === "GraphRecursionError" ||
    /Recursion limit of \d+ reached without hitting a stop condition/i.test(error.message)
  )
}

interface CompletionOptions {
  signal: AbortSignal
  readCompletedArtifact: (force?: boolean) => Promise<string | undefined>
  completed: (html: string) => void
}

/** A graph budget error must not discard a completed, validated-as-ready draft. */
export async function* designStreamWithArtifactRecovery<T>(
  stream: AsyncIterable<T>,
  options: CompletionOptions
): AsyncGenerator<T> {
  try {
    for await (const chunk of stream) {
      yield chunk
      if (options.signal.aborted) return
    }
  } catch (error) {
    if (!options.signal.aborted && isDesignGraphRecursionLimit(error)) {
      // A budget error must not discard a fresh, complete artifact. It still
      // goes through the same final structural/browser validation as usual.
      const html = await options.readCompletedArtifact(true)
      if (html) {
        options.completed(html)
        return
      }
    }
    throw error
  }
}
