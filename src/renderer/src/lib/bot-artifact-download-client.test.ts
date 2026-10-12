import { expect, it } from "vitest"
import type {
  BotArtifactDownloadsAPI,
  BotArtifactDownloadJob
} from "../../../shared/bot-artifact-downloads"
import type { BotIpcTransport } from "../../../shared/bot-ipc-result"
import { createBotArtifactDownloadClient } from "./bot-artifact-download-client"
import { createBotDownloadStartStore } from "./bot-artifact-download-starts"
const source = {
  artifactId: "artifact-1",
  conversationId: "conversation-1",
  sha256: "a".repeat(64),
  size: 20,
  dataEpoch: "epoch-1"
}
const label = { name: "report.txt", mime: "text/plain" }
function fixture(start: BotIpcTransport<BotArtifactDownloadsAPI>["start"]) {
  let raw: string | null = null
  const storage = {
    getItem: () => raw,
    setItem: (_key: string, value: string) => {
      raw = value
    },
    removeItem: () => {
      raw = null
    }
  }
  const store = createBotDownloadStartStore(() => storage)
  const client = createBotArtifactDownloadClient(
    () => ({ start }) as BotIpcTransport<BotArtifactDownloadsAPI>,
    store
  )
  return { client, store, storage }
}
function job(nonce: string): BotArtifactDownloadJob {
  return {
    id: nonce,
    revision: 1,
    source,
    ...label,
    state: "choosing",
    bytes: 0,
    total: source.size,
    createdAt: 1,
    updatedAt: 1
  }
}
it("lost start ACK reuses the durable nonce and a choosing ACK hands authority to Main", async () => {
  const calls: string[] = []
  let loseReply = true
  const f = fixture(async (input) => {
    calls.push(input.nonce)
    if (loseReply) {
      loseReply = false
      return { botFailure: { code: "transport_closed", message: "Lost" } }
    }
    return job(input.nonce)
  })
  await expect(f.client.start(source, label)).rejects.toThrow("Lost")
  const reopened = createBotDownloadStartStore(() => f.storage).inspect()
  expect(reopened.kind).toBe("valid")
  await f.client.start(source, label)
  expect(calls[1]).toBe(calls[0])
  expect(f.store.inspect()).toEqual({ kind: "empty" })
})
it("a malformed or substituted ACK retains the intent; definitive rejection ends only the exact nonce", async () => {
  let result: "wrong" | "reject" = "wrong"
  const f = fixture(async (input) =>
    result === "wrong"
      ? { ...job(input.nonce), source: { ...source, sha256: "b".repeat(64) } }
      : { botFailure: { code: "download_capacity", message: "Capacity" } }
  )
  await expect(f.client.start(source, label)).rejects.toThrow()
  expect(f.store.inspect().kind).toBe("valid")
  result = "reject"
  await expect(f.client.start(source, label)).rejects.toThrow("Capacity")
  expect(f.store.inspect().kind).toBe("empty")
})
it("cleanup failure after accepted ACK reports the known task without replaying it", async () => {
  let calls = 0
  const f = fixture(async (input) => {
    calls++
    return job(input.nonce)
  })
  f.storage.removeItem = () => {
    throw new Error("denied")
  }
  const result = await f.client.start(source, label)
  expect(result.cleanupFailed).toBe(true)
  expect(result.job.state).toBe("choosing")
  expect(calls).toBe(1)
  expect(f.store.inspect().kind).toBe("valid")
})
