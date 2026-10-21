import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { join, resolve } from "node:path"

const object = (value: unknown): Record<string, unknown> => {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    "Missing actual terminal object"
  )
  return value as Record<string, unknown>
}
const array = (value: unknown): unknown[] => {
  assert(Array.isArray(value), "Missing actual terminal array")
  return value
}
const sha = (value: unknown): string => {
  assert(typeof value === "string" && /^[a-f0-9]{40}$/.test(value), "Invalid actual Git commit SHA")
  return value
}

/** Read-only test projection of native provision/implementation/merge/cleanup and actual main Git. */
export function readFullAppTerminalEvidence(input: {
  workspace: string
  archived: string
  repository: string
  workflow: unknown
  submissions: unknown[]
  promotion?: unknown
}) {
  const workflow = object(input.workflow),
    result = object(workflow.result)
  assert.equal(workflow.status, "completed")
  assert.equal(result.ok, true)
  assert.equal(result.finalStatus, input.promotion ? "awaiting_user_confirmation" : "succeeded")
  assert(
    array(workflow.agents).length > 0 &&
      array(workflow.agents).every((agent) => object(agent).status === "completed"),
    "Every actual native agent must complete"
  )
  assert(typeof result.runId === "string" && /^cw-[a-zA-Z0-9-]+$/.test(result.runId))
  const runId = result.runId,
    runsRoot = join(input.archived, ".parallel-runs")
  const entries = readdirSync(runsRoot, { withFileTypes: true })
  assert(
    !entries.some((entry) => entry.isSymbolicLink()),
    "Archived run links are not native run directories"
  )
  const directories = entries.filter((entry) => entry.isDirectory())
  assert.equal(directories.length, 1, "Exactly one actual archived run directory is required")
  assert.equal(
    directories[0].name,
    runId,
    "Archive directory must match the original Workflow run ID"
  )
  const manifest = object(JSON.parse(readFileSync(join(runsRoot, runId, "manifest.json"), "utf8")))
  assert.equal(manifest.runId, runId)
  if (input.promotion) {
    const promotion = object(input.promotion),
      actual = object(promotion.mainPromotion),
      persisted = object(manifest.mainPromotion),
      prepared = object(object(result.verification).mainPromotion)
    assert.equal(promotion.success, true)
    assert.equal(promotion.status, "succeeded")
    assert.equal(promotion.runId, runId)
    assert.equal(manifest.status, "succeeded")
    assert.equal(actual.status, "merged")
    assert.equal(persisted.status, "merged")
    assert(
      typeof prepared.approvalDigest === "string" && /^[a-f0-9]{64}$/.test(prepared.approvalDigest)
    )
    assert.equal(actual.approvalDigest, prepared.approvalDigest)
    assert.equal(persisted.approvalDigest, prepared.approvalDigest)
    assert.equal(actual.approvedBy, "explicit-native-app-acceptance-fixture")
    assert.equal(persisted.approvedBy, actual.approvedBy)
    assert.deepEqual(actual.snapshot, persisted.snapshot)
    assert.deepEqual(actual.repositories, persisted.repositories)
  }
  const deliveries = Object.entries(object(manifest.batches)).filter(
    ([, row]) => object(row).type === "delivery"
  )
  assert.equal(deliveries.length, 2)
  const implementations = array(result.batchResults).map(object)
  assert.equal(implementations.length, 2)
  assert.equal(new Set(implementations.map((row) => row.batchId)).size, 2)
  const provisions = input.submissions.map(object).filter((row) => {
    const actual = object(row.actualCommandResult)
    return (
      actual.success === true &&
      typeof actual.reused === "boolean" &&
      typeof actual.worktreePath === "string"
    )
  })
  assert.equal(provisions.length, 2, "Two original native provision responses are required")
  const provisionPaths = provisions.map((row) => object(row.actualCommandResult).worktreePath)
  assert.equal(new Set(provisionPaths).size, 2, "Distinct provision paths must precede cleanup")
  const cleaned = array(result.cleanupResults).flatMap((row) => {
    const cleanup = object(row)
    assert.equal(cleanup.runId, runId)
    assert.equal(cleanup.success, true)
    assert.deepEqual(cleanup.errors, [])
    return array(cleanup.cleanedBatchIds)
  })
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", input.repository, ...args], {
      encoding: "utf8",
      windowsHide: true,
      stdio: "pipe"
    }).trim()
  assert.equal(realpathSync(git("rev-parse", "--show-toplevel")), realpathSync(input.repository))
  assert.equal(git("branch", "--show-current"), "main")
  const head = sha(git("rev-parse", "HEAD"))
  const proof = deliveries.map(([batchId, row]) => {
    const delivery = object(row),
      implementation = implementations.find((item) => item.batchId === batchId)
    const provision = provisions.find(
      (item) => object(item.actualCommandResult).batchId === batchId
    )
    assert(
      implementation && provision,
      "Native provision and implementation must belong to the delivered Batch"
    )
    const actual = object(provision.actualCommandResult),
      submitted = object(provision.arguments)
    for (const field of ["batchId", "worktreePath", "branchName"])
      assert.equal(
        submitted[field],
        actual[field],
        "Model submission must preserve native provision facts"
      )
    const expectedPath = join(input.workspace, ".autobizdevops/worktrees", runId, batchId)
    assert.equal(resolve(String(actual.worktreePath)), resolve(expectedPath))
    assert.equal(implementation.worktreePath, actual.worktreePath)
    assert.equal(implementation.branchName, actual.branchName)
    assert.equal(implementation.status, "success")
    assert.equal(delivery.status, "merged")
    assert.equal(delivery.worktreePath, null, "Original cleanup must clear the final manifest path")
    assert(cleaned.includes(batchId), "Original cleanup result must name the delivered Batch")
    assert.throws(
      () => lstatSync(expectedPath),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
      "Cleaned worktree must be physically absent"
    )
    const implementationSha = sha(implementation.commitSha),
      mergeSha = sha(delivery.mergeCommitSha)
    git("cat-file", "-e", `${implementationSha}^{commit}`)
    git("cat-file", "-e", `${mergeSha}^{commit}`)
    git("merge-base", "--is-ancestor", implementationSha, head)
    git("merge-base", "--is-ancestor", mergeSha, head)
    return {
      batchId,
      provisionPath: actual.worktreePath,
      branchName: actual.branchName,
      implementationSha,
      mergeSha,
      cleanupPath: delivery.worktreePath,
      physicallyRemoved: true
    }
  })
  const verification = object(manifest.finalVerification)
  assert.equal(verification.passed, true)
  assert.equal(verification.runId, runId)
  assert.deepEqual(verification.errors, [])
  assert.equal(verification.hasDeferredIssues, false)
  const e2e = object(result.e2e),
    e2eResult = object(e2e.result)
  assert.equal(e2e.success, true)
  assert.equal(e2eResult.success, true)
  assert.equal(e2eResult.status, "verified")
  assert.deepEqual(e2e.cleanupErrors, [])
  const registeredWorktrees = git("worktree", "list", "--porcelain", "-z")
    .split("\0")
    .filter((field) => field.startsWith("worktree "))
    .map((field) => field.slice("worktree ".length))
  const expectedWorktrees = [realpathSync(input.repository)]
  if (input.promotion) {
    const promoted = object(object(manifest.mainPromotion).repositories),
      snapshot = object(object(object(manifest.mainPromotion).snapshot).repositories)
    for (const [ref, row] of Object.entries(object(manifest.repositories))) {
      const binding = object(row),
        canonical = binding.integrationRepositoryRef ?? ref
      if (canonical !== ref) continue
      const integration = object(binding.integration),
        item = object(snapshot[ref])
      assert.equal(integration.owner, "plugin")
      assert.equal(binding.baseBranch, "main")
      assert.equal(binding.headSha, head)
      assert.equal(item.candidateSha, head)
      assert.equal(object(promoted[ref]).status, "merged")
      assert.equal(object(promoted[ref]).commitSha, head)
      const path = join(
        input.workspace,
        ".autobizdevops/worktrees",
        runId,
        createHash("sha256").update(ref).digest("hex").slice(0, 12),
        "integration"
      )
      assert.equal(resolve(String(integration.worktreePath)), resolve(path))
      assert.equal(resolve(String(item.worktreePath)), resolve(path))
      const at = (...args: string[]) =>
        execFileSync("git", ["-C", path, ...args], {
          encoding: "utf8",
          windowsHide: true,
          stdio: "pipe"
        }).trim()
      assert.equal(realpathSync(at("rev-parse", "--show-toplevel")), realpathSync(path))
      assert.equal(at("branch", "--show-current"), integration.branchName)
      assert.equal(item.branchName, integration.branchName)
      assert.equal(at("rev-parse", "HEAD"), head)
      assert.equal(at("status", "--porcelain"), "")
      assert.equal(
        realpathSync(resolve(path, at("rev-parse", "--git-common-dir"))),
        realpathSync(resolve(input.repository, git("rev-parse", "--git-common-dir")))
      )
      expectedWorktrees.push(realpathSync(path))
    }
    assert(expectedWorktrees.length > 1, "Original isolated integration checkout must remain")
  }
  assert.deepEqual(
    registeredWorktrees.map((path) => realpathSync(path)).sort(),
    expectedWorktrees.sort(),
    "Only the original main and exact native promoted integration checkouts may remain registered"
  )
  return {
    manifest,
    proof,
    mainGit: { root: realpathSync(input.repository), branch: "main", head, registeredWorktrees },
    scope: "Read-only native terminal projection; not an App run or enterprise acceptance"
  }
}
