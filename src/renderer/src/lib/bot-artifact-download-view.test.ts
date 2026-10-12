import { expect, it } from "vitest"
import { BotDomainError } from "../../../shared/bot-types"
import type { BotArtifactDownloadJob } from "../../../shared/bot-artifact-downloads"
import {
  botDownloadActions,
  botDownloadPercent,
  isDefiniteBotDownloadStartFailure,
  projectBotDownloadPage,
  verifyBotDownloadJob,
  verifyBotDownloadPage
} from "./bot-artifact-download-view"
const source = {
  artifactId: "artifact-1",
  conversationId: "conversation-1",
  sha256: "a".repeat(64),
  size: 20,
  dataEpoch: "epoch-1"
}
const job: BotArtifactDownloadJob = {
  id: "605caf6a-3d4a-4fcb-b78b-253d5a50e249",
  revision: 2,
  source,
  name: "report.txt",
  mime: "text/plain",
  state: "downloading",
  bytes: 5,
  total: 20,
  createdAt: 1,
  updatedAt: 2
}
it("rejects mutated source, old control revision and false completed byte counts", () => {
  expect(verifyBotDownloadJob(job, job)).toEqual(job)
  for (const wrong of [
    { ...job, source: { ...source, dataEpoch: "epoch-2" } },
    { ...job, id: "6c105419-79ae-4311-95c7-d6f12a049fcc" },
    { ...job, revision: 1 },
    { ...job, state: "completed" },
    { ...job, bytes: 21 },
    { ...job, path: "/secret/native/path" }
  ])
    expect(() => verifyBotDownloadJob(wrong, job)).toThrow()
})
it("rejects page duplicates, foreign conversation, invalid totals and over twenty rows", () => {
  for (const page of [
    { items: [job, job], total: 2, nextCursor: null },
    { items: [job], total: 0, nextCursor: null },
    { items: [], total: 217, nextCursor: null },
    { items: Array(21).fill(job), total: 21, nextCursor: null }
  ])
    expect(() => verifyBotDownloadPage(page)).toThrow()
  expect(() =>
    verifyBotDownloadPage({ items: [job], total: 1, nextCursor: null }, "other")
  ).toThrow()
})
it("keeps a confirmed pause against an old poll and accepts new bytes in the same control revision", () => {
  const current = {
    items: [{ ...job, revision: 3, state: "paused" as const, bytes: 10 }],
    total: 1,
    nextCursor: null
  }
  expect(projectBotDownloadPage(current, { ...current, items: [job] }).items[0]).toEqual(
    current.items[0]
  )
  expect(
    projectBotDownloadPage(
      { ...current, items: [job] },
      { ...current, items: [{ ...job, bytes: 10 }] }
    ).items[0].bytes
  ).toBe(10)
  expect(() =>
    projectBotDownloadPage(current, {
      ...current,
      items: [{ ...job, source: { ...source, sha256: "b".repeat(64) } }]
    })
  ).toThrow()
})
it("never retries publishing or offers resume on an unaccepted failed choice", () => {
  expect(botDownloadActions({ ...job, state: "publishing" })).toEqual([])
  expect(botDownloadActions({ ...job, state: "failed" })).toEqual(["forget"])
  expect(botDownloadActions({ ...job, state: "paused" })).toEqual(["resume", "cancel"])
  expect(botDownloadPercent({ ...job, bytes: 20, total: 20, state: "verifying" })).toBe(100)
  expect(
    botDownloadPercent({
      ...job,
      source: { ...source, size: 0 },
      bytes: 0,
      total: 0,
      state: "completed"
    })
  ).toBe(100)
})
it("only structured definitive rejection may clear a start nonce", () => {
  for (const code of [
    "download_request_rejected",
    "download_capacity",
    "download_nonce_conflict",
    "download_archived"
  ])
    expect(isDefiniteBotDownloadStartFailure(new BotDomainError(code, "Rejected"))).toBe(true)
  for (const error of [
    new Error("download_capacity"),
    { code: "download_archived" },
    new BotDomainError("transport_closed", "Closed"),
    new BotDomainError("download_revision_conflict", "Changed")
  ])
    expect(isDefiniteBotDownloadStartFailure(error)).toBe(false)
})
