import { expect, test } from "vitest"
import { BotLinkPreviewCache } from "./bot-link-preview-cache"
import type {
  BotLinkPreviewClient,
  BotLinkPreviewRequest,
  BotLinkPreviewResult
} from "../../../shared/bot-link-preview"

const url = "https://public.candidate.net/page"
const image = {
  mime: "image/jpeg" as const,
  base64: Buffer.alloc(128 * 1024).toString("base64"),
  width: 480,
  height: 480
}
const ready = (target: string): BotLinkPreviewResult => ({
  status: "ready",
  metadata: {
    url: target,
    finalUrl: target,
    hostname: new URL(target).hostname,
    title: "Public",
    description: "",
    siteName: "Public",
    fetchedAt: 1,
    image
  }
})
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function immediate() {
  const calls: string[] = []
  const client: BotLinkPreviewClient = {
    getLinkPreview: async ({ url: target }) => {
      calls.push(target)
      return ready(target)
    },
    cancelLinkPreview: async () => {}
  }
  return { client, calls }
}
function deferred() {
  const calls: Array<{
    input: BotLinkPreviewRequest
    resolve(value: BotLinkPreviewResult): void
  }> = []
  const cancelled: string[] = []
  const client: BotLinkPreviewClient = {
    getLinkPreview: (input) => new Promise((resolve) => calls.push({ input, resolve })),
    cancelLinkPreview: async ({ requestId }) => {
      cancelled.push(requestId)
    }
  }
  return { client, calls, cancelled }
}

test("expired retained resources release decoded snapshots and reload without negative or missing byte accounting", async () => {
  let now = 0
  const { client, calls } = immediate(),
    cache = new BotLinkPreviewCache(client, () => now),
    resource = cache.resource(url)
  const off = resource.subscribe(() => {})
  await tick()
  expect(cache.metrics().bytes).toBe(JSON.stringify(resource.get()).length * 2)
  off()
  now = 24 * 60 * 60 * 1000 + 1
  cache.resource(url + "-other")
  expect(resource.get().status).toBe("idle")
  expect(cache.metrics().bytes).toBe(0)
  const offNew = resource.subscribe(() => {})
  expect(cache.metrics().bytes).toBe(0)
  await tick()
  expect(calls).toEqual([url, url])
  expect(cache.metrics().bytes).toBe(JSON.stringify(resource.get()).length * 2)
  offNew()
  await cache.dispose()
})

test("count LRU retirement and retained rejoin enforce the 10 MiB budget while preserving subscribed results", async () => {
  const { client, calls } = immediate(),
    cache = new BotLinkPreviewCache(client),
    retained = cache.resource(url)
  const offOld = retained.subscribe(() => {})
  await tick()
  offOld()
  const active: Array<{ resource: ReturnType<BotLinkPreviewCache["resource"]>; off(): void }> = []
  for (let index = 0; index < 63; index++) {
    const resource = cache.resource(url + index),
      off = resource.subscribe(() => {})
    active.push({ resource, off })
    await tick()
  }
  // This resource lookup evicts only the unobserved oldest entry; its closure
  // remains held just as a temporarily inactive mounted card would retain it.
  cache.resource(url + "-overflow")
  expect(retained.get().status).toBe("idle")
  const offRetained = retained.subscribe(() => {})
  await tick()
  const states = [...active.map(({ resource }) => resource.get()), retained.get()]
  expect(states.every((value) => value.status === "ready")).toBe(true)
  expect(calls.filter((value) => value === url)).toHaveLength(2)
  const actual = states.reduce((bytes, value) => bytes + JSON.stringify(value).length * 2, 0)
  expect(cache.metrics().bytes).toBe(actual)
  expect(actual).toBeLessThanOrEqual(10 * 1024 * 1024)
  for (const { off } of active) off()
  offRetained()
  await cache.dispose()
})

test("an evicted resource joins the current same-URL entry and stale completion/cleanup cannot cancel its lease", async () => {
  const { client, calls, cancelled } = deferred(),
    cache = new BotLinkPreviewCache(client),
    retained = cache.resource(url)
  let oldNotifications = 0,
    newNotifications = 0
  const offOld = retained.subscribe(() => oldNotifications++)
  offOld()
  expect(cancelled).toEqual([calls[0].input.requestId])
  cache.resource(url + "-prune")
  const current = cache.resource(url),
    offCurrent = current.subscribe(() => newNotifications++),
    offRejoined = retained.subscribe(() => oldNotifications++)
  expect(calls).toHaveLength(2)
  calls[0].resolve(ready(url))
  await tick()
  expect(current.get().status).toBe("loading")
  expect(retained.get().status).toBe("loading")
  offOld()
  offRejoined()
  expect(cancelled).toEqual([calls[0].input.requestId])
  const offRejoinedAgain = retained.subscribe(() => oldNotifications++)
  const beforeOld = oldNotifications,
    beforeNew = newNotifications
  calls[1].resolve(ready(url))
  await tick()
  expect(oldNotifications).toBeGreaterThan(beforeOld)
  expect(newNotifications).toBeGreaterThan(beforeNew)
  expect(retained.get()).toBe(current.get())
  expect(cache.metrics().bytes).toBe(JSON.stringify(current.get()).length * 2)
  offCurrent()
  offRejoinedAgain()
  await cache.dispose()
})

test("temporarily inactive unexpired entries preserve their ready result without another request", async () => {
  const { client, calls } = immediate(),
    cache = new BotLinkPreviewCache(client),
    resource = cache.resource(url)
  const off = resource.subscribe(() => {})
  await tick()
  const before = resource.get(),
    bytes = cache.metrics().bytes
  off()
  const offAgain = resource.subscribe(() => {})
  await tick()
  expect(resource.get()).toBe(before)
  expect(cache.metrics().bytes).toBe(bytes)
  expect(calls).toEqual([url])
  offAgain()
  await cache.dispose()
})
