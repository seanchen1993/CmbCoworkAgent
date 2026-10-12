import type { BotImageResult } from "./image-contract"
import type { BotDocumentReader } from "./document-reader"

interface ImageWork {
  controller: AbortController
  consumers: number
  promise: Promise<BotImageResult>
}
interface ImageCacheEntry {
  value: BotImageResult
  bytes: number
}

/** Host-owned raster reuse. Callers still authorize and hash the original on every read.
 * Consumer cancellation and byte-budgeted LRU are adapted from link-preview-service
 * and workspace-file-preview-cache; this class owns only immutable raster results. */
export class BotArtifactImagePreviews {
  private readonly work = new Map<string, ImageWork>()
  private readonly running = new Set<ImageWork>()
  private readonly cache = new Map<string, ImageCacheEntry>()
  private cacheBytes = 0
  private closed = false
  constructor(private readonly reader: BotDocumentReader) {}

  async get(key: string, bytes: Buffer, signal: AbortSignal): Promise<BotImageResult> {
    signal.throwIfAborted()
    if (this.closed) throw new Error("文件服务正在关闭")
    const cached = this.cache.get(key)
    if (cached) {
      this.cache.delete(key)
      this.cache.set(key, cached)
      return cached.value
    }
    let work = this.work.get(key)
    if (!work || work.controller.signal.aborted) {
      if (this.running.size >= 4) throw new Error("当前预览较多，请稍后重试")
      const controller = new AbortController()
      const pending: ImageWork = {
        controller,
        consumers: 0,
        promise: Promise.resolve()
          .then(() => {
            controller.signal.throwIfAborted()
            return this.reader.image(bytes, undefined, controller.signal)
          })
          .then((value) => {
            controller.signal.throwIfAborted()
            if (!this.closed) this.remember(key, value)
            return value
          })
          .finally(() => {
            this.running.delete(pending)
            if (this.work.get(key) === pending) this.work.delete(key)
          })
      }
      this.work.set(key, pending)
      this.running.add(pending)
      work = pending
    }
    const selected = work
    selected.consumers++
    return new Promise<BotImageResult>((resolve, reject) => {
      let settled = false
      const finish = (result: { value: BotImageResult } | { error: unknown }) => {
        if (settled) return
        settled = true
        signal.removeEventListener("abort", cancel)
        selected.consumers--
        if ("error" in result) reject(result.error)
        else resolve(result.value)
      }
      const cancel = () => {
        finish({ error: signal.reason ?? new Error("文件预览已取消") })
        if (!selected.consumers) selected.controller.abort(signal.reason)
      }
      signal.addEventListener("abort", cancel, { once: true })
      if (signal.aborted) cancel()
      selected.promise.then(
        (value) => finish({ value }),
        (error) => finish({ error })
      )
    })
  }

  async close(): Promise<void> {
    this.closed = true
    for (const work of this.running) work.controller.abort(new Error("文件服务正在关闭"))
    await Promise.allSettled([...this.running].map((work) => work.promise))
    this.cache.clear()
    this.cacheBytes = 0
  }

  private remember(key: string, value: BotImageResult): void {
    // A 1 MiB wire view can occupy more than 2 MiB as a UTF-16 base64 string.
    const bytes = (value.base64.length + key.length) * 2 + 512
    const budget = 8 * 1024 * 1024
    if (bytes > budget) return
    const previous = this.cache.get(key)
    if (previous) this.cacheBytes -= previous.bytes
    this.cache.delete(key)
    this.cache.set(key, { value, bytes })
    this.cacheBytes += bytes
    while (this.cache.size > 16 || this.cacheBytes > budget) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cacheBytes -= this.cache.get(oldest)!.bytes
      this.cache.delete(oldest)
    }
  }
}
