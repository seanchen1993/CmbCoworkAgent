import { requestCodeHighlight } from "../components/tabs/code-highlight-client"

const MAX_PENDING = 16
const MAX_CACHE_ENTRIES = 16
const MAX_CACHE_CHARS = 1024 * 1024
const MAX_OUTPUT_CHARS = 512 * 1024
const MIN_START_INTERVAL_MS = 100

interface HighlightRequest {
  promise: Promise<string>
  cancel: () => void
}

interface HighlightJob {
  owner: object
  source: string
  language: string
  key: string
  settled: boolean
  resolve: (html: string) => void
  reject: (error: unknown) => void
}

/** A Mods-only queue. File previews continue using their existing worker client directly. */
export function createFunctionCodeHighlighter(raw = requestCodeHighlight): {
  request: (owner: object, source: string, language: string) => HighlightRequest
} {
  const pending = new Map<object, HighlightJob>()
  const cache = new Map<string, string>()
  let cacheChars = 0
  let active: HighlightJob | undefined
  let nextStart = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  function reject(job: HighlightJob, error: unknown): void {
    if (job.settled) return
    job.settled = true
    job.reject(error)
  }

  function cancel(job: HighlightJob): void {
    if (pending.get(job.owner) === job) pending.delete(job.owner)
    reject(job, new Error("MODS_CODE_HIGHLIGHT_CANCELLED"))
    if (pending.size === 0 && timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    // Never call raw.cancel(): it rejects immediately but cannot stop worker computation.
    // An abandoned active job must retain its slot until the actual worker reply/error.
  }

  function remember(key: string, html: string): void {
    const previous = cache.get(key)
    if (previous !== undefined) {
      cacheChars -= key.length + previous.length
      cache.delete(key)
    }
    cache.set(key, html)
    cacheChars += key.length + html.length
    while (cache.size > MAX_CACHE_ENTRIES || cacheChars > MAX_CACHE_CHARS) {
      const oldest = cache.entries().next().value
      if (!oldest) break
      cache.delete(oldest[0])
      cacheChars -= oldest[0].length + oldest[1].length
    }
  }

  function finish(job: HighlightJob, html?: string, error?: unknown): void {
    if (!job.settled) {
      if (typeof html !== "string" || html.length > MAX_OUTPUT_CHARS) {
        reject(job, error ?? new Error("MODS_CODE_HIGHLIGHT_OUTPUT"))
      } else {
        remember(job.key, html)
        job.settled = true
        job.resolve(html)
      }
    }
    active = undefined
    pump()
  }

  function pump(): void {
    if (active || timer !== undefined || pending.size === 0) return
    const delay = Math.max(0, nextStart - Date.now())
    if (delay > 0) {
      timer = setTimeout(() => {
        timer = undefined
        pump()
      }, delay)
      return
    }
    const job = pending.values().next().value
    if (!job) return
    pending.delete(job.owner)
    active = job
    nextStart = Date.now() + MIN_START_INTERVAL_MS
    try {
      void raw(job.source, job.language).promise.then(
        (html) => finish(job, html),
        (error) => finish(job, undefined, error)
      )
    } catch (error) {
      finish(job, undefined, error)
    }
  }

  return {
    request(owner, source, language) {
      let resolve!: (html: string) => void
      let rejectPromise!: (error: unknown) => void
      const promise = new Promise<string>((yes, no) => {
        resolve = yes
        rejectPromise = no
      })
      const job: HighlightJob = {
        owner,
        source,
        language,
        key: `${language}\u0000${source}`,
        settled: false,
        resolve,
        reject: rejectPromise
      }
      const previous = pending.get(owner)
      if (previous) cancel(previous)
      if (active?.owner === owner) cancel(active)
      if (source.length > 10000 || !/^[a-z0-9-]{1,64}$/i.test(language)) {
        reject(job, new Error("MODS_CODE_HIGHLIGHT_INPUT"))
      } else {
        const cached = cache.get(job.key)
        if (cached !== undefined) {
          cache.delete(job.key)
          cache.set(job.key, cached)
          job.settled = true
          resolve(cached)
        } else if (pending.size >= MAX_PENDING) {
          reject(job, new Error("MODS_CODE_HIGHLIGHT_QUEUE_FULL"))
        } else {
          pending.set(owner, job)
          pump()
        }
      }
      return { promise, cancel: () => cancel(job) }
    }
  }
}

export const functionCodeHighlighter = createFunctionCodeHighlighter()
