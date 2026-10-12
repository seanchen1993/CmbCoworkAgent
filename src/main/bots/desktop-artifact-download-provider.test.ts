import { expect, it, vi } from "vitest"
import type { BotArtifactDownloadSource } from "../../shared/bot-artifact-downloads"
import {
  DesktopArtifactDownloadSource,
  type ArtifactSourceConnection
} from "./desktop-artifact-download-provider"
import { openArtifactSourceConnection } from "./desktop-artifact-source-connection"

const source: BotArtifactDownloadSource = {
  artifactId: "file",
  conversationId: "conversation",
  size: 3,
  sha256: "a".repeat(64),
  dataEpoch: "epoch"
}
const artifact = {
  id: source.artifactId,
  conversationId: source.conversationId,
  size: source.size,
  sha256: source.sha256,
  name: "hello.txt",
  mime: "text/plain",
  createdAt: 1,
  runId: null
}
function connection() {
  let epoch = "epoch"
  let chunkPending: ((value: unknown) => void) | undefined
  let rejectChunk: ((error: Error) => void) | undefined
  const call = vi.fn(async (method: string, input?: { offset: number }): Promise<unknown> => {
    if (method === "status") return { hostId: "host", dataEpoch: epoch }
    if (method === "fileChunk")
      return { artifact, offset: input!.offset, base64: input!.offset === 3 ? "" : "YWJj" }
    throw new Error("Unexpected source request")
  })
  const close = vi.fn(() => rejectChunk?.(new Error("closed")))
  const closeAndWait = vi.fn(async () => close())
  return {
    client: { call, close, closeAndWait } as ArtifactSourceConnection,
    call,
    close,
    closeAndWait,
    setEpoch: (value: string) => {
      epoch = value
    },
    holdChunk() {
      call.mockImplementation(async (method) => {
        if (method === "status") return { hostId: "host", dataEpoch: epoch }
        return new Promise((resolve, reject) => {
          chunkPending = resolve
          rejectChunk = reject
        })
      })
    },
    get chunkPending() {
      return chunkPending
    }
  }
}

it("describes an artifact through an authenticated EOF read without allocating its payload", async () => {
  const fixture = connection()
  const signal = new AbortController().signal
  const provider = new DesktopArtifactDownloadSource(
    async () => fixture.client,
    () => {}
  )
  expect((await provider.describe(source, signal)).artifact.id).toBe(source.artifactId)
  expect(fixture.call.mock.calls.map(([method]) => method)).toEqual([
    "status",
    "fileChunk",
    "status"
  ])
  expect(fixture.call.mock.calls[1][1]).toEqual({ id: source.artifactId, offset: 3 })
  await provider.release(signal)
  expect(fixture.closeAndWait).toHaveBeenCalledOnce()
})

it("rejects bytes read across a restored data epoch", async () => {
  const fixture = connection()
  const signal = new AbortController().signal
  const provider = new DesktopArtifactDownloadSource(
    async () => fixture.client,
    () => {}
  )
  fixture.holdChunk()
  const result = provider.read(source, 0, signal)
  const rejected = expect(result).rejects.toMatchObject({ code: "download_source_changed" })
  await vi.waitFor(() => expect(fixture.chunkPending).toBeDefined())
  fixture.setEpoch("restored")
  fixture.chunkPending!({ artifact, offset: 0, base64: "YWJj" })
  await rejected
  await provider.release(signal)
})

it("cancels only its private session while another authenticated read stays usable", async () => {
  const first = connection(),
    second = connection()
  const a = new AbortController(),
    b = new AbortController()
  const clients = [first.client, second.client]
  const provider = new DesktopArtifactDownloadSource(
    async () => clients.shift()!,
    () => {}
  )
  first.holdChunk()
  const pending = provider.read(source, 0, a.signal)
  const rejected = expect(pending).rejects.toThrow("closed")
  await vi.waitFor(() => expect(first.chunkPending).toBeDefined())
  expect((await provider.read(source, 0, b.signal)).chunk.base64).toBe("YWJj")
  a.abort()
  await rejected
  expect(second.close).not.toHaveBeenCalled()
  await provider.release(a.signal)
  await provider.release(b.signal)
})

it("waits for a late private open to physically close without sending requests", async () => {
  const fixture = connection(),
    controller = new AbortController()
  let finish!: (client: ArtifactSourceConnection) => void
  const provider = new DesktopArtifactDownloadSource(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
    () => {}
  )
  const result = provider.describe(source, controller.signal).catch((error) => error)
  await vi.waitFor(() => expect(finish).toBeDefined())
  controller.abort()
  const released = vi.fn()
  const release = provider.release(controller.signal).then(released)
  await result
  expect(released).not.toHaveBeenCalled()
  finish(fixture.client)
  await release
  expect(fixture.closeAndWait).toHaveBeenCalledOnce()
  expect(fixture.call).not.toHaveBeenCalled()
})

it("closes a newly opened private connection when its owner has been replaced", async () => {
  const fixture = connection(),
    signal = new AbortController().signal
  let owned = true
  let finish!: (client: ArtifactSourceConnection) => void
  const provider = new DesktopArtifactDownloadSource(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
    () => {
      if (!owned) throw new Error("replaced")
    }
  )
  const result = expect(provider.describe(source, signal)).rejects.toThrow("replaced")
  await vi.waitFor(() => expect(finish).toBeDefined())
  owned = false
  finish(fixture.client)
  await result
  await provider.release(signal)
  expect(fixture.closeAndWait).toHaveBeenCalledOnce()
  expect(fixture.call).not.toHaveBeenCalled()
})

it("does not clone or cancel the shared Host launch after a file-open abort", async () => {
  const controller = new AbortController(),
    clone = vi.fn()
  let complete!: (value: { openIsolatedConnection: typeof clone }) => void
  const result = openArtifactSourceConnection(
    controller.signal,
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  ).catch((error) => error)
  await vi.waitFor(() => expect(complete).toBeDefined())
  controller.abort()
  await result
  complete({ openIsolatedConnection: clone })
  await Promise.resolve()
  await Promise.resolve()
  expect(clone).not.toHaveBeenCalled()
})
