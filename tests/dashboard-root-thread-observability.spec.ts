/**
 * Regression tests for root-thread observability query wiring.
 *
 * Run:
 *   npx tsx tests/dashboard-root-thread-observability.spec.ts
 */

import { readFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function assertIncludes(source: string, expected: string, message: string): void {
  assert(source.includes(expected), `${message}: expected to find ${expected}`)
}

function assertNotIncludes(source: string, unexpected: string, message: string): void {
  assert(!source.includes(unexpected), `${message}: did not expect ${unexpected}`)
}

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  assert(startIndex >= 0, `missing section start: ${start}`)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert(endIndex > startIndex, `missing section end: ${end}`)
  return source.slice(startIndex, endIndex)
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const dashboardSource = readFileSync(join(__dirname, "../src/main/ipc/dashboard.ts"), "utf8")

function testThreadListAggUsesRootThreadId(): void {
  const source = section(dashboardSource, "function threadListAgg", "function parseThreadListContainer")
  assertIncludes(
    source,
    'total_threads: { cardinality: { field: "rootThreadId" } }',
    "thread view total count should use rootThreadId"
  )
  assertIncludes(source, 'field: "rootThreadId"', "thread view buckets should use rootThreadId")
  assertNotIncludes(source, 'field: "threadId"', "thread view should not bucket by physical threadId")
}

function testCommitAdoptionUsesRootThreadId(): void {
  const source = section(dashboardSource, "async function fetchCommitAdoptionMap", "function attachCommitAdoption")
  assertIncludes(
    source,
    'by_thread: { terms: { field: "properties.rootThreadId", size: 50 } }',
    "commit adoption should aggregate root thread ids"
  )
}

function testCommitPairUsesRootThreadId(): void {
  const source = section(dashboardSource, "async function fetchCommitAdoptionEvents", "// ─────────────────────────────────────────────────────────\n// Dashboard data fetchers")
  assertIncludes(source, '"properties.rootThreadId"', "commit adoption event detail should load rootThreadId")
  assertIncludes(source, "eventRootThreadId(gen)", "paired gen rows should prefer rootThreadId")
  assertIncludes(source, "eventRootThreadId(adopt)", "unpaired adopt rows should prefer rootThreadId")
}

function testUncommittedDetailUsesRootThreadId(): void {
  const source = section(dashboardSource, "async function fetchUncommittedDetail", "return {")
  assertIncludes(source, '"properties.rootThreadId"', "uncommitted detail should load rootThreadId")
  assertIncludes(source, "threadId: eventRootThreadId(props)", "uncommitted samples should prefer rootThreadId")
}

function run(): void {
  testThreadListAggUsesRootThreadId()
  console.log("PASS dashboard thread list rootThreadId aggregation")
  testCommitAdoptionUsesRootThreadId()
  console.log("PASS dashboard commit adoption rootThreadId aggregation")
  testCommitPairUsesRootThreadId()
  console.log("PASS dashboard commit pair rootThreadId detail")
  testUncommittedDetailUsesRootThreadId()
  console.log("PASS dashboard uncommitted rootThreadId detail")
}

run()
