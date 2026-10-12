import {
  CMB_SEARCH_MAX_FILES,
  createCmbLiteralSearchResults
} from "../agent/literal-search-results"

export interface BotProjectSearchResult {
  matches: { path: string; line: number; text: string }[]
  scannedFiles: number
  skippedFiles: number
  incomplete: boolean
  stoppedReason: "files" | "bytes" | "matches" | "time" | null
}

const FILE_BYTES = 2 * 1024 * 1024
const TOTAL_BYTES = 16 * 1024 * 1024
const READ_CONCURRENCY = 4

/** Bounded scan over already-scoped paths. All reads retain the project's
 * stable handles. Reserve each batch's worst-case bytes before starting it;
 * settle the whole batch before returning, including on cancellation. */
export async function searchBotProject(
  paths: string[],
  pattern: string,
  read: (path: string, maxBytes: number) => Promise<{ text: string; bytes: number }>,
  check: () => void,
  deadline = performance.now() + 10_000
): Promise<BotProjectSearchResult> {
  const collected = createCmbLiteralSearchResults()
  let scannedFiles = 0,
    skippedFiles = 0,
    bytes = 0
  let stoppedReason: BotProjectSearchResult["stoppedReason"] = null
  scan: while (scannedFiles < paths.length) {
    check()
    if (scannedFiles >= CMB_SEARCH_MAX_FILES) {
      stoppedReason = "files"
      break
    }
    if (bytes >= TOTAL_BYTES) {
      stoppedReason = "bytes"
      break
    }
    if (performance.now() >= deadline) {
      stoppedReason = "time"
      break
    }
    const remainingBytes = TOTAL_BYTES - bytes
    const maxBytes = Math.min(FILE_BYTES, remainingBytes)
    const count = Math.min(
      READ_CONCURRENCY,
      Math.floor(remainingBytes / maxBytes),
      CMB_SEARCH_MAX_FILES - scannedFiles,
      paths.length - scannedFiles
    )
    const batch = paths.slice(scannedFiles, scannedFiles + count)
    // No unbounded Promise.all and no background read survives the scan.
    const results = await Promise.allSettled(batch.map(async (path) => read(path, maxBytes)))
    check()
    scannedFiles += batch.length
    for (const result of results) {
      if (result.status === "rejected") skippedFiles++
      else bytes += result.value.bytes
    }
    for (const [fileIndex, result] of results.entries()) {
      check()
      if (performance.now() >= deadline) {
        stoppedReason = "time"
        break scan
      }
      if (result.status === "rejected") continue
      const lines = result.value.text.split("\n")
      for (let index = 0; index < lines.length; index++) {
        if (index % 256 === 0) {
          check()
          if (performance.now() >= deadline) {
            stoppedReason = "time"
            break scan
          }
        }
        if (
          lines[index].includes(pattern) &&
          !collected.append(batch[fileIndex], index + 1, lines[index])
        ) {
          stoppedReason = "matches"
          break scan
        }
      }
    }
  }
  check()
  return {
    matches: Object.entries(collected.results).flatMap(([path, lines]) =>
      lines.map(([line, text]) => ({ path, line, text }))
    ),
    scannedFiles,
    skippedFiles,
    incomplete: stoppedReason !== null || skippedFiles > 0,
    stoppedReason
  }
}
