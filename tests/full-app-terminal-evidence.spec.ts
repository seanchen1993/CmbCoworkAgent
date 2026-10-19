import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFullAppTerminalEvidence } from "./support/full-app-terminal-evidence"

// Synthetic boundary fixtures below exercise only the read-only verifier, never business execution.
const root = mkdtempSync(join(tmpdir(), "full10-terminal-boundaries-"))
const workspace = join(root, "workspace"),
  repository = join(workspace, "repository")
const archived = join(workspace, "archive"),
  runId = "cw-unit-001"
const runsRoot = join(archived, ".parallel-runs"),
  runRoot = join(runsRoot, runId)
mkdirSync(repository, { recursive: true })
mkdirSync(runRoot, { recursive: true })
const git = (...args: string[]) =>
  execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: "pipe"
  }).trim()
git("init", "-b", "main")
git(
  "-c",
  "user.name=Boundary Fixture",
  "-c",
  "user.email=boundary@example.invalid",
  "commit",
  "--allow-empty",
  "-m",
  "Boundary fixture only"
)
const commit = git("rev-parse", "HEAD")
const batchIds = ["B001", "B002"]
const provisions = batchIds.map((batchId) => ({
  batchId,
  success: true,
  reused: false,
  branchName: `fixture/${batchId}`,
  worktreePath: join(workspace, ".autobizdevops/worktrees", runId, batchId)
}))
const manifest = {
  runId,
  batches: Object.fromEntries(
    batchIds.map((batchId) => [
      batchId,
      { type: "delivery", status: "merged", mergeCommitSha: commit, worktreePath: null }
    ])
  ),
  finalVerification: { runId, passed: true, errors: [], hasDeferredIssues: false }
}
const workflow = {
  status: "completed",
  agents: [{ status: "completed" }],
  result: {
    ok: true,
    finalStatus: "succeeded",
    runId,
    batchResults: provisions.map((row) => ({ ...row, status: "success", commitSha: commit })),
    cleanupResults: [{ runId, success: true, errors: [], cleanedBatchIds: batchIds }],
    e2e: { success: true, result: { success: true, status: "verified" }, cleanupErrors: [] }
  }
}
const submissions = provisions.map((row) => ({ actualCommandResult: row, arguments: { ...row } }))
const manifestPath = join(runRoot, "manifest.json")
const saveManifest = (value: unknown = manifest) =>
  writeFileSync(manifestPath, JSON.stringify(value))
const verify = (overrides: Partial<Parameters<typeof readFullAppTerminalEvidence>[0]> = {}) =>
  readFullAppTerminalEvidence({
    workspace,
    archived,
    repository,
    workflow,
    submissions,
    ...overrides
  })
let assertions = 0
const refuses = (run: () => unknown) => {
  assert.throws(run)
  assertions++
}

try {
  saveManifest()
  writeFileSync(join(runsRoot, ".run-id.lock"), "1")
  const positive = verify()
  assert.equal(positive.proof.length, 2)
  assert.equal(positive.mainGit.head, commit)
  assert(positive.proof.every((row) => row.cleanupPath === null && row.physicallyRemoved))
  assertions++
  mkdirSync(join(runsRoot, "cw-foreign"))
  refuses(() => verify())
  rmSync(join(runsRoot, "cw-foreign"), { recursive: true })
  symlinkSync(
    runRoot,
    join(runsRoot, "linked-run"),
    process.platform === "win32" ? "junction" : "dir"
  )
  refuses(() => verify())
  rmSync(join(runsRoot, "linked-run"))
  refuses(() => verify({ workflow: { ...workflow, status: "error" } }))
  refuses(() => verify({ workflow: { ...workflow, agents: [{ status: "error" }] } }))
  refuses(() => verify({ workflow: { ...workflow, result: { ...workflow.result, ok: false } } }))
  refuses(() => verify({ submissions: submissions.slice(1) }))
  refuses(() => verify({ submissions: [submissions[0], submissions[0]] }))
  refuses(() =>
    verify({
      submissions: [
        submissions[0],
        { ...submissions[1], arguments: { ...submissions[1].arguments, worktreePath: repository } }
      ]
    })
  )
  refuses(() =>
    verify({
      workflow: {
        ...workflow,
        result: {
          ...workflow.result,
          batchResults: [
            { ...workflow.result.batchResults[0], commitSha: "a".repeat(40) },
            workflow.result.batchResults[1]
          ]
        }
      }
    })
  )
  refuses(() =>
    verify({
      workflow: {
        ...workflow,
        result: {
          ...workflow.result,
          cleanupResults: [{ runId, success: true, errors: [], cleanedBatchIds: ["B001"] }]
        }
      }
    })
  )
  refuses(() =>
    verify({
      workflow: {
        ...workflow,
        result: {
          ...workflow.result,
          cleanupResults: [
            { runId, success: false, errors: ["not removed"], cleanedBatchIds: batchIds }
          ]
        }
      }
    })
  )
  refuses(() =>
    verify({
      workflow: {
        ...workflow,
        result: { ...workflow.result, e2e: { ...workflow.result.e2e, success: false } }
      }
    })
  )
  mkdirSync(provisions[0].worktreePath, { recursive: true })
  refuses(() => verify())
  rmSync(provisions[0].worktreePath, { recursive: true })
  for (const mutation of [
    { ...manifest, runId: "cw-foreign" },
    { ...manifest, finalVerification: { ...manifest.finalVerification, passed: false } },
    {
      ...manifest,
      batches: {
        ...manifest.batches,
        B001: { ...manifest.batches.B001, worktreePath: provisions[0].worktreePath }
      }
    },
    {
      ...manifest,
      batches: {
        ...manifest.batches,
        B001: { ...manifest.batches.B001, mergeCommitSha: "b".repeat(40) }
      }
    }
  ]) {
    saveManifest(mutation)
    refuses(() => verify())
  }
  saveManifest()
  const other = git(
    "-c",
    "user.name=Boundary Fixture",
    "-c",
    "user.email=boundary@example.invalid",
    "commit-tree",
    `${commit}^{tree}`,
    "-m",
    "Unreachable fixture commit"
  )
  saveManifest({
    ...manifest,
    batches: { ...manifest.batches, B001: { ...manifest.batches.B001, mergeCommitSha: other } }
  })
  refuses(() => verify())
} finally {
  // Verified absolute test-owned directory; no user workspace is removed.
  rmSync(root, { recursive: true, force: true })
}

