import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  appendBoundedHookLogEntry,
  HOOK_LOG_ENTRIES_PER_BUCKET_LIMIT
} from "../src/renderer/src/lib/hook-log-retention"

let entries: number[] = []
for (let index = 0; index < 100_000; index += 1) {
  entries = appendBoundedHookLogEntry(entries, index)
}

assert.equal(entries.length, HOOK_LOG_ENTRIES_PER_BUCKET_LIMIT)
assert.equal(entries[0], 100_000 - HOOK_LOG_ENTRIES_PER_BUCKET_LIMIT)
assert.equal(entries.at(-1), 99_999)

const threadContextSource = readFileSync(
  join(process.cwd(), "src/renderer/src/lib/thread-context.tsx"),
  "utf8"
)
assert.equal(
  threadContextSource.match(/appendBoundedHookLogEntry\(target\.entries, entry\)/g)?.length,
  3
)
assert.doesNotMatch(threadContextSource, /entries: \[\.\.\.target\.entries, entry\]/)

console.log("hook log retention tests passed")
