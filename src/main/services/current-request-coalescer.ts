export interface CurrentRequestCoalescerOptions<T> {
  scope: string
  requestKey: string
  begin: () => number
  isCurrent: (generation: number) => boolean
  finish: (generation: number) => void
  run: (generation: number) => Promise<T>
}

interface CurrentRequestEntry<T> {
  requestKey: string
  generation: number
  promise: Promise<T>
}

/**
 * Shares one current, identical request without advancing its latest-intent
 * generation. A different request still begins a new generation and keeps the
 * caller's normal supersession semantics.
 */
export class CurrentRequestCoalescer<T> {
  private readonly entries = new Map<string, CurrentRequestEntry<T>>()

  run(options: CurrentRequestCoalescerOptions<T>): Promise<T> {
    const existing = this.entries.get(options.scope)
    if (existing?.requestKey === options.requestKey && options.isCurrent(existing.generation)) {
      return existing.promise
    }

    const generation = options.begin()
    const promise = Promise.resolve()
      .then(() => options.run(generation))
      .finally(() => {
        try {
          options.finish(generation)
        } finally {
          if (this.entries.get(options.scope)?.promise === promise) {
            this.entries.delete(options.scope)
          }
        }
      })
    const entry = { requestKey: options.requestKey, generation, promise }
    this.entries.set(options.scope, entry)
    return promise
  }

  get retainedScopeCount(): number {
    return this.entries.size
  }
}
