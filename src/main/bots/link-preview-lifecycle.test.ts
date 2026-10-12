import { test } from "vitest"
import assert from "node:assert/strict"
import { BotLinkPreviewService } from "./link-preview-service"
import { PublicLinkFetcher } from "./public-link-fetch"
import { BotLinkPreviewCache } from "../../renderer/src/lib/bot-link-preview-cache"
import { previewProxyPolicy } from "./link-preview-main-adapter"
import { previewTLSFixture, publicDNS } from "./link-preview-tls-fixture"
import type { BotLinkPreviewResult, BotLinkPreviewRequest } from "../../shared/bot-link-preview"
const URL = "https://preview.candidate.net/page"
const input = (url = URL) => ({ requestId: crypto.randomUUID(), url })
const ready = (url: string): BotLinkPreviewResult => ({
  status: "ready",
  metadata: {
    url,
    finalUrl: url,
    hostname: new globalThis.URL(url).hostname,
    title: "Public title",
    description: "Description",
    siteName: "Public",
    fetchedAt: 1
  }
})
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20))
const waitUntil = async (predicate: () => boolean) => {
  const deadline = performance.now() + 3000
  while (!predicate()) {
    if (performance.now() >= deadline)
      throw new Error("TLS fixture did not reach its expected handshake state")
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

test("same URL dedups owners; same lease returns exact promise; cancelling one owner keeps the other request", async () => {
  let respond: (() => void) | undefined
  const fixture = await previewTLSFixture((_request, response) => {
    respond = () =>
      response.writeHead(200, { "content-type": "text/html" }).end("<title>Public</title>")
  })
  const service = new BotLinkPreviewService({
    fetcher: new PublicLinkFetcher(publicDNS, fixture.dial),
    proxyFor: async () => "DIRECT",
    image: async () => null
  })
  try {
    const a = input(),
      b = input(),
      first = service.get("a", a),
      same = service.get("a", a),
      second = service.get("b", b)
    assert.equal(first, same)
    await waitUntil(() => respond !== undefined)
    assert.equal(fixture.observed.length, 1)
    service.closeOwner("a")
    assert.deepEqual(await first, {
      status: "unavailable",
      reason: "cancelled"
    })
    respond!()
    assert.equal((await second).status, "ready")
    assert.equal(service.metrics().requests, 0)
  } finally {
    await service.close()
    await fixture.close()
  }
})
test("last owner cancellation physically closes TLS, queued restart receives a fresh non-aborted scope", async () => {
  let held = 0
  const fixture = await previewTLSFixture((_request, response) => {
    if (++held > 1)
      response.writeHead(200, { "content-type": "text/html" }).end("<title>fresh</title>")
  })
  const service = new BotLinkPreviewService({
    fetcher: new PublicLinkFetcher(publicDNS, fixture.dial),
    proxyFor: async () => "DIRECT",
    image: async () => null
  })
  try {
    const request = input(),
      pending = service.get("a", request)
    await waitUntil(() => held === 1 && fixture.sockets.size > 0)
    service.cancel("b", request.requestId)
    assert.equal(service.metrics().requests, 1)
    service.cancel("a", request.requestId)
    assert.equal((await pending).status, "unavailable")
    const renewed = await service.get("a", input())
    assert.equal(renewed.status, "ready")
    await service.close()
    await tick()
    assert.equal(fixture.sockets.size, 0)
    assert.equal(service.metrics().active, 0)
  } finally {
    await service.close()
    await fixture.close()
  }
})
test("bounded concurrent queue, owner destruction and shared close join all native requests", async () => {
  const fixture = await previewTLSFixture(() => {})
  const service = new BotLinkPreviewService({
    fetcher: new PublicLinkFetcher(publicDNS, fixture.dial),
    proxyFor: async () => "DIRECT",
    image: async () => null
  })
  try {
    const pending = Array.from({ length: 18 }, (_, index) => service.get("a", input(URL + index)))
    await tick()
    assert.equal(fixture.observed.length, 2)
    assert.equal(service.metrics().work, 18)
    assert.deepEqual(await service.get("a", input(URL + "overflow")), {
      status: "unavailable",
      reason: "capacity"
    })
    const close = service.close()
    assert.equal(service.close(), close)
    await close
    assert.equal(
      (await Promise.all(pending)).every((value) => value.status === "unavailable"),
      true
    )
    await tick()
    assert.equal(fixture.sockets.size, 0)
    assert.deepEqual(service.metrics(), {
      active: 0,
      work: 0,
      requests: 0,
      cache: 0,
      cacheBytes: 0
    })
  } finally {
    await service.close()
    await fixture.close()
  }
})
test("Electron system/environment proxy is conservatively respected and aborted late resolveProxy cannot start a dial", async () => {
  let calls = 0,
    finish: (value: string) => void = () => {}
  const session = {
    resolveProxy: async () => {
      calls++
      return new Promise<string>((resolve) => {
        finish = resolve
      })
    }
  }
  const blocked = previewProxyPolicy(session, {
    HTTPS_PROXY: "http://user:secret@proxy.local:8080"
  })
  assert.equal(await blocked(URL, new AbortController().signal), "PROXY configured")
  assert.equal(calls, 0)
  const controller = new AbortController(),
    pending = previewProxyPolicy(session, {})(URL, controller.signal)
  controller.abort(new Error("stop"))
  await assert.rejects(pending, /stop/)
  finish("DIRECT")
  await tick()
})
test("renderer visible subscriptions dedup, no polling; last unmount cancels exact request and stale answer cannot populate next generation", async () => {
  const calls: Array<{
      input: BotLinkPreviewRequest
      resolve: (value: BotLinkPreviewResult) => void
    }> = [],
    cancelled: string[] = []
  const cache = new BotLinkPreviewCache({
    getLinkPreview: (request) => new Promise((resolve) => calls.push({ input: request, resolve })),
    cancelLinkPreview: async (request) => {
      cancelled.push(request.requestId)
    }
  })
  const resource = cache.resource(URL),
    other = cache.resource(URL)
  const off = resource.subscribe(() => {}),
    offOther = other.subscribe(() => {})
  assert.equal(calls.length, 1)
  off()
  assert.equal(cancelled.length, 0)
  offOther()
  assert.deepEqual(cancelled, [calls[0].input.requestId])
  const offNew = resource.subscribe(() => {})
  assert.equal(calls.length, 2)
  calls[0].resolve(ready(URL))
  await tick()
  assert.equal(resource.get().status, "loading")
  calls[1].resolve(ready(URL))
  await tick()
  assert.equal(resource.get().status, "ready")
  await tick()
  assert.equal(calls.length, 2)
  offNew()
  await cache.dispose()
  assert.equal(cache.metrics().pending, 0)
})
test("renderer LRU render-to-subscribe eviction does not create untracked resources and response target cannot be spoofed", async () => {
  const calls: string[] = []
  const cache = new BotLinkPreviewCache({
    getLinkPreview: async (request) => {
      calls.push(request.url)
      return ready(request.url.includes("spoof") ? URL + "wrong" : request.url)
    },
    cancelLinkPreview: async () => {}
  })
  const early = cache.resource(URL)
  for (let index = 0; index < 100; index++) cache.resource(URL + index)
  const off = early.subscribe(() => {})
  await tick()
  assert.equal(early.get().status, "ready")
  assert.equal(calls.includes(URL), true)
  assert.ok(cache.metrics().entries <= 64)
  const spoof = cache.resource(URL + "spoof"),
    offSpoof = spoof.subscribe(() => {})
  await tick()
  assert.deepEqual(spoof.get(), {
    status: "unavailable",
    reason: "unavailable"
  })
  off()
  offSpoof()
  await cache.dispose()
})

test("accepted queue deadline includes waiting time, close during async proxy resolution leaves no queued request", async () => {
  let proxyCalls = 0
  const service = new BotLinkPreviewService({
    proxyFor: async (_url, signal) => {
      ++proxyCalls
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true
        })
        signal.throwIfAborted()
      })
    },
    image: async () => null,
    deadlineMs: 40
  })
  const values = await Promise.all(
    Array.from({ length: 18 }, (_, index) => service.get("deadline", input(URL + index)))
  )
  assert.equal(
    values.every((value) => value.status === "unavailable" && value.reason === "timeout"),
    true
  )
  assert.ok(proxyCalls >= 2 && proxyCalls <= 18)
  await service.close()
  assert.deepEqual(service.metrics(), {
    active: 0,
    work: 0,
    requests: 0,
    cache: 0,
    cacheBytes: 0
  })
})
test("Main metadata cache obeys TTL/count LRU; failure fallback is cached without an automatic retry timer", async () => {
  let now = 0
  const fixture = await previewTLSFixture((request, response) =>
    response.writeHead(200, { "content-type": "text/html" }).end(`<title>${request.url}</title>`)
  )
  const service = new BotLinkPreviewService({
    fetcher: new PublicLinkFetcher(publicDNS, fixture.dial),
    proxyFor: async () => "DIRECT",
    image: async () => null,
    now: () => now
  })
  try {
    const first = input(),
      result = await service.get("cache", first)
    assert.equal(result.status, "ready")
    await service.get("cache", input())
    assert.equal(fixture.observed.length, 1)
    now = 24 * 60 * 60 * 1000 + 1
    await service.get("cache", input())
    assert.equal(fixture.observed.length, 2)
    for (let index = 0; index < 130; index++) await service.get("cache", input(URL + index))
    assert.ok(service.metrics().cache <= 128)
    assert.ok(service.metrics().cacheBytes <= 12 * 1024 * 1024)
    const before = fixture.observed.length
    await service.get("cache", input(URL + 129))
    assert.equal(fixture.observed.length, before)
    await service.get("cache", input())
    assert.equal(fixture.observed.length, before + 1)
  } finally {
    await service.close()
    await fixture.close()
  }
})

