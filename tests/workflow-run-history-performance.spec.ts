/**
 * Run: npx tsx tests/workflow-run-history-performance.spec.ts
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile as readFileAsync, rm, writeFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  createWorkflowRunStore,
  deleteWorkflowRunsForThread,
  getWorkflowRunsDir,
  hasUndeliveredWorkflowRunAsync,
  listWorkflowRunsPage,
  loadWorkflowRunAsync,
  loadWorkflowRunForResumeAsync,
  markWorkflowRunNotified,
  rollbackWorkflowRunNotified,
  selectWorkflowRunPage,
  workflowRunIndexFilePath
} from "../src/main/agent/workflow/run-store"
import type { PersistedWorkflowRun } from "../src/main/agent/workflow/types"

async function main(): Promise<void> {
const runs = Array.from({ length: 5_000 }, (_, index) => ({
  runId: `wf_${index.toString(36).padStart(8, "0")}`,
  startedAt: new Date(Date.UTC(2026, 0, 1) - index * 1_000).toISOString()
}))

const first = selectWorkflowRunPage(runs, null, 50)
assert.equal(first.items.length, 50)
assert.equal(first.items[0].runId, runs[0].runId)
assert.equal(first.items.at(-1)?.runId, runs[49].runId)
assert.ok(first.nextCursor)

const second = selectWorkflowRunPage(runs, first.nextCursor, 50)
assert.equal(second.items.length, 50)
assert.equal(second.items[0].runId, runs[50].runId)
assert.equal(second.items.at(-1)?.runId, runs[99].runId)

const insertedNewest = [
  { runId: "wf_newest00", startedAt: new Date(Date.UTC(2027, 0, 1)).toISOString() },
  ...runs
]
const stableSecond = selectWorkflowRunPage(insertedNewest, first.nextCursor, 50)
assert.deepEqual(
  stableSecond.items.map((run) => run.runId),
  second.items.map((run) => run.runId),
  "a new run inserted before the cursor must not duplicate or shift the next page"
)

const capped = selectWorkflowRunPage(runs, null, 5_000)
assert.equal(capped.items.length, 100, "the main-process page API must enforce its hard cap")

const seen = new Set<string>()
let cursor: string | null = null
do {
  const page = selectWorkflowRunPage(runs, cursor, 50)
  assert.ok(page.items.length <= 50)
  for (const run of page.items) {
    assert.equal(seen.has(run.runId), false, `duplicate cursor row: ${run.runId}`)
    seen.add(run.runId)
  }
  cursor = page.nextCursor
} while (cursor)
assert.equal(seen.size, 5_000)

const largeWorkspace = await mkdtemp(join(tmpdir(), "workflow-history-large-"))
const largeThreadId = "thread-history-large"
const largeRun: PersistedWorkflowRun = {
  version: 1,
  runId: "wf_large0000",
  threadId: largeThreadId,
  workflowName: "large history regression",
  script: "return 'ok'",
  scriptSha256: "sha",
  status: "completed",
  phases: ["large"],
  currentPhase: null,
  agents: Array.from({ length: 1_000 }, (_, index) => ({
    index,
    label: `agent-${index}`,
    phase: "large",
    status: "completed" as const,
    outputTokens: index,
    startedAt: new Date(1_000 + index).toISOString(),
    endedAt: new Date(2_000 + index).toISOString()
  })),
  logs: [],
  journal: [],
  stats: {
    agentsTotal: 1_000,
    agentsCached: 0,
    agentsFailed: 0,
    outputTokens: 499_500,
    durationMs: 1_000
  },
  startedAt: new Date(1_000).toISOString(),
  updatedAt: new Date(2_000).toISOString(),
  completedAt: new Date(2_000).toISOString(),
  notificationDelivered: true
}
try {
  const store = createWorkflowRunStore({
    workspacePath: largeWorkspace,
    threadId: largeThreadId,
    initial: largeRun
  })
  assert.equal(await store.whenInitialPersisted, true)
  const page = await listWorkflowRunsPage(largeWorkspace, largeThreadId)
  assert.equal(page.runs.length, 1)
  assert.equal(page.runs[0].agentCount, 1_000)
  assert.equal((await loadWorkflowRunAsync(largeWorkspace, largeThreadId, largeRun.runId))?.agents.length, 1_000)
  assert.equal(await hasUndeliveredWorkflowRunAsync(largeWorkspace, largeThreadId), false)
  assert.equal(await rollbackWorkflowRunNotified(largeWorkspace, largeThreadId, largeRun.runId), true)
  assert.equal(
    await hasUndeliveredWorkflowRunAsync(largeWorkspace, largeThreadId),
    true,
    "rolling back an ack must update the compact pending index"
  )
  assert.equal(await markWorkflowRunNotified(largeWorkspace, largeThreadId, largeRun.runId), true)
  assert.equal(
    await hasUndeliveredWorkflowRunAsync(largeWorkspace, largeThreadId),
    false,
    "notification ack must clear the compact pending index"
  )
  const index = JSON.parse(
    await readFileAsync(workflowRunIndexFilePath(largeWorkspace, largeThreadId), "utf8")
  ) as { entries?: unknown[] }
  assert.equal(index.entries?.length, 1, "new writes must maintain the compact run index")
} finally {
  deleteWorkflowRunsForThread(largeWorkspace, largeThreadId)
  await rm(largeWorkspace, { recursive: true, force: true })
}

// Runtime compatibility functions intentionally remain synchronous. Prove the
// IPC-facing page/detail readers do not touch any synchronous fs primitive.
const trapWorkspace = await mkdtemp(join(tmpdir(), "workflow-history-trap-"))
const trapThreadId = "thread-history-trap"
const trapRun = {
  ...largeRun,
  runId: "wf_legacy00",
  threadId: trapThreadId,
  agents: largeRun.agents.slice(0, 10)
}
const trapRunDir = getWorkflowRunsDir(trapWorkspace, trapThreadId)
await mkdir(trapRunDir, { recursive: true })
await writeFile(join(trapRunDir, `${trapRun.runId}.json`), JSON.stringify(trapRun))
await writeFile(join(trapRunDir, `${trapRun.runId}.journal`), "[]")
const mutableFs = fs as unknown as Record<string, unknown>
const trappedNames = [
  "existsSync",
  "readFileSync",
  "readdirSync",
  "statSync",
  "writeFileSync"
] as const
const originals = new Map(trappedNames.map((name) => [name, mutableFs[name]]))
for (const name of trappedNames) {
  mutableFs[name] = (): never => {
    throw new Error(`synchronous fs trap: ${name}`)
  }
}
syncBuiltinESMExports()
try {
  const missingWorkspace = join(tmpdir(), `workflow-history-missing-${process.pid}-${Date.now()}`)
  const page = await listWorkflowRunsPage(missingWorkspace, "thread-history")
  assert.deepEqual(page, { runs: [], nextCursor: null })
  assert.equal(
    await loadWorkflowRunAsync(missingWorkspace, "thread-history", "wf_missing0"),
    null
  )
  const legacyPage = await listWorkflowRunsPage(trapWorkspace, trapThreadId)
  assert.equal(legacyPage.runs.length, 1)
  assert.equal(legacyPage.runs[0].runId, trapRun.runId)
  assert.equal(await hasUndeliveredWorkflowRunAsync(trapWorkspace, trapThreadId), false)
  assert.equal(
    (await loadWorkflowRunAsync(trapWorkspace, trapThreadId, trapRun.runId))?.agents.length,
    10
  )
  assert.equal(
    (await loadWorkflowRunForResumeAsync(trapWorkspace, trapThreadId, trapRun.runId))?.agents.length,
    10,
    "workflow resume must not synchronously parse its run or journal on the Electron event loop"
  )
} finally {
  for (const [name, original] of originals) mutableFs[name] = original
  syncBuiltinESMExports()
  deleteWorkflowRunsForThread(trapWorkspace, trapThreadId)
  await rm(trapWorkspace, { recursive: true, force: true })
}

const repositoryRoot = process.cwd()
const ipcSource = readFileSync(join(repositoryRoot, "src/main/ipc/workflows.ts"), "utf8")
const listHandler = ipcSource.slice(
  ipcSource.indexOf('"workflow:list-runs"'),
  ipcSource.indexOf('"workflow:get-run"')
)
assert.match(listHandler, /await listWorkflowRunsPage\(/)
assert.doesNotMatch(listHandler, /\blistWorkflowRuns\(/)
assert.doesNotMatch(listHandler, /\bloadWorkflowRun\(/)
assert.equal(
  (listHandler.match(/listWorkflowRunsPage\(/g) ?? []).length,
  1,
  "zombie reconciliation must update the current page without a second directory scan"
)

const getRunHandler = ipcSource.slice(
  ipcSource.indexOf('"workflow:get-run"'),
  ipcSource.indexOf('"workflow:cancel-run"')
)
assert.match(getRunHandler, /await loadWorkflowRunAsync\(/)
assert.doesNotMatch(getRunHandler, /\bloadWorkflowRun\(/)

const hydrateHandler = ipcSource.slice(ipcSource.indexOf('"workflow:hydrate"'))
assert.match(hydrateHandler, /await hasUndeliveredWorkflowRunAsync\(/)
assert.ok(
  hydrateHandler.indexOf("await hasUndeliveredWorkflowRunAsync") <
    hydrateHandler.indexOf("workflowRunManager.findPendingNotification"),
  "hydrate must use the compact async pending index before the legacy exact scan"
)

const workflowToolSource = readFileSync(
  join(repositoryRoot, "src/main/agent/workflow/tool.ts"),
  "utf8"
)
assert.match(workflowToolSource, /await resolveResumeRun\(/)
assert.match(workflowToolSource, /await loadWorkflowRunAsync\(/)
assert.match(workflowToolSource, /await loadWorkflowRunForResumeAsync\(/)
assert.doesNotMatch(workflowToolSource, /\bloadWorkflowRunForResume\b/)

const dialogSource = readFileSync(
  join(repositoryRoot, "src/renderer/src/components/chat/WorkflowRunsDialog.tsx"),
  "utf8"
)
assert.match(dialogSource, /WORKFLOW_RUN_LIST_PAGE_SIZE = 50/)
assert.match(dialogSource, /WORKFLOW_AGENT_DETAIL_PAGE_SIZE = 240/)
assert.match(dialogSource, /run\.agents\.slice\(agentPageStart, agentPageEnd\)/)
assert.match(dialogSource, /for \(const agent of visibleAgents\)/)
assert.doesNotMatch(
  dialogSource,
  /run\.agents\.map\(/,
  "large run details must not mount every agent row"
)
assert.match(dialogSource, /page\.runs as WorkflowRunSummaryDTO\[\]/)
assert.match(dialogSource, /加载更多/)

console.log("workflow run history performance tests passed")
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
