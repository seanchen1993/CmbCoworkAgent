import {
  botLinkPreviewRequest,
  botLinkPreviewResult,
  type BotLinkPreviewImage,
  type BotLinkPreviewRequest,
  type BotLinkPreviewResult
} from "../../shared/bot-link-preview"
import { PublicLinkFetcher, LinkPreviewFailure } from "./public-link-fetch"
import { scrapeBotLinkPreview } from "./link-preview-metadata"

interface Consumer {
  owner: string
  id: string
  resolve: (value: BotLinkPreviewResult) => void
  promise: Promise<BotLinkPreviewResult>
}
interface Work {
  url: string
  controller: AbortController
  consumers: Map<string, Consumer>
  promise?: Promise<void>
  deadline?: ReturnType<typeof setTimeout>
}
interface Cache {
  value: BotLinkPreviewResult
  expires: number
  bytes: number
}
export interface BotLinkPreviewServiceOptions {
  proxyFor(url: string, signal: AbortSignal): Promise<string>
  fetcher?: PublicLinkFetcher
  image(bytes: Buffer, mime: string, signal: AbortSignal): Promise<BotLinkPreviewImage | null>
  now?: () => number
  deadlineMs?: number
}
/** Main-owned bounded shared work; owner cancellation cannot cancel another visible card's lease. */
export class BotLinkPreviewService {
  private readonly work = new Map<string, Work>()
  private readonly requests = new Map<string, Work>()
  private readonly running = new Set<Work>()
  private readonly cache = new Map<string, Cache>()
  private cacheBytes = 0
  private active = 0
  private stopped = false
  private closing?: Promise<void>
  private readonly fetcher: PublicLinkFetcher
  private readonly now: () => number
  constructor(private readonly options: BotLinkPreviewServiceOptions) {
    if (
      options.deadlineMs !== undefined &&
      (!Number.isInteger(options.deadlineMs) ||
        options.deadlineMs < 1 ||
        options.deadlineMs > 10_000)
    )
      throw new Error("Preview deadline limit")
    this.fetcher = options.fetcher ?? new PublicLinkFetcher()
    this.now = options.now ?? Date.now
  }
  get(owner: string, raw: unknown): Promise<BotLinkPreviewResult> {
    const parsed = botLinkPreviewRequest.safeParse(raw)
    if (!parsed.success) return Promise.resolve({ status: "unavailable", reason: "blocked" })
    if (this.stopped) return Promise.resolve({ status: "unavailable", reason: "closed" })
    const input: BotLinkPreviewRequest = parsed.data,
      key = owner + ":" + input.requestId
    // Same owner+ID is a lease identity, not a replay for a different URL.
    const prior = this.requests.get(key)
    if (prior) {
      if (prior.url !== input.url)
        return Promise.resolve({ status: "unavailable", reason: "blocked" })
      return prior.consumers.get(key)!.promise
    }
    const cached = this.cache.get(input.url)
    if (cached && cached.expires > this.now()) {
      this.cache.delete(input.url)
      this.cache.set(input.url, cached)
      return Promise.resolve(cached.value)
    }
    if (cached) {
      this.cache.delete(input.url)
      this.cacheBytes -= cached.bytes
    }
    if (this.requests.size >= 64)
      return Promise.resolve({ status: "unavailable", reason: "capacity" })
    let work = this.work.get(input.url)
    if (!work) {
      if (this.work.size >= 18)
        return Promise.resolve({ status: "unavailable", reason: "capacity" })
      work = {
        url: input.url,
        controller: new AbortController(),
        consumers: new Map()
      }
      const pending = work
      work.deadline = setTimeout(() => this.expire(pending), this.options.deadlineMs ?? 10_000)
      this.work.set(input.url, work)
    }
    const selected = work
    let settle!: (value: BotLinkPreviewResult) => void
    const answer = new Promise<BotLinkPreviewResult>((resolve) => {
      settle = resolve
    })
    selected.consumers.set(key, {
      owner,
      id: input.requestId,
      resolve: settle,
      promise: answer
    })
    this.requests.set(key, selected)
    this.pump()
    return answer
  }
  cancel(owner: string, id: string): void {
    const key = owner + ":" + id,
      work = this.requests.get(key)
    if (!work) return
    this.requests.delete(key)
    const consumer = work.consumers.get(key)
    work.consumers.delete(key)
    consumer?.resolve({ status: "unavailable", reason: "cancelled" })
    if (!work.consumers.size) {
      work.controller.abort()
      if (!work.promise && work.deadline) clearTimeout(work.deadline)
      if (this.work.get(work.url) === work) this.work.delete(work.url)
    }
  }
  closeOwner(owner: string): void {
    for (const [key, work] of this.requests) {
      const consumer = work.consumers.get(key)
      if (consumer?.owner === owner) this.cancel(owner, consumer.id)
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.stopped = true
    for (const work of new Set([...this.work.values(), ...this.running])) {
      work.controller.abort()
      if (work.deadline) clearTimeout(work.deadline)
      for (const consumer of work.consumers.values())
        consumer.resolve({ status: "unavailable", reason: "closed" })
      work.consumers.clear()
    }
    this.requests.clear()
    this.closing = Promise.allSettled(
      [...this.running].flatMap((work) => (work.promise ? [work.promise] : []))
    ).then(() => {
      this.work.clear()
      this.cache.clear()
      this.cacheBytes = 0
    })
    return this.closing
  }
  metrics() {
    return {
      active: this.active,
      work: this.work.size,
      requests: this.requests.size,
      cache: this.cache.size,
      cacheBytes: this.cacheBytes
    }
  }
  private pump(): void {
    if (this.stopped) return
    for (const work of this.work.values()) {
      if (this.active >= 2) break
      if (work.promise || !work.consumers.size) continue
      this.active++
      this.running.add(work)
      work.promise = Promise.resolve()
        .then(() => this.run(work))
        .then((value) => {
          if (
            !this.stopped &&
            !work.controller.signal.aborted &&
            work.consumers.size &&
            !(
              value.status === "unavailable" &&
              ["cancelled", "closed", "capacity"].includes(value.reason)
            )
          )
            this.remember(work.url, value)
          for (const [key, consumer] of work.consumers) {
            this.requests.delete(key)
            consumer.resolve(value)
          }
          work.consumers.clear()
        })
        .finally(() => {
          if (work.deadline) clearTimeout(work.deadline)
          this.active--
          this.running.delete(work)
          if (this.work.get(work.url) === work) this.work.delete(work.url)
          this.pump()
        })
    }
  }
  private expire(work: Work): void {
    work.controller.abort(new LinkPreviewFailure("timeout"))
    if (work.promise) return
    for (const [key, consumer] of work.consumers) {
      this.requests.delete(key)
      consumer.resolve({ status: "unavailable", reason: "timeout" })
    }
    work.consumers.clear()
    if (this.work.get(work.url) === work) this.work.delete(work.url)
    this.pump()
  }
  private async run(work: Work): Promise<BotLinkPreviewResult> {
    const signal = work.controller.signal
    try {
      const route = async (url: string, activeSignal: AbortSignal) => {
        const proxy = await this.options.proxyFor(url, activeSignal)
        activeSignal.throwIfAborted()
        if (proxy.trim().toUpperCase() !== "DIRECT")
          throw new LinkPreviewFailure("proxy_unsupported")
      }
      const response = await this.fetcher.fetch(work.url, "html", signal, route)
      const contentType = response.headers["content-type"]
      const parsed = scrapeBotLinkPreview(
        response.bytes,
        response.finalUrl,
        Array.isArray(contentType) ? contentType[0] : contentType
      )
      let image: BotLinkPreviewImage | null = null
      if (parsed.imageUrl) {
        try {
          const resource = await this.fetcher.fetch(parsed.imageUrl, "image", signal, route)
          const header = resource.headers["content-type"]
          const mime = (Array.isArray(header) ? header[0] : (header ?? ""))
            .split(";", 1)[0]
            .trim()
            .toLowerCase()
          image = await this.options.image(resource.bytes, mime, signal)
        } catch {
          signal.throwIfAborted()
        }
      }
      signal.throwIfAborted()
      return botLinkPreviewResult.parse({
        status: "ready",
        metadata: {
          url: work.url,
          finalUrl: response.finalUrl,
          hostname: new URL(response.finalUrl).hostname,
          title: parsed.title,
          description: parsed.description,
          siteName: parsed.siteName,
          ...(image ? { image } : {}),
          fetchedAt: this.now()
        }
      })
    } catch (error) {
      const reason = signal.aborted
        ? signal.reason instanceof LinkPreviewFailure
          ? signal.reason.reason
          : "cancelled"
        : error instanceof LinkPreviewFailure
          ? error.reason
          : "unavailable"
      return { status: "unavailable", reason }
    }
  }
  private remember(url: string, value: BotLinkPreviewResult): void {
    const bytes = JSON.stringify(value).length * 2,
      previous = this.cache.get(url)
    if (previous) {
      this.cacheBytes -= previous.bytes
      this.cache.delete(url)
    }
    this.cache.set(url, {
      value,
      bytes,
      expires: this.now() + (value.status === "ready" ? 24 * 60 * 60 * 1000 : 60 * 1000)
    })
    this.cacheBytes += bytes
    while (this.cache.size > 128 || this.cacheBytes > 12 * 1024 * 1024) {
      const key = this.cache.keys().next().value
      if (key === undefined) break
      this.cacheBytes -= this.cache.get(key)!.bytes
      this.cache.delete(key)
    }
  }
}