const actualRoot = process.env.AUTOBIZ_FULL_TERMINAL_EVIDENCE_ROOT
if (actualRoot) {
  const load = (path: string) => JSON.parse(readFileSync(join(actualRoot, path), "utf8"))
  const actualEvidence = load("evidence.json"),
    actualWorkflow = load("native-workflow.json")
  assert.equal(actualEvidence.passed, false, "The original failed fixture must remain failed")
  const actualWorkspace = join(actualRoot, "workspace/complete")
  const actual = readFullAppTerminalEvidence({
    workspace: actualWorkspace,
    archived: join(actualWorkspace, ".autobizdevops/archive/app-complete-iter1"),
    repository: join(actualWorkspace, "repositories/creator-code"),
    workflow: actualWorkflow,
    submissions: actualEvidence.structuredOutputSubmissions
  })
  const latest = load("managed-latest.json")
  assert.equal(latest.status, "completed")
  const state = load("workspace/complete/.autobizdevops/state.json")
  assert.equal(state.features["app-complete"].checkpoint, "archived")
  const requests = load("model-requests.json") as { actor: string; step?: { key?: string } }[]
  const actualChildren = requests.filter((row) => row.actor.startsWith("child-"))
  assert(actualChildren.length >= 10)
  const actualImplementations = requests.filter(
    (row) => row.step?.key === "actual-original-implementation"
  )
  assert.equal(actualImplementations.length, 2)
  assert.equal(new Set(actualImplementations.map((row) => row.actor)).size, 2)
  assert(actualEvidence.specsTaskResult)
  assert(requests.filter((row) => row.actor === "specs-role-child").length >= 3)
  const actualGitWorktrees = actualEvidence.structuredOutputSubmissions.filter(
    (row: { actualCommandResult: { actualGitWorktree?: unknown } }) =>
      row.actualCommandResult.actualGitWorktree
  )
  assert.equal(actualGitWorktrees.length, 2)
  const negatives = actualEvidence.structuredOutputSubmissions.filter(
    (row: {
      actualCommandResult: {
        negativeFailedTest?: {
          execution: { exitCode: number }
          originalRecord: { ok: boolean }
          gate: { success: boolean }
        }
      }
    }) => {
      const negative = row.actualCommandResult.negativeFailedTest
      return (
        negative &&
        negative.execution.exitCode !== 0 &&
        negative.originalRecord.ok === false &&
        negative.gate.success === false
      )
    }
  )
  assert.equal(negatives.length, 1)
  assert.equal(actualEvidence.acceptance.performanceAcceptance, false)
  assert.equal(actualEvidence.acceptance.bounded15Acceptance, false)
  const output = process.env.AUTOBIZ_FULL_TERMINAL_PROJECTION_OUTPUT
  assert(output, "Actual read-only projection must retain a separately named evidence output")
  writeFileSync(
    output,
    JSON.stringify(
      {
        ...actual,
        scope:
          "Read-only R26 terminal projection; original fixture remains FAILED; not a rerun or formal App PASS",
        originalRoot: actualRoot,
        originalFixturePassed: false,
        terminalProjectionPassed: true,
        performanceAcceptance: false,
        bounded15Acceptance: false,
        sourceBugRepairCovered: false,
        testBugNegativeAndAssetRepairCovered: true,
        actualChildRequests: actualChildren.length,
        actualImplementationActors: actualImplementations.map((row) => row.actor),
        actualGitWorktreeResults: actualGitWorktrees.map(
          (row: { actualCommandResult: unknown }) => row.actualCommandResult
        ),
        stateCheckpoint: state.features["app-complete"].checkpoint,
        managedStatus: latest.status,
        workflowStatus: actualWorkflow.status,
        nativeAgents: actualWorkflow.agents.length
      },
      null,
      2
    )
  )
  console.log(
    `PASS read-only actual terminal projection: ${output}; original full fixture remains FAILED`
  )
}
console.log(
  `PASS terminal evidence boundaries (${assertions}): native provision, merged Git ancestry, original cleanup/null and run directories only`
)
