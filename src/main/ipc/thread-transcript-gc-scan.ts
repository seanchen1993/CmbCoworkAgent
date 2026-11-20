export interface TranscriptReferenceJsonPage {
  jsonValues: readonly string[]
  hasMore: boolean
  nextAfterRowId?: number
}

export interface TranscriptReferenceScanSource {
  readThreadValuesPage: (afterRowId: number, limit: number) => TranscriptReferenceJsonPage
  readManifestPage: (afterRowId: number, limit: number) => TranscriptReferenceJsonPage
  yieldNow?: () => Promise<void>
  threadPageSize?: number
  manifestPageSize?: number
  chunkChars?: number
}

const HASH_PATTERN_SOURCE = String.raw`"sha256"\s*:\s*"([a-f0-9]{64})"`

function immediateYield(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * Scan raw reference JSON in bounded DB pages and bounded string chunks. The
 * caller never holds all thread rows/manifests in memory and yields between
 * every chunk/page so deletion-triggered GC cannot monopolize Electron main.
 */
export async function collectReferencedTranscriptHashesFromPages(
  source: TranscriptReferenceScanSource
): Promise<Set<string>> {
  const hashes = new Set<string>()
  const yieldNow = source.yieldNow ?? immediateYield
  const chunkChars = Math.min(
    2 * 1024 * 1024,
    Math.max(64 * 1024, Math.floor(source.chunkChars ?? 1024 * 1024))
  )
  const overlapChars = 160
  let charsSinceYield = 0

  const collectRaw = async (raw: string): Promise<void> => {
    for (let offset = 0; offset < raw.length; offset += chunkChars) {
      const start = Math.max(0, offset - overlapChars)
      const end = Math.min(raw.length, offset + chunkChars)
      const chunk = raw.slice(start, end)
      const pattern = new RegExp(HASH_PATTERN_SOURCE, "g")
      for (let match = pattern.exec(chunk); match; match = pattern.exec(chunk)) {
        hashes.add(match[1])
      }
      charsSinceYield += end - offset
      if (charsSinceYield >= chunkChars) {
        charsSinceYield = 0
        await yieldNow()
      }
    }
  }

  const scanPages = async (
    readPage: TranscriptReferenceScanSource["readThreadValuesPage"],
    pageSize: number
  ): Promise<void> => {
    let afterRowId = 0
    while (true) {
      const page = readPage(afterRowId, pageSize)
      for (const raw of page.jsonValues) await collectRaw(raw)
      // Small manifests share one event-loop step per DB page; an individual
      // giant JSON value still yields at the byte bound above.
      charsSinceYield = 0
      await yieldNow()
      if (!page.hasMore) return
      if (
        !Number.isSafeInteger(page.nextAfterRowId) ||
        (page.nextAfterRowId ?? 0) <= afterRowId
      ) {
        throw new Error("Transcript reference scan returned a non-advancing cursor")
      }
      afterRowId = page.nextAfterRowId as number
    }
  }

  await scanPages(
    source.readThreadValuesPage,
    Math.min(128, Math.max(1, Math.floor(source.threadPageSize ?? 16)))
  )
  await scanPages(
    source.readManifestPage,
    Math.min(512, Math.max(1, Math.floor(source.manifestPageSize ?? 128)))
  )
  return hashes
}
