import { describe, expect, it, vi } from "vitest"
import { collectReferencedTranscriptHashesFromPages } from "./thread-transcript-gc-scan"

function hash(index: number): string {
  return index.toString(16).padStart(64, "0")
}

describe("transcript reference GC scan", () => {
  it("scans 20k manifests in bounded pages and yields between work units", async () => {
    const manifests = Array.from(
      { length: 20_000 },
      (_, index) => `{"content":{"sha256":"${hash(index)}"}}`
    )
    let maxRequested = 0
    let maxReturned = 0
    let pageCalls = 0
    const readManifestPage = (afterRowId: number, limit: number) => {
      if (limit > 128) throw new Error("manifest GC requested an unbounded page")
      if (afterRowId < 0 || afterRowId > manifests.length) {
        throw new Error("manifest GC used an unsafe cursor")
      }
      maxRequested = Math.max(maxRequested, limit)
      pageCalls += 1
      const jsonValues = manifests.slice(afterRowId, afterRowId + limit)
      maxReturned = Math.max(maxReturned, jsonValues.length)
      const nextAfterRowId = afterRowId + jsonValues.length
      return {
        jsonValues,
        hasMore: nextAfterRowId < manifests.length,
        ...(nextAfterRowId < manifests.length ? { nextAfterRowId } : {})
      }
    }
    const yieldNow = vi.fn(async () => undefined)

    const hashes = await collectReferencedTranscriptHashesFromPages({
      readThreadValuesPage: () => ({ jsonValues: [], hasMore: false }),
      readManifestPage,
      yieldNow,
      manifestPageSize: 128
    })

    expect(hashes.size).toBe(20_000)
    expect(maxRequested).toBe(128)
    expect(maxReturned).toBeLessThanOrEqual(128)
    expect(pageCalls).toBe(Math.ceil(20_000 / 128))
    // One empty thread-values page plus one yield per bounded manifest page;
    // do not turn 20k small rows into 20k event-loop hops.
    expect(yieldNow.mock.calls.length).toBe(pageCalls + 1)
  })

  it("finds a hash split across bounded string chunks", async () => {
    const expected = "a".repeat(64)
    const prefix = "x".repeat(65_530)
    const hashes = await collectReferencedTranscriptHashesFromPages({
      readThreadValuesPage: () => ({
        jsonValues: [`${prefix}{"sha256":"${expected}"}`],
        hasMore: false
      }),
      readManifestPage: () => ({ jsonValues: [], hasMore: false }),
      yieldNow: async () => undefined,
      chunkChars: 65_536
    })

    expect(hashes).toContain(expected)
  })
})
