import { describe, expect, it } from "vitest"
import { mergeRecordedLlmFileMetadata } from "./llm-file-metadata-merge"

describe("mergeRecordedLlmFileMetadata", () => {
  it("rebases two out-of-order record completions without losing either file", () => {
    const newer = mergeRecordedLlmFileMetadata({
      existingFiles: [],
      recentlyRevertedFiles: ["a.ts", "b.ts"],
      fileHistory: {},
      incomingFiles: ["b.ts"],
      relativePathsByFile: new Map([["b.ts", ["b.ts"]]]),
      snapshots: [{ relPath: "b.ts", snapshot: { exists: true, content: "B", ts: "2" } }],
      maxSnapshotsPerFile: 6
    })
    const olderCompletesLast = mergeRecordedLlmFileMetadata({
      existingFiles: newer.files,
      recentlyRevertedFiles: newer.recentlyRevertedFiles,
      fileHistory: newer.fileHistory,
      incomingFiles: ["a.ts"],
      relativePathsByFile: new Map([["a.ts", ["a.ts"]]]),
      snapshots: [{ relPath: "a.ts", snapshot: { exists: true, content: "A", ts: "1" } }],
      maxSnapshotsPerFile: 6
    })

    expect(olderCompletesLast.files).toEqual(["b.ts", "a.ts"])
    expect(olderCompletesLast.recentlyRevertedFiles).toEqual([])
    expect(Object.keys(olderCompletesLast.fileHistory).sort()).toEqual(["a.ts", "b.ts"])
  })

  it("deduplicates identical snapshots while retaining the bounded latest history", () => {
    const result = mergeRecordedLlmFileMetadata({
      existingFiles: ["a.ts"],
      recentlyRevertedFiles: [],
      fileHistory: {
        "a.ts": [{ exists: true, content: "same", ts: "old" }]
      },
      incomingFiles: ["a.ts"],
      relativePathsByFile: new Map([["a.ts", ["a.ts"]]]),
      snapshots: [{ relPath: "a.ts", snapshot: { exists: true, content: "same", ts: "new" } }],
      maxSnapshotsPerFile: 6
    })
    expect(result.fileHistory["a.ts"]).toHaveLength(1)
  })
})
