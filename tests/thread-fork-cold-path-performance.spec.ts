import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

function section(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert(start >= 0 && end > start, `missing source section: ${startMarker}`)
  return source.slice(start, end)
}

async function main(): Promise<void> {
  const threadsSource = await readFile(
    resolve(__dirname, "../src/main/ipc/threads.ts"),
    "utf8"
  )
  const databaseSource = await readFile(
    resolve(__dirname, "../src/main/db/index.ts"),
    "utf8"
  )

  const messageCopy = section(
    threadsSource,
    "async function copyForkedThreadMessages",
    "async function findForkSubagentPrompt"
  )
  assert.doesNotMatch(
    messageCopy,
    /\bgetThreadMessages\s*\(/,
    "fork message copy must not materialize the source lifetime transcript"
  )
  assert.match(messageCopy, /visibleMessages\.slice\(/)
  assert.match(messageCopy, /getThreadMessageIdentityContext\(/)
  assert.match(messageCopy, /preserveExistingOrder: true/)
  assert.match(messageCopy, /await yieldForkColdPath\(\)/)

  const batchSize = Number(
    /const FORK_MESSAGE_COPY_BATCH_SIZE = (\d+)/.exec(threadsSource)?.[1]
  )
  assert(Number.isSafeInteger(batchSize) && batchSize > 0 && batchSize <= 256)
  assert(
    Math.ceil(20_000 / batchSize) <= 157,
    "20k visible messages must complete in a bounded number of yielding batches"
  )

  const subagentCopy = section(
    threadsSource,
    "async function copyForkedSubagentTranscriptsPaged",
    "function toCheckpointTimeMs"
  )
  assert.match(subagentCopy, /getThreadSubagentBucketIdPage\(/)
  assert.match(subagentCopy, /copyThreadSubagentManifestRowsPage\(/)
  assert.match(subagentCopy, /await yieldForkColdPath\(\)/)
  assert.doesNotMatch(subagentCopy, /getThreadSubagentManifestBuckets\(/)

  const durableTail = section(
    threadsSource,
    "function findDurableForkTailMessages",
    "function appendDurableTailToCheckpoint"
  )
  assert.match(durableTail, /visibleMessages\.slice\(-32\)/)
  assert.match(durableTail, /getThreadMessagesByIds\(/)
  assert.match(
    durableTail,
    /getThreadMessagesAfterAnyId\([\s\S]*MAX_FORK_DURABLE_TAIL_MESSAGES \+ 1/
  )
  assert.doesNotMatch(durableTail, /\bgetThreadMessages\s*\(/)

  const gcScan = section(
    threadsSource,
    "async function collectReferencedTranscriptHashesBounded",
    "function escapeMarkdown"
  )
  assert.match(gcScan, /getThreadValuesJsonPage/)
  assert.match(gcScan, /getThreadSubagentManifestJsonPage/)
  assert.doesNotMatch(gcScan, /getAllThreads|getThreadSubagentManifestBuckets|forEachThread/)

  const boundedAfter = section(
    databaseSource,
    "export function getThreadMessagesAfterAnyId",
    "function getThreadMessageProviderOccurrenceRows"
  )
  assert.match(boundedAfter, /LIMIT \?/)
  assert.match(boundedAfter, /boundedLimit/)

  console.log("thread-fork-cold-path-performance.spec.ts passed")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