test("renderer live subscriptions keep the byte cap by dropping optional images rather than evicting visible row state", async () => {
  const image = {
    mime: "image/jpeg" as const,
    base64: Buffer.alloc(128 * 1024).toString("base64"),
    width: 480,
    height: 480
  }
  const cache = new BotLinkPreviewCache({
    getLinkPreview: async (request) => {
      const result = ready(request.url)
      return result.status === "ready"
        ? { ...result, metadata: { ...result.metadata, image } }
        : result
    },
    cancelLinkPreview: async () => {}
  })
  const resources = Array.from({ length: 64 }, (_, index) => cache.resource(URL + index)),
    unsubscribes = resources.map((resource) => resource.subscribe(() => {}))
  await tick()
  assert.ok(cache.metrics().bytes <= 10 * 1024 * 1024)
  assert.ok(cache.metrics().entries <= 64)
  assert.equal(
    resources.every((resource) => resource.get().status === "ready"),
    true
  )
  assert.equal(
    resources.some((resource) => {
      const value = resource.get()
      return value.status === "ready" && !value.metadata.image
    }),
    true
  )
  for (const unsubscribe of unsubscribes) unsubscribe()
  await cache.dispose()
})

test("logically cancelled noncancellable native proxy calls remain physically bounded", async () => {
  const finishes: Array<(value: string) => void> = []
  const proxy = previewProxyPolicy(
    {
      resolveProxy: async () => new Promise<string>((resolve) => finishes.push(resolve))
    },
    {}
  )
  for (let index = 0; index < 2; index++) {
    const controller = new AbortController(),
      pending = proxy(URL, controller.signal)
    await new Promise((resolve) => setImmediate(resolve))
    controller.abort(new Error("view closed"))
    await assert.rejects(pending, /view closed/)
  }
  await assert.rejects(proxy(URL, new AbortController().signal), /unavailable/)
  assert.equal(finishes.length, 2)
  finishes[0]("DIRECT")
  await new Promise((resolve) => setImmediate(resolve))
  const renewed = proxy(URL, new AbortController().signal)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(finishes.length, 3)
  finishes[1]("DIRECT")
  finishes[2]("DIRECT")
  assert.equal(await renewed, "DIRECT")
})

test("close joins logical work without waiting indefinitely for bounded noncancellable native PAC calls", async () => {
  const finishes: Array<(value: string) => void> = []
  const proxyFor = previewProxyPolicy(
    {
      resolveProxy: async () => new Promise<string>((resolve) => finishes.push(resolve))
    },
    {}
  )
  const service = new BotLinkPreviewService({
    proxyFor,
    image: async () => null
  })
  const requests = [service.get("closing", input()), service.get("closing", input(URL + "-2"))]
  await tick()
  assert.equal(finishes.length, 2)
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      service.close(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("close waited for uncancellable PAC")), 500)
      })
    ])
    assert.deepEqual(await Promise.all(requests), [
      { status: "unavailable", reason: "closed" },
      { status: "unavailable", reason: "closed" }
    ])
    assert.deepEqual(service.metrics(), {
      active: 0,
      work: 0,
      requests: 0,
      cache: 0,
      cacheBytes: 0
    })
    assert.deepEqual(await service.get("closing", input()), {
      status: "unavailable",
      reason: "closed"
    })
    assert.equal(finishes.length, 2)
  } finally {
    if (timeout) clearTimeout(timeout)
    for (const finish of finishes) finish("DIRECT")
    await service.close()
  }
})
