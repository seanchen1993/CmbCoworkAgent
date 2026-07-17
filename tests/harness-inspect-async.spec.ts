import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = process.cwd()
const serviceSource = readFileSync(join(root, "src/main/harness-board/service.ts"), "utf8")
const ipcSource = readFileSync(join(root, "src/main/ipc/harness-board.ts"), "utf8")
const agentSource = readFileSync(join(root, "src/main/ipc/agent.ts"), "utf8")
const reporterSource = readFileSync(
  join(root, "src/main/services/harness-status-reporter.ts"),
  "utf8"
)

function between(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  assert(startIndex >= 0, `missing start marker: ${start}`)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert(endIndex >= 0, `missing end marker: ${end}`)
  return source.slice(startIndex, endIndex)
}

const singleInspect = between(
  serviceSource,
  "async function runInspectAdapter(",
  "function runHarnessJsonInvocation("
)
assert(
  singleInspect.includes("await runHarnessInvocationAsync("),
  "single project/run inspect must use the non-blocking spawn runner"
)
assert(
  !singleInspect.includes("runHarnessInvocation("),
  "single project/run inspect must not call the execFileSync runner"
)

const batchInspect = between(
  serviceSource,
  "async function runInspectAdapterBatch(",
  "function makeProjectErrorDetail("
)
assert(
  batchInspect.includes("await runHarnessInvocationAsync("),
  "batch project inspect must use the non-blocking spawn runner"
)
assert(
  !batchInspect.includes("runHarnessInvocation("),
  "batch project inspect must not call the execFileSync runner"
)

for (const signature of [
  "export async function resolveHarnessFeatureCurrentStage(",
  "export async function getHarnessProjectDetail(",
  "export async function getHarnessProjectDetails(",
  "export async function getHarnessRunDetail("
]) {
  assert(serviceSource.includes(signature), `${signature} must remain asynchronous`)
}

assert(
  ipcSource.includes("await getHarnessProjectDetails(projectIds)"),
  "project details IPC must await the asynchronous inspect"
)
assert(
  agentSource.includes("await resolveHarnessFeatureCurrentStage("),
  "agent stage attribution must await the asynchronous inspect"
)
assert(
  reporterSource.includes("await getHarnessProjectDetails("),
  "status reporting must await the asynchronous inspect"
)

console.log("harness inspect async checks passed")
