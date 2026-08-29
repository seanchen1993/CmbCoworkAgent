import { execFileSync } from "child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  watch,
  writeFileSync
} from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { pathToFileURL } from "url"
import {
  createWorkflowWorktree,
  cleanupWorkflowWorktree,
  diffWorkflowWorktree,
  discardWorkflowWorktree,
  finalizeWorkflowWorktreeRecord,
  identifyRepository,
  isWorktreePristine,
  listWorkflowWorktreeRecords,
  listWorkflowWorktreeRecordsForPrune,
  mergeWorkflowWorktree,
  parseWorktreeList,
  persistWorkflowWorktreeRecord,
  removeWorkflowWorktree,
  type WorkflowWorktreeInfo
} from "../src/main/services/git-worktree.ts"
import {
  isGitRepositoryOverrideEnvironmentVariable,
  withoutGitRepositoryOverrides
} from "../src/main/services/git-environment.ts"
import { WorkflowWorktreeLedger } from "../src/main/agent/workflow/worktree-lease.ts"
import { runWorkflowEngine } from "../src/main/agent/workflow/engine.ts"
import { workflowRunManager } from "../src/main/agent/workflow/run-manager.ts"
import { validateWorkflowScript } from "../src/main/agent/workflow/script.ts"
import { WORKFLOW_TOOL_DESCRIPTION } from "../src/main/agent/workflow/prompts.ts"
import {
  createWorkflowRunStore,
  generateWorkflowRunId,
  loadWorkflowRun,
  markWorkflowRunNotified,
  pruneWorkflowRuns,
  runFilePath,
  sha256Hex,
  updateWorkflowWorktreeRecord
} from "../src/main/agent/workflow/run-store.ts"
import type {
  PersistedWorkflowRun,
  WorkflowSubagentRunner,
  WorkflowWorktreeRecord
} from "../src/main/agent/workflow/types.ts"

const PREVIOUS_WORKFLOW_DATA_ROOT = process.env.CMB_COWORK_AGENT_HOME

const WORKFLOW_WORKTREE_DIFF_SUMMARY_MAX_CHARS = 32 * 1024
const WORKFLOW_WORKTREE_BRANCH_PREFIX = "cmbcowork/wf"

/**
 * Worktree isolation for dynamic workflows, driven against REAL throwaway git
 * repositories — the invariants here (HEAD attachment, name/branch uniqueness
 * under concurrency, what authorizes a delete) are properties of git's behaviour,
 * so a mocked git would only test the mock.
 */

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim()
}

function makeRepo(): string {
  // realpath: on macOS `mkdtemp` hands back /var/... while git reports the real
  // /private/var/..., and the service canonicalizes through git. Comparing the two
  // raw strings would fail for a reason that has nothing to do with the code.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cmb-wt-repo-")))
  git(dir, ["init", "--initial-branch=main"])
  git(dir, ["config", "user.name", "Repo Owner"])
  git(dir, ["config", "user.email", "owner@example.com"])
  // A commit is required: `worktree add` has nothing to branch from otherwise.
  writeFileSync(join(dir, "README.md"), "base\n")
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-m", "base"])
  return dir
}

function makeAppDataRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "cmb-wt-data-")))
}

function recordFor(
  info: WorkflowWorktreeInfo,
  status: WorkflowWorktreeRecord["status"],
  runId = "wf_record"
): WorkflowWorktreeRecord {
  const now = new Date().toISOString()
  return {
    id: info.name,
    runId,
    threadId: runId,
    branch: info.branch,
    directory: info.directory,
    workspaceDirectory: info.workspaceDirectory,
    sourceRoot: info.sourceRoot,
    sourceRelativePath: info.sourceRelativePath,
    sourceBranch: info.sourceBranch,
    gitRoot: info.gitRoot,
    commonDir: info.commonDir,
    baseCommit: info.baseCommit,
    headCommit: info.baseCommit,
    dirty: false,
    status,
    updatedAt: now
  }
}

async function mergeRecordedWorktree(
  workspacePath: string,
  info: WorkflowWorktreeInfo,
  appDataRoot: string
): Promise<WorkflowWorktreeRecord> {
  const record = (await listWorkflowWorktreeRecords(info.commonDir, appDataRoot)).find(
    (candidate) => candidate.id === info.name
  )
  if (!record) throw new Error(`missing worktree record for ${info.name}`)
  return (await mergeWorkflowWorktree({ workspacePath, record, appDataRoot })).record
}

// ── service: creation ────────────────────────────────────────────────────────

