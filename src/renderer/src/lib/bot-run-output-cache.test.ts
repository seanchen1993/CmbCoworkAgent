import { afterEach, expect, it, vi } from "vitest"
import { BotStore } from "../../../main/bots/store"
import { BotRunOutputCache } from "./bot-run-output-cache"
import { readBotWorkspaceFrame } from "../../../shared/bot-workspace-frame"
import type { BotHostStatus } from "../../../shared/bot-api"
import type { BotRunOutputPage, BotRunOutputRequest } from "../../../shared/bot-run-output"
import { botPersonaState } from "./bot-persona-state"

const stores: BotStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function fixture() {
  const store = new BotStore(":memory:")
  stores.push(store)
  const { conversationId } = store.createBot({ nonce: "bot", name: "Owner" })
  store.send({ nonce: "run", conversationId, text: "Task" })
  const claim = store.claim("host")!
  const scope = { conversationId, dataEpoch: store.dataEpoch() }
  const cache = new BotRunOutputCache()
  const reconcile = () =>
    cache.reconcile(scope, "host", store.snapshot({ runProjection: "summary" }).runs)
  const read = vi.fn(async (input: BotRunOutputRequest) => ({
    ...store.runOutput(input),
    hostId: "host"
  }))
  return { store, claim, scope, cache, reconcile, read }
}
it("reads all output beyond the first 32k page, reuses a valid prefix and replaces equal-length or shorter text", async () => {
  const f = fixture()
  const id = f.claim.lease.runId
  const body = "中😀".repeat(40_000)
  f.store.streamOutput(f.claim.lease, body)
  f.reconcile()
  await f.cache.refresh(f.scope, f.read)
  expect(f.cache.project()[id].hasMore).toBe(true)
  await f.cache.refresh(f.scope, f.read)
  expect(f.cache.project()[id]).toEqual({ text: body, hasMore: false })
  const calls = f.read.mock.calls.length
  await f.cache.refresh(f.scope, f.read)
  expect(f.read).toHaveBeenCalledTimes(calls)
  f.store.streamOutput(f.claim.lease, body + "新😀")
  f.reconcile()
  await f.cache.refresh(f.scope, f.read)
  expect(f.cache.project()[id].text).toBe(body + "新😀")
  f.store.streamOutput(f.claim.lease, "改" + body.slice(1))
  f.reconcile()
  await f.cache.refresh(f.scope, f.read)
  await f.cache.refresh(f.scope, f.read)
  expect(f.cache.project()[id].text).toBe("改" + body.slice(1))
  f.store.streamOutput(f.claim.lease, "短😀")
  f.reconcile()
  await f.cache.refresh(f.scope, f.read)
  expect(f.cache.project()[id]).toEqual({ text: "短😀", hasMore: false })
})
it("coalesces the same output and drops late responses after selection/epoch/fence retirement", async () => {
  const f = fixture()
  const id = f.claim.lease.runId
  f.store.streamOutput(f.claim.lease, "Original")
  f.reconcile()
  let release!: (page: BotRunOutputPage) => void
  const pending = vi.fn(
    (input: BotRunOutputRequest) =>
      new Promise<BotRunOutputPage>((resolve) => {
        release = () => resolve({ ...f.store.runOutput(input), hostId: "host" })
      })
  )
  const a = f.cache.refresh(f.scope, pending)
  const b = f.cache.refresh(f.scope, pending)
  expect(pending).toHaveBeenCalledOnce()
  f.cache.clear()
  release({} as BotRunOutputPage)
  await Promise.all([a, b])
  expect(f.cache.project()).toEqual({})
  f.reconcile()
  await f.cache.refresh(f.scope, f.read)
  expect(f.cache.project()[id].text).toBe("Original")
  const run = f.store.snapshot({ runProjection: "summary" }).runs[0]
  f.cache.reconcile(f.scope, "host", [{ ...run, fence: run.fence + 1 }])
  expect(f.cache.project()[id].text).toBe("")
  f.cache.reconcile({ ...f.scope, dataEpoch: "restored" }, "host", [])
  expect(f.cache.project()).toEqual({})
})
it("bounds resident output to five targets and in-flight transport to two, retiring queued old reads", async () => {
  const f = fixture()
  const base = f.store.getRun(f.claim.lease.runId)
  const runs = Array.from({ length: 9 }, (_, i) => ({
    ...base,
    id: `run-${i}`,
    hasOutput: true,
    outputCursor: 1
  }))
  f.cache.reconcile(f.scope, "host", runs)
  expect(Object.keys(f.cache.project())).toHaveLength(5)
  const releases: (() => void)[] = []
  const read = vi.fn(
    () =>
      new Promise<BotRunOutputPage>((resolve) =>
        releases.push(() => resolve({} as BotRunOutputPage))
      )
  )
  const work = f.cache.refresh(f.scope, read)
  expect(read).toHaveBeenCalledTimes(2)
  f.cache.clear()
  for (const release of releases) release()
  await work
  expect(read).toHaveBeenCalledTimes(2)
  expect(f.cache.project()).toEqual({})
})
it("negotiates legacy output fallback and retries a changed modern Host before accepting an epoch-bound frame", async () => {
  const f = fixture()
  const legacy: BotHostStatus = {
    protocol: 1,
    hostId: "legacy",
    platform: "darwin",
    runtimeReady: true,
    error: null
  }
  const snapshot = vi.fn(async () => f.store.snapshot())
  await readBotWorkspaceFrame({ status: vi.fn(async () => legacy), snapshot })
  expect(snapshot).toHaveBeenCalledWith(undefined)
  const modern = {
    ...legacy,
    hostId: "new",
    dataEpoch: f.scope.dataEpoch,
    capabilities: ["run-output-pages-v1"]
  }
  const modernSnapshot = vi
    .fn()
    .mockResolvedValueOnce({ ...f.store.snapshot({ runProjection: "summary" }), hostId: "old" })
    .mockResolvedValueOnce({ ...f.store.snapshot({ runProjection: "summary" }), hostId: "new" })
  const frame = await readBotWorkspaceFrame({
    status: vi.fn(async () => modern),
    snapshot: modernSnapshot
  })
  expect(frame.host.hostId).toBe("new")
  expect(modernSnapshot).toHaveBeenCalledTimes(2)
  expect(modernSnapshot).toHaveBeenCalledWith({ runProjection: "summary" })
  expect(
    botPersonaState({
      status: "running",
      waitingForBot: null,
      activity: { kind: "thinking", description: "" },
      hasOutput: true
    })
  ).toBe("writing")
})

it("rejects a page from another Host without publishing its body", async () => {
  const f = fixture()
  const id = f.claim.lease.runId
  f.store.streamOutput(f.claim.lease, "Authorized body")
  f.reconcile()
  await f.cache.refresh(f.scope, async (input) => ({
    ...f.store.runOutput(input),
    hostId: "other-host",
    text: "Foreign body"
  }))
  expect(f.cache.project()[id].text).toBe("")
  expect(f.cache.project()[id].error).toContain("身份已变化")
})
