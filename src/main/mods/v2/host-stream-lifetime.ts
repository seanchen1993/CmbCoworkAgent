/** Only trusted native wrappers attach this, never guest JSON or an early result Promise. */
export const FUNCTION_STREAM_TERMINAL = Symbol("function-stream-actual-terminal")

/** A generator may yield again from finally before its actual cleanup is complete. */
export async function closeHostStreamActual(
  source: AsyncGenerator<unknown, unknown>
): Promise<void> {
  let item = await source.return(null)
  while (!item.done) item = await source.next()
}

/** No deadline is added: observe actual native completion, including return before first next. */
export function trackHostStreamTerminal<T extends AsyncGenerator<unknown, unknown>>(source: T): T {
  let finish!: () => void
  const actualTerminal = new Promise<void>((resolve) => {
    finish = resolve
  })
  const invoke = async (method: "next" | "return" | "throw", value: unknown) => {
    try {
      const item = await source[method](value)
      if (item.done) finish()
      return item
    } catch (error) {
      finish()
      throw error
    }
  }
  const wrapped = Object.create(source) as T
  Object.defineProperties(wrapped, {
    next: { value: (value: unknown) => invoke("next", value) },
    return: { value: (value: unknown) => invoke("return", value) },
    throw: { value: (value: unknown) => invoke("throw", value) },
    [Symbol.asyncIterator]: { value: () => wrapped },
    [Symbol.asyncDispose]: { value: () => closeHostStreamActual(wrapped) },
    [FUNCTION_STREAM_TERMINAL]: { value: actualTerminal }
  })
  return wrapped
}

/** Iterator completion is separate from its result Promise and may include yielded cleanup. */
export function retainHostStream<T extends AsyncGenerator<unknown, unknown>>(
  source: T,
  context: <V>(run: () => Promise<V>) => Promise<V>,
  finish: () => void
): T {
  let finished = false
  const done = () => {
    if (finished) return
    finished = true
    finish()
  }
  const actualTerminal = Object.getOwnPropertyDescriptor(source, FUNCTION_STREAM_TERMINAL)
    ?.value as Promise<void> | undefined
  if (actualTerminal) void actualTerminal.then(done, done)
  const methodEnded = () => {
    if (!actualTerminal) done()
  }
  const invoke = async (method: "next" | "return" | "throw", value: unknown) => {
    try {
      const item = await context(() => source[method](value))
      if (item.done) methodEnded()
      return item
    } catch (error) {
      methodEnded()
      throw error
    }
  }
  const wrapped = Object.create(source) as T
  const dispose = async () => {
    if (finished) return
    try {
      await context(async () => {
        let item = await source.return(undefined)
        while (!item.done) item = await source.next()
        await source[Symbol.asyncDispose]?.()
      })
    } finally {
      methodEnded()
    }
  }
  // Real transport streams have a non-writable own return; create independent own methods.
  Object.defineProperties(wrapped, {
    next: { value: (value: unknown) => invoke("next", value) },
    return: { value: (value: unknown) => invoke("return", value) },
    throw: { value: (value: unknown) => invoke("throw", value) },
    [Symbol.asyncIterator]: { value: () => wrapped },
    [Symbol.asyncDispose]: { value: dispose }
  })
  if (actualTerminal)
    Object.defineProperty(wrapped, FUNCTION_STREAM_TERMINAL, { value: actualTerminal })
  return wrapped
}