async function testCreateProducesAttachedBranchAtHead(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    const head = git(repo, ["rev-parse", "HEAD"])
    const info = await createWorkflowWorktree({
      workspacePath: repo,
      runId: "wf_abc123",
      label: "a1-review",
      appDataRoot
    })

    assert(existsSync(info.directory), "worktree directory should exist")
    assert(existsSync(join(info.directory, "README.md")), "worktree should be checked out")
    assert(info.baseCommit === head, "baseCommit should pin the repo HEAD")
    assert(
      info.branch.startsWith(`${WORKFLOW_WORKTREE_BRANCH_PREFIX}/`),
      `branch should live in our namespace, got ${info.branch}`
    )
    assert(info.gitRoot === repo, `gitRoot should be the primary checkout, got ${info.gitRoot}`)

    // HEAD attached to the new branch — the invariant that makes a commit inside
    // the worktree advance a real ref instead of landing detached.
    const symbolic = git(info.directory, ["symbolic-ref", "HEAD"])
    assert(
      symbolic === `refs/heads/${info.branch}`,
      `HEAD should be attached to the new branch, got ${symbolic}`
    )
    assert(git(info.directory, ["rev-parse", "HEAD"]) === head, "worktree HEAD should be at base")

    // The directory lives under the app data root, NOT next to the user's repo.
    assert(
      info.directory.startsWith(appDataRoot),
      `worktree should live under the app data root, got ${info.directory}`
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testDetachedSourceFailsBeforeProvisioning(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    git(repo, ["checkout", "--detach", "HEAD"])
    let rejected = false
    try {
      await createWorkflowWorktree({
        workspacePath: repo,
        runId: "wf_detached_source",
        label: "detached",
        appDataRoot
      })
    } catch (error) {
      rejected = /attached to a branch/i.test(
        error instanceof Error ? error.message : String(error)
      )
    }
    assert(rejected, "detached source HEAD must fail before creating an unusable deliverable")
    assert(
      !existsSync(join(appDataRoot, "worktrees")) ||
        readdirSync(join(appDataRoot, "worktrees")).length === 0,
      "detached-source rejection must not leave a managed worktree"
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testCreateDoesNotMutateGitConfig(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    const configBefore = git(repo, ["config", "--local", "--list"])
    const info = await createWorkflowWorktree({
      workspacePath: repo,
      runId: "wf_ident",
      appDataRoot
    })
    const configAfter = git(repo, ["config", "--local", "--list"])
    assert(
      configAfter === configBefore,
      "creating a workflow worktree must not rewrite repo config"
    )
    // Linked worktrees naturally read the repository's existing identity. No
    // inheritance write is necessary (and writing it would mutate user config).
    assert(
      git(info.directory, ["config", "--local", "user.name"]) === "Repo Owner",
      "worktree should read the repository committer name"
    )
    assert(
      git(info.directory, ["config", "--local", "user.email"]) === "owner@example.com",
      "worktree should read the repository committer email"
    )

    // And a commit made there actually advances the branch (end-to-end proof of
    // the attachment + identity pair).
    writeFileSync(join(info.directory, "work.txt"), "done\n")
    git(info.directory, ["add", "-A"])
    git(info.directory, ["commit", "-m", "agent work"])
    const branchHead = git(repo, ["rev-parse", info.branch])
    assert(
      branchHead === git(info.directory, ["rev-parse", "HEAD"]),
      "the parent repo should see the branch advance"
    )
    assert(
      git(repo, ["log", "-1", "--format=%an <%ae>", info.branch]) ===
        "Repo Owner <owner@example.com>",
      "the commit should be attributed to the inherited identity"
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testSourceSnapshotRejectsConcurrentBranchSwitch(): Promise<void> {
  const repo = makeRepo()
  const wrapperRoot = makeAppDataRoot()
  try {
    git(repo, ["switch", "-c", "other"])
    writeFileSync(join(repo, "README.md"), "other\n")
    git(repo, ["add", "README.md"])
    git(repo, ["commit", "-m", "other head"])
    git(repo, ["switch", "main"])

    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim()
    const wrapper = join(wrapperRoot, "git")
    const marker = join(wrapperRoot, "switched")
    writeFileSync(
      wrapper,
      `#!/bin/sh
trigger=0
for arg in "$@"; do
  if [ "$arg" = "--porcelain=v2" ]; then trigger=1; fi
done
previous=""
for arg in "$@"; do
  if [ "$previous" = "rev-parse" ] && [ "$arg" = "HEAD" ]; then trigger=1; fi
  previous="$arg"
done
if [ "$trigger" = "1" ] && [ ! -e "$CMB_SWITCH_MARKER" ]; then
  output=$("$CMB_REAL_GIT" "$@")
  code=$?
  : > "$CMB_SWITCH_MARKER"
  "$CMB_REAL_GIT" -C "$CMB_TEST_REPO" switch other >/dev/null 2>&1
  printf '%s\n' "$output"
  exit "$code"
fi
exec "$CMB_REAL_GIT" "$@"
`
    )
    chmodSync(wrapper, 0o755)
    const moduleUrl = pathToFileURL(
      join(process.cwd(), "src", "main", "services", "git-worktree.ts")
    ).href
    const probe = `
      const { prepareWorkflowWorktreeSource } = await import(${JSON.stringify(moduleUrl)});
      try {
        const source = await prepareWorkflowWorktreeSource(${JSON.stringify(repo)});
        console.log(JSON.stringify({ ok: true, baseCommit: source.baseCommit, sourceBranch: source.sourceBranch }));
      } catch (error) {
        console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      }
    `
    const output = execFileSync(
      process.execPath,
      [...process.execArgv, "--input-type=module", "-e", probe],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${wrapperRoot}:${process.env.PATH ?? ""}`,
          CMB_REAL_GIT: realGit,
          CMB_SWITCH_MARKER: marker,
          CMB_TEST_REPO: repo
        }
      }
    ).trim()
    const result = JSON.parse(output) as { ok: boolean; error?: string }
    assert(
      !result.ok && result.error?.includes("source HEAD changed"),
      `a branch switch during source capture must fail closed, got ${output}`
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(wrapperRoot, { recursive: true, force: true })
  }
}

async function testSourceSnapshotHonorsWorkflowCancellation(): Promise<void> {
  const repo = makeRepo()
  const wrapperRoot = makeAppDataRoot()
  try {
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim()
    const wrapper = join(wrapperRoot, "git")
    writeFileSync(
      wrapper,
      `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--porcelain=v2" ]; then
    exec sleep 30
  fi
done
exec "$CMB_REAL_GIT" "$@"
`
    )
    chmodSync(wrapper, 0o755)
    const moduleUrl = pathToFileURL(
      join(process.cwd(), "src", "main", "services", "git-worktree.ts")
    ).href
    const probe = `
      const { prepareWorkflowWorktreeSource } = await import(${JSON.stringify(moduleUrl)});
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100);
      const startedAt = Date.now();
      try {
        await prepareWorkflowWorktreeSource(${JSON.stringify(repo)}, controller.signal);
        console.log(JSON.stringify({ ok: true, elapsedMs: Date.now() - startedAt }));
      } catch (error) {
        console.log(JSON.stringify({
          ok: false,
          elapsedMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error)
        }));
      }
    `
    const output = execFileSync(
      process.execPath,
      [...process.execArgv, "--input-type=module", "-e", probe],
      {
        encoding: "utf8",
        timeout: 5_000,
        env: {
          ...process.env,
          PATH: `${wrapperRoot}:${process.env.PATH ?? ""}`,
          CMB_REAL_GIT: realGit
        }
      }
    ).trim()
    const result = JSON.parse(output) as { ok: boolean; elapsedMs: number; error?: string }
    assert(!result.ok, `cancelled source capture must fail, got ${output}`)
    assert(
      result.elapsedMs < 3_000,
      `cancelled source capture must not wait for the configured long timeout, got ${output}`
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(wrapperRoot, { recursive: true, force: true })
  }
}

async function testWorkspaceHookFilesAreMaterializedWithoutDirtyingWorktree(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    const sourceHook = join(repo, ".cmbdevclaw", "hooks", "check.py")
    mkdirSync(dirname(sourceHook), { recursive: true })
    writeFileSync(sourceHook, "print('hook')\n")
    const info = await createWorkflowWorktree({
      workspacePath: repo,
      runId: "wf_hook_copy",
      appDataRoot
    })
    const copiedHook = join(info.workspaceDirectory, ".cmbdevclaw", "hooks", "check.py")
    assert(readFileSync(copiedHook, "utf8") === "print('hook')\n", "workspace hook must be copied")
    assert(
      realpathSync(copiedHook) !== realpathSync(sourceHook),
      "the isolated hook file must not point back to the source checkout"
    )
    assert(
      await isWorktreePristine(info.directory, info.baseCommit),
      "app-materialized hook files must not turn a no-op agent into a deliverable"
    )
    await removeWorkflowWorktree({
      directory: info.directory,
      gitRoot: info.gitRoot,
      branch: info.branch,
      expectedBranchHead: info.baseCommit,
      preserveChanges: true
    })
    assert(!existsSync(info.directory), "a pristine hook-enabled checkout must clean up normally")
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testTrackedWorkspaceHookSymlinkStaysPristine(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    const support = join(repo, ".cmbdevclaw")
    mkdirSync(join(support, "hooks"), { recursive: true })
    writeFileSync(join(support, "helper.json"), "{}\n")
    symlinkSync("../helper.json", join(support, "hooks", "linked.json"))
    // `.cmbdevclaw` is normally ignored, but repositories may deliberately
    // version hook configuration.  The linked checkout already has that Git
    // symlink; hook materialization must not dereference-overwrite it.
    git(repo, ["add", "-f", ".cmbdevclaw"])
    git(repo, ["commit", "-m", "track workspace hook support"])

    const info = await createWorkflowWorktree({
      workspacePath: repo,
      runId: "wf_tracked_hook_symlink",
      appDataRoot
    })
    assert(
      git(info.directory, ["status", "--porcelain"]) === "",
      "tracked workspace hook symlinks must stay pristine after materialization"
    )
    assert(
      await isWorktreePristine(info.directory, info.baseCommit),
      "a tracked hook symlink must not retain an otherwise no-op worktree"
    )
    await removeWorkflowWorktree({
      directory: info.directory,
      gitRoot: info.gitRoot,
      branch: info.branch,
      expectedBranchHead: info.baseCommit,
      preserveChanges: true
    })
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testDirtySourceUsesCommittedHead(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    writeFileSync(join(repo, "staged.txt"), "committed staged\n")
    git(repo, ["add", "staged.txt"])
    git(repo, ["commit", "-m", "add dirty-source fixtures"])

    writeFileSync(join(repo, "README.md"), "source unstaged only\n")
    writeFileSync(join(repo, "staged.txt"), "source staged only\n")
    git(repo, ["add", "staged.txt"])
    writeFileSync(join(repo, "untracked.txt"), "source untracked only\n")
    const sourceStatusBefore = git(repo, ["status", "--short"])

    const isolated = await createWorkflowWorktree({
      workspacePath: repo,
      runId: "wf_dirty_source",
      appDataRoot
    })
    assert(
      readFileSync(join(isolated.directory, "README.md"), "utf8") === "base\n",
      "unstaged source changes must not be copied into the isolated checkout"
    )
    assert(
      readFileSync(join(isolated.directory, "staged.txt"), "utf8") === "committed staged\n",
      "staged source changes must not be copied into the isolated checkout"
    )
    assert(
      !existsSync(join(isolated.directory, "untracked.txt")),
      "untracked source files must not be copied into the isolated checkout"
    )
    assert(
      git(isolated.directory, ["status", "--porcelain"]) === "",
      "a dirty source checkout must still produce a pristine committed-HEAD worktree"
    )
    assert(
      git(repo, ["status", "--short"]) === sourceStatusBefore,
      "provisioning must not alter the source checkout's staged or unstaged state"
    )
    await removeWorkflowWorktree({
      directory: isolated.directory,
      gitRoot: isolated.gitRoot,
      branch: isolated.branch,
      expectedBranchHead: isolated.baseCommit,
      preserveChanges: true
    })
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testSubdirectoryScopeAndLinkedSourceHead(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    mkdirSync(join(repo, "packages", "a"), { recursive: true })
    writeFileSync(join(repo, "packages", "a", "index.ts"), "export {}\n")
    git(repo, ["add", "-A"])
    git(repo, ["commit", "-m", "add package"])

    writeFileSync(join(repo, "packages", "a", "local.ts"), "assigned dirty\n")
    const scopedDirty = await createWorkflowWorktree({
      workspacePath: join(repo, "packages", "a"),
      runId: "wf_scope_dirty",
      appDataRoot
    })
    assert(
      !existsSync(join(scopedDirty.workspaceDirectory, "local.ts")),
      "assigned-scope source changes must not be copied into the isolated checkout"
    )
    await removeWorkflowWorktree({
      directory: scopedDirty.directory,
      gitRoot: scopedDirty.gitRoot,
      branch: scopedDirty.branch,
      expectedBranchHead: scopedDirty.baseCommit,
      preserveChanges: true
    })

    mkdirSync(join(repo, "packages", "b"), { recursive: true })
    writeFileSync(join(repo, "packages", "b", "unrelated.ts"), "sibling dirty\n")

    // Runtime files from other CmbCowork workspaces in the same repository are
    // not source edits. In particular, a repo-root thread must not prevent a
    // packages/a thread from creating its isolated checkout.
    mkdirSync(join(repo, ".cmbdevclaw", "workflows", "root-thread"), { recursive: true })
    writeFileSync(join(repo, ".cmbdevclaw", "workflows", "root-thread", "run.json"), "{}\n")
    mkdirSync(join(repo, "packages", "b", ".cmbdevclaw", "workflows", "sibling-thread"), {
      recursive: true
    })
    writeFileSync(
      join(repo, "packages", "b", ".cmbdevclaw", "workflows", "sibling-thread", "run.json"),
      "{}\n"
    )
    const scoped = await createWorkflowWorktree({
      workspacePath: join(repo, "packages", "a"),
      runId: "wf_scope",
      appDataRoot
    })
    assert(
      scoped.workspaceDirectory === join(scoped.directory, "packages", "a"),
      `subdirectory workspace scope must be preserved, got ${scoped.workspaceDirectory}`
    )
    assert(existsSync(join(scoped.workspaceDirectory, "index.ts")), "scoped file should exist")

    writeFileSync(join(repo, ".gitignore"), "packages/new-package/\n")
    git(repo, ["add", ".gitignore"])
    git(repo, ["commit", "-m", "ignore empty package fixture"])
    mkdirSync(join(repo, "packages", "new-package"), { recursive: true })
    writeFileSync(join(repo, "packages", "new-package", "ignored.cache"), "seed\n")
    const emptyScoped = await createWorkflowWorktree({
      workspacePath: join(repo, "packages", "new-package"),
      runId: "wf_empty_scope",
      appDataRoot
    })
    assert(
      existsSync(emptyScoped.workspaceDirectory),
      "an ignored-only assigned workspace must be materialized in the linked checkout"
    )

    writeFileSync(join(scoped.directory, "linked.txt"), "linked\n")
    git(scoped.directory, ["add", "-A"])
    git(scoped.directory, ["commit", "-m", "linked source advances"])
    const linkedHead = git(scoped.directory, ["rev-parse", "HEAD"])
    const primaryHead = git(repo, ["rev-parse", "HEAD"])
    assert(linkedHead !== primaryHead, "linked source should diverge for this regression test")
    const nested = await createWorkflowWorktree({
      workspacePath: scoped.workspaceDirectory,
      runId: "wf_linked",
      appDataRoot
    })
    assert(nested.baseCommit === linkedHead, "creation must use the actual linked checkout HEAD")
    assert(
      nested.workspaceDirectory === join(nested.directory, "packages", "a"),
      "linked subdirectory scope must survive nested isolation"
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testConcurrentCreatesAreSerializedAndUnique(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    // The real failure this guards: concurrent `git worktree add` on one repo race
    // on the shared index.lock / worktree admin and one of them dies.
    const infos = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        createWorkflowWorktree({
          workspacePath: repo,
          runId: "wf_par",
          label: `a${i}`,
          appDataRoot
        })
      )
    )
    assert(infos.length === 6, "all concurrent creations should succeed")
    assert(
      new Set(infos.map((i) => i.directory)).size === 6,
      "every worktree should get its own directory"
    )
    assert(
      new Set(infos.map((i) => i.branch)).size === 6,
      "every worktree should get its own branch"
    )
    for (const info of infos) {
      assert(existsSync(info.directory), `${info.directory} should exist`)
      assert(
        git(info.directory, ["symbolic-ref", "HEAD"]) === `refs/heads/${info.branch}`,
        "each concurrent worktree should be attached to its own branch"
      )
    }
    const listed = parseWorktreeList(git(repo, ["worktree", "list", "--porcelain"]))
    assert(listed.length === 7, `repo should register 6 worktrees + primary, got ${listed.length}`)
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testLongLabelOwnershipRecordsDoNotCollide(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    const label = "same-very-long-agent-label-" + "x".repeat(80)
    const first = await createWorkflowWorktree({
      workspacePath: repo,
      runId: "wf_manifest",
      threadId: "thread-manifest",
      label,
      persistOwnership: true,
      appDataRoot
    })
    const second = await createWorkflowWorktree({
      workspacePath: repo,
      runId: "wf_manifest",
      threadId: "thread-manifest",
      label,
      persistOwnership: true,
      appDataRoot
    })
    const records = await listWorkflowWorktreeRecords(first.commonDir, appDataRoot)
    assert(records.length === 2, "truncated display names must not collide as manifest keys")
    assert(
      records.every((record) => record.threadId === "thread-manifest"),
      "ownership records must carry their thread for restart reconciliation"
    )
    assert(
      records.some((record) => record.id === first.name) &&
        records.some((record) => record.id === second.name),
      "both long-label worktrees must retain independent ownership records"
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testCreateFromInsideAWorktreeUsesPrimaryRepo(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    const first = await createWorkflowWorktree({
      workspacePath: repo,
      runId: "wf_nest",
      appDataRoot
    })
    // Creating with a worktree as the workspace must still resolve to the PRIMARY
    // checkout, or nested isolation would branch off the wrong base and the repo
    // lock would key on a different directory (defeating serialization).
    const nested = await createWorkflowWorktree({
      workspacePath: first.directory,
      runId: "wf_nest",
      appDataRoot
    })
    assert(
      nested.gitRoot === repo,
      `nested create should resolve the primary repo, got ${nested.gitRoot}`
    )

    const identity = await identifyRepository(first.directory)
    assert(
      identity?.gitRoot === repo,
      "identifyRepository should map a worktree to its primary repo"
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testSymlinkedWorkspaceKeepsOneRepositoryIdentity(): Promise<void> {
  if (process.platform === "win32") return
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  const aliasRoot = realpathSync(mkdtempSync(join(tmpdir(), "cmb-wt-alias-")))
  const workspaceAlias = join(aliasRoot, "repository")
  try {
    symlinkSync(repo, workspaceAlias, "dir")
    const canonicalIdentity = await identifyRepository(repo)
    const aliasIdentity = await identifyRepository(workspaceAlias)
    assert(
      aliasIdentity?.commonDir === canonicalIdentity?.commonDir &&
        aliasIdentity?.sourceRoot === canonicalIdentity?.sourceRoot &&
        aliasIdentity?.gitRoot === canonicalIdentity?.gitRoot,
      "symlink and canonical workspace spellings must identify the same repository"
    )

    const ledger = new WorkflowWorktreeLedger({
      workspacePath: workspaceAlias,
      runId: "wf_symlink_identity",
      appDataRoot
    })
    const info = await ledger.acquire("symlinked-workspace")
    writeFileSync(join(info.directory, "symlink-delivery.txt"), "delivered\n")
    git(info.directory, ["add", "symlink-delivery.txt"])
    git(info.directory, ["commit", "-m", "deliver through symlink workspace"])
    await ledger.settle(info, { succeeded: true })
    const ready = (await listWorkflowWorktreeRecords(info.commonDir, appDataRoot)).find(
      (record) => record.id === info.name
    )
    assert(ready?.status === "ready", "symlinked workspace deliverable should become ready")

    const diff = await diffWorkflowWorktree({
      workspacePath: workspaceAlias,
      record: ready!,
      appDataRoot
    })
    assert(
      diff.summary.includes("deliver through symlink workspace"),
      "Diff should accept the original symlinked workspace spelling"
    )
    const merged = await mergeWorkflowWorktree({
      workspacePath: workspaceAlias,
      record: diff.record,
      appDataRoot
    })
    assert(merged.record.status === "merged", "Merge should preserve repository identity")
    assert(
      readFileSync(join(repo, "symlink-delivery.txt"), "utf8") === "delivered\n",
      "merged output should land in the canonical source checkout"
    )
    assert(!existsSync(info.directory), "successful Merge should clean up the worktree")
  } finally {
    rmSync(aliasRoot, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testCreateRejectsNonGitDirectory(): Promise<void> {
  const plain = mkdtempSync(join(tmpdir(), "cmb-wt-plain-"))
  const appDataRoot = makeAppDataRoot()
  try {
    let thrown: unknown
    try {
      await createWorkflowWorktree({ workspacePath: plain, runId: "wf_x", appDataRoot })
    } catch (error) {
      thrown = error
    }
    assert(thrown instanceof Error, "creating outside a git repo should throw")
    assert(
      String((thrown as Error).message).includes("git repository"),
      `error should name the cause, got ${(thrown as Error).message}`
    )
  } finally {
    rmSync(plain, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

// ── service: pristine detection ──────────────────────────────────────────────

async function testPristineDetection(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    const untouched = await createWorkflowWorktree({
      workspacePath: repo,
      runId: "wf_p",
      label: "clean",
      appDataRoot
    })
    assert(
      await isWorktreePristine(untouched.directory, untouched.baseCommit),
      "a freshly created worktree should be pristine"
    )

    // Uncommitted edit counts as work.
    const edited = await createWorkflowWorktree({
      workspacePath: repo,
      runId: "wf_p",
      label: "edited",
      appDataRoot
    })
    writeFileSync(join(edited.directory, "README.md"), "changed\n")
    assert(
      !(await isWorktreePristine(edited.directory, edited.baseCommit)),
      "an edited worktree is not pristine"
    )

    // Untracked file counts as work.
    const added = await createWorkflowWorktree({
      workspacePath: repo,
      runId: "wf_p",
      label: "added",
      appDataRoot
    })
    writeFileSync(join(added.directory, "new.txt"), "new\n")
    assert(
      !(await isWorktreePristine(added.directory, added.baseCommit)),
      "an untracked file is work"
    )

    // Committed work counts even though the tree is clean again.
    const committed = await createWorkflowWorktree({
      workspacePath: repo,
      runId: "wf_p",
      label: "committed",
      appDataRoot
    })
    writeFileSync(join(committed.directory, "feature.txt"), "feature\n")
    git(committed.directory, ["add", "-A"])
    git(committed.directory, ["commit", "-m", "feature"])
    assert(
      !(await isWorktreePristine(committed.directory, committed.baseCommit)),
      "a committed worktree is not pristine even with a clean status"
    )

    // Unknown base fails CLOSED: this predicate authorizes a delete, so an
    // unreliable answer must never be the one that discards an agent's output.
    assert(
      !(await isWorktreePristine(untouched.directory, "")),
      "an empty base commit must read as 'has work'"
    )
    assert(
      !(await isWorktreePristine(join(repo, "does-not-exist"), untouched.baseCommit)),
      "an unreadable worktree must read as 'has work'"
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

// ── service: removal ─────────────────────────────────────────────────────────

async function testRemoveIsCompleteAndIdempotent(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    const info = await createWorkflowWorktree({
      workspacePath: repo,
      runId: "wf_rm",
      appDataRoot
    })
    writeFileSync(join(info.directory, "dirty.txt"), "uncommitted\n")

    await removeWorkflowWorktree({
      directory: info.directory,
      gitRoot: repo,
      branch: info.branch
    })
    assert(!existsSync(info.directory), "directory should be gone")
    const listed = parseWorktreeList(git(repo, ["worktree", "list", "--porcelain"]))
    assert(listed.length === 1, "git should no longer register the worktree")
    let branchLookupFailed = false
    try {
      git(repo, ["rev-parse", "--verify", `refs/heads/${info.branch}`])
    } catch {
      branchLookupFailed = true
    }
    assert(branchLookupFailed, "the branch should be deleted with the worktree")

    // Idempotent: reclaim paths call this on directories that may already be gone.
    await removeWorkflowWorktree({
      directory: info.directory,
      gitRoot: repo,
      branch: info.branch
    })
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testManagedOperationsDoNotPruneUnrelatedWorktrees(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  const userParent = realpathSync(mkdtempSync(join(tmpdir(), "cmb-user-wt-")))
  const userWorktree = join(userParent, "checkout")
  const parkedWorktree = join(userParent, "checkout-offline")
  try {
    git(repo, ["worktree", "add", "-b", "user/offline", userWorktree, "HEAD"])
    const managed = await createWorkflowWorktree({
      workspacePath: repo,
      runId: "wf_unrelated",
      appDataRoot
    })

    renameSync(userWorktree, parkedWorktree)
    const before = parseWorktreeList(git(repo, ["worktree", "list", "--porcelain"])).find(
      (entry) => entry.path === userWorktree
    )
    assert(before, "Git should retain the temporarily offline user worktree registration")

    await removeWorkflowWorktree({
      directory: managed.directory,
      gitRoot: repo,
      branch: managed.branch,
      expectedBranchHead: managed.baseCommit,
      preserveChanges: true
    })
    const afterRemove = parseWorktreeList(git(repo, ["worktree", "list", "--porcelain"])).find(
      (entry) => entry.path === userWorktree
    )
    assert(afterRemove, "managed removal must not prune an unrelated offline worktree")

    const second = await createWorkflowWorktree({
      workspacePath: repo,
      runId: "wf_unrelated_again",
      appDataRoot
    })
    const afterCreate = parseWorktreeList(git(repo, ["worktree", "list", "--porcelain"])).find(
      (entry) => entry.path === userWorktree
    )
    assert(afterCreate, "managed creation must not prune an unrelated offline worktree")
    await removeWorkflowWorktree({
      directory: second.directory,
      gitRoot: repo,
      branch: second.branch,
      expectedBranchHead: second.baseCommit,
      preserveChanges: true
    })
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
    rmSync(userParent, { recursive: true, force: true })
  }
}

async function testSafeRemovalRejectsAnAdvancedBranch(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    const info = await createWorkflowWorktree({
      workspacePath: repo,
      runId: "wf_advanced",
      appDataRoot
    })
    writeFileSync(join(info.directory, "late.txt"), "late\n")
    git(info.directory, ["add", "-A"])
    git(info.directory, ["commit", "-m", "late work"])

    let rejected: unknown
    try {
      await removeWorkflowWorktree({
        directory: info.directory,
        gitRoot: repo,
        branch: info.branch,
        expectedBranchHead: info.baseCommit,
        preserveChanges: true
      })
    } catch (error) {
      rejected = error
    }
    assert(rejected instanceof Error, "an advanced branch must reject safe cleanup")
    assert(existsSync(info.directory), "safe cleanup must leave the advanced checkout intact")
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testGitRemovalFailureNeverFallsBackToRecursiveDelete(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  const userParent = realpathSync(mkdtempSync(join(tmpdir(), "cmb-unavailable-wt-")))
  const userWorktree = join(userParent, "external-checkout")
  const parkedWorktree = join(userParent, "external-checkout-offline")
  try {
    git(repo, ["worktree", "add", "-b", "user/unavailable", userWorktree, "HEAD"])
    renameSync(userWorktree, parkedWorktree)

    const info = await createWorkflowWorktree({
      workspacePath: repo,
      runId: "wf_locked",
      appDataRoot
    })
    writeFileSync(join(info.directory, "recover-me.txt"), "must survive\n")
    git(repo, ["worktree", "lock", "--reason", "test lock", info.directory])

    let removalError: unknown
    try {
      await removeWorkflowWorktree({
        directory: info.directory,
        gitRoot: repo,
        branch: info.branch
      })
    } catch (error) {
      removalError = error
    }
    assert(removalError instanceof Error, "a Git worktree removal failure must surface")
    assert(
      removalError.message.includes(userWorktree) &&
        removalError.message.includes("git worktree prune --dry-run --verbose"),
      "cleanup failure should identify unavailable external registrations without pruning them"
    )
    assert(existsSync(info.directory), "Git failure must retain the worktree directory")
    assert(
      existsSync(join(info.directory, "recover-me.txt")),
      "Git failure must retain recoverable content instead of recursively deleting it"
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
    rmSync(userParent, { recursive: true, force: true })
  }
}

// ── ledger ───────────────────────────────────────────────────────────────────

async function testLedgerKeepsOnlyChangedSuccesses(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  const ledger = new WorkflowWorktreeLedger({ workspacePath: repo, runId: "wf_led", appDataRoot })
  try {
    // Succeeded + changed → kept as a host-managed deliverable.
    const changed = await ledger.acquire("worker")
    writeFileSync(join(changed.directory, "out.txt"), "result\n")
    await ledger.settle(changed, { succeeded: true })
    const changedRecord = (await listWorkflowWorktreeRecords(changed.commonDir, appDataRoot)).find(
      (record) => record.id === changed.name
    )
    assert(changedRecord?.status === "ready", "a changed success should be retained as ready")
    assert(existsSync(changed.directory), "a kept worktree stays on disk")

    // Succeeded + untouched → removed, no deliverable. A run that fans out 20
    // read-only agents must not leave 20 empty checkouts behind.
    const untouched = await ledger.acquire("noop")
    await ledger.settle(untouched, { succeeded: true })
    assert(!existsSync(untouched.directory), "an untouched worktree is removed")

    // Failed + changed → no success deliverable, but the partial edit is retained
    // as recoverable. Failure must never be a data-loss trigger.
    const failed = await ledger.acquire("failer")
    writeFileSync(join(failed.directory, "half.txt"), "partial\n")
    await ledger.settle(failed, { succeeded: false })
    assert(existsSync(failed.directory), "a failed agent's changed worktree must be retained")
    const failedRecord = (await listWorkflowWorktreeRecords(failed.commonDir, appDataRoot)).find(
      (record) => record.id === failed.name
    )
    assert(failedRecord?.status === "recoverable", "failed changes should be recoverable")

    // Kept work survives a reclaim — cancelling a run must not destroy what its
    // finished agents already produced.
    await ledger.reclaimAll()
    assert(existsSync(changed.directory), "reclaim must not delete kept deliverables")
    const retainedRecords = await listWorkflowWorktreeRecords(changed.commonDir, appDataRoot)
    assert(
      retainedRecords.filter(
        (record) => record.status === "ready" || record.status === "recoverable"
      ).length === 2,
      "the ledger should report ready and recoverable worktrees"
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testSuccessfulAgentWithMissingCheckoutIsRecoverable(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    const ledger = new WorkflowWorktreeLedger({
      workspacePath: repo,
      runId: "wf_missing_success",
      appDataRoot
    })
    const info = await ledger.acquire("missing checkout")
    // Simulate an external/manual removal after the agent has begun. A success
    // result cannot make this a ready deliverable: no Git checkout remains to
    // Diff, Commit, or Merge.
    git(repo, ["worktree", "remove", "--force", info.directory])
    await ledger.settle(info, { succeeded: true })
    const record = (await listWorkflowWorktreeRecords(info.commonDir, appDataRoot)).find(
      (candidate) => candidate.id === info.name
    )
    assert(record?.status === "recoverable", "a missing successful checkout must be recoverable")
    assert(
      record?.error?.includes("unreadable"),
      `recovery state should explain the missing checkout, got ${record?.error}`
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testRewrittenBaseIsNotAdvertisedAsReady(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    const ledger = new WorkflowWorktreeLedger({
      workspacePath: repo,
      runId: "wf_rewritten_base",
      appDataRoot
    })
    const info = await ledger.acquire("rewrite base")
    writeFileSync(join(info.directory, "amended.txt"), "amended base\n")
    git(info.directory, ["add", "amended.txt"])
    git(info.directory, ["commit", "--amend", "--no-edit"])

    await ledger.settle(info, { succeeded: true })
    const record = (await listWorkflowWorktreeRecords(info.commonDir, appDataRoot)).find(
      (candidate) => candidate.id === info.name
    )
    assert(record?.status === "recoverable", "a rewritten base must not be advertised as ready")
    assert(
      record?.error?.includes("no longer descends from its recorded base"),
      `recovery state should explain the rewritten history, got ${record?.error}`
    )
    assert(existsSync(info.directory), "rewritten work must be retained for manual recovery")
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testLedgerReclaimsOutstandingWorktrees(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  const ledger = new WorkflowWorktreeLedger({ workspacePath: repo, runId: "wf_rec", appDataRoot })
  try {
    const a = await ledger.acquire("a")
    const b = await ledger.acquire("b")
    writeFileSync(join(a.directory, "x.txt"), "x\n")

    await ledger.reclaimAll()
    assert(existsSync(a.directory), "reclaim retains an unsettled changed worktree")
    assert(existsSync(b.directory), "reclaim conservatively retains an unsettled pristine worktree")
    const records = await listWorkflowWorktreeRecords(a.commonDir, appDataRoot)
    assert(
      records.every((record) => record.status === "recoverable"),
      "every outstanding worktree should become recoverable"
    )

    // A settle arriving after the reclaim is a no-op, not a double removal.
    await ledger.settle(a, { succeeded: true })

    let acquireFailed = false
    try {
      await ledger.acquire("late")
    } catch {
      acquireFailed = true
    }
    assert(acquireFailed, "acquire after a reclaim must fail rather than leak a worktree")
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testLedgerCleansUpWorktreeCreatedDuringCancel(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    // The race that leaks: a `worktree add` already in flight when cancel lands.
    // The worktree exists on disk but nothing owns it yet, so the ledger must
    // dispose of it at registration time.
    let releaseCreate: (() => void) | undefined
    const createStarted = new Promise<void>((resolve) => {
      releaseCreate = resolve
    })
    let createdInfo: WorkflowWorktreeInfo | undefined
    const ledger = new WorkflowWorktreeLedger({
      workspacePath: repo,
      runId: "wf_race",
      appDataRoot,
      create: async (input) => {
        const info = await createWorkflowWorktree(input)
        createdInfo = info
        releaseCreate?.()
        // Stay in-flight long enough for the reclaim below to run first.
        await new Promise((resolve) => setTimeout(resolve, 50))
        return info
      }
    })

    const acquisition = ledger.acquire("racer")
    await createStarted
    await ledger.reclaimAll()

    let acquireRejected = false
    try {
      await acquisition
    } catch {
      acquireRejected = true
    }
    assert(acquireRejected, "an acquire that finishes after a cancel must fail")
    assert(createdInfo !== undefined, "the worktree should have been created on disk")
    assert(
      !existsSync(createdInfo!.directory),
      "a worktree created during cancel must not leak — it should delete itself"
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testLedgerReclaimAwaitsRecoveryBeforeReturning(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    let inspectionSettled = false
    const ledger = new WorkflowWorktreeLedger({
      workspacePath: repo,
      runId: "wf_slow",
      appDataRoot,
      pristine: async () => {
        await new Promise((resolve) => setTimeout(resolve, 120))
        inspectionSettled = true
        return false
      }
    })
    await ledger.acquire("stuck")
    const started = Date.now()
    await ledger.reclaimAll()
    const elapsed = Date.now() - started
    assert(inspectionSettled, "reclaim must not leave a recovery task writing after final flush")
    assert(elapsed >= 100, `reclaim returned before recovery settled (${elapsed}ms)`)
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testLedgerRetriesSourcePreparationAfterDetachedHead(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    const ledger = new WorkflowWorktreeLedger({
      workspacePath: repo,
      runId: "wf_source_retry",
      appDataRoot
    })
    git(repo, ["checkout", "--detach"])
    let firstFailure: unknown
    try {
      await ledger.acquire("first")
    } catch (error) {
      firstFailure = error
    }
    assert(
      firstFailure instanceof Error && firstFailure.message.includes("attached to a branch"),
      `the first detached source must fail, got ${String(firstFailure)}`
    )

    git(repo, ["switch", "main"])
    const recovered = await ledger.acquire("retry")
    assert(existsSync(recovered.directory), "a corrected source must be retried in the same run")
    await ledger.settle(recovered, { succeeded: true })
    assert(!existsSync(recovered.directory), "the pristine retry checkout should clean up normally")
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testLedgerFreezesFanoutBase(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    const ledger = new WorkflowWorktreeLedger({
      workspacePath: repo,
      runId: "wf_frozen",
      appDataRoot
    })
    const first = await ledger.acquire("first")
    const frozenHead = first.baseCommit
    writeFileSync(join(repo, "later.txt"), "later\n")
    git(repo, ["add", "-A"])
    git(repo, ["commit", "-m", "source advances during fanout"])
    const second = await ledger.acquire("second")
    assert(second.baseCommit === frozenHead, "one fanout ledger must freeze one source commit")
    assert(
      !existsSync(join(second.directory, "later.txt")),
      "a later source commit must not split an in-flight fanout baseline"
    )
    await ledger.reclaimAll()
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

// ── explicit delivery operations ────────────────────────────────────────────

async function testDiffMergeAndDiscardOperations(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    const ledger = new WorkflowWorktreeLedger({
      workspacePath: repo,
      runId: "wf_merge",
      appDataRoot
    })
    const info = await ledger.acquire("feature")
    writeFileSync(join(info.directory, "..feature.txt"), "done\n")
    const hookMarker = join(appDataRoot, "post-merge-ran")
    const hook = join(info.directory, ".githooks", "reference-transaction")
    mkdirSync(join(info.directory, ".githooks"), { recursive: true })
    writeFileSync(hook, `#!/bin/sh\ntouch '${hookMarker}'\n`)
    chmodSync(hook, 0o755)
    const removalHook = join(info.directory, ".githooks", "post-worktree-removal")
    writeFileSync(removalHook, `#!/bin/sh\ntouch '${hookMarker}'\n`)
    chmodSync(removalHook, 0o755)
    const indexHook = join(info.directory, ".githooks", "post-index-change")
    writeFileSync(indexHook, `#!/bin/sh\ntouch '${hookMarker}'\n`)
    chmodSync(indexHook, 0o755)
    git(repo, ["config", "core.hooksPath", ".githooks"])
    git(info.directory, ["-c", "core.hooksPath=/dev/null", "add", "-A"])
    git(info.directory, ["-c", "core.hooksPath=/dev/null", "commit", "-m", "feature work"])
    mkdirSync(join(repo, ".githooks"), { recursive: true })
    for (const name of ["reference-transaction", "post-worktree-removal", "post-index-change"]) {
      const sourceHook = join(repo, ".githooks", name)
      writeFileSync(sourceHook, `#!/bin/sh\ntouch '${hookMarker}'\n`)
      chmodSync(sourceHook, 0o755)
    }
    git(repo, ["-c", "core.hooksPath=/dev/null", "add", ".githooks"])
    git(repo, ["-c", "core.hooksPath=/dev/null", "commit", "-m", "install source hooks"])
    await ledger.settle(info, { succeeded: true })
    const ready = (await listWorkflowWorktreeRecords(info.commonDir, appDataRoot)).find(
      (record) => record.id === info.name
    )
    assert(ready?.status === "ready", "successful committed work should be ready")
    const diff = await diffWorkflowWorktree({ workspacePath: repo, record: ready!, appDataRoot })
    assert(diff.summary.includes("feature work"), `diff should list commits, got ${diff.summary}`)

    const merged = await mergeRecordedWorktree(repo, info, appDataRoot)
    assert(merged.status === "merged", "guarded integration should mark the record merged")
    assert(
      git(repo, ["show", "-s", "--format=%an%x00%ae", "HEAD"]) ===
        "Repo Owner\u0000owner@example.com",
      "integration commits must use the repository's resolved Git identity"
    )
    assert(
      existsSync(join(repo, "..feature.txt")),
      "merged output should land in the source checkout"
    )
    assert(!existsSync(info.directory), "successful merge should clean up its worktree")
    assert(
      !existsSync(hookMarker),
      "host integration must never execute deliverable-controlled hooks"
    )
    assert(
      git(repo, ["merge-base", "--is-ancestor", ready!.headCommit!, "HEAD"]) === "",
      "deliverable commit must be an ancestor of source HEAD"
    )
    const mergeTombstones = await listWorkflowWorktreeRecords(info.commonDir, appDataRoot)
    assert(
      mergeTombstones.find((record) => record.id === info.name)?.status === "merged",
      "merged ownership must remain durable until run history is flushed"
    )
    await finalizeWorkflowWorktreeRecord(merged, appDataRoot)
    assert(
      !(await listWorkflowWorktreeRecords(info.commonDir, appDataRoot)).some(
        (record) => record.id === info.name
      ),
      "a caller may remove the merged tombstone only after its run state is durable"
    )

    const discardLedger = new WorkflowWorktreeLedger({
      workspacePath: repo,
      runId: "wf_discard",
      appDataRoot
    })
    const disposable = await discardLedger.acquire("discard")
    writeFileSync(join(disposable.directory, "partial.txt"), "partial\n")
    await discardLedger.settle(disposable, { succeeded: false })
    const recoverable = (await listWorkflowWorktreeRecords(disposable.commonDir, appDataRoot)).find(
      (record) => record.id === disposable.name
    )
    assert(recoverable?.status === "recoverable", "failed partial output should be recoverable")
    const discarded = await discardWorkflowWorktree({
      workspacePath: repo,
      record: recoverable!,
      appDataRoot
    })
    assert(discarded.record.status === "discarded", "explicit discard should be recorded")
    assert(!existsSync(disposable.directory), "explicit discard should remove the checkout")
    assert(
      (await listWorkflowWorktreeRecords(disposable.commonDir, appDataRoot)).some(
        (record) => record.id === disposable.name && record.status === "discarded"
      ),
      "discard authorization must survive until run history records it"
    )
    assert(
      await finalizeWorkflowWorktreeRecord(discarded.record, appDataRoot),
      "discard tombstone should finalize after durable run persistence"
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testCancellationAfterSourceAdvanceStillFinishesMerge(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  const wrapperRoot = makeAppDataRoot()
  try {
    const ledger = new WorkflowWorktreeLedger({
      workspacePath: repo,
      runId: "wf_cancel_after_advance",
      appDataRoot
    })
    const info = await ledger.acquire("cancel-after-advance")
    writeFileSync(join(info.directory, "delivered.txt"), "delivered\n")
    git(info.directory, ["add", "delivered.txt"])
    git(info.directory, ["commit", "-m", "deliver before cancellation"])
    await ledger.settle(info, { succeeded: true })
    const ready = (await listWorkflowWorktreeRecords(info.commonDir, appDataRoot)).find(
      (record) => record.id === info.name
    )
    assert(ready?.status === "ready", "committed deliverable should be ready before merge")

    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim()
    const wrapper = join(wrapperRoot, "git")
    const signalMarker = join(wrapperRoot, "cancelled-after-update-ref")
    writeFileSync(
      wrapper,
      `#!/bin/sh
is_update_ref=0
for arg in "$@"; do
  if [ "$arg" = "update-ref" ]; then is_update_ref=1; fi
done
"$CMB_REAL_GIT" "$@"
code=$?
if [ "$code" -eq 0 ] && [ "$is_update_ref" -eq 1 ] && [ ! -e "$CMB_SIGNAL_MARKER" ]; then
  : > "$CMB_SIGNAL_MARKER"
  kill -USR2 "$PPID"
fi
exit "$code"
`
    )
    chmodSync(wrapper, 0o755)

    const moduleUrl = pathToFileURL(
      join(process.cwd(), "src", "main", "services", "git-worktree.ts")
    ).href
    const probe = `
      const { mergeWorkflowWorktree } = await import(${JSON.stringify(moduleUrl)});
      const controller = new AbortController();
      process.once("SIGUSR2", () => controller.abort());
      try {
        const outcome = await mergeWorkflowWorktree({
          workspacePath: ${JSON.stringify(repo)},
          record: ${JSON.stringify(ready)},
          appDataRoot: ${JSON.stringify(appDataRoot)},
          signal: controller.signal
        });
        console.log(JSON.stringify({
          ok: true,
          status: outcome.record.status,
          aborted: controller.signal.aborted
        }));
      } catch (error) {
        console.log(JSON.stringify({
          ok: false,
          aborted: controller.signal.aborted,
          error: error instanceof Error ? error.message : String(error)
        }));
      }
    `
    const output = execFileSync(
      process.execPath,
      [...process.execArgv, "--input-type=module", "-e", probe],
      {
        encoding: "utf8",
        timeout: 15_000,
        env: {
          ...process.env,
          PATH: `${wrapperRoot}:${process.env.PATH ?? ""}`,
          CMB_REAL_GIT: realGit,
          CMB_SIGNAL_MARKER: signalMarker
        }
      }
    ).trim()
    const result = JSON.parse(output) as {
      ok: boolean
      status?: string
      aborted: boolean
      error?: string
    }
    assert(result.aborted, `test must cancel immediately after update-ref, got ${output}`)
    assert(result.ok, `post-CAS cancellation must not fail the completed merge: ${output}`)
    assert(result.status === "merged", `post-CAS cancellation must finish as merged: ${output}`)
    assert(
      readFileSync(join(repo, "delivered.txt"), "utf8") === "delivered\n",
      "the source checkout must contain the integrated deliverable"
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
    rmSync(wrapperRoot, { recursive: true, force: true })
  }
}

async function testConcurrentActionsStayMonotonic(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    const makeReady = async (runId: string, file: string) => {
      const ledger = new WorkflowWorktreeLedger({ workspacePath: repo, runId, appDataRoot })
      const info = await ledger.acquire(file)
      writeFileSync(join(info.directory, file), `${file}\n`)
      git(info.directory, ["add", "-A"])
      git(info.directory, ["commit", "-m", file])
      await ledger.settle(info, { succeeded: true })
      const record = (await listWorkflowWorktreeRecords(info.commonDir, appDataRoot)).find(
        (candidate) => candidate.id === info.name
      )!
      return { info, record }
    }

    const double = await makeReady("wf_double_merge", "double.txt")
    const doubleResults = await Promise.allSettled([
      mergeRecordedWorktree(repo, double.info, appDataRoot),
      mergeRecordedWorktree(repo, double.info, appDataRoot)
    ])
    assert(
      doubleResults.filter((result) => result.status === "fulfilled").length === 1,
      "exactly one concurrent merge may win"
    )
    const doubleManifest = (
      await listWorkflowWorktreeRecords(double.info.commonDir, appDataRoot)
    ).find((record) => record.id === double.info.name)
    assert(
      doubleManifest?.status === "merged",
      "stale double merge must not regress terminal state"
    )

    const diffRace = await makeReady("wf_diff_merge", "diff-race.txt")
    const diffResults = await Promise.allSettled([
      diffWorkflowWorktree({ workspacePath: repo, record: diffRace.record, appDataRoot }),
      mergeRecordedWorktree(repo, diffRace.info, appDataRoot)
    ])
    assert(
      diffResults.some((result) => result.status === "fulfilled"),
      "diff/merge race should complete at least the terminal action"
    )
    const diffManifest = (
      await listWorkflowWorktreeRecords(diffRace.info.commonDir, appDataRoot)
    ).find((record) => record.id === diffRace.info.name)
    assert(diffManifest?.status === "merged", "stale diff must not overwrite merged state")

    const choiceRace = await makeReady("wf_merge_discard", "choice-race.txt")
    const choiceResults = await Promise.allSettled([
      mergeRecordedWorktree(repo, choiceRace.info, appDataRoot),
      discardWorkflowWorktree({ workspacePath: repo, record: choiceRace.record, appDataRoot })
    ])
    assert(
      choiceResults.filter((result) => result.status === "fulfilled").length === 1,
      "merge and discard must be mutually exclusive"
    )
    const choiceManifest = (
      await listWorkflowWorktreeRecords(choiceRace.info.commonDir, appDataRoot)
    ).find((record) => record.id === choiceRace.info.name)
    assert(
      choiceManifest?.status === "merged" || choiceManifest?.status === "discarded",
      "the winning user action must leave a terminal manifest"
    )
    assert(
      existsSync(join(repo, "choice-race.txt")) === (choiceManifest?.status === "merged"),
      "source content must agree with the serialized winning action"
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testAtomicIntegrationCrashWindowIsRecoverable(): Promise<void> {
  const runCase = async (mode: "clean" | "dirty" | "switched") => {
    const repo = makeRepo()
    const appDataRoot = makeAppDataRoot()
    try {
      const ledger = new WorkflowWorktreeLedger({
        workspacePath: repo,
        runId: `wf_atomic_crash_${mode}`,
        appDataRoot
      })
      const info = await ledger.acquire(mode)
      const deliveredPath = join(info.directory, `delivered-${mode}.txt`)
      writeFileSync(deliveredPath, "delivered\n")
      git(info.directory, ["add", "-A"])
      git(info.directory, ["commit", "-m", `deliver ${mode}`])
      await ledger.settle(info, { succeeded: true })
      const ready = (await listWorkflowWorktreeRecords(info.commonDir, appDataRoot)).find(
        (record) => record.id === info.name
      )!
      const sourceHead = git(repo, ["rev-parse", "HEAD"])
      const deliverableHead = git(info.directory, ["rev-parse", "HEAD"])
      const mergeTree = git(repo, [
        "merge-tree",
        "--write-tree",
        sourceHead,
        deliverableHead
      ]).split(/\s+/)[0]
      const mergeCommit = git(repo, [
        "commit-tree",
        mergeTree,
        "-p",
        sourceHead,
        "-p",
        deliverableHead,
        "-m",
        `atomic crash ${mode}`
      ])
      git(repo, ["update-ref", `refs/heads/${ready.sourceBranch}`, mergeCommit, sourceHead])
      await persistWorkflowWorktreeRecord(
        {
          ...ready,
          status: "integrating",
          headCommit: deliverableHead,
          integrationParent: sourceHead,
          integrationCommit: mergeCommit
        },
        appDataRoot
      )

      if (mode === "dirty") {
        writeFileSync(join(repo, "user-local.txt"), "must survive\n")
      } else if (mode === "switched") {
        git(repo, ["switch", "-c", "user-after-workflow-cas"])
      }

      let outcome: WorkflowWorktreeRecord | undefined
      let rejected: unknown
      try {
        outcome = await mergeRecordedWorktree(repo, info, appDataRoot)
      } catch (error) {
        rejected = error
      }
      if (mode === "clean" || mode === "dirty") {
        assert(outcome?.status === "merged", `${mode} CAS crash retry should repair and complete`)
        assert(
          existsSync(join(repo, `delivered-${mode}.txt`)),
          "crash repair must refresh the source checkout"
        )
        assert(!existsSync(info.directory), "completed crash repair may clean the deliverable")
        if (mode === "dirty") {
          assert(
            readFileSync(join(repo, "user-local.txt"), "utf8") === "must survive\n",
            "safe two-tree refresh must preserve unrelated local work"
          )
        }
      } else {
        assert(!rejected, `an already-integrated switched source should close: ${String(rejected)}`)
        assert(outcome?.status === "merged", "an already-integrated worktree should close")
        assert(!existsSync(info.directory), "completed integration may clean the deliverable")
        assert(
          git(repo, ["branch", "--show-current"]) === "user-after-workflow-cas",
          "closing an integrated worktree must not switch or reset the user's new branch"
        )
      }
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(appDataRoot, { recursive: true, force: true })
    }
  }

  await runCase("clean")
  await runCase("dirty")
  await runCase("switched")
}

async function testMergedTerminalStateSurvivesCleanupPersistenceFailure(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  let recordsRoot = ""
  let backupRoot = ""
  try {
    const ledger = new WorkflowWorktreeLedger({
      workspacePath: repo,
      runId: "wf_terminal_persist",
      appDataRoot
    })
    const info = await ledger.acquire("terminal-persist")
    writeFileSync(join(info.directory, "terminal.txt"), "merged\n")
    git(info.directory, ["add", "-A"])
    git(info.directory, ["commit", "-m", "terminal persistence"])
    await ledger.settle(info, { succeeded: true })
    const ready = (await listWorkflowWorktreeRecords(info.commonDir, appDataRoot)).find(
      (record) => record.id === info.name
    )!

    // Keep removal in the helper's failure path, then make only the SECOND
    // terminal-manifest write fail after the durable merged decision appears.
    git(repo, ["worktree", "lock", info.directory])
    recordsRoot = join(dirname(info.directory), ".records")
    backupRoot = `${recordsRoot}.terminal-test`
    const recordFile = readdirSync(recordsRoot).find((file) => file.endsWith(".json"))!
    let sabotageDone!: () => void
    const sabotaged = new Promise<void>((resolve) => {
      sabotageDone = resolve
    })
    const watcher = watch(recordsRoot, () => {
      try {
        const current = JSON.parse(readFileSync(join(recordsRoot, recordFile), "utf8")) as {
          status?: string
        }
        if (current.status !== "merged") return
        watcher.close()
        renameSync(recordsRoot, backupRoot)
        writeFileSync(recordsRoot, "block later manifest writes")
        sabotageDone()
      } catch {
        // The atomic writer emits temp-file events before the final rename.
      }
    })

    const outcome = await mergeWorkflowWorktree({ workspacePath: repo, record: ready, appDataRoot })
    await Promise.race([
      sabotaged,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("terminal persistence sabotage did not run")), 2_000)
      )
    ])
    watcher.close()
    assert(outcome.record.status === "merged", "cleanup failure must not reopen a merged record")
    assert(outcome.record.cleanupPending === true, "failed cleanup persistence remains retryable")

    rmSync(recordsRoot, { force: true })
    renameSync(backupRoot, recordsRoot)
    const durable = (await listWorkflowWorktreeRecords(info.commonDir, appDataRoot)).find(
      (record) => record.id === info.name
    )
    assert(durable?.status === "merged", "durable terminal state must never regress")
  } finally {
    if (backupRoot && existsSync(backupRoot)) {
      rmSync(recordsRoot, { recursive: true, force: true })
      renameSync(backupRoot, recordsRoot)
    }
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testIgnoredSourceCollisionNeverGetsOverwritten(): Promise<void> {
  const runCase = async (recovering: boolean) => {
    const repo = makeRepo()
    const appDataRoot = makeAppDataRoot()
    try {
      writeFileSync(join(repo, ".gitignore"), ".env\n")
      git(repo, ["add", ".gitignore"])
      git(repo, ["commit", "-m", "ignore local env"])
      const ledger = new WorkflowWorktreeLedger({
        workspacePath: repo,
        runId: recovering ? "wf_ignored_recovery" : "wf_ignored_fresh",
        appDataRoot
      })
      const info = await ledger.acquire("ignored collision")
      writeFileSync(join(info.directory, ".env"), "AGENT-VALUE\n")
      git(info.directory, ["add", "-f", ".env"])
      git(info.directory, ["commit", "-m", "deliver env"])
      await ledger.settle(info, { succeeded: true })
      const ready = (await listWorkflowWorktreeRecords(info.commonDir, appDataRoot)).find(
        (record) => record.id === info.name
      )!
      const sourceHead = git(repo, ["rev-parse", "HEAD"])
      const sourceIndex = git(repo, ["write-tree"])

      if (recovering) {
        const deliverableHead = git(info.directory, ["rev-parse", "HEAD"])
        const mergeTree = git(repo, [
          "merge-tree",
          "--write-tree",
          sourceHead,
          deliverableHead
        ]).split(/\s+/)[0]
        const mergeCommit = git(repo, [
          "commit-tree",
          mergeTree,
          "-p",
          sourceHead,
          "-p",
          deliverableHead,
          "-m",
          "interrupted ignored integration"
        ])
        await persistWorkflowWorktreeRecord(
          {
            ...ready,
            status: "integrating",
            headCommit: deliverableHead,
            integrationParent: sourceHead,
            integrationCommit: mergeCommit
          },
          appDataRoot
        )
        git(repo, ["update-ref", `refs/heads/${ready.sourceBranch}`, mergeCommit, sourceHead])
      }

      writeFileSync(join(repo, ".env"), "USER-SECRET\n")
      let rejected: unknown
      try {
        await mergeRecordedWorktree(repo, info, appDataRoot)
      } catch (error) {
        rejected = error
      }
      assert(
        rejected instanceof Error && /ignored|untracked/.test(rejected.message),
        `ignored collision must fail closed: ${String(rejected)}`
      )
      assert(readFileSync(join(repo, ".env"), "utf8") === "USER-SECRET\n", "source secret changed")
      assert(git(repo, ["rev-parse", "HEAD"]) === sourceHead, "source ref must remain unchanged")
      assert(git(repo, ["write-tree"]) === sourceIndex, "source index must remain unchanged")
      assert(existsSync(info.directory), "collision must retain the deliverable")
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(appDataRoot, { recursive: true, force: true })
    }
  }
  await runCase(false)
  await runCase(true)
}

async function testTrackedFileToDirectoryIntegrationIsSupported(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    writeFileSync(join(repo, "node"), "tracked file\n")
    git(repo, ["add", "node"])
    git(repo, ["commit", "-m", "tracked file parent"])
    const ledger = new WorkflowWorktreeLedger({
      workspacePath: repo,
      runId: "wf_type_change",
      appDataRoot
    })
    const info = await ledger.acquire("type change")
    rmSync(join(info.directory, "node"))
    mkdirSync(join(info.directory, "node"))
    writeFileSync(join(info.directory, "node", "child.txt"), "child\n")
    git(info.directory, ["add", "-A"])
    git(info.directory, ["commit", "-m", "replace file with directory"])
    await ledger.settle(info, { succeeded: true })
    const merged = await mergeRecordedWorktree(repo, info, appDataRoot)
    assert(merged.status === "merged", "clean tracked file-to-directory change should merge")
    assert(
      readFileSync(join(repo, "node", "child.txt"), "utf8") === "child\n",
      "tracked type change did not refresh the source checkout"
    )

    const reverseLedger = new WorkflowWorktreeLedger({
      workspacePath: repo,
      runId: "wf_reverse_type_change",
      appDataRoot
    })
    const reverse = await reverseLedger.acquire("reverse type change")
    rmSync(join(reverse.directory, "node"), { recursive: true })
    writeFileSync(join(reverse.directory, "node"), "tracked file again\n")
    git(reverse.directory, ["add", "-A"])
    git(reverse.directory, ["commit", "-m", "replace directory with file"])
    await reverseLedger.settle(reverse, { succeeded: true })
    const reverseMerged = await mergeRecordedWorktree(repo, reverse, appDataRoot)
    assert(reverseMerged.status === "merged", "clean tracked directory-to-file change should merge")
    assert(
      readFileSync(join(repo, "node"), "utf8") === "tracked file again\n",
      "reverse tracked type change did not refresh the source checkout"
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testSourceOnlyFilteredSiblingDoesNotBlockScopedMerge(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    mkdirSync(join(repo, "packages", "assigned"), { recursive: true })
    writeFileSync(join(repo, "packages", "assigned", "index.ts"), "base\n")
    writeFileSync(join(repo, "outside.txt"), "outside base\n")
    writeFileSync(join(repo, ".gitattributes"), "outside.txt filter=review\n")
    git(repo, [
      "config",
      "filter.review.smudge",
      `sh -c 'touch ${join(appDataRoot, "filter-ran")}; cat'`
    ])
    git(repo, ["add", ".gitattributes", "outside.txt", "packages/assigned/index.ts"])
    git(repo, ["commit", "-m", "scoped filter fixture"])

    const ledger = new WorkflowWorktreeLedger({
      workspacePath: join(repo, "packages", "assigned"),
      runId: "wf_filtered_sibling",
      appDataRoot
    })
    const info = await ledger.acquire("scoped edit")

    // `git worktree add` checks out the trusted source tree and may run its
    // configured smudge filter. This test is specifically about guarded merge:
    // clear that provisioning marker before the source-only sibling commit.
    rmSync(join(appDataRoot, "filter-ran"), { force: true })

    writeFileSync(join(repo, "outside.txt"), "source-only change\n")
    git(repo, ["add", "outside.txt"])
    git(repo, ["commit", "-m", "source-only filtered sibling"])

    writeFileSync(join(info.workspaceDirectory, "index.ts"), "deliverable\n")
    git(info.directory, ["add", "packages/assigned/index.ts"])
    git(info.directory, ["commit", "-m", "assigned deliverable"])
    await ledger.settle(info, { succeeded: true })
    const merged = await mergeRecordedWorktree(
      join(repo, "packages", "assigned"),
      info,
      appDataRoot
    )
    assert(merged.status === "merged", "an unrelated filtered sibling must not block scoped merge")
    assert(
      readFileSync(join(repo, "packages", "assigned", "index.ts"), "utf8") === "deliverable\n",
      "the scoped deliverable should integrate normally"
    )
    assert(!existsSync(join(appDataRoot, "filter-ran")), "source-only sibling filter must not run")
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testGitLfsAttributeRemainsUsable(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    writeFileSync(join(repo, ".gitattributes"), "data.bin filter=lfs -text\n")
    writeFileSync(join(repo, "data.bin"), "base\n")
    // Use a deterministic local stand-in so this regression does not depend on
    // git-lfs being installed on the test machine. The integration contract is
    // that repositories using the conventional attribute keep normal Git
    // semantics without requiring git-lfs on the test machine.
    git(repo, ["config", "filter.lfs.clean", "cat"])
    git(repo, ["config", "filter.lfs.smudge", "cat"])
    git(repo, ["config", "filter.lfs.process", ""])
    git(repo, ["config", "filter.lfs.required", "false"])
    git(repo, ["add", ".gitattributes", "data.bin"])
    git(repo, ["commit", "-m", "lfs base"])
    const ledger = new WorkflowWorktreeLedger({
      workspacePath: repo,
      runId: "wf_lfs_attribute",
      appDataRoot
    })
    const info = await ledger.acquire("lfs attribute")
    writeFileSync(join(info.directory, "data.bin"), "deliverable\n")
    git(info.directory, ["add", "data.bin"])
    git(info.directory, ["commit", "-m", "lfs deliverable"])
    await ledger.settle(info, { succeeded: true })
    const merged = await mergeRecordedWorktree(repo, info, appDataRoot)
    assert(merged.status === "merged", "standard Git LFS deliverable should merge")
    assert(
      readFileSync(join(repo, "data.bin"), "utf8") === "deliverable\n",
      "Git LFS-backed source checkout should refresh to the merged content"
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testGitLfsCheckoutMatchesSourceWhenAvailable(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    // Keep the suite runnable on machines without git-lfs. This test exercises
    // the real smudge filter when it is installed, rather than a stand-in
    // filter which cannot detect GIT_LFS_SKIP_SMUDGE.
    try {
      git(repo, ["lfs", "version"])
    } catch {
      return
    }

    git(repo, ["lfs", "install", "--local"])
    git(repo, ["lfs", "track", "*.bin"])
    writeFileSync(join(repo, "model.bin"), "REAL_LFS_CONTENT\n")
    git(repo, ["add", ".gitattributes", "model.bin"])
    git(repo, ["commit", "-m", "lfs source content"])

    const info = await createWorkflowWorktree({
      workspacePath: repo,
      runId: "wf_real_lfs",
      appDataRoot
    })
    assert(
      readFileSync(join(info.directory, "model.bin"), "utf8") === "REAL_LFS_CONTENT\n",
      "isolated worktree must materialize the same LFS content as the source checkout"
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testSingleSidedMergeAttributeDoesNotBlock(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    writeFileSync(join(repo, "data.txt"), "base\n")
    git(repo, ["add", "data.txt"])
    git(repo, ["commit", "-m", "single-sided driver base"])
    const ledger = new WorkflowWorktreeLedger({
      workspacePath: repo,
      runId: "wf_single_sided_driver",
      appDataRoot
    })
    const info = await ledger.acquire("single-sided driver")
    const marker = join(appDataRoot, "single-sided-driver-ran")
    git(repo, ["config", "merge.review.driver", `sh -c 'touch ${marker}; cat %A'`])
    writeFileSync(join(repo, ".gitattributes"), "data.txt merge=review\n")
    git(repo, ["add", ".gitattributes"])
    git(repo, ["commit", "-m", "source attribute only"])
    writeFileSync(join(info.directory, "data.txt"), "deliverable\n")
    git(info.directory, ["add", "data.txt"])
    git(info.directory, ["commit", "-m", "single-sided deliverable"])
    await ledger.settle(info, { succeeded: true })
    const merged = await mergeRecordedWorktree(repo, info, appDataRoot)
    assert(merged.status === "merged", "a single-sided edit must not be rejected by driver guard")
    assert(!existsSync(marker), "Git must not execute a merge driver for a trivial one-sided edit")
    assert(readFileSync(join(repo, "data.txt"), "utf8") === "deliverable\n", "edit merged")
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testIntegrationTransactionOwnershipAndDescendants(): Promise<void> {
  const runCase = async (
    mode:
      | "manual"
      | "manual-missing"
      | "manual-missing-symlink"
      | "unrelated-descendant"
      | "reverting-descendant"
  ) => {
    const repo = makeRepo()
    const appDataDirectory = makeAppDataRoot()
    const appDataAlias =
      mode === "manual-missing-symlink"
        ? join(tmpdir(), `cmb-wt-data-alias-${Date.now()}-${Math.random().toString(16).slice(2)}`)
        : undefined
    if (appDataAlias) symlinkSync(appDataDirectory, appDataAlias, "dir")
    const appDataRoot = appDataAlias ?? appDataDirectory
    try {
      const ledger = new WorkflowWorktreeLedger({
        workspacePath: repo,
        runId: `wf_transaction_${mode}`,
        appDataRoot
      })
      const info = await ledger.acquire(mode)
      writeFileSync(join(info.directory, "delivered.txt"), "delivered\n")
      git(info.directory, ["add", "delivered.txt"])
      git(info.directory, ["commit", "-m", "deliver content"])
      await ledger.settle(info, { succeeded: true })
      const ready = (await listWorkflowWorktreeRecords(info.commonDir, appDataRoot)).find(
        (record) => record.id === info.name
      )!
      const sourceHead = git(repo, ["rev-parse", "HEAD"])
      const deliverableHead = git(info.directory, ["rev-parse", "HEAD"])

      if (mode === "manual" || mode === "manual-missing" || mode === "manual-missing-symlink") {
        await persistWorkflowWorktreeRecord(
          { ...ready, status: "integrating", headCommit: deliverableHead },
          appDataRoot
        )
        git(repo, ["merge", "--no-ff", deliverableHead, "-m", "user manual merge"])
        const manualHead = git(repo, ["rev-parse", "HEAD"])
        if (mode !== "manual") {
          // Git/user cleanup may happen before Cmb sees the manual merge.  The
          // remaining ownership record must still be closable from ancestry.
          git(repo, ["worktree", "remove", "--force", info.directory])
          assert(!existsSync(info.directory), "manual cleanup fixture must remove the checkout")
        }
        writeFileSync(join(repo, "local-after-merge.txt"), "user work\n")
        const merged = await mergeRecordedWorktree(repo, info, appDataRoot)
        assert(merged.status === "merged", "manual merge ancestry should close the deliverable")
        assert(git(repo, ["rev-parse", "HEAD"]) === manualHead, "app rolled back a user merge")
        assert(!existsSync(info.directory), "manual merge cleanup should remove the worktree")
        assert(
          readFileSync(join(repo, "local-after-merge.txt"), "utf8") === "user work\n",
          "manual merge closure must not touch later source work"
        )
        return
      }

      const mergeTree = git(repo, [
        "merge-tree",
        "--write-tree",
        sourceHead,
        deliverableHead
      ]).split(/\s+/)[0]
      const mergeCommit = git(repo, [
        "commit-tree",
        mergeTree,
        "-p",
        sourceHead,
        "-p",
        deliverableHead,
        "-m",
        "owned integration"
      ])
      await persistWorkflowWorktreeRecord(
        {
          ...ready,
          status: "integrating",
          headCommit: deliverableHead,
          integrationParent: sourceHead,
          integrationCommit: mergeCommit
        },
        appDataRoot
      )
      git(repo, ["update-ref", `refs/heads/${ready.sourceBranch}`, mergeCommit, sourceHead])
      if (mode === "unrelated-descendant") {
        git(repo, ["reset", "--hard", mergeCommit])
      }
      writeFileSync(join(repo, "later.txt"), "later\n")
      git(repo, ["add", "later.txt"])
      git(repo, ["commit", "-m", "later user commit"])

      const merged = await mergeRecordedWorktree(repo, info, appDataRoot)
      assert(merged.status === "merged", "an integrated descendant should close by ancestry")
      assert(!existsSync(info.directory), "integrated descendant cleanup should remove worktree")
      if (mode === "unrelated-descendant") {
        assert(existsSync(join(repo, "delivered.txt")), "delivered content disappeared")
      } else {
        assert(
          !existsSync(join(repo, "delivered.txt")),
          "later user history is allowed to change previously delivered paths"
        )
      }
    } finally {
      rmSync(repo, { recursive: true, force: true })
      if (appDataAlias) unlinkSync(appDataAlias)
      rmSync(appDataDirectory, { recursive: true, force: true })
    }
  }
  await runCase("manual")
  await runCase("manual-missing")
  if (process.platform !== "win32") await runCase("manual-missing-symlink")
  await runCase("unrelated-descendant")
  await runCase("reverting-descendant")
}

async function testTrackedRuntimeChangesBlockMerge(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    mkdirSync(join(repo, ".cmbdevclaw"), { recursive: true })
    const runtimeFile = join(repo, ".cmbdevclaw", "tracked.txt")
    writeFileSync(runtimeFile, "base\n")
    git(repo, ["add", "-f", ".cmbdevclaw/tracked.txt"])
    git(repo, ["commit", "-m", "tracked runtime base"])

    const ledger = new WorkflowWorktreeLedger({
      workspacePath: repo,
      runId: "wf_tracked_runtime",
      appDataRoot
    })
    const info = await ledger.acquire("runtime")
    writeFileSync(join(info.directory, "deliverable.txt"), "deliverable\n")
    git(info.directory, ["add", "-A"])
    git(info.directory, ["commit", "-m", "deliverable"])
    await ledger.settle(info, { succeeded: true })

    writeFileSync(runtimeFile, "user staged edit\n")
    git(repo, ["add", "-f", ".cmbdevclaw/tracked.txt"])
    let rejected: unknown
    try {
      await mergeRecordedWorktree(repo, info, appDataRoot)
    } catch (error) {
      rejected = error
    }
    assert(
      rejected instanceof Error && rejected.message.includes("source workspace must be clean"),
      `tracked runtime changes must block merge: ${String(rejected)}`
    )
    assert(readFileSync(runtimeFile, "utf8") === "user staged edit\n", "runtime edit must survive")
    assert(
      git(repo, ["diff", "--cached", "--name-only"]).includes(".cmbdevclaw/tracked.txt"),
      "tracked runtime edit must remain staged"
    )
    assert(existsSync(info.directory), "blocked integration must retain its deliverable")
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testScopedDeliverableCannotMergeOutsideWorkspace(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    mkdirSync(join(repo, "packages", "assigned"), { recursive: true })
    writeFileSync(join(repo, "packages", "assigned", "inside.txt"), "inside\n")
    writeFileSync(join(repo, "outside.txt"), "outside\n")
    git(repo, ["add", "-A"])
    git(repo, ["commit", "-m", "monorepo base"])
    const ledger = new WorkflowWorktreeLedger({
      workspacePath: join(repo, "packages", "assigned"),
      runId: "wf_scoped_paths",
      appDataRoot
    })
    const info = await ledger.acquire("scoped")
    writeFileSync(join(info.directory, "outside.txt"), "escaped\n")
    git(info.directory, ["add", "-A"])
    git(info.directory, ["commit", "-m", "out of scope"])
    await ledger.settle(info, { succeeded: true })
    const retained = (await listWorkflowWorktreeRecords(info.commonDir, appDataRoot)).find(
      (record) => record.id === info.name
    )
    assert(
      retained?.status === "recoverable" &&
        retained.error?.includes("outside the assigned workspace"),
      "an out-of-scope native commit should be retained with an actionable completion error"
    )
    let rejected: unknown
    try {
      await mergeRecordedWorktree(repo, info, appDataRoot)
    } catch (error) {
      rejected = error
    }
    assert(
      rejected instanceof Error && rejected.message.includes("outside the assigned workspace"),
      `out-of-scope commit must be rejected, got ${String(rejected)}`
    )
    assert(
      readFileSync(join(repo, "outside.txt"), "utf8") === "outside\n",
      "source file outside the scoped workspace must remain unchanged"
    )
    if (process.platform !== "win32") {
      const slashLedger = new WorkflowWorktreeLedger({
        workspacePath: join(repo, "packages", "assigned"),
        runId: "wf_scoped_backslash",
        appDataRoot
      })
      const slashInfo = await slashLedger.acquire("backslash")
      const deceptiveRoot = join(slashInfo.directory, "packages\\assigned")
      mkdirSync(deceptiveRoot, { recursive: true })
      writeFileSync(join(deceptiveRoot, "escape.txt"), "escaped\n")
      git(slashInfo.directory, ["add", "-A"])
      git(slashInfo.directory, ["commit", "-m", "posix backslash escape"])
      await slashLedger.settle(slashInfo, { succeeded: true })
      let slashRejected: unknown
      try {
        await mergeRecordedWorktree(join(repo, "packages", "assigned"), slashInfo, appDataRoot)
      } catch (error) {
        slashRejected = error
      }
      assert(
        slashRejected instanceof Error &&
          slashRejected.message.includes("outside the assigned workspace"),
        `a POSIX backslash filename must not impersonate the assigned scope: ${String(slashRejected)}`
      )
    }

    const renameLedger = new WorkflowWorktreeLedger({
      workspacePath: join(repo, "packages", "assigned"),
      runId: "wf_scoped_source_rename",
      appDataRoot
    })
    const renameInfo = await renameLedger.acquire("source rename")
    mkdirSync(join(repo, "outside-renamed"), { recursive: true })
    git(repo, ["mv", "packages/assigned/inside.txt", "outside-renamed/inside.txt"])
    git(repo, ["commit", "-m", "move assigned file outside scope"])
    writeFileSync(join(renameInfo.workspaceDirectory, "inside.txt"), "agent scoped edit\n")
    git(renameInfo.directory, ["add", "packages/assigned/inside.txt"])
    git(renameInfo.directory, ["commit", "-m", "edit before source rename"])
    await renameLedger.settle(renameInfo, { succeeded: true })
    let renameRejected: unknown
    try {
      await mergeRecordedWorktree(join(repo, "packages", "assigned"), renameInfo, appDataRoot)
    } catch (error) {
      renameRejected = error
    }
    assert(
      renameRejected instanceof Error &&
        renameRejected.message.includes("outside the assigned workspace"),
      `merge result must not carry scoped edits through a source rename: ${String(renameRejected)}`
    )
    assert(
      readFileSync(join(repo, "outside-renamed", "inside.txt"), "utf8") === "inside\n",
      "scoped deliverable changed a source path outside its assignment"
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testReservedRuntimeAndGitlinkChangesFailClosed(): Promise<void> {
  const runCase = async (mode: "reserved" | "gitlink") => {
    const repo = makeRepo()
    const appDataRoot = makeAppDataRoot()
    try {
      const ledger = new WorkflowWorktreeLedger({
        workspacePath: repo,
        runId: `wf_unsupported_${mode}`,
        appDataRoot
      })
      const info = await ledger.acquire(mode)
      if (mode === "reserved") {
        mkdirSync(join(info.directory, ".CMBDEVCLAW"), { recursive: true })
        writeFileSync(join(info.directory, ".CMBDEVCLAW", "payload.txt"), "reserved\n")
        git(info.directory, ["add", "-f", ".CMBDEVCLAW/payload.txt"])
      } else {
        const commit = git(info.directory, ["rev-parse", "HEAD"])
        git(info.directory, ["update-index", "--add", "--cacheinfo", `160000,${commit},nested`])
        git(info.directory, ["clone", "--no-checkout", repo, "nested"])
        git(join(info.directory, "nested"), ["checkout", "--detach", commit])
      }
      git(info.directory, ["commit", "-m", mode])
      await ledger.settle(info, { succeeded: true })
      let rejected: unknown
      try {
        await mergeRecordedWorktree(repo, info, appDataRoot)
      } catch (error) {
        rejected = error
      }
      assert(
        rejected instanceof Error &&
          (mode === "reserved"
            ? rejected.message.includes("reserved workflow runtime path")
            : rejected.message.includes("submodule gitlink")),
        `${mode} change must fail closed: ${String(rejected)}`
      )
      assert(existsSync(info.directory), `${mode} rejection must retain the deliverable`)
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(appDataRoot, { recursive: true, force: true })
    }
  }
  await runCase("reserved")
  await runCase("gitlink")
}

async function testSourceGitOperationIsNeverAborted(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    const ledger = new WorkflowWorktreeLedger({
      workspacePath: repo,
      runId: "wf_user_merge",
      appDataRoot
    })
    const info = await ledger.acquire("operation")
    writeFileSync(join(info.directory, "operation.txt"), "work\n")
    git(info.directory, ["add", "-A"])
    git(info.directory, ["commit", "-m", "operation work"])
    await ledger.settle(info, { succeeded: true })
    const mergeHeadPath = join(repo, ".git", "MERGE_HEAD")
    writeFileSync(mergeHeadPath, `${git(repo, ["rev-parse", "HEAD"])}\n`)
    let rejected: unknown
    try {
      await mergeRecordedWorktree(repo, info, appDataRoot)
    } catch (error) {
      rejected = error
    }
    assert(
      rejected instanceof Error && rejected.message.includes("in-progress Git operation"),
      "source operation must block workflow integration"
    )
    assert(existsSync(mergeHeadPath), "workflow failure must not abort the user's Git operation")
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testDamagedWorktreeDiscardIsRecoverableAndNoFollow(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    const registered = await createWorkflowWorktree({
      workspacePath: repo,
      runId: "wf_damaged_registered",
      label: "registered",
      appDataRoot
    })
    writeFileSync(join(registered.directory, "partial.txt"), "recoverable\n")
    const registeredRecord = recordFor(registered, "recoverable", "wf_damaged_registered")
    await persistWorkflowWorktreeRecord(registeredRecord, appDataRoot)
    rmSync(join(registered.directory, ".git"), { force: true })
    const registeredDiscard = await discardWorkflowWorktree({
      workspacePath: repo,
      record: registeredRecord,
      appDataRoot
    })
    assert(
      registeredDiscard.record.cleanupPending,
      "damaged checkout must remain pending when Git cannot validate safe removal"
    )
    assert(
      existsSync(registered.directory),
      "host must not recursively delete a registered but damaged checkout"
    )

    const unregistered = await createWorkflowWorktree({
      workspacePath: repo,
      runId: "wf_damaged_unregistered",
      label: "unregistered",
      appDataRoot
    })
    writeFileSync(join(unregistered.directory, "partial.txt"), "explicitly discarded\n")
    const unregisteredRecord = recordFor(unregistered, "recoverable", "wf_damaged_unregistered")
    await persistWorkflowWorktreeRecord(unregisteredRecord, appDataRoot)
    rmSync(join(unregistered.directory, ".git"), { force: true })
    git(repo, ["worktree", "prune", "--expire", "now"])
    if (process.platform !== "win32") {
      symlinkSync(repo, join(unregistered.directory, "must-not-follow"), "dir")
    }
    const unregisteredDiscard = await discardWorkflowWorktree({
      workspacePath: repo,
      record: unregisteredRecord,
      appDataRoot
    })
    assert(
      unregisteredDiscard.record.cleanupPending,
      "unregistered damaged checkout must require manual cleanup"
    )
    assert(
      existsSync(unregistered.directory),
      "host must not recursively delete an unregistered damaged checkout"
    )
    assert(
      unregisteredDiscard.record.error?.includes(
        `请手动删除目录“${unregistered.directory}”后，再点击“重试清理”。`
      ),
      "unregistered damaged checkout must tell the user which directory to remove before retrying cleanup"
    )
    assert(
      existsSync(join(repo, "README.md")),
      "safe discard must unlink an internal symlink instead of following it"
    )
    rmSync(unregistered.directory, { recursive: true, force: true })
    const manualCleanup = await cleanupWorkflowWorktree({
      workspacePath: repo,
      record: unregisteredDiscard.record,
      appDataRoot
    })
    assert(
      manualCleanup.record.cleanupPending === false,
      "after the user removes an unregistered damaged directory, retry cleanup must safely close its branch state"
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testDiscardCleanupNeverDeletesLateCommits(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    const finalizeInfo = await createWorkflowWorktree({
      workspacePath: repo,
      runId: "wf_discard_late_finalize",
      appDataRoot
    })
    const finalizeRecord = recordFor(finalizeInfo, "discarded", "wf_discard_late_finalize")
    git(repo, ["worktree", "remove", "--force", finalizeInfo.directory])
    const tree = git(repo, ["rev-parse", `${finalizeInfo.baseCommit}^{tree}`])
    const lateFinalizeHead = git(repo, [
      "commit-tree",
      tree,
      "-p",
      finalizeInfo.baseCommit,
      "-m",
      "late branch-only work"
    ])
    git(repo, ["update-ref", `refs/heads/${finalizeInfo.branch}`, lateFinalizeHead])
    await persistWorkflowWorktreeRecord(finalizeRecord, appDataRoot)
    assert(
      !(await finalizeWorkflowWorktreeRecord(finalizeRecord, appDataRoot)),
      "finalize must refuse a discarded branch whose tip advanced"
    )
    assert(
      git(repo, ["rev-parse", `refs/heads/${finalizeInfo.branch}`]) === lateFinalizeHead,
      "finalize deleted late branch-only work"
    )

    const cleanupInfo = await createWorkflowWorktree({
      workspacePath: repo,
      runId: "wf_cleanup_late",
      appDataRoot
    })
    const cleanupRecord = {
      ...recordFor(cleanupInfo, "discarded", "wf_cleanup_late"),
      cleanupPending: true
    }
    await persistWorkflowWorktreeRecord(cleanupRecord, appDataRoot)
    writeFileSync(join(cleanupInfo.directory, "late-cleanup.txt"), "late\n")
    git(cleanupInfo.directory, ["add", "late-cleanup.txt"])
    git(cleanupInfo.directory, ["commit", "-m", "late cleanup commit"])
    let cleanupRejected = false
    try {
      await cleanupWorkflowWorktree({ workspacePath: repo, record: cleanupRecord, appDataRoot })
    } catch {
      cleanupRejected = true
    }
    assert(cleanupRejected, "terminal cleanup must reject a branch advanced after authorization")
    assert(existsSync(cleanupInfo.directory), "late cleanup commit must retain its checkout")
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

function testWorktreePromptMatchesRuntimeBoundary(): void {
  assert(
    WORKFLOW_TOOL_DESCRIPTION.includes("independent Git working copy") &&
      WORKFLOW_TOOL_DESCRIPTION.includes("frozen source commit") &&
      WORKFLOW_TOOL_DESCRIPTION.includes("are not copied into it") &&
      WORKFLOW_TOOL_DESCRIPTION.includes("transform each (worktree isolation)"),
    "workflow prompt must describe when isolated worktrees are useful"
  )
  assert(
    WORKFLOW_TOOL_DESCRIPTION.includes("Isolation never changes the return value") &&
      WORKFLOW_TOOL_DESCRIPTION.includes("retained in Cmb's workflow panel") &&
      WORKFLOW_TOOL_DESCRIPTION.includes("never falls back to the shared workspace") &&
      WORKFLOW_TOOL_DESCRIPTION.includes("not a sandbox for untrusted code or network access"),
    "workflow prompt must retain the script-facing isolation contract"
  )
  assert(
    WORKFLOW_TOOL_DESCRIPTION.includes("work normally with `git add` and `git commit`") &&
      WORKFLOW_TOOL_DESCRIPTION.includes("Do not ask it to push unless"),
    "the prompt must state Cmb's delivery requirements without exposing integration internals"
  )
}

function testGitEnvironmentOverridesAreRemoved(): void {
  const clean = withoutGitRepositoryOverrides({
    PATH: "/usr/bin",
    GIT_DIR: "/tmp/redirected",
    git_work_tree: "/tmp/worktree",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.worktree",
    GIT_CONFIG_VALUE_0: "/tmp/other",
    GIT_LFS_SKIP_SMUDGE: "1",
    CMB_SAFE: "yes"
  })
  assert(clean.PATH === "/usr/bin" && clean.CMB_SAFE === "yes", "ordinary env must survive")
  assert(
    !Object.keys(clean).some((name) => name.toUpperCase().startsWith("GIT_CONFIG")) &&
      clean.GIT_DIR === undefined &&
      clean.git_work_tree === undefined &&
      clean.GIT_LFS_SKIP_SMUDGE === undefined,
    "Git repository/config redirection must not reach lifecycle or isolated shell processes"
  )
  assert(
    !isGitRepositoryOverrideEnvironmentVariable("GIT_LFS_SKIP_SMUDGE"),
    "LFS checkout control must be cleaned only on inheritance, not forbidden as repository redirection"
  )
}

async function testDiffSummaryIsBoundedAndBranchIdentityIsEnforced(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    const ledger = new WorkflowWorktreeLedger({
      workspacePath: repo,
      runId: "wf_bounded_diff",
      appDataRoot
    })
    const info = await ledger.acquire("large")
    writeFileSync(join(info.directory, "large.txt"), "large\n")
    git(info.directory, ["add", "-A"])
    git(info.directory, [
      "commit",
      "-m",
      `large-${"x".repeat(WORKFLOW_WORKTREE_DIFF_SUMMARY_MAX_CHARS + 1024)}`
    ])
    await ledger.settle(info, { succeeded: true })
    const ready = (await listWorkflowWorktreeRecords(info.commonDir, appDataRoot)).find(
      (record) => record.id === info.name
    )!
    const diff = await diffWorkflowWorktree({ workspacePath: repo, record: ready, appDataRoot })
    assert(diff.summary.endsWith("… output truncated"), "large summaries should be truncated")
    assert(
      diff.summary.length <= WORKFLOW_WORKTREE_DIFF_SUMMARY_MAX_CHARS + 32,
      "bounded diff must not send an unbounded IPC payload"
    )

    git(info.directory, ["checkout", "--detach"])
    let rejected: unknown
    try {
      await diffWorkflowWorktree({ workspacePath: repo, record: ready, appDataRoot })
    } catch (error) {
      rejected = error
    }
    assert(
      rejected instanceof Error && rejected.message.includes("recorded branch"),
      "managed actions must reject a detached or repointed checkout"
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testMergeConflictDoesNotTouchSource(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  try {
    const ledger = new WorkflowWorktreeLedger({
      workspacePath: repo,
      runId: "wf_conflict",
      appDataRoot
    })
    const first = await ledger.acquire("first")
    const second = await ledger.acquire("second")
    writeFileSync(join(first.directory, "README.md"), "first\n")
    git(first.directory, ["add", "-A"])
    git(first.directory, ["commit", "-m", "first version"])
    writeFileSync(join(second.directory, "README.md"), "second\n")
    git(second.directory, ["add", "-A"])
    git(second.directory, ["commit", "-m", "second version"])
    await ledger.settle(first, { succeeded: true })
    await ledger.settle(second, { succeeded: true })
    await mergeRecordedWorktree(repo, first, appDataRoot)
    const sourceHead = git(repo, ["rev-parse", "HEAD"])

    let conflict: unknown
    try {
      await mergeRecordedWorktree(repo, second, appDataRoot)
    } catch (error) {
      conflict = error
    }
    assert(
      conflict instanceof Error && conflict.message.includes("conflict"),
      `conflicting integration should fail before mutation, got ${String(conflict)}`
    )
    assert(git(repo, ["rev-parse", "HEAD"]) === sourceHead, "conflict must not advance source HEAD")
    assert(
      git(repo, ["status", "--porcelain"]) === "",
      "conflict preflight must leave source clean"
    )
    assert(existsSync(second.directory), "conflicting worktree must remain recoverable")
    const records = await listWorkflowWorktreeRecords(second.commonDir, appDataRoot)
    assert(
      records.find((record) => record.id === second.name)?.status === "recoverable",
      "conflicting record should become recoverable"
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testRunPruneKeepsUnresolvedWorktreeEntry(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  const threadId = "thread-prune-worktree"
  try {
    const info = await createWorkflowWorktree({
      workspacePath: repo,
      runId: "wf_prune",
      appDataRoot
    })
    const unresolved = recordFor(info, "ready", "wf_placeholder")
    const persistRun = async (
      worktree?: WorkflowWorktreeRecord,
      embedWorktree = true,
      explicitRunId?: string
    ): Promise<string> => {
      const runId = explicitRunId ?? generateWorkflowRunId()
      const now = new Date().toISOString()
      const store = createWorkflowRunStore({
        workspacePath: repo,
        threadId,
        initial: {
          version: 1,
          runId,
          threadId,
          workflowName: "prune",
          script: "return null",
          scriptSha256: sha256Hex("return null"),
          status: "completed",
          phases: [],
          currentPhase: null,
          agents: [],
          worktrees: worktree && embedWorktree ? [{ ...worktree, runId }] : [],
          logs: [],
          journal: [],
          stats: {
            agentsTotal: 0,
            agentsCached: 0,
            agentsFailed: 0,
            outputTokens: 0,
            durationMs: 1
          },
          startedAt: now,
          updatedAt: now,
          completedAt: now,
          notificationDelivered: true
        }
      })
      await store.whenInitialPersisted
      await store.flush()
      return runId
    }
    const protectedRunId = await persistRun(unresolved)
    const cleanupPending = {
      ...unresolved,
      id: `${unresolved.id}-terminal-dir`,
      status: "discarded" as const,
      headCommit: info.baseCommit
    }
    await persistWorkflowWorktreeRecord(cleanupPending, appDataRoot)
    const cleanupPendingRunId = await persistRun(cleanupPending)

    const tombstoneRunId = generateWorkflowRunId()
    const tombstoneInfo = await createWorkflowWorktree({
      workspacePath: repo,
      runId: tombstoneRunId,
      appDataRoot
    })
    const tombstone = recordFor(tombstoneInfo, "discarded", tombstoneRunId)
    await removeWorkflowWorktree({
      directory: tombstoneInfo.directory,
      gitRoot: tombstoneInfo.gitRoot,
      branch: tombstoneInfo.branch,
      expectedBranchHead: tombstoneInfo.baseCommit,
      preserveChanges: true
    })
    await persistWorkflowWorktreeRecord(tombstone, appDataRoot)
    // Keep this genuinely record-only: the run snapshot has no embedded
    // worktree entry, so the independent ownership manifest is the only route
    // by which pruning can discover and protect it.
    await persistRun(tombstone, false, tombstoneRunId)
    const disposableRunId = await persistRun()
    const manifestState = await listWorkflowWorktreeRecordsForPrune(info.commonDir, appDataRoot)
    assert(manifestState.reliable, "current repository manifest index should be readable")
    pruneWorkflowRuns(
      repo,
      threadId,
      0,
      manifestState.records.map((record) => record.runId)
    )
    assert(
      loadWorkflowRun(repo, threadId, protectedRunId) !== null,
      "history pruning must keep the UI entry for an unresolved worktree"
    )
    assert(
      loadWorkflowRun(repo, threadId, cleanupPendingRunId) !== null,
      "history pruning must keep terminal worktrees whose checkout cleanup is pending"
    )
    assert(
      loadWorkflowRun(repo, threadId, tombstoneRunId) !== null,
      "history pruning must keep a terminal run while its ownership manifest remains"
    )
    assert(
      loadWorkflowRun(repo, threadId, disposableRunId) === null,
      "ordinary delivered terminal history remains prunable"
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testRunFileMutationsDoNotLoseWorktreeNotificationOrBackupState(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  const threadId = "thread-run-mutation"
  try {
    const runId = generateWorkflowRunId()
    const now = new Date().toISOString()
    const info = await createWorkflowWorktree({ workspacePath: repo, runId, appDataRoot })
    const record = recordFor(info, "ready", runId)
    const store = createWorkflowRunStore({
      workspacePath: repo,
      threadId,
      initial: {
        version: 1,
        runId,
        threadId,
        workflowName: "mutation-race",
        script: "return null",
        scriptSha256: sha256Hex("return null"),
        status: "completed",
        phases: [],
        currentPhase: null,
        agents: [],
        worktrees: [],
        logs: [],
        journal: [],
        stats: {
          agentsTotal: 0,
          agentsCached: 0,
          agentsFailed: 0,
          outputTokens: 0,
          durationMs: 1
        },
        startedAt: now,
        updatedAt: now,
        completedAt: now,
        notificationDelivered: false
      }
    })
    await store.whenInitialPersisted
    await store.flush()
    await Promise.all([
      markWorkflowRunNotified(repo, threadId, runId, now),
      updateWorkflowWorktreeRecord(repo, threadId, runId, record)
    ])
    const persisted = loadWorkflowRun(repo, threadId, runId)
    assert(persisted?.notificationDelivered === true, "notification ack must not be overwritten")
    assert(
      persisted?.worktrees?.some((candidate) => candidate.id === record.id) === true,
      "worktree terminal mutation must not be lost to a concurrent notification write"
    )

    const merged = await updateWorkflowWorktreeRecord(repo, threadId, runId, {
      ...record,
      status: "merged",
      cleanupPending: false,
      updatedAt: new Date(Date.now() + 1).toISOString()
    })
    assert(
      merged?.worktrees?.find((candidate) => candidate.id === record.id)?.status === "merged",
      "terminal worktree mutation must reach the primary run record"
    )
    // The backup is an automatic corruption fallback, not merely a historical
    // snapshot. A later terminal action must therefore keep it current.
    writeFileSync(runFilePath(repo, threadId, runId), "{corrupt")
    const recovered = loadWorkflowRun(repo, threadId, runId)
    assert(
      recovered?.worktrees?.find((candidate) => candidate.id === record.id)?.status === "merged",
      "backup fallback must retain the latest terminal worktree state"
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testRunStoreRecoversManifestMissingFromSnapshot(): Promise<void> {
  const repo = makeRepo()
  const appDataRoot = makeAppDataRoot()
  const threadId = "thread-manifest-recovery"
  try {
    const runId = generateWorkflowRunId()
    const now = new Date().toISOString()
    const store = createWorkflowRunStore({
      workspacePath: repo,
      threadId,
      initial: {
        version: 1,
        runId,
        threadId,
        workflowName: "recover-manifest",
        script: "return null",
        scriptSha256: sha256Hex("return null"),
        status: "aborted",
        phases: [],
        currentPhase: null,
        agents: [],
        worktrees: [],
        logs: [],
        journal: [],
        stats: {
          agentsTotal: 0,
          agentsCached: 0,
          agentsFailed: 0,
          outputTokens: 0,
          durationMs: 1
        },
        startedAt: now,
        updatedAt: now,
        completedAt: now,
        notificationDelivered: true
      }
    })
    await store.whenInitialPersisted
    await store.flush()

    const info = await createWorkflowWorktree({
      workspacePath: repo,
      runId,
      threadId,
      label: "crash-window",
      persistOwnership: true,
      appDataRoot
    })
    const record = { ...recordFor(info, "recoverable", runId), threadId }
    const updated = await updateWorkflowWorktreeRecord(repo, threadId, runId, record)
    assert(
      updated?.worktrees?.some((candidate) => candidate.id === record.id),
      "restart reconciliation must be able to append a manifest absent from the run snapshot"
    )
    assert(
      loadWorkflowRun(repo, threadId, runId)?.worktrees?.some(
        (candidate) => candidate.id === record.id
      ),
      "the recovered ownership record must be durable"
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
}

async function testManifestOnlyWorktreePinsItsWorkspace(): Promise<void> {
  const repo = makeRepo()
  const isolatedHome = mkdtempSync(join(tmpdir(), "cmb-wt-pin-home-"))
  const appDataRoot = join(isolatedHome, ".cmbcoworkagent")
  const previousHome = process.env.HOME
  const threadId = "thread-manifest-only-pin"
  try {
    // The production manifest reader uses ~/.cmbcoworkagent. Point HOME at the
    // fixture so this exercises the real workspace-switch predicate without a
    // test-only injection seam or a second index.
    process.env.HOME = isolatedHome
    await createWorkflowWorktree({
      workspacePath: repo,
      runId: generateWorkflowRunId(),
      threadId,
      label: "crash-window",
      persistOwnership: true,
      appDataRoot
    })
    const repositoriesRoot = join(appDataRoot, "worktrees")
    const [repositoryKey] = readdirSync(repositoriesRoot)
    assert(repositoryKey, "fixture must create a repository manifest directory")
    writeFileSync(join(repositoriesRoot, repositoryKey, ".records", "corrupt.json"), "{not-json")
    assert(
      await workflowRunManager.isWorkspacePinnedForThread(threadId, repo),
      "a valid ownership manifest must pin its workspace even when a sibling manifest is corrupt"
    )
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    rmSync(repo, { recursive: true, force: true })
    rmSync(isolatedHome, { recursive: true, force: true })
  }
}

// ── engine contract ──────────────────────────────────────────────────────────

interface EngineHarness {
  workspace: string
  logs: string[]
  run(
    script: string,
    runner: WorkflowSubagentRunner,
    expectedStatus?: "completed" | "error"
  ): Promise<{
    result: unknown
    journal: PersistedWorkflowRun["journal"]
    status: "completed" | "error" | "aborted"
    error?: string
  }>
}

function makeEngineHarness(): EngineHarness {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "cmb-wt-engine-")))
  const logs: string[] = []
  const threadId = "thread-worktree"
  return {
    workspace,
    logs,
    async run(script, runner, expectedStatus = "completed") {
      const parsed = validateWorkflowScript(script)
      const now = new Date().toISOString()
      const runStore = createWorkflowRunStore({
        workspacePath: workspace,
        threadId,
        initial: {
          version: 1,
          runId: generateWorkflowRunId(),
          threadId,
          workflowName: parsed.meta.name,
          script,
          scriptSha256: sha256Hex(script),
          status: "running",
          phases: [],
          currentPhase: null,
          agents: [],
          logs: [],
          journal: [],
          stats: {
            agentsTotal: 0,
            agentsCached: 0,
            agentsFailed: 0,
            outputTokens: 0,
            durationMs: 0
          },
          startedAt: now,
          updatedAt: now
        }
      })
      const outcome = await runWorkflowEngine({
        parsed,
        runStore,
        tokenBudget: null,
        subagentRunner: runner,
        emit: (event) => {
          if (event.kind === "log") logs.push(event.message)
        },
        signal: new AbortController().signal,
        workspacePath: workspace
      })
      assert(
        outcome.status === expectedStatus,
        `engine run should be ${expectedStatus}, got ${outcome.status}: ${outcome.error}`
      )
      return {
        result: outcome.result,
        journal: runStore.state.journal,
        status: outcome.status,
        error: outcome.error
      }
    }
  }
}

async function testEngineForwardsIsolationWithoutChangingResults(): Promise<void> {
  const harness = makeEngineHarness()
  try {
    const seen: (string | undefined)[] = []
    const runner: WorkflowSubagentRunner = async (request) => {
      seen.push(request.isolation)
      return {
        text: `text:${request.prompt}`,
        structured: request.schema
          ? request.prompt === "isolated exact schema"
            ? { answer: request.prompt, _worktree: "model-owned value" }
            : { answer: request.prompt }
          : undefined,
        outputTokens: 5
      }
    }

    const { result } = await harness.run(
      `export const meta = { name: 'iso', description: 'isolation plumbing' }
       const plain = await agent('shared work')
       const isolatedText = await agent('isolated work', { isolation: 'worktree' })
       const structured = await agent('isolated structured', {
         isolation: 'worktree',
         schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }
       })
       const exact = await agent('isolated exact schema', {
         isolation: 'worktree',
         schema: {
           type: 'object',
           properties: { answer: { type: 'string' }, _worktree: { type: 'string' } },
           required: ['answer', '_worktree'],
           additionalProperties: false
         }
       })
       const pristine = await agent('isolated pristine schema', {
         isolation: 'worktree',
         schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }
       })
       return { plain, isolatedText, structured, exact, pristine }`,
      runner
    )

    assert(
      JSON.stringify(seen) ===
        JSON.stringify([undefined, "worktree", "worktree", "worktree", "worktree"]),
      `runner should receive isolation per call, got ${JSON.stringify(seen)}`
    )

    const out = result as {
      plain: unknown
      isolatedText: unknown
      structured: { answer?: string; _worktree?: unknown }
      exact: { answer?: string; _worktree?: string }
      pristine: { answer?: string }
    }
    assert(out.plain === "text:shared work", "a shared agent returns its plain text")
    assert(
      out.isolatedText === "text:isolated work",
      "a retained isolated text result must stay identical to the shared return shape"
    )
    assert(
      out.structured.answer === "isolated structured",
      "a retained isolated schema result must remain directly accessible"
    )
    assert(
      Object.keys(out.structured).join(",") === "answer",
      "retained worktree metadata must not be injected into a schema result"
    )
    assert(
      out.exact._worktree === "model-owned value",
      "a schema-defined _worktree field must remain the model's own value"
    )
    assert(
      Object.keys(out.exact).sort().join(",") === "_worktree,answer",
      "additionalProperties:false schema result must not gain delivery fields"
    )
    assert(
      out.pristine.answer === "isolated pristine schema",
      "a pristine isolated schema call must keep the same direct result shape"
    )
  } finally {
    rmSync(harness.workspace, { recursive: true, force: true })
  }
}

async function testEngineDoesNotJournalIsolatedAgents(): Promise<void> {
  const harness = makeEngineHarness()
  try {
    const runner: WorkflowSubagentRunner = async (request) => ({
      text: `text:${request.prompt}`,
      structured: undefined,
      outputTokens: 5
    })

    const { journal } = await harness.run(
      `export const meta = { name: 'iso-journal', description: 'journal policy' }
       await agent('shared')
       await agent('isolated', { isolation: 'worktree' })
       return 'done'`,
      runner
    )

    // The isolated call's deliverable is a checkout the journal cannot rebuild,
    // so only the shared call may be journaled.
    assert(journal.length === 1, `only the shared agent should be journaled, got ${journal.length}`)
    assert(journal[0].result === "text:shared", "the journaled entry should be the shared agent's")
    assert(
      harness.logs.some((line) => line.includes("not journaled")),
      `the run log should say why, got ${JSON.stringify(harness.logs)}`
    )
  } finally {
    rmSync(harness.workspace, { recursive: true, force: true })
  }
}

async function testIsolationChangesCallIdentity(): Promise<void> {
  const harness = makeEngineHarness()
  try {
    const runner: WorkflowSubagentRunner = async (request) => ({
      text: `text:${request.prompt}`,
      structured: undefined,
      outputTokens: 5
    })
    // Same prompt, different isolation. The two calls must hash differently, or a
    // resume could replay the shared result for what is now an isolated call.
    const { journal } = await harness.run(
      `export const meta = { name: 'iso-hash', description: 'identity' }
       await agent('same prompt')
       await agent('same prompt', { isolation: 'worktree' })
       return 'done'`,
      runner
    )
    assert(journal.length === 1, "the isolated twin is not journaled")
    const sharedHash = journal[0].hash

    const second = makeEngineHarness()
    try {
      const { journal: plainJournal } = await second.run(
        `export const meta = { name: 'iso-hash', description: 'identity' }
         await agent('same prompt')
         return 'done'`,
        runner
      )
      assert(
        plainJournal[0].hash === sharedHash,
        "an unchanged shared call must keep a stable hash across runs"
      )
    } finally {
      rmSync(second.workspace, { recursive: true, force: true })
    }
  } finally {
    rmSync(harness.workspace, { recursive: true, force: true })
  }
}

async function testUnsupportedIsolationKeepsLegacySharedExecution(): Promise<void> {
  const harness = makeEngineHarness()
  try {
    const seen: (string | undefined)[] = []
    const runner: WorkflowSubagentRunner = async (request) => {
      seen.push(request.isolation)
      return { text: "ok", structured: undefined, outputTokens: 1 }
    }
    const { result } = await harness.run(
      `export const meta = { name: 'iso-bad', description: 'unsupported mode' }
       return agent('work', { isolation: 'remote' })`,
      runner
    )
    assert(
      result === "ok",
      `unsupported legacy isolation should retain shared execution, got ${String(result)}`
    )
    assert(
      seen.length === 1 && seen[0] === undefined,
      "legacy isolation must not enter worktree mode"
    )
  } finally {
    rmSync(harness.workspace, { recursive: true, force: true })
  }
}

// ── list parsing ─────────────────────────────────────────────────────────────

function testParseWorktreeList(): void {
  const parsed = parseWorktreeList(
    [
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repo-wt",
      "HEAD def456",
      "branch refs/heads/cmbcowork/wf/run/agent-1",
      "",
      "worktree /detached",
      "HEAD 999",
      "detached",
      ""
    ].join("\n")
  )
  assert(parsed.length === 3, `expected 3 entries, got ${parsed.length}`)
  assert(parsed[0].branch === "main", "refs/heads/ prefix should be stripped")
  assert(parsed[1].branch === "cmbcowork/wf/run/agent-1", "namespaced branch should parse")
  assert(parsed[2].branch === undefined, "a detached worktree has no branch")
}

// ── entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const workflowDataRoot = mkdtempSync(join(tmpdir(), "cmb-workflow-worktree-data-"))
  process.env.CMB_COWORK_AGENT_HOME = workflowDataRoot
  try {
    await testCreateProducesAttachedBranchAtHead()
    await testDetachedSourceFailsBeforeProvisioning()
    await testCreateDoesNotMutateGitConfig()
    await testSourceSnapshotRejectsConcurrentBranchSwitch()
    await testSourceSnapshotHonorsWorkflowCancellation()
    await testWorkspaceHookFilesAreMaterializedWithoutDirtyingWorktree()
    await testTrackedWorkspaceHookSymlinkStaysPristine()
    await testDirtySourceUsesCommittedHead()
    await testSubdirectoryScopeAndLinkedSourceHead()
    await testConcurrentCreatesAreSerializedAndUnique()
    await testLongLabelOwnershipRecordsDoNotCollide()
    await testCreateFromInsideAWorktreeUsesPrimaryRepo()
    await testSymlinkedWorkspaceKeepsOneRepositoryIdentity()
    await testCreateRejectsNonGitDirectory()
    await testPristineDetection()
    await testRemoveIsCompleteAndIdempotent()
    await testManagedOperationsDoNotPruneUnrelatedWorktrees()
    await testSafeRemovalRejectsAnAdvancedBranch()
    await testGitRemovalFailureNeverFallsBackToRecursiveDelete()
    await testLedgerKeepsOnlyChangedSuccesses()
    await testSuccessfulAgentWithMissingCheckoutIsRecoverable()
    await testRewrittenBaseIsNotAdvertisedAsReady()
    await testLedgerReclaimsOutstandingWorktrees()
    await testLedgerCleansUpWorktreeCreatedDuringCancel()
    await testLedgerReclaimAwaitsRecoveryBeforeReturning()
    await testLedgerRetriesSourcePreparationAfterDetachedHead()
    await testLedgerFreezesFanoutBase()
    await testDiffMergeAndDiscardOperations()
    await testCancellationAfterSourceAdvanceStillFinishesMerge()
    await testConcurrentActionsStayMonotonic()
    await testAtomicIntegrationCrashWindowIsRecoverable()
    await testMergedTerminalStateSurvivesCleanupPersistenceFailure()
    await testIgnoredSourceCollisionNeverGetsOverwritten()
    await testTrackedFileToDirectoryIntegrationIsSupported()
    await testSourceOnlyFilteredSiblingDoesNotBlockScopedMerge()
    await testGitLfsAttributeRemainsUsable()
    await testGitLfsCheckoutMatchesSourceWhenAvailable()
    await testSingleSidedMergeAttributeDoesNotBlock()
    await testIntegrationTransactionOwnershipAndDescendants()
    await testTrackedRuntimeChangesBlockMerge()
    await testScopedDeliverableCannotMergeOutsideWorkspace()
    await testReservedRuntimeAndGitlinkChangesFailClosed()
    await testSourceGitOperationIsNeverAborted()
    await testDamagedWorktreeDiscardIsRecoverableAndNoFollow()
    await testDiscardCleanupNeverDeletesLateCommits()
    await testDiffSummaryIsBoundedAndBranchIdentityIsEnforced()
    await testMergeConflictDoesNotTouchSource()
    await testRunPruneKeepsUnresolvedWorktreeEntry()
    await testRunFileMutationsDoNotLoseWorktreeNotificationOrBackupState()
    await testRunStoreRecoversManifestMissingFromSnapshot()
    await testManifestOnlyWorktreePinsItsWorkspace()
    await testEngineForwardsIsolationWithoutChangingResults()
    await testEngineDoesNotJournalIsolatedAgents()
    await testIsolationChangesCallIdentity()
    await testUnsupportedIsolationKeepsLegacySharedExecution()
    testParseWorktreeList()
    testWorktreePromptMatchesRuntimeBoundary()
    testGitEnvironmentOverridesAreRemoved()

    console.log("PASS workflow-worktree (62 tests)")
  } finally {
    if (PREVIOUS_WORKFLOW_DATA_ROOT === undefined) delete process.env.CMB_COWORK_AGENT_HOME
    else process.env.CMB_COWORK_AGENT_HOME = PREVIOUS_WORKFLOW_DATA_ROOT
    rmSync(workflowDataRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
