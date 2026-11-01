/** Test-only reads. Explicitly await both the read and predicate; never pass a mutation. */
export async function pollPublicState<T>(
  read: () => T | Promise<T>,
  accept: (value: T) => boolean | Promise<boolean>,
  options: { deadline: number; code: string; delayMs?: number; observe?(value: T): void }
): Promise<T> {
  while (Date.now() < options.deadline) {
    const value = await read()
    options.observe?.(value)
    if (await accept(value)) return value
    const remaining = options.deadline - Date.now()
    if (remaining > 0)
      await new Promise((done) => setTimeout(done, Math.min(options.delayMs ?? 100, remaining)))
  }
  throw Error(options.code)
}
