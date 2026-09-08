import { execFile } from "child_process"
import { createHash, randomBytes } from "crypto"
import * as fs from "fs/promises"
import { homedir } from "os"
import * as path from "path"
import { promisify } from "util"
import type {
  WorkflowWorktreeIsolationBoundary,
  WorkflowWorktreeRecord
} from "../agent/workflow/types"
import {
  getWorkflowWorktreeRemoveTimeoutMs,
  getWorkflowWorktreeTimeoutMs
} from "../../shared/agent-runtime-limits"
import { getCmbCoworkAgentDataRoot } from "../app-data-root"
import { withoutGitRepositoryOverrides } from "./git-environment"
import {
  openStableFileHandle,
  readStableFileHandleBounded
} from "./stable-file-handle"

const execFileAsync = promisify(execFile)

/**
 * Programmatic git-worktree lifecycle for dynamic-workflow agent isolation.
 *
 * Distinct from the THREAD-level worktrees the Git panel creates (see
 * workspace:createWorktree in ipc/models.ts): those are user-driven, live next to
 * the repo, and outlive the app. These are RUN-scoped, machine-managed, live under
 * the app data root, and are reclaimed automatically — a workflow can hold dozens
 * at once, so they must never litter the user's project directory.
 *
 * Electron-free on purpose (plain node + git), so the tsx specs can drive it
 * against a real throwaway repository.
 *
 * Concurrency contract — the reason this module exists rather than inlining git
 * calls at the call site: every worktree of one repository SHARES a single object
 * store, ref store and `.git/index.lock`. Two concurrent `git worktree add` runs on
 * the same repo race on that shared admin state and one fails nondeterministically,
 * so creation is serialized per repository. The lock key is the CANONICAL COMMON
 * DIR (`--git-common-dir`), not the caller's directory: creating from the primary
 * checkout and creating from an existing worktree of the same repo must take the
 * SAME lock, and only the common dir is equal in both cases.
 */

const GIT_BASE_ENV: NodeJS.ProcessEnv = {
  ...withoutGitRepositoryOverrides(process.env),
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
  LANG: "C"
}

const GIT_SPAWN_OPTIONS = { windowsHide: true } as const
// Git documents /dev/null as the hooks opt-out, but Git for Windows does not
// consistently suppress post-index-change through that MSYS path. The native
// null device is unresolvable as a hook directory and keeps host-side plumbing
// from executing repository- or deliverable-controlled hooks on Windows.
const GIT_DISABLED_HOOKS_PATH = process.platform === "win32" ? "NUL" : "/dev/null"
const GIT_NO_HOOKS_ARGS = ["-c", `core.hooksPath=${GIT_DISABLED_HOOKS_PATH}`] as const

/** Query timeout for the short plumbing commands (rev-parse, show-ref, config). */
const GIT_QUERY_TIMEOUT_MS = 10_000

/** Attempts at finding an unused `<name>` / `refs/heads/<branch>` pair. */
const MAX_NAME_ATTEMPTS = 25

/** Where run-scoped worktrees live: `~/.cmbcoworkagent/worktrees/<repoKey>/<name>`. */
const WORKTREE_ROOT_DIR_NAME = "worktrees"
const WORKTREE_RECORDS_DIR_NAME = ".records"
const WORKTREE_INTERNAL_EXCLUDES_FILE_NAME = ".cmb-internal-excludes"
// Workspace hook commands may depend on adjacent `.cmbdevclaw` configuration
// or helpers. Those files are materialized into an isolated checkout, but are
// CmbCowork runtime support rather than a deliverable, so Git must not retain
// them when removing an otherwise pristine worktree.
const WORKTREE_INTERNAL_EXCLUDES = "**/.cmbdevclaw/**\n"
const WORKFLOW_WORKTREE_DIFF_SUMMARY_MAX_CHARS = 32 * 1024
const WORKFLOW_WORKTREE_RECORD_MAX_BYTES = 256 * 1024
const WORKFLOW_WORKTREE_EXCLUDES_MAX_BYTES = 1024 * 1024
const WORKFLOW_WORKTREE_RECORD_SCAN_MAX_FILES = 2048
const WORKFLOW_WORKTREE_RECORD_SCAN_MAX_DIRECTORY_ENTRIES = 4096
const WORKFLOW_WORKTREE_RECORD_SCAN_MAX_TOTAL_BYTES = 8 * 1024 * 1024
const WORKFLOW_WORKTREE_RECORD_SCAN_YIELD_EVERY = 128

/** Branch namespace for machine-created worktrees. */
const WORKFLOW_WORKTREE_BRANCH_PREFIX = "cmbcowork/wf"

async function readStableWorktreeFile(filePath: string, maxBytes: number): Promise<Buffer> {
  const opened = await openStableFileHandle(path.dirname(filePath), filePath)
  try {
    return await readStableFileHandleBounded(opened, maxBytes)
  } finally {
    await opened.handle.close().catch(() => undefined)
  }
}

export interface WorkflowWorktreeInfo {
  /** Directory basename, unique within the repo's worktree root. */
  name: string
  /** Full branch name (`cmbcowork/wf/...`), without the `refs/heads/` prefix. */
  branch: string
  /** Absolute path to the checked-out worktree. */
  directory: string
  /** Absolute path to the repository the worktree belongs to (the primary checkout). */
  gitRoot: string
  /** Actual checkout which supplied the base commit (may itself be a linked worktree). */
  sourceRoot: string
  /** Workspace scope relative to sourceRoot. Empty means repository root. */
  sourceRelativePath: string
  /** Directory exposed to the isolated agent. */
  workspaceDirectory: string
  /** Shared git metadata directory used for repository locking and durable records. */
  commonDir: string
  /** Source branch. Provisioning rejects detached source checkouts. */
  sourceBranch: string
  /** Commit the worktree was created at. Empty string only if HEAD was unreadable —
   * callers MUST treat an empty base as "assume changed" and never auto-delete. */
  baseCommit: string
}

type GitWorktreeErrorCode = "merge-conflict" | "dirty-deliverable" | "source-busy" | "unsafe-state"

class GitWorktreeError extends Error {
  constructor(
    message: string,
    readonly code: GitWorktreeErrorCode = "unsafe-state"
  ) {
    super(message)
    this.name = "GitWorktreeError"
  }
}

interface GitResult {
  code: number
  stdout: string
  stderr: string
  infrastructureFailure: boolean
}

interface GitProcessTestOverride {
  executable: string
  args: string[]
}

/**
 * Runs git and NEVER throws for a non-zero exit — callers branch on `code`. A
 * spawn failure (git missing, timeout, killed) also lands here as code 1 with the
 * message in stderr, so a single shape covers every failure mode.
 */
async function git(
  cwd: string,
  args: string[],
  timeoutMs = GIT_QUERY_TIMEOUT_MS,
  signal?: AbortSignal,
  processTestOverride?: GitProcessTestOverride
): Promise<GitResult> {
  try {
    // These are host-owned lifecycle commands, so none may execute hooks from
    // the source repository or an agent-controlled deliverable. Apply the hook
    // guard centrally: even nominally read-only Git commands can refresh an
    // index and invoke post-index-change on some platforms. Worktree expiry is
    // likewise disabled globally so an operation cannot prune unrelated paths.
    const executable = processTestOverride?.executable ?? "git"
    const processArgs = processTestOverride?.args ?? [
      "-c",
      "gc.worktreePruneExpire=never",
      ...GIT_NO_HOOKS_ARGS,
      "-C",
      cwd,
      ...args
    ]
    const { stdout, stderr } = await execFileAsync(
      executable,
      processArgs,
      {
        env: GIT_BASE_ENV,
        timeout: timeoutMs,
        signal,
        maxBuffer: 16 * 1024 * 1024,
        ...GIT_SPAWN_OPTIONS
      }
    )
    return { code: 0, stdout, stderr, infrastructureFailure: false }
  } catch (error) {
    const e = error as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: string }
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" && e.stderr ? e.stderr : (e.message ?? "git failed"),
      infrastructureFailure: typeof e.code !== "number"
    }
  }
}

function gitFailure(result: GitResult, fallback: string): string {
  return result.stderr.trim() || result.stdout.trim() || fallback
}

function isMissingGitRef(result: GitResult): boolean {
  return (
    result.code !== 0 &&
    !result.infrastructureFailure &&
    (result.code === 1 || /not a valid ref|does not exist|not found/i.test(gitFailure(result, "")))
  )
}

async function writeWorkflowWorktreeExcludesFile(
  repoRoot: string,
  targetPath: string,
  signal?: AbortSignal
): Promise<void> {
  // core.excludesFile is a single-value setting. Pointing Git straight at
  // Cmb's private file would replace the user's effective global/repository
  // excludes and make `git add -A` stage files Git normally ignores. Snapshot
  // that effective file first, then append only the Cmb-owned support pattern.
  const configured = await git(
    repoRoot,
    ["config", "--path", "--get", "core.excludesFile"],
    GIT_QUERY_TIMEOUT_MS,
    signal
  )
  let inherited: Buffer = Buffer.alloc(0)
  const configuredPath = configured.code === 0 ? configured.stdout.trim() : ""
  let inheritedPath = ""
  if (configuredPath) {
    // `git config --path` expands `~`, but intentionally leaves relative values
    // relative. Git invoked with `-C repoRoot` resolves those from the repository;
    // Node would otherwise resolve them from Electron's unrelated process cwd.
    inheritedPath = path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(repoRoot, configuredPath)
  } else {
    // When core.excludesFile is unset, Git still reads its documented default:
    // $XDG_CONFIG_HOME/git/ignore, or ~/.config/git/ignore when XDG is absent.
    // Injecting Cmb's private file would otherwise silently replace that rule set.
    const xdgConfigHome = GIT_BASE_ENV.XDG_CONFIG_HOME?.trim() ?? ""
    inheritedPath =
      xdgConfigHome && path.isAbsolute(xdgConfigHome)
        ? path.join(xdgConfigHome, "git", "ignore")
        : path.join(homedir(), ".config", "git", "ignore")
  }
  if (inheritedPath) {
    inherited = await readStableWorktreeFile(
      inheritedPath,
      WORKFLOW_WORKTREE_EXCLUDES_MAX_BYTES
    ).catch(() => Buffer.alloc(0))
  }
  const separator = inherited.length > 0 && inherited[inherited.length - 1] !== 0x0a ? "\n" : ""
  await fs.writeFile(
    targetPath,
    Buffer.concat([inherited, Buffer.from(`${separator}${WORKTREE_INTERNAL_EXCLUDES}`, "utf8")])
  )
}

function isConfirmedMergeTreeConflict(result: GitResult): boolean {
  if (result.infrastructureFailure || result.code !== 1) return false
  return /(?:^|\n)CONFLICT \(/.test(`${result.stdout}\n${result.stderr}`)
}

async function rollbackAtomicWorkflowIntegration(
  directory: string,
  targetRef: string,
  mergeCommit: string,
  sourceHead: string,
  reason: string
): Promise<never> {
  const rolledBack = await git(directory, [
    ...GIT_NO_HOOKS_ARGS,
    "update-ref",
    targetRef,
    sourceHead,
    mergeCommit
  ])
  if (rolledBack.code === 0) {
    throw new GitWorktreeError(`${reason}; source branch ref was safely rolled back`, "source-busy")
  }
  throw new GitWorktreeError(
    `${reason}; source branch also changed before rollback and requires manual recovery (${gitFailure(rolledBack, "atomic rollback failed")})`,
    "unsafe-state"
  )
}

async function currentGitOperation(directory: string): Promise<string | null> {
  for (const ref of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD"]) {
    const result = await git(directory, ["rev-parse", "--verify", "--quiet", ref])
    if (result.code === 0) return ref
  }
  for (const state of ["rebase-merge", "rebase-apply", "sequencer"]) {
    const resolved = await git(directory, ["rev-parse", "--git-path", state])
    const reportedPath = resolved.stdout.trim()
    const statePath = path.isAbsolute(reportedPath)
      ? reportedPath
      : path.resolve(directory, reportedPath)
    if (resolved.code === 0 && reportedPath && (await pathExists(statePath))) {
      return state
    }
  }
  return null
}

function isGitPathInsideScope(gitPath: string, sourceRelativePath: string): boolean {
  // Git's path output uses `/` on Windows. On POSIX, however, a backslash is a
  // legal filename byte, not a separator; normalizing it would make a root path
  // like `packages\assigned/file` impersonate `packages/assigned/file`.
  const candidate = (process.platform === "win32" ? gitPath.replace(/\\/g, "/") : gitPath).replace(
    /^\.\//,
    ""
  )
  const scope = sourceRelativePath
    .split(path.sep)
    .join("/")
    .replace(/^\/+|\/+$/g, "")
  if (
    !candidate ||
    candidate.startsWith("/") ||
    candidate === ".." ||
    candidate.startsWith("../")
  ) {
    return false
  }
  return !scope || candidate === scope || candidate.startsWith(`${scope}/`)
}

export async function assertWorkflowWorktreeDeliverablePathsInScope(
  directory: string,
  baseCommit: string,
  headCommit: string,
  sourceRelativePath: string,
  timeoutMs = GIT_QUERY_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<void> {
  const changedPaths = await listChangedGitPaths(
    directory,
    baseCommit,
    headCommit,
    timeoutMs,
    signal
  )
  assertGitPathsInScope(changedPaths, sourceRelativePath)
}

export async function assertWorkflowWorktreeDeliverableDescendsFromBase(
  directory: string,
  baseCommit: string,
  headCommit: string,
  timeoutMs = GIT_QUERY_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<void> {
  const basedOnSource = await git(
    directory,
    ["merge-base", "--is-ancestor", baseCommit, headCommit],
    timeoutMs,
    signal
  )
  if (basedOnSource.code !== 0) {
    throw new GitWorktreeError("deliverable history no longer descends from its recorded base")
  }
}

function assertGitPathsInScope(changedPaths: string[], sourceRelativePath: string): void {
  const scope = sourceRelativePath
    .split(path.sep)
    .join("/")
    .replace(/^\/+|\/+$/g, "")
  const internalPath = scope ? `${scope}/.cmbdevclaw` : ".cmbdevclaw"
  for (const changedPath of changedPaths) {
    const comparablePath =
      process.platform === "win32" ? changedPath.replace(/\\/g, "/") : changedPath
    const foldedPath = comparablePath.toLowerCase()
    const foldedInternalPath = internalPath.toLowerCase()
    if (foldedPath === foldedInternalPath || foldedPath.startsWith(`${foldedInternalPath}/`)) {
      throw new GitWorktreeError(
        `deliverable changes reserved workflow runtime path: ${changedPath}`
      )
    }
    if (!isGitPathInsideScope(changedPath, sourceRelativePath)) {
      throw new GitWorktreeError(
        `deliverable changes path outside the assigned workspace: ${changedPath}`
      )
    }
  }
}

async function listChangedGitPaths(
  directory: string,
  baseCommit: string,
  headCommit: string,
  timeoutMs = GIT_QUERY_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<string[]> {
  const changed = await git(
    directory,
    ["diff", "--name-status", "-z", "--find-renames", "--find-copies", baseCommit, headCommit],
    timeoutMs,
    signal
  )
  if (changed.code !== 0) {
    throw new GitWorktreeError(gitFailure(changed, "failed to inspect changed paths"))
  }
  const fields = changed.stdout.split("\0")
  if (fields[fields.length - 1] === "") fields.pop()
  const paths: string[] = []
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++]
    const pathCount = /^[RC]/.test(status) ? 2 : 1
    if (!/^[ACDMRTUXB][0-9]*$/.test(status) || index + pathCount > fields.length) {
      throw new GitWorktreeError("cannot safely parse deliverable path changes")
    }
    paths.push(...fields.slice(index, index + pathCount))
    index += pathCount
  }
  return [...new Set(paths)]
}

async function assertNoGitlinkChanges(
  directory: string,
  baseCommit: string,
  headCommit: string,
  changedPaths: string[],
  timeoutMs = GIT_QUERY_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<void> {
  if (changedPaths.length === 0) return
  for (const changedPathBatch of gitPathBatches(changedPaths)) {
    const paths = changedPathBatch.map((gitPath) => `:(top,literal)${gitPath}`)
    for (const commit of [baseCommit, headCommit]) {
      const tree = await git(
        directory,
        ["ls-tree", "-z", commit, "--", ...paths],
        timeoutMs,
        signal
      )
      if (tree.code !== 0) {
        throw new GitWorktreeError(gitFailure(tree, "failed to inspect deliverable file modes"))
      }
      if (tree.stdout.split("\0").some((entry) => entry.startsWith("160000 commit "))) {
        throw new GitWorktreeError(
          "guarded integration does not support submodule gitlink changes; integrate that deliverable manually"
        )
      }
    }
  }
}

function gitPathBatches(paths: string[]): string[][] {
  const batches: string[][] = []
  let batch: string[] = []
  let bytes = 0
  for (const gitPath of paths) {
    const pathBytes = Buffer.byteLength(gitPath, "utf8") + 16
    if (batch.length > 0 && (batch.length >= 100 || bytes + pathBytes > 16 * 1024)) {
      batches.push(batch)
      batch = []
      bytes = 0
    }
    batch.push(gitPath)
    bytes += pathBytes
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}

function gitPathAncestors(gitPath: string): string[] {
  const segments = gitPath.split("/").filter(Boolean)
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"))
}

function gitPathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

/** Git's two-tree `read-tree -u` protects ordinary untracked files, but it may
 * overwrite ignored files. Query only the changed paths and their ancestors so
 * an ignored secret/cache is never silently replaced during guarded Merge. */
async function assertNoIgnoredSourceCollisions(
  directory: string,
  integrationPaths: string[],
  timeoutMs = GIT_QUERY_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<void> {
  if (integrationPaths.length === 0) return
  const candidates = [...new Set(integrationPaths.flatMap(gitPathAncestors))]
  for (const batch of gitPathBatches(candidates)) {
    const ignored = await git(
      directory,
      [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "-z",
        "--",
        ...batch.map((gitPath) => `:(top,literal)${gitPath}`)
      ],
      timeoutMs,
      signal
    )
    if (ignored.code !== 0) {
      throw new GitWorktreeError(gitFailure(ignored, "failed to inspect ignored source paths"))
    }
    const collision = ignored.stdout
      .split("\0")
      .filter(Boolean)
      .find((ignoredPath) =>
        integrationPaths.some((changedPath) => gitPathsOverlap(ignoredPath, changedPath))
      )
    if (collision) {
      throw new GitWorktreeError(
        `source has an ignored path that guarded Merge would overwrite: ${collision}`,
        "source-busy"
      )
    }
  }
}

// ── Per-repository serialization ─────────────────────────────────────────────
// One promise chain per canonical common dir. Read-tail-then-replace-tail happens
// SYNCHRONOUSLY (no await between them), so two callers entering in the same tick
// chain onto each other instead of both seeing an idle lock. The map holds at most
// one promise per active repository and evicts it when the chain settles.
const repoLocks = new Map<string, Promise<void>>()

function withRepoLock<T>(repoKey: string, task: () => Promise<T>): Promise<T> {
  const previous = repoLocks.get(repoKey) ?? Promise.resolve()
  // `then(task, task)` swallows the predecessor's rejection: one failed creation
  // must not poison the chain for every later caller on the same repository.
  const run = previous.then(task, task)
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  repoLocks.set(repoKey, tail)
  void tail.then(() => {
    if (repoLocks.get(repoKey) === tail) repoLocks.delete(repoKey)
  })
  return run
}

// UI actions can arrive concurrently from multiple windows. Repository locking
// alone is insufficient because each IPC call carries a stale record snapshot;
// serialize by durable worktree identity and reload the manifest inside the lock.
const worktreeActionLocks = new Map<string, Promise<void>>()

function withWorktreeActionLock<T>(
  record: WorkflowWorktreeRecord,
  task: () => Promise<T>
): Promise<T> {
  const key = `${canonicalKey(record.commonDir)}\0${record.id}`
  const previous = worktreeActionLocks.get(key) ?? Promise.resolve()
  const run = previous.then(task, task)
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  worktreeActionLocks.set(key, tail)
  void tail.then(() => {
    if (worktreeActionLocks.get(key) === tail) worktreeActionLocks.delete(key)
  })
  return run
}

function canonicalKey(input: string): string {
  const normalized = path.resolve(input).replace(/\\/g, "/").replace(/\/+$/, "")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function repoKeyFor(commonDir: string): string {
  return createHash("sha256").update(canonicalKey(commonDir)).digest("hex").slice(0, 12)
}

function workflowScopePathspec(sourceRelativePath: string): string {
  return sourceRelativePath ? `:(top,literal)${sourceRelativePath.split(path.sep).join("/")}` : "."
}

/** Inspect one assigned workspace scope (or the whole checkout when empty), then
 * untracked files while excluding CmbCowork's reserved runtime directories. The
 * tracked pass deliberately has no exclusion: a tracked/staged `.cmbdevclaw`
 * change is user work and must still block checkout refresh. */
async function inspectWorkspaceStatus(
  directory: string,
  sourceRelativePath = "",
  timeoutMs = GIT_QUERY_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<GitResult> {
  const scope = workflowScopePathspec(sourceRelativePath)
  const tracked = await git(
    directory,
    ["-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=no", "--", scope],
    timeoutMs,
    signal
  )
  if (tracked.code !== 0) return tracked
  const untracked = await git(
    directory,
    [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      scope,
      ":(top,glob,exclude)**/.cmbdevclaw/**"
    ],
    timeoutMs,
    signal
  )
  if (untracked.code !== 0) return untracked
  return {
    code: 0,
    stdout: `${tracked.stdout}${untracked.stdout}`,
    stderr: `${tracked.stderr}${untracked.stderr}`,
    infrastructureFailure: false
  }
}

interface SourceWorkspaceSnapshot {
  baseCommit: string
  sourceBranch?: string
}

function parseSourceWorkspaceSnapshot(result: GitResult): SourceWorkspaceSnapshot {
  if (result.code !== 0) {
    throw new GitWorktreeError(
      `cannot inspect source workspace before worktree isolation (${gitFailure(result, "git status failed")})`
    )
  }
  const lines = result.stdout.split(/\r?\n/).filter(Boolean)
  const oid =
    lines
      .find((line) => line.startsWith("# branch.oid "))
      ?.slice(13)
      .trim() ?? ""
  const branch =
    lines
      .find((line) => line.startsWith("# branch.head "))
      ?.slice(14)
      .trim() ?? ""
  if (!/^[0-9a-f]{40,64}$/i.test(oid) || !branch) {
    throw new GitWorktreeError("cannot resolve a stable source HEAD for worktree isolation")
  }
  return {
    baseCommit: oid,
    sourceBranch: branch === "(detached)" ? undefined : branch
  }
}

/** Git porcelain v2 reports branch and OID from one status snapshot. Read it
 * twice so an IDE branch switch/ref advance cannot pair one branch name with
 * another branch's commit. Source checkout changes are deliberately ignored:
 * the isolated checkout starts from the committed HEAD, matching Git worktree
 * and Claude Code semantics. */
async function inspectSourceWorkspaceForProvisioning(
  directory: string,
  sourceRelativePath: string,
  timeoutMs = GIT_QUERY_TIMEOUT_MS,
  signal?: AbortSignal,
  afterInitialSnapshot?: () => void | Promise<void>,
  processTestOverride?: GitProcessTestOverride
): Promise<SourceWorkspaceSnapshot> {
  const scope = workflowScopePathspec(sourceRelativePath)
  const statusArgs = [
    "-c",
    "core.fsmonitor=false",
    "status",
    "--porcelain=v2",
    "--branch",
    "--untracked-files=no",
    "--",
    scope
  ]
  const before = parseSourceWorkspaceSnapshot(
    await git(directory, statusArgs, timeoutMs, signal, processTestOverride)
  )
  // Deterministic concurrency-test seam. Production callers omit it; the
  // callback lets the Windows regression switch branches at the exact boundary
  // without relying on PATH shell wrappers that cannot intercept git.exe.
  await afterInitialSnapshot?.()
  const after = parseSourceWorkspaceSnapshot(
    await git(directory, statusArgs, timeoutMs, signal, processTestOverride)
  )
  if (before.baseCommit !== after.baseCommit || before.sourceBranch !== after.sourceBranch) {
    throw new GitWorktreeError(
      "source HEAD changed while preparing worktree isolation; retry after branch activity stops",
      "source-busy"
    )
  }
  return after
}

/** Resolve a path to its real location, tolerating a not-yet-existing target.
 *
 * `realpath` only succeeds for an existing leaf.  For a missing worktree below
 * a symlinked parent (the usual macOS `/var` -> `/private/var` case), retain the
 * missing suffix but canonicalize the deepest existing parent.  Ownership and
 * terminal-cleanup checks must compare the same spelling on both sides even
 * after Git has removed the checkout directory.
 */
async function canonicalPath(input: string): Promise<string> {
  let candidate = path.resolve(input)
  const missingSuffix: string[] = []
  while (true) {
    try {
      return path.normalize(path.join(await fs.realpath(candidate), ...missingSuffix))
    } catch {
      const parent = path.dirname(candidate)
      if (parent === candidate) return path.normalize(path.resolve(input))
      missingSuffix.unshift(path.basename(candidate))
      candidate = parent
    }
  }
}

/** Destructive/execution boundaries must never fall back to a lexical path: a
 * symlink or inaccessible component is exactly where containment checks need to
 * fail closed. */
async function canonicalExistingPath(input: string, label: string): Promise<string> {
  try {
    return path.normalize(await fs.realpath(path.resolve(input)))
  } catch (error) {
    throw new GitWorktreeError(
      `cannot resolve ${label} "${input}": ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function isPathInsideOrSame(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}

interface RepoIdentity {
  /** Primary checkout when discoverable; otherwise the actual source checkout. */
  gitRoot: string
  /** The actual checkout containing the requested workspace path. */
  sourceRoot: string
  /** `--git-common-dir` resolved absolute — the shared ref/object store. Identical
   * for the primary checkout and every worktree of the same repository. */
  commonDir: string
}

/**
 * Identify the repository owning `directory`. Returns null when it is not a git
 * repository (the caller degrades to "no isolation available" rather than failing
 * the whole run).
 *
 * `gitRoot` deliberately resolves to the PRIMARY checkout even when `directory` is
 * itself a linked worktree, using Git's porcelain worktree list (not path
 * arithmetic, which fails for submodules/separate git dirs). `sourceRoot` remains
 * the actual checkout so isolation pins that checkout's HEAD.
 */
export async function identifyRepository(
  directory: string,
  signal?: AbortSignal
): Promise<RepoIdentity | null> {
  // Resolve Git's relative output ourselves instead of using
  // `--path-format=absolute`. Older Git for Windows (including 2.18) echoes that
  // unknown option to stdout while still exiting successfully, which can turn
  // `--path-format=absolute\n.git` into a fictitious filesystem path.
  const commonRaw = await git(
    directory,
    ["rev-parse", "--git-common-dir"],
    GIT_QUERY_TIMEOUT_MS,
    signal
  )
  if (commonRaw.code !== 0) return null
  const commonValue = commonRaw.stdout.trim()
  if (!commonValue) return null
  const commonDir = await canonicalExistingPath(
    path.resolve(directory, commonValue),
    "git common directory"
  )
  const sourceTop = await git(
    directory,
    ["rev-parse", "--show-toplevel"],
    GIT_QUERY_TIMEOUT_MS,
    signal
  )
  if (sourceTop.code !== 0 || !sourceTop.stdout.trim()) return null
  const sourceRoot = await canonicalExistingPath(sourceTop.stdout.trim(), "source checkout")

  // Do not derive the primary checkout from `dirname(commonDir)`: that is wrong
  // for submodules and --separate-git-dir repositories. Git's own worktree list is
  // authoritative; the first non-bare entry is the primary checkout.
  const listed = await git(
    sourceRoot,
    ["worktree", "list", "--porcelain"],
    GIT_QUERY_TIMEOUT_MS,
    signal
  )
  const primary = listed.code === 0 ? parseWorktreeList(listed.stdout)[0]?.path : undefined
  const gitRoot = primary
    ? await canonicalExistingPath(primary, "primary checkout")
    : sourceRoot
  return { gitRoot, sourceRoot, commonDir }
}

/**
 * Serialize a caller-owned Git worktree mutation with every workflow worktree
 * mutation for the same repository. The canonical common directory is the only
 * stable lock identity shared by a primary checkout and all linked worktrees.
 */
export async function withGitWorktreeRepositoryLock<T>(
  directory: string,
  task: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const repo = await identifyRepository(directory, signal)
  if (!repo) {
    throw new GitWorktreeError(
      `worktree mutation needs a git repository — "${directory}" is not inside one`
    )
  }
  return withRepoLock(canonicalKey(repo.commonDir), async () => {
    if (signal?.aborted) {
      throw new GitWorktreeError("worktree mutation was cancelled", "source-busy")
    }
    return task()
  })
}

export interface WorkflowWorktreeSource extends RepoIdentity {
  workspacePath: string
  sourceRelativePath: string
  baseCommit: string
  sourceBranch: string
}

/** Capture the exact source checkout and committed base once for a ledger/fan-out.
 * As with Claude Code and native `git worktree add`, staged, unstaged, and
 * untracked source-checkout changes are not copied into the isolated checkout. */
export async function prepareWorkflowWorktreeSource(
  workspacePath: string,
  signal?: AbortSignal,
  testHooks?: {
    afterInitialSnapshot?: () => void | Promise<void>
    /** @internal Replace only the two status probes in process-lifecycle tests. */
    processTestOverride?: GitProcessTestOverride
  }
): Promise<WorkflowWorktreeSource> {
  const workspace = await canonicalPath(workspacePath)
  const repo = await identifyRepository(workspace, signal)
  if (signal?.aborted) {
    throw new GitWorktreeError("workflow worktree preparation was cancelled", "source-busy")
  }
  if (!repo) {
    throw new GitWorktreeError(
      `worktree isolation needs a git repository — "${workspacePath}" is not inside one`
    )
  }
  const sourceRoot = await canonicalPath(repo.sourceRoot)
  const relative = path.relative(sourceRoot, workspace)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new GitWorktreeError(`workspace "${workspacePath}" is outside its git checkout`)
  }
  const sourceRelativePath = relative === "." ? "" : relative
  const snapshot = await inspectSourceWorkspaceForProvisioning(
    sourceRoot,
    sourceRelativePath,
    getWorkflowWorktreeTimeoutMs(),
    signal,
    testHooks?.afterInitialSnapshot,
    testHooks?.processTestOverride
  )
  if (!snapshot.sourceBranch) {
    throw new GitWorktreeError(
      "worktree isolation requires the source checkout to be attached to a branch; check out the intended target branch first"
    )
  }
  return {
    ...repo,
    sourceRoot,
    workspacePath: workspace,
    sourceRelativePath,
    baseCommit: snapshot.baseCommit,
    sourceBranch: snapshot.sourceBranch
  }
}

function worktreeRootFor(commonDir: string, appDataRoot: string): string {
  return path.join(appDataRoot, WORKTREE_ROOT_DIR_NAME, repoKeyFor(commonDir))
}

function worktreeRecordsRootFor(commonDir: string, appDataRoot: string): string {
  return path.join(worktreeRootFor(commonDir, appDataRoot), WORKTREE_RECORDS_DIR_NAME)
}

/** Default app data root. Honors CMB_COWORK_AGENT_HOME like every other
 * app-managed store; explicit `appDataRoot` arguments remain test seams. */
function defaultWorktreeAppDataRoot(): string {
  return getCmbCoworkAgentDataRoot()
}

let legacyWorktreeAppDataRootForTest: string | undefined

function legacyHomeWorktreeAppDataRoot(): string {
  return legacyWorktreeAppDataRootForTest ?? path.join(homedir(), ".cmbcoworkagent")
}

/** @internal Standalone regression seam; production never overrides homedir(). */
export function setLegacyWorktreeAppDataRootForTest(root?: string): void {
  legacyWorktreeAppDataRootForTest = root ? path.resolve(root) : undefined
}

/** New records always use the configured root. Omitted roots on READ/ACTION
 * paths additionally discover the pre-contract home root so enabling
 * CMB_COWORK_AGENT_HOME cannot strand an existing linked checkout. */
function worktreeAppDataReadRoots(explicitRoot?: string): string[] {
  const roots = explicitRoot
    ? [path.resolve(explicitRoot)]
    : [defaultWorktreeAppDataRoot(), legacyHomeWorktreeAppDataRoot()]
  const seen = new Set<string>()
  return roots.filter((root) => {
    const key = canonicalKey(path.resolve(root))
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const workflowWorktreeRecordRoots = new WeakMap<WorkflowWorktreeRecord, string>()

function rememberWorkflowWorktreeRecordRoot(
  record: WorkflowWorktreeRecord,
  appDataRoot: string
): WorkflowWorktreeRecord {
  workflowWorktreeRecordRoots.set(record, appDataRoot)
  return record
}

function workflowWorktreeOwnershipIdentity(record: WorkflowWorktreeRecord): string {
  return JSON.stringify({
    id: record.id,
    runId: record.runId,
    threadId: record.threadId,
    branch: record.branch,
    directory: canonicalKey(record.directory),
    workspaceDirectory: canonicalKey(record.workspaceDirectory),
    sourceRoot: canonicalKey(record.sourceRoot),
    sourceRelativePath: record.sourceRelativePath,
    sourceBranch: record.sourceBranch,
    gitRoot: canonicalKey(record.gitRoot),
    commonDir: canonicalKey(record.commonDir),
    baseCommit: record.baseCommit
  })
}

function newerLocatedWorkflowWorktreeRecord(
  left: WorkflowWorktreeRecord,
  right: WorkflowWorktreeRecord
): WorkflowWorktreeRecord {
  return Date.parse(right.updatedAt) > Date.parse(left.updatedAt) ? right : left
}

function worktreeRecordPath(commonDir: string, id: string, appDataRoot: string): string {
  const readable = sanitizeNameComponent(id) || "worktree"
  // `sanitizeNameComponent` intentionally truncates readable names. Never use
  // that truncated value as the identity by itself: repeated long labels would
  // otherwise overwrite each other's ownership manifests and make one changed
  // branch invisible to crash recovery.
  const identity = createHash("sha256").update(id).digest("hex").slice(0, 16)
  return path.join(worktreeRecordsRootFor(commonDir, appDataRoot), `${readable}-${identity}.json`)
}

function isWorkflowWorktreeRecord(value: unknown): value is WorkflowWorktreeRecord {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  const validStatuses = new Set([
    "provisioning",
    "running",
    "ready",
    "recoverable",
    "integrating",
    "merged",
    "discarded"
  ])
  return (
    typeof record.id === "string" &&
    typeof record.runId === "string" &&
    typeof record.threadId === "string" &&
    typeof record.branch === "string" &&
    record.branch.startsWith(`${WORKFLOW_WORKTREE_BRANCH_PREFIX}/`) &&
    typeof record.directory === "string" &&
    typeof record.workspaceDirectory === "string" &&
    typeof record.sourceRoot === "string" &&
    typeof record.sourceRelativePath === "string" &&
    typeof record.sourceBranch === "string" &&
    typeof record.gitRoot === "string" &&
    typeof record.commonDir === "string" &&
    typeof record.baseCommit === "string" &&
    /^[0-9a-f]{40,64}$/i.test(record.baseCommit) &&
    (record.headCommit === undefined ||
      (typeof record.headCommit === "string" && /^[0-9a-f]{40,64}$/i.test(record.headCommit))) &&
    (record.integrationParent === undefined ||
      (typeof record.integrationParent === "string" &&
        /^[0-9a-f]{40,64}$/i.test(record.integrationParent))) &&
    (record.integrationCommit === undefined ||
      (typeof record.integrationCommit === "string" &&
        /^[0-9a-f]{40,64}$/i.test(record.integrationCommit))) &&
    typeof record.dirty === "boolean" &&
    typeof record.status === "string" &&
    validStatuses.has(record.status) &&
    (record.cleanupPending === undefined || typeof record.cleanupPending === "boolean") &&
    (record.error === undefined || typeof record.error === "string") &&
    typeof record.updatedAt === "string"
  )
}

/** Atomically persist one worktree ownership record. Per-record files avoid lost
 * updates when several fan-out agents settle concurrently. */
export async function persistWorkflowWorktreeRecord(
  record: WorkflowWorktreeRecord,
  appDataRoot = defaultWorktreeAppDataRoot()
): Promise<void> {
  const target = worktreeRecordPath(record.commonDir, record.id, appDataRoot)
  const recordsRoot = path.dirname(target)
  await fs.mkdir(recordsRoot, { recursive: true })
  const temp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  const handle = await fs.open(temp, "w", 0o600)
  let writeComplete = false
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8")
    await handle.sync()
    writeComplete = true
  } finally {
    await handle.close()
    if (!writeComplete) await fs.rm(temp, { force: true }).catch(() => undefined)
  }
  try {
    await fs.rename(temp, target)
    // Persist the directory entry as well. Some Windows filesystems reject
    // syncing directory handles, so durability there remains best-effort.
    const directory = await fs.open(recordsRoot, "r").catch(() => null)
    if (directory) {
      await directory.sync().catch(() => undefined)
      await directory.close().catch(() => undefined)
    }
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function deleteWorkflowWorktreeRecord(
  commonDir: string,
  id: string,
  appDataRoot = defaultWorktreeAppDataRoot()
): Promise<void> {
  await fs.rm(worktreeRecordPath(commonDir, id, appDataRoot), { force: true })
}

async function deleteMatchingWorkflowWorktreeRecordCopies(
  expected: WorkflowWorktreeRecord,
  appDataRoot?: string
): Promise<void> {
  const authorizedPaths: string[] = []
  for (const sourceRoot of worktreeAppDataReadRoots(appDataRoot)) {
    const pathToRecord = worktreeRecordPath(expected.commonDir, expected.id, sourceRoot)
    try {
      const parsed: unknown = JSON.parse(
        (await readStableWorktreeFile(pathToRecord, WORKFLOW_WORKTREE_RECORD_MAX_BYTES)).toString(
          "utf8"
        )
      )
      if (
        !isWorkflowWorktreeRecord(parsed) ||
        workflowWorktreeOwnershipIdentity(parsed) !==
          workflowWorktreeOwnershipIdentity(expected)
      ) {
        throw new GitWorktreeError(
          `workflow worktree "${expected.id}" has a conflicting ownership manifest`,
          "unsafe-state"
        )
      }
      authorizedPaths.push(pathToRecord)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
  }
  // Validate every compatibility copy before deleting any of them. A conflict
  // in the lower-authority root must fail closed without first erasing the
  // configured-root ownership proof.
  await Promise.all(authorizedPaths.map((pathToRecord) => fs.rm(pathToRecord, { force: true })))
}

class WorkflowWorktreeRecordScanLimitError extends GitWorktreeError {
  constructor(message: string) {
    super(message, "unsafe-state")
    this.name = "WorkflowWorktreeRecordScanLimitError"
  }
}

interface WorkflowWorktreeRecordScanBudget {
  directoryEntries: number
  files: number
  processedFiles: number
  totalBytes: number
}

/** @internal Observable limits for pressure regressions. */
export function getWorkflowWorktreeRecordScanLimitsForTest(): {
  maxRecordBytes: number
  maxFiles: number
  maxDirectoryEntries: number
  maxTotalBytes: number
} {
  return {
    maxRecordBytes: WORKFLOW_WORKTREE_RECORD_MAX_BYTES,
    maxFiles: WORKFLOW_WORKTREE_RECORD_SCAN_MAX_FILES,
    maxDirectoryEntries: WORKFLOW_WORKTREE_RECORD_SCAN_MAX_DIRECTORY_ENTRIES,
    maxTotalBytes: WORKFLOW_WORKTREE_RECORD_SCAN_MAX_TOTAL_BYTES
  }
}

async function yieldWorkflowWorktreeRecordScan(counter: number): Promise<void> {
  if (counter % WORKFLOW_WORKTREE_RECORD_SCAN_YIELD_EVERY !== 0) return
  await new Promise<void>((resolveYield) => setImmediate(resolveYield))
}

async function listBoundedWorkflowWorktreeRecordNames(
  root: string,
  budget: WorkflowWorktreeRecordScanBudget
): Promise<string[]> {
  const directory = await fs.opendir(root)
  const names: string[] = []
  try {
    for await (const entry of directory) {
      budget.directoryEntries += 1
      if (budget.directoryEntries > WORKFLOW_WORKTREE_RECORD_SCAN_MAX_DIRECTORY_ENTRIES) {
        throw new WorkflowWorktreeRecordScanLimitError(
          "workflow worktree record directory exceeds the safe entry limit"
        )
      }
      if (entry.name.endsWith(".json")) {
        budget.files += 1
        if (budget.files > WORKFLOW_WORKTREE_RECORD_SCAN_MAX_FILES) {
          throw new WorkflowWorktreeRecordScanLimitError(
            "workflow worktree record count exceeds the safe limit"
          )
        }
        names.push(entry.name)
      }
      await yieldWorkflowWorktreeRecordScan(budget.directoryEntries)
    }
  } finally {
    await directory.close().catch(() => undefined)
  }
  return names.sort()
}

async function scanWorkflowWorktreeRecords(
  commonDir: string,
  appDataRoot: string | undefined,
  failClosedResult: boolean
): Promise<{ records: WorkflowWorktreeRecord[]; reliable: boolean }> {
  const records = new Map<string, WorkflowWorktreeRecord>()
  const conflictedIds = new Set<string>()
  const budget: WorkflowWorktreeRecordScanBudget = {
    directoryEntries: 0,
    files: 0,
    processedFiles: 0,
    totalBytes: 0
  }
  let reliable = true

  for (const sourceRoot of worktreeAppDataReadRoots(appDataRoot)) {
    const root = worktreeRecordsRootFor(commonDir, sourceRoot)
    let names: string[]
    try {
      names = await listBoundedWorkflowWorktreeRecordNames(root, budget)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      if (error instanceof WorkflowWorktreeRecordScanLimitError) {
        if (!failClosedResult) throw error
        return { records: Array.from(records.values()), reliable: false }
      }
      if (failClosedResult) reliable = false
      continue
    }

    for (const name of names) {
      try {
        const bytes = await readStableWorktreeFile(
          path.join(root, name),
          WORKFLOW_WORKTREE_RECORD_MAX_BYTES
        )
        budget.totalBytes += bytes.byteLength
        if (budget.totalBytes > WORKFLOW_WORKTREE_RECORD_SCAN_MAX_TOTAL_BYTES) {
          throw new WorkflowWorktreeRecordScanLimitError(
            "workflow worktree record data exceeds the safe total-byte limit"
          )
        }
        const parsed: unknown = JSON.parse(bytes.toString("utf8"))
        if (!isWorkflowWorktreeRecord(parsed)) {
          reliable = false
          continue
        }
        const located = rememberWorkflowWorktreeRecordRoot(parsed, sourceRoot)
        if (conflictedIds.has(located.id)) continue
        const existing = records.get(located.id)
        if (
          existing &&
          workflowWorktreeOwnershipIdentity(existing) !==
            workflowWorktreeOwnershipIdentity(located)
        ) {
          if (!failClosedResult) {
            throw new GitWorktreeError(
              `conflicting ownership manifests exist for workflow worktree "${located.id}"`,
              "unsafe-state"
            )
          }
          reliable = false
          conflictedIds.add(located.id)
          records.delete(located.id)
          continue
        }
        records.set(
          located.id,
          existing ? newerLocatedWorkflowWorktreeRecord(existing, located) : located
        )
      } catch (error) {
        if (error instanceof WorkflowWorktreeRecordScanLimitError) {
          if (!failClosedResult) throw error
          return { records: Array.from(records.values()), reliable: false }
        }
        if (error instanceof GitWorktreeError && !failClosedResult) throw error
        reliable = false
      }
      budget.processedFiles += 1
      await yieldWorkflowWorktreeRecordScan(budget.processedFiles)
    }
  }
  return { records: Array.from(records.values()), reliable }
}

export async function listWorkflowWorktreeRecords(
  commonDir: string,
  appDataRoot?: string
): Promise<WorkflowWorktreeRecord[]> {
  return (await scanWorkflowWorktreeRecords(commonDir, appDataRoot, false)).records
}

/** Prune needs to distinguish a genuinely absent store from an unreadable or
 * corrupt one. The normal list API intentionally hides those failures for UI
 * hydration; this variant is fail-closed for destructive history pruning. */
export async function listWorkflowWorktreeRecordsForPrune(
  commonDir: string,
  appDataRoot?: string
): Promise<{ records: WorkflowWorktreeRecord[]; reliable: boolean }> {
  return scanWorkflowWorktreeRecords(commonDir, appDataRoot, true)
}

/** A managed checkout is manually removable only after ownership is terminal. */
export function findBlockingWorkflowWorktreeOwnership(
  records: readonly WorkflowWorktreeRecord[],
  directory: string
): WorkflowWorktreeRecord | null {
  const targetKey = canonicalKey(directory)
  return (
    records.find(
      (record) =>
        canonicalKey(record.directory) === targetKey &&
        ((record.status !== "merged" && record.status !== "discarded") ||
          record.cleanupPending === true)
    ) ?? null
  )
}

async function readWorkflowWorktreeRecord(
  commonDir: string,
  id: string,
  appDataRoot?: string
): Promise<WorkflowWorktreeRecord | undefined> {
  let selected: WorkflowWorktreeRecord | undefined
  for (const sourceRoot of worktreeAppDataReadRoots(appDataRoot)) {
    const recordPath = worktreeRecordPath(commonDir, id, sourceRoot)
    try {
      const parsed: unknown = JSON.parse(
        (
          await readStableWorktreeFile(
            recordPath,
            WORKFLOW_WORKTREE_RECORD_MAX_BYTES
          )
        ).toString("utf8")
      )
      // A sibling root is part of the same ownership proof. Ignoring a corrupt,
      // oversized, or foreign same-id manifest and accepting a valid copy from
      // another root would let a destructive action proceed through ambiguous
      // state. Point actions therefore fail closed even though the broad UI list
      // remains best-effort.
      if (!isWorkflowWorktreeRecord(parsed) || parsed.id !== id) {
        throw new GitWorktreeError(
          `workflow worktree "${id}" has an invalid ownership manifest`,
          "unsafe-state"
        )
      }
      const located = rememberWorkflowWorktreeRecordRoot(parsed, sourceRoot)
      if (
        selected &&
        workflowWorktreeOwnershipIdentity(selected) !==
          workflowWorktreeOwnershipIdentity(located)
      ) {
        throw new GitWorktreeError(
          `conflicting ownership manifests exist for workflow worktree "${id}"`,
          "unsafe-state"
        )
      }
      selected = selected ? newerLocatedWorkflowWorktreeRecord(selected, located) : located
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      if (error instanceof GitWorktreeError) throw error
      throw new GitWorktreeError(
        `workflow worktree "${id}" has an unreadable ownership manifest at ${recordPath}`,
        "unsafe-state"
      )
    }
  }
  return selected
}

async function loadCurrentWorkflowWorktreeRecord(
  expected: WorkflowWorktreeRecord,
  appDataRoot?: string
): Promise<WorkflowWorktreeRecord> {
  const current = await readWorkflowWorktreeRecord(expected.commonDir, expected.id, appDataRoot)
  if (!current) {
    throw new GitWorktreeError(
      `workflow worktree "${expected.id}" is no longer actionable; refresh run history`
    )
  }
  if (
    workflowWorktreeOwnershipIdentity(current) !==
    workflowWorktreeOwnershipIdentity(expected)
  ) {
    throw new GitWorktreeError("workflow worktree ownership changed; refusing stale action")
  }
  return current
}

function locatedWorkflowWorktreeAppDataRoot(
  record: WorkflowWorktreeRecord,
  explicitRoot?: string
): string {
  return (
    workflowWorktreeRecordRoots.get(record) ??
    (explicitRoot ? path.resolve(explicitRoot) : defaultWorktreeAppDataRoot())
  )
}

function sanitizeNameComponent(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 40)
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function isDefinitelyMissingPath(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return false
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "ENOENT" || code === "ENOTDIR"
  }
}

const WORKTREE_HOOK_RUNTIME_ENTRIES = new Set([
  "conversation_history",
  "coordinator",
  "large_tool_results",
  "setup-state.json",
  "workflows"
])

/** Workspace hook configuration is loaded from the source checkout, while hook
 * commands run in the isolated checkout so their relative writes remain
 * isolated. Copy the hook-owned `.cmbdevclaw` support tree, not just `hooks/`:
 * command hooks commonly load sibling config, templates, or helpers. Runtime
 * state is deliberately omitted so a worktree never inherits another run's
 * journal, history, tool artifacts, or setup marker. All copied symlinks are
 * dereferenced and must remain within that support tree. */
async function materializeWorkspaceHookSupport(
  sourceWorkspace: string,
  targetWorkspace: string
): Promise<void> {
  const sourceSupport = path.join(sourceWorkspace, ".cmbdevclaw")
  const sourceHooks = path.join(sourceSupport, "hooks")
  let sourceHooksStat: Awaited<ReturnType<typeof fs.stat>>
  try {
    sourceHooksStat = await fs.stat(sourceHooks)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  if (!sourceHooksStat.isDirectory()) {
    throw new GitWorktreeError(`workspace hook path is not a directory: ${sourceHooks}`)
  }
  const canonicalSupport = await fs.realpath(sourceSupport)
  const targetSupport = path.join(targetWorkspace, ".cmbdevclaw")
  await fs.cp(canonicalSupport, targetSupport, {
    recursive: true,
    // This is a new worktree. Untracked hook support has no destination yet,
    // while tracked support was already checked out by Git. Do not overwrite
    // the latter: dereferencing a tracked symlink would make a no-op worktree
    // dirty. No per-file Git inventory is needed.
    force: false,
    dereference: true,
    filter: async (candidate) => {
      const resolved = await fs.realpath(candidate)
      if (!isPathInsideOrSame(resolved, canonicalSupport)) {
        throw new GitWorktreeError(`workspace hook support path escapes .cmbdevclaw: ${candidate}`)
      }
      const relative = path.relative(canonicalSupport, resolved)
      const firstSegment = relative.split(path.sep)[0]
      if (WORKTREE_HOOK_RUNTIME_ENTRIES.has(firstSegment)) return false
      return true
    }
  })
}

interface CreateWorkflowWorktreeInput {
  /** Any directory inside the repository — usually the run's workspace path. */
  workspacePath: string
  /** Run id, used for the branch/directory name and ownership attribution. */
  runId: string
  /** Owning thread. Lets restart reconciliation recover a manifest that landed
   * before the throttled run snapshot gained its worktree entry. */
  threadId?: string
  /** Short label (agent index / role) folded into the name for readability. */
  label?: string
  /** Override the app data root. Tests only. */
  appDataRoot?: string
  /** Frozen source shared by every worktree in one run. */
  source?: WorkflowWorktreeSource
  /** When true, persist ownership BEFORE git worktree add
   * so a crash after checkout creation cannot leave an unattributed directory. */
  persistOwnership?: boolean
  /** Cancels a long checkout promptly during workflow abort/shutdown. */
  signal?: AbortSignal
}

/**
 * Create a fresh worktree checked out on a NEW branch at the repository's current
 * HEAD, and return its identity.
 *
 * Everything from name selection through the HEAD assertion runs under the
 * repository lock, so a concurrent creator can neither claim the same name nor
 * clobber the ref while it is being written.
 */
export async function createWorkflowWorktree(
  input: CreateWorkflowWorktreeInput
): Promise<WorkflowWorktreeInfo> {
  if (input.signal?.aborted) throw new GitWorktreeError("worktree creation was cancelled")
  const source =
    input.source ?? (await prepareWorkflowWorktreeSource(input.workspacePath, input.signal))
  const repo: RepoIdentity = source
  const appDataRoot = input.appDataRoot ?? defaultWorktreeAppDataRoot()
  const root = worktreeRootFor(repo.commonDir, appDataRoot)
  const runShort = sanitizeNameComponent(input.runId.replace(/^wf_/, "")) || "run"
  const labelPart = input.label ? sanitizeNameComponent(input.label) : ""

  return withRepoLock(canonicalKey(repo.commonDir), async () => {
    await fs.mkdir(root, { recursive: true })
    await writeWorkflowWorktreeExcludesFile(
      repo.sourceRoot,
      path.join(root, WORKTREE_INTERNAL_EXCLUDES_FILE_NAME),
      input.signal
    )

    const info = await pickAvailableName(repo, source, root, runShort, labelPart)

    let ownershipRecord: WorkflowWorktreeRecord | undefined
    if (input.persistOwnership) {
      const now = new Date().toISOString()
      ownershipRecord = {
        id: info.name,
        runId: input.runId,
        threadId: input.threadId ?? input.runId,
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
        status: "provisioning",
        updatedAt: now
      }
      await persistWorkflowWorktreeRecord(ownershipRecord, appDataRoot)
    }

    const created = await git(
      source.sourceRoot,
      [
        ...GIT_NO_HOOKS_ARGS,
        "worktree",
        "add",
        "-b",
        info.branch,
        info.directory,
        source.baseCommit
      ],
      getWorkflowWorktreeTimeoutMs(),
      input.signal
    )
    if (created.code !== 0) {
      let cleanupError: unknown
      try {
        await removeWorkflowWorktree({
          directory: info.directory,
          gitRoot: repo.gitRoot,
          branch: info.branch,
          expectedBranchHead: info.baseCommit,
          preserveChanges: true
        })
        if (ownershipRecord) {
          await deleteWorkflowWorktreeRecord(repo.commonDir, ownershipRecord.id, appDataRoot)
        }
      } catch (error) {
        cleanupError = error
        if (ownershipRecord) {
          await persistWorkflowWorktreeRecord(
            {
              ...ownershipRecord,
              status: "recoverable",
              error: `worktree creation failed and partial checkout cleanup is pending: ${error instanceof Error ? error.message : String(error)}`,
              updatedAt: new Date().toISOString()
            },
            appDataRoot
          ).catch(() => undefined)
        }
      }
      const detail = gitFailure(created, "git worktree add failed")
      throw new GitWorktreeError(
        cleanupError
          ? `${detail}; partial checkout retained for recovery (${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)})`
          : detail
      )
    }

    const failProvisioningValidation = async (message: string): Promise<never> => {
      let cleaned = false
      try {
        await removeWorkflowWorktree({
          directory: info.directory,
          gitRoot: repo.gitRoot,
          branch: info.branch,
          expectedBranchHead: info.baseCommit,
          preserveChanges: true
        })
        cleaned = true
      } catch (error) {
        if (ownershipRecord) {
          await persistWorkflowWorktreeRecord(
            {
              ...ownershipRecord,
              status: "recoverable",
              error: `${message}; cleanup is pending: ${error instanceof Error ? error.message : String(error)}`,
              updatedAt: new Date().toISOString()
            },
            appDataRoot
          ).catch(() => undefined)
        }
      }
      if (cleaned && ownershipRecord) {
        await deleteWorkflowWorktreeRecord(repo.commonDir, ownershipRecord.id, appDataRoot).catch(
          () => undefined
        )
      }
      throw new GitWorktreeError(message)
    }

    // Assert HEAD is attached to the branch we asked for. A detached or wrong HEAD
    // here would let the agent commit onto a ref nothing points at — the work would
    // survive as a dangling object but the branch would never advance, so the
    // deliverable would look empty. Fail loudly and clean up instead.
    const symbolic = await git(info.directory, ["symbolic-ref", "--quiet", "HEAD"])
    const head = symbolic.stdout.trim()
    const expected = `refs/heads/${info.branch}`
    if (symbolic.code !== 0 || head !== expected) {
      await failProvisioningValidation(
        `worktree HEAD is not attached to ${expected} (got ${head || "detached HEAD"})`
      )
    }

    // Git does not materialize empty or ignored-only directories. The assigned
    // workspace must nevertheless exist before the isolated runtime canonicalizes
    // its cwd.
    if (info.sourceRelativePath) {
      try {
        await fs.mkdir(info.workspaceDirectory, { recursive: true })
      } catch (error) {
        await failProvisioningValidation(
          `cannot create isolated workspace directory ${info.workspaceDirectory}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
    try {
      await materializeWorkspaceHookSupport(source.workspacePath, info.workspaceDirectory)
    } catch (error) {
      await failProvisioningValidation(
        `cannot materialize workspace hooks in ${info.workspaceDirectory}: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    return info
  })
}

/** Find a `<name>` whose directory is free AND whose branch ref does not exist.
 * Called under the repo lock, so the answer stays valid until `worktree add`. */
async function pickAvailableName(
  repo: RepoIdentity,
  source: WorkflowWorktreeSource,
  root: string,
  runShort: string,
  labelPart: string
): Promise<WorkflowWorktreeInfo> {
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    const suffix = randomBytes(4).toString("hex")
    const name = [runShort, labelPart, suffix].filter(Boolean).join("-")
    const branch = `${WORKFLOW_WORKTREE_BRANCH_PREFIX}/${runShort}/${labelPart || "agent"}-${suffix}`
    const directory = path.join(root, name)

    if (await pathExists(directory)) continue
    const refCheck = await git(repo.gitRoot, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`
    ])
    if (refCheck.code === 0) continue

    return {
      name,
      branch,
      directory,
      workspaceDirectory: source.sourceRelativePath
        ? path.join(directory, source.sourceRelativePath)
        : directory,
      gitRoot: repo.gitRoot,
      sourceRoot: source.sourceRoot,
      sourceRelativePath: source.sourceRelativePath,
      commonDir: repo.commonDir,
      sourceBranch: source.sourceBranch,
      baseCommit: source.baseCommit
    }
  }
  throw new GitWorktreeError(
    `failed to allocate a unique worktree name after ${MAX_NAME_ATTEMPTS} attempts`
  )
}

/**
 * Resolve the shell boundary from Git's live registry. This deliberately runs
 * after `worktree add`: the per-worktree gitdir and branch registration are
 * authoritative only once Git has registered the checkout. The managed-root and
 * private-gitdir checks establish that the runtime is attached to the checkout
 * created by this app, rather than trusting paths supplied by a workflow script.
 */
export async function resolveWorkflowWorktreeIsolationBoundary(
  info: WorkflowWorktreeInfo,
  appDataRoot = defaultWorktreeAppDataRoot()
): Promise<WorkflowWorktreeIsolationBoundary> {
  const [workspaceRoot, worktreeRoot, commonDir, managedWorktreesRoot] = await Promise.all([
    canonicalExistingPath(info.workspaceDirectory, "isolated workspace"),
    canonicalExistingPath(info.directory, "worktree checkout"),
    canonicalExistingPath(info.commonDir, "git common directory"),
    canonicalExistingPath(worktreeRootFor(info.commonDir, appDataRoot), "managed worktree root")
  ])
  if (!isPathInsideOrSame(workspaceRoot, worktreeRoot)) {
    throw new GitWorktreeError("isolated workspace resolves outside its worktree checkout")
  }
  if (
    !isPathInsideOrSame(worktreeRoot, managedWorktreesRoot) ||
    worktreeRoot === managedWorktreesRoot
  ) {
    throw new GitWorktreeError("worktree checkout resolves outside the managed worktree root")
  }

  const gitDirResult = await git(worktreeRoot, ["rev-parse", "--absolute-git-dir"])
  if (gitDirResult.code !== 0 || !gitDirResult.stdout.trim()) {
    throw new GitWorktreeError(
      `cannot resolve isolated worktree gitdir (${gitFailure(gitDirResult, "git rev-parse failed")})`
    )
  }
  const worktreeGitDir = await canonicalExistingPath(
    gitDirResult.stdout.trim(),
    "isolated worktree gitdir"
  )
  if (!isPathInsideOrSame(worktreeGitDir, commonDir) || worktreeGitDir === commonDir) {
    throw new GitWorktreeError("isolated checkout does not use a private linked-worktree gitdir")
  }

  const listed = await git(info.gitRoot, ["worktree", "list", "--porcelain"])
  if (listed.code !== 0) {
    throw new GitWorktreeError(
      `cannot enumerate repository worktrees (${gitFailure(listed, "git worktree list failed")})`
    )
  }
  const ownRegistration = parseWorktreeList(listed.stdout).find(
    (entry) => canonicalKey(entry.path) === canonicalKey(worktreeRoot)
  )
  if (!ownRegistration) {
    throw new GitWorktreeError("isolated checkout is no longer registered by git")
  }
  if (ownRegistration.branch !== info.branch) {
    throw new GitWorktreeError(
      `isolated worktree registration moved from ${info.branch} to ${ownRegistration.branch ?? "detached HEAD"}`
    )
  }
  return {
    workspaceRoot,
    worktreeRoot,
    commonDir,
    branch: info.branch
  }
}

interface RemoveWorkflowWorktreeInput {
  directory: string
  gitRoot: string
  /** Branch to delete after the worktree is gone. Omit to leave the branch. */
  branch?: string
  /** Delete the branch only if it still points here. Used after integration so
   * an external late commit cannot be erased by a blind `branch -D`. */
  expectedBranchHead?: string
  /** Remove without `--force`; used for pristine/post-merge cleanup. */
  preserveChanges?: boolean
}

export interface AttemptedWorktreeCreationRollbackInput {
  directory: string
  gitRoot: string
  branch: string
  expectedBaseCommit: string
  /** Diagnostic preflight fact only. It is NOT ownership proof: an external Git
   * process can create the same ref after the check and before `worktree add`. */
  branchWasAbsentBeforeAttempt: boolean
}

/**
 * Reconcile an indeterminate `git worktree add` result. A timeout/non-zero exit
 * can arrive after Git created the ref, registration and directory, so cleanup
 * must inspect those durable side effects rather than trust a local `created`
 * boolean. Every deletion is fenced by exact path + branch + expected HEAD.
 */
export async function rollbackAttemptedWorktreeCreation(
  input: AttemptedWorktreeCreationRollbackInput
): Promise<boolean> {
  const directory = path.resolve(input.directory)
  const listed = await git(
    input.gitRoot,
    ["worktree", "list", "--porcelain"],
    getWorkflowWorktreeRemoveTimeoutMs()
  )
  if (listed.code !== 0) {
    throw new GitWorktreeError(
      `cannot inspect attempted worktree creation: ${gitFailure(listed, "worktree list failed")}`
    )
  }

  const registration = parseWorktreeList(listed.stdout).find(
    (entry) => canonicalKey(entry.path) === canonicalKey(directory)
  )
  if (registration) {
    if (
      registration.branch !== input.branch ||
      registration.head !== input.expectedBaseCommit
    ) {
      throw new GitWorktreeError(
        `refusing attempted-worktree rollback: ${directory} no longer matches ${input.branch}@${input.expectedBaseCommit}`
      )
    }
    return removeWorkflowWorktree({
      directory,
      gitRoot: input.gitRoot,
      branch: input.branch,
      expectedBranchHead: input.expectedBaseCommit,
      preserveChanges: true
    })
  }

  // Never recursively delete an unregistered directory: it may predate this
  // request or contain user data. Surface it for manual recovery instead.
  if (await pathExists(directory)) {
    throw new GitWorktreeError(
      `attempted worktree path exists without the expected Git registration: ${directory}`
    )
  }

  const branchHead = await git(input.gitRoot, [
    "show-ref",
    "--verify",
    "--hash",
    `refs/heads/${input.branch}`
  ])
  if (isMissingGitRef(branchHead)) return true
  if (branchHead.code !== 0) {
    throw new GitWorktreeError(
      `cannot inspect attempted worktree branch: ${gitFailure(branchHead, "branch query failed")}`
    )
  }

  // A preflight absence check is not atomic ownership: another Git process may
  // create this same branch at the same base commit before our `worktree add`
  // fails. Without the exact path+branch+HEAD registration above, retain every
  // existing ref and fail closed instead of risking deletion of external work.
  throw new GitWorktreeError(
    `attempted worktree branch ${input.branch}@${branchHead.stdout.trim()} has no matching worktree registration; it was retained for manual inspection`
  )
}

async function findUnavailableWorktreeRegistrations(
  gitRoot: string,
  targetDirectory: string
): Promise<string[]> {
  const listed = await git(gitRoot, ["worktree", "list", "--porcelain"])
  if (listed.code !== 0) return []

  const targetKey = canonicalKey(targetDirectory)
  const unavailable: string[] = []
  for (const entry of parseWorktreeList(listed.stdout)) {
    if (!entry.path || canonicalKey(entry.path) === targetKey) continue
    // This is diagnostic only. A permission error or temporarily unavailable
    // mount must not be presented as a stale registration the user should prune.
    if (await isDefinitelyMissingPath(entry.path)) unavailable.push(entry.path)
  }
  return unavailable
}

/**
 * Remove a worktree and (optionally) its branch. Idempotent: an already-removed
 * directory reports success.
 *
 * Ordering matters. `git worktree remove` is tried first so git's own
 * administrative files (`.git/worktrees/<name>`) are cleaned up properly. A Git
 * failure is retained for recovery — raw recursive deletion is never a fallback,
 * because it can lose gitignored/in-progress files and follow Windows junctions.
 *
 * A failed branch delete keeps the ownership manifest recoverable. Otherwise a
 * late commit can become an invisible dangling branch after the checkout is gone.
 */
export async function removeWorkflowWorktree(input: RemoveWorkflowWorktreeInput): Promise<boolean> {
  const directory = path.resolve(input.directory)

  // A clean/pristine cleanup and a post-merge cleanup both know the exact branch
  // tip they are allowed to remove. Check it BEFORE removing the checkout so an
  // external late commit leaves a fully usable worktree instead of only a
  // dangling recovery branch. `update-ref` below repeats this check atomically.
  if (input.branch && input.expectedBranchHead) {
    const current = await git(input.gitRoot, [
      "show-ref",
      "--verify",
      "--hash",
      `refs/heads/${input.branch}`
    ])
    if (current.code === 0 && current.stdout.trim() !== input.expectedBranchHead) {
      throw new GitWorktreeError(
        `refusing to remove worktree ${directory}: branch ${input.branch} advanced unexpectedly`
      )
    }
    const refMissing = isMissingGitRef(current)
    if (refMissing) {
      if (await pathExists(directory)) {
        throw new GitWorktreeError(
          `refusing to remove worktree ${directory}: expected branch ${input.branch} is missing`
        )
      }
    } else if (current.code !== 0) {
      throw new GitWorktreeError(
        `cannot verify branch ${input.branch} before worktree removal: ${gitFailure(current, "Git ref query failed")}`
      )
    }
  }

  // A file monitor daemon rooted in the worktree holds handles that make removal
  // fail on Windows (and leave stale state on macOS). Best-effort, and only when
  // the directory is still there.
  if (await pathExists(directory)) {
    await git(directory, ["fsmonitor--daemon", "stop"]).catch(() => undefined)
  }

  const removed = await git(
    input.gitRoot,
    [
      ...((await pathExists(
        path.join(path.dirname(directory), WORKTREE_INTERNAL_EXCLUDES_FILE_NAME)
      ))
        ? [
            "-c",
            `core.excludesFile=${path.join(
              path.dirname(directory),
              WORKTREE_INTERNAL_EXCLUDES_FILE_NAME
            )}`
          ]
        : []),
      ...GIT_NO_HOOKS_ARGS,
      "worktree",
      "remove",
      ...(input.preserveChanges ? [] : ["--force"]),
      directory
    ],
    getWorkflowWorktreeRemoveTimeoutMs()
  )

  // Git is the only automatic remover. A timeout, lock, submodule, ignored file,
  // junction, or other unexpected state must leave the directory recoverable.
  if (await pathExists(directory)) {
    const unavailableRegistrations = await findUnavailableWorktreeRegistrations(
      input.gitRoot,
      directory
    )
    const recoveryHint = unavailableRegistrations.length
      ? `\nGit also reports unavailable worktree registrations that may block cleanup:\n${unavailableRegistrations.map((entry) => `- ${entry}`).join("\n")}\nInspect them with \`git worktree prune --dry-run --verbose\`. Only after confirming those paths are permanently gone, run \`git worktree prune --verbose\` and retry Cleanup.`
      : ""
    throw new GitWorktreeError(
      `git did not remove worktree ${directory}: ${gitFailure(removed, "worktree remains on disk")}${recoveryHint}`
    )
  }
  if (removed.code !== 0) {
    // A missing directory is idempotent only when this exact worktree is also no
    // longer registered. Never use repository-wide `worktree prune`: that can
    // erase unrelated user worktrees whose network/removable paths are offline.
    const listed = await git(input.gitRoot, ["worktree", "list", "--porcelain"])
    if (listed.code !== 0) {
      throw new GitWorktreeError(
        `cannot verify removal of ${directory}: ${gitFailure(listed, "worktree list failed")}`
      )
    }
    const directoryKey = canonicalKey(await canonicalPath(directory))
    const stillRegistered = parseWorktreeList(listed.stdout).some(
      (entry) => canonicalKey(path.resolve(entry.path)) === directoryKey
    )
    if (stillRegistered) {
      throw new GitWorktreeError(
        `git did not unregister worktree ${directory}: ${gitFailure(removed, "worktree remove failed")}`
      )
    }
  }

  if (input.branch) {
    const deleted = input.expectedBranchHead
      ? await git(input.gitRoot, [
          ...GIT_NO_HOOKS_ARGS,
          "update-ref",
          "-d",
          `refs/heads/${input.branch}`,
          input.expectedBranchHead
        ])
      : await git(input.gitRoot, [...GIT_NO_HOOKS_ARGS, "branch", "-D", input.branch])
    // "not found" is the idempotent case (this removal already ran, or the branch
    // was never created), not a problem worth telling anyone about.
    if (deleted.code !== 0) {
      const remaining = await git(input.gitRoot, [
        "show-ref",
        "--verify",
        "--hash",
        `refs/heads/${input.branch}`
      ])
      const missing = isMissingGitRef(remaining)
      if (!missing) {
        throw new GitWorktreeError(
          `worktree was removed but branch ${input.branch} could not be safely verified/deleted (${gitFailure(deleted, "safe branch deletion failed")})`
        )
      }
    }
  }
  return true
}

/**
 * True when the worktree holds NO work: a clean status AND HEAD still at the
 * commit it was created from.
 *
 * Fails CLOSED (returns false = "has work") on every uncertainty — an unreadable
 * status, a git error, or an empty `baseCommit`. This predicate authorizes a
 * DELETE, so an unreliable answer must never be the one that discards an agent's
 * output.
 *
 * Untracked files count as work (`--porcelain` lists them), but files ignored by
 * the repository's own .gitignore do not — matching what a user would call "this
 * worktree has changes".
 */
export async function isWorktreePristine(directory: string, baseCommit: string): Promise<boolean> {
  if (!baseCommit) return false
  // core.fsmonitor=false: a stale monitor daemon can report a phantom dirty state,
  // and a false "dirty" here only costs a kept worktree — but a phantom CLEAN is
  // never produced by disabling it, so this makes the check strictly more truthful.
  const status = await inspectWorkspaceStatus(directory)
  if (status.code !== 0) return false
  if (status.stdout.trim() !== "") return false
  const head = await git(directory, ["rev-parse", "HEAD"])
  if (head.code !== 0) return false
  return head.stdout.trim() === baseCommit
}

export async function inspectWorkflowWorktree(
  directory: string,
  baseCommit: string,
  timeoutMs = GIT_QUERY_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<{ pristine: boolean; dirty: boolean; headCommit: string }> {
  const status = await inspectWorkspaceStatus(directory, "", timeoutMs, signal)
  const head = await git(directory, ["rev-parse", "HEAD"], GIT_QUERY_TIMEOUT_MS, signal)
  const headCommit = head.code === 0 ? head.stdout.trim() : ""
  // Unknown state fails non-destructively: non-pristine+dirty means callers retain it.
  if (!baseCommit || status.code !== 0 || head.code !== 0 || !headCommit) {
    return { pristine: false, dirty: true, headCommit }
  }
  const dirty = status.stdout.trim() !== ""
  const changed = dirty || headCommit !== baseCommit
  return { pristine: !changed, dirty, headCommit }
}

interface WorkflowWorktreeDiff {
  record: WorkflowWorktreeRecord
  /** Human-readable bounded summary: commits, diffstat, then working-tree status. */
  summary: string
}

interface WorkflowWorktreeActionResult {
  record: WorkflowWorktreeRecord
}

type ManagedCheckoutState = "registered" | "registered-damaged" | "missing" | "unregistered"
type ManagedWorkflowWorktree = RepoIdentity & { checkoutState: ManagedCheckoutState }

async function assertManagedWorkflowWorktree(
  record: WorkflowWorktreeRecord,
  workspacePath: string,
  appDataRoot: string,
  options?: { allowMissingCheckout?: boolean; allowUnregisteredCheckout?: boolean }
): Promise<ManagedWorkflowWorktree> {
  if (!record.branch.startsWith(`${WORKFLOW_WORKTREE_BRANCH_PREFIX}/`)) {
    throw new GitWorktreeError(`refusing to manage non-workflow branch "${record.branch}"`)
  }
  const workspaceRepo = await identifyRepository(workspacePath)
  if (!workspaceRepo)
    throw new GitWorktreeError("the workflow workspace is no longer a git repository")
  if (canonicalKey(workspaceRepo.commonDir) !== canonicalKey(record.commonDir)) {
    throw new GitWorktreeError("worktree ownership record does not belong to this workspace")
  }
  if (canonicalKey(workspaceRepo.sourceRoot) !== canonicalKey(record.sourceRoot)) {
    throw new GitWorktreeError("worktree ownership record targets a different source checkout")
  }

  const managedRoot = await canonicalPath(worktreeRootFor(record.commonDir, appDataRoot))
  const directory = await canonicalPath(record.directory)
  if (!canonicalKey(directory).startsWith(`${canonicalKey(managedRoot)}/`)) {
    throw new GitWorktreeError("worktree ownership record points outside the managed app directory")
  }
  const expectedWorkspace = record.sourceRelativePath
    ? path.join(directory, record.sourceRelativePath)
    : directory
  if (
    canonicalKey(expectedWorkspace) !== canonicalKey(await canonicalPath(record.workspaceDirectory))
  ) {
    throw new GitWorktreeError("worktree workspace scope does not match its ownership record")
  }

  const listed = await git(workspaceRepo.gitRoot, ["worktree", "list", "--porcelain"])
  if (listed.code !== 0) {
    throw new GitWorktreeError(gitFailure(listed, "failed to validate Git worktree registry"))
  }
  const registered = parseWorktreeList(listed.stdout).find(
    (entry) => canonicalKey(entry.path) === canonicalKey(directory)
  )
  if (registered && registered.branch !== record.branch) {
    throw new GitWorktreeError("managed worktree registry no longer matches its recorded branch")
  }

  const exists = await pathExists(directory)
  const worktreeRepo = exists ? await identifyRepository(directory) : null
  if (!worktreeRepo) {
    if (registered && options?.allowMissingCheckout) {
      return {
        ...workspaceRepo,
        checkoutState: exists ? "registered-damaged" : "missing"
      }
    }
    if (!registered && !exists && options?.allowMissingCheckout) {
      return { ...workspaceRepo, checkoutState: "missing" }
    }
    if (!registered && exists && options?.allowUnregisteredCheckout) {
      return { ...workspaceRepo, checkoutState: "unregistered" }
    }
    throw new GitWorktreeError("managed worktree is missing or no longer registered with Git")
  }
  if (canonicalKey(worktreeRepo.commonDir) !== canonicalKey(record.commonDir)) {
    throw new GitWorktreeError("managed worktree is missing or belongs to a different repository")
  }
  if (!registered) {
    throw new GitWorktreeError("managed worktree repository exists but is not registered with Git")
  }
  const attachedBranch = await git(directory, ["symbolic-ref", "--quiet", "--short", "HEAD"])
  if (attachedBranch.code !== 0 || attachedBranch.stdout.trim() !== record.branch) {
    throw new GitWorktreeError("managed worktree is no longer attached to its recorded branch")
  }
  return { ...workspaceRepo, checkoutState: "registered" }
}

async function transitionWorkflowWorktreeRecord(
  record: WorkflowWorktreeRecord,
  status: WorkflowWorktreeRecord["status"],
  patch: Partial<WorkflowWorktreeRecord>,
  appDataRoot: string
): Promise<WorkflowWorktreeRecord> {
  const next = { ...record, ...patch, status, updatedAt: new Date().toISOString() }
  await persistWorkflowWorktreeRecord(next, appDataRoot)
  return next
}

/** Close a deliverable whose current head is already reachable from the recorded
 * source branch. This path never changes the source ref/index/worktree; ancestry
 * is the integration fact, while app-owned transaction fields are reserved for
 * repairing the narrow CAS-before-checkout-refresh crash window. */
async function finishMergedWorkflowWorktree(
  record: WorkflowWorktreeRecord,
  repo: RepoIdentity,
  headCommit: string,
  appDataRoot: string,
  operationTimeoutMs: number,
  signal?: AbortSignal
): Promise<WorkflowWorktreeActionResult> {
  // A user may have integrated the committed deliverable manually and then
  // removed its linked checkout.  In that terminal situation the source-branch
  // ancestry proof is still available, while there is no checkout left to
  // inspect.  If it still exists, keep the usual late-write guard.
  if (await pathExists(record.directory)) {
    const afterMerge = await inspectWorkflowWorktree(
      record.directory,
      record.baseCommit,
      operationTimeoutMs,
      signal
    )
    if (signal?.aborted) {
      throw new GitWorktreeError("workflow integration was cancelled", "source-busy")
    }
    if (afterMerge.dirty || afterMerge.headCommit !== headCommit) {
      throw new GitWorktreeError(
        "deliverable changed during integration; the integrated commit is preserved and newer work remains recoverable"
      )
    }
  }

  let merged = await transitionWorkflowWorktreeRecord(
    record,
    "merged",
    {
      headCommit,
      dirty: false,
      cleanupPending: true,
      error: undefined
    },
    appDataRoot
  )
  try {
    await removeWorkflowWorktree({
      directory: merged.directory,
      gitRoot: repo.gitRoot,
      branch: merged.branch,
      expectedBranchHead: headCommit,
      preserveChanges: true
    })
    const cleaned = { cleanupPending: false, error: undefined }
    merged = await transitionWorkflowWorktreeRecord(merged, "merged", cleaned, appDataRoot).catch(
      () => ({
        ...merged,
        cleanupPending: true,
        error: "changes merged; worktree was removed but cleanup state persistence is pending"
      })
    )
  } catch (error) {
    const pending = {
      cleanupPending: true,
      error: `changes merged; worktree cleanup pending: ${error instanceof Error ? error.message : String(error)}`
    }
    merged = await transitionWorkflowWorktreeRecord(merged, "merged", pending, appDataRoot).catch(
      () => ({
        ...merged,
        cleanupPending: true,
        error: pending.error
      })
    )
  }
  return { record: merged }
}

/** Convert a crash-remnant transient state into an actionable recovery state.
 * Reconciliation runs concurrently with renderer requests, so it must share the
 * same per-worktree lock and reload the manifest instead of persisting a stale
 * run.json snapshot after Diff/Merge/Discard has already advanced it. */
export async function recoverInterruptedWorkflowWorktree(input: {
  record: WorkflowWorktreeRecord
  error: string
  appDataRoot?: string
}): Promise<WorkflowWorktreeRecord> {
  return withWorktreeActionLock(input.record, async () => {
    const current = await loadCurrentWorkflowWorktreeRecord(input.record, input.appDataRoot)
    const appDataRoot = locatedWorkflowWorktreeAppDataRoot(current, input.appDataRoot)
    return withRepoLock(canonicalKey(current.commonDir), async () => {
      const latest = await loadCurrentWorkflowWorktreeRecord(current, appDataRoot)
      if (
        latest.status === "merged" ||
        latest.status === "discarded" ||
        latest.status === "ready" ||
        latest.status === "recoverable"
      ) {
        return latest
      }
      return transitionWorkflowWorktreeRecord(
        latest,
        "recoverable",
        { error: input.error },
        appDataRoot
      )
    })
  })
}

/** Read-only inspection used by the UI. It deliberately returns a summary rather
 * than an unbounded patch; the worktree path remains available for deeper review. */
export async function diffWorkflowWorktree(input: {
  workspacePath: string
  record: WorkflowWorktreeRecord
  appDataRoot?: string
}): Promise<WorkflowWorktreeDiff> {
  return withWorktreeActionLock(input.record, async () => {
    const current = await loadCurrentWorkflowWorktreeRecord(input.record, input.appDataRoot)
    const appDataRoot = locatedWorkflowWorktreeAppDataRoot(current, input.appDataRoot)
    return withRepoLock(canonicalKey(current.commonDir), async () => {
      const latest = await loadCurrentWorkflowWorktreeRecord(current, appDataRoot)
      if (latest.status === "merged" || latest.status === "discarded") {
        throw new GitWorktreeError(`cannot inspect a worktree while it is ${latest.status}`)
      }
      await assertManagedWorkflowWorktree(latest, input.workspacePath, appDataRoot)
      const inspected = await inspectWorkflowWorktree(latest.directory, latest.baseCommit)
      const record: WorkflowWorktreeRecord = {
        ...latest,
        headCommit: inspected.headCommit || latest.headCommit,
        dirty: inspected.dirty,
        updatedAt: new Date().toISOString()
      }
      await persistWorkflowWorktreeRecord(record, appDataRoot)

      const sections: string[] = []
      if (inspected.headCommit && inspected.headCommit !== record.baseCommit) {
        const commits = await git(record.directory, [
          "log",
          "--oneline",
          "--no-decorate",
          `${record.baseCommit}..${inspected.headCommit}`
        ])
        if (commits.code === 0 && commits.stdout.trim())
          sections.push(`Commits:\n${commits.stdout.trim()}`)
        const stat = await git(record.directory, [
          "diff",
          "--stat",
          record.baseCommit,
          inspected.headCommit
        ])
        if (stat.code === 0 && stat.stdout.trim())
          sections.push(`Committed changes:\n${stat.stdout.trim()}`)
      }
      const status = await git(record.directory, [
        "-c",
        "core.fsmonitor=false",
        "status",
        "--short",
        "--untracked-files=all"
      ])
      if (status.code !== 0) {
        throw new GitWorktreeError(gitFailure(status, "failed to inspect worktree status"))
      }
      if (status.stdout.trim()) sections.push(`Uncommitted changes:\n${status.stdout.trim()}`)
      const summary = sections.join("\n\n") || "No changes."
      return {
        record,
        summary:
          summary.length <= WORKFLOW_WORKTREE_DIFF_SUMMARY_MAX_CHARS
            ? summary
            : `${summary.slice(0, WORKFLOW_WORKTREE_DIFF_SUMMARY_MAX_CHARS)}\n\n… output truncated`
      }
    })
  })
}

/** Explicit destructive operation. No background path calls this for a changed
 * worktree; durable status is set first so a crash leaves an authorized cleanup
 * candidate rather than an ambiguous orphan. */
export async function discardWorkflowWorktree(input: {
  workspacePath: string
  record: WorkflowWorktreeRecord
  appDataRoot?: string
}): Promise<WorkflowWorktreeActionResult> {
  return withWorktreeActionLock(input.record, async () => {
    const current = await loadCurrentWorkflowWorktreeRecord(input.record, input.appDataRoot)
    const appDataRoot = locatedWorkflowWorktreeAppDataRoot(current, input.appDataRoot)
    return withRepoLock(canonicalKey(current.commonDir), async () => {
      const repo = await assertManagedWorkflowWorktree(current, input.workspacePath, appDataRoot, {
        allowMissingCheckout: true,
        allowUnregisteredCheckout: true
      })
      if (
        current.status === "provisioning" ||
        current.status === "running" ||
        current.status === "integrating"
      ) {
        throw new GitWorktreeError(`cannot discard a worktree while it is ${current.status}`)
      }
      if (current.status === "merged" || current.status === "discarded") {
        throw new GitWorktreeError(`cannot discard a worktree while it is ${current.status}`)
      }
      const discardHeadResult = await git(repo.gitRoot, [
        "rev-parse",
        "--verify",
        `refs/heads/${current.branch}`
      ])
      const discardHead =
        discardHeadResult.code === 0 && /^[0-9a-f]{40,64}$/i.test(discardHeadResult.stdout.trim())
          ? discardHeadResult.stdout.trim()
          : undefined
      let record = await transitionWorkflowWorktreeRecord(
        current,
        "discarded",
        {
          headCommit: discardHead ?? current.headCommit,
          cleanupPending: true,
          error: undefined
        },
        appDataRoot
      )
      let cleanupPending = false
      try {
        if (repo.checkoutState === "unregistered") {
          throw new GitWorktreeError(
            `丢弃已记录，但此 worktree 已不再被 Git 登记。为保护源工作区，系统不会自动删除；请手动删除目录“${current.directory}”后，再点击“重试清理”。`
          )
        }
        if (!discardHead) {
          throw new GitWorktreeError(
            "discard is recorded, but the branch tip could not be pinned for safe cleanup"
          )
        }
        await removeWorkflowWorktree({
          directory: record.directory,
          gitRoot: repo.gitRoot,
          branch: record.branch,
          expectedBranchHead: discardHead
        })
      } catch (error) {
        cleanupPending = true
        record = await transitionWorkflowWorktreeRecord(
          record,
          "discarded",
          {
            cleanupPending: true,
            error: `discard authorized; worktree cleanup pending: ${error instanceof Error ? error.message : String(error)}`
          },
          appDataRoot
        )
      }
      if (!cleanupPending) {
        record = await transitionWorkflowWorktreeRecord(
          record,
          "discarded",
          { cleanupPending: false, error: undefined },
          appDataRoot
        )
      }
      // Keep the terminal manifest until the caller has durably recorded this state
      // in run history. finalizeWorkflowWorktreeRecord closes that crash window.
      return { record }
    })
  })
}

/** Explicit retry for a terminal record whose destructive cleanup lost a crash
 * window. The user has confirmed that the remaining checkout (including ignored
 * files) may be deleted. The current branch tip is pinned immediately before removal so an
 * unknown late commit is never removed by a blind ref delete. */
export async function cleanupWorkflowWorktree(input: {
  workspacePath: string
  record: WorkflowWorktreeRecord
  appDataRoot?: string
}): Promise<WorkflowWorktreeActionResult> {
  return withWorktreeActionLock(input.record, async () => {
    const current = await loadCurrentWorkflowWorktreeRecord(input.record, input.appDataRoot)
    const appDataRoot = locatedWorkflowWorktreeAppDataRoot(current, input.appDataRoot)
    return withRepoLock(canonicalKey(current.commonDir), async () => {
      if (current.status !== "merged" && current.status !== "discarded") {
        throw new GitWorktreeError(`cannot retry cleanup while the worktree is ${current.status}`)
      }
      const repo = await assertManagedWorkflowWorktree(current, input.workspacePath, appDataRoot, {
        allowMissingCheckout: true
      })
      const tip = await git(repo.gitRoot, [
        "show-ref",
        "--verify",
        "--hash",
        `refs/heads/${current.branch}`
      ])
      const observedTip = tip.code === 0 ? tip.stdout.trim() : ""
      const missing =
        tip.code !== 0 &&
        !tip.infrastructureFailure &&
        /not a valid ref|does not exist|not found/i.test(gitFailure(tip, ""))
      if (tip.code !== 0 && !missing) {
        throw new GitWorktreeError(gitFailure(tip, "cannot verify terminal branch before cleanup"))
      }
      if (tip.code === 0 && (!current.headCommit || observedTip !== current.headCommit)) {
        throw new GitWorktreeError(
          "terminal cleanup is blocked because the worktree branch advanced after its original authorization"
        )
      }
      const expectedBranchHead = current.headCommit
      let cleanupPending = false
      let record = current
      try {
        await removeWorkflowWorktree({
          directory: current.directory,
          gitRoot: repo.gitRoot,
          branch: current.branch,
          expectedBranchHead,
          preserveChanges: false
        })
      } catch (error) {
        cleanupPending = true
        record = await transitionWorkflowWorktreeRecord(
          current,
          current.status,
          {
            cleanupPending: true,
            error: `terminal cleanup pending: ${error instanceof Error ? error.message : String(error)}`
          },
          appDataRoot
        )
      }
      if (!cleanupPending) {
        record = await transitionWorkflowWorktreeRecord(
          current,
          current.status,
          { cleanupPending: false, error: undefined },
          appDataRoot
        )
      }
      return { record }
    })
  })
}

/** Merge one committed deliverable into the original source branch. New source
 * mutations require an unchanged, clean source checkout plus serialized conflict
 * preflight. If the branch already contains the deliverable, ancestry is enough
 * to close it without touching the source checkout. Failures remain recoverable. */
export async function mergeWorkflowWorktree(input: {
  workspacePath: string
  record: WorkflowWorktreeRecord
  appDataRoot?: string
  signal?: AbortSignal
  /** Deterministic regression seam for the irreversible ref-CAS boundary. */
  testHooks?: { afterSourceRefAdvanced?: () => void | Promise<void> }
}): Promise<WorkflowWorktreeActionResult> {
  const operationTimeoutMs = getWorkflowWorktreeTimeoutMs()
  const throwIfAborted = (): void => {
    if (input.signal?.aborted) {
      throw new GitWorktreeError("workflow integration was cancelled", "source-busy")
    }
  }
  return withWorktreeActionLock(input.record, async () => {
    throwIfAborted()
    const current = await loadCurrentWorkflowWorktreeRecord(input.record, input.appDataRoot)
    const appDataRoot = locatedWorkflowWorktreeAppDataRoot(current, input.appDataRoot)
    const repo = await assertManagedWorkflowWorktree(current, input.workspacePath, appDataRoot, {
      allowMissingCheckout: true
    })
    if (
      current.status !== "ready" &&
      current.status !== "recoverable" &&
      current.status !== "integrating"
    ) {
      throw new GitWorktreeError(`cannot merge a worktree while it is ${current.status}`)
    }

    return withRepoLock(canonicalKey(repo.commonDir), async () => {
      let record = current
      try {
        throwIfAborted()
        // A manually integrated deliverable remains safely recognizable by its
        // recorded commit even when Git/the user has already removed the linked
        // checkout.  This is deliberately read-only: without a checkout there
        // is no new work to inspect or source state to refresh.
        if (repo.checkoutState === "missing") {
          const sourceBranch = record.sourceBranch
          const headCommit = record.headCommit
          if (
            !sourceBranch ||
            !headCommit ||
            !/^[0-9a-f]{40,64}$/i.test(headCommit) ||
            headCommit === record.baseCommit
          ) {
            throw new GitWorktreeError(
              "managed worktree is missing before it produced a committed deliverable"
            )
          }
          const targetRef = `refs/heads/${sourceBranch}`
          const alreadyIntegrated = await git(
            record.sourceRoot,
            ["merge-base", "--is-ancestor", headCommit, targetRef],
            operationTimeoutMs,
            input.signal
          )
          if (alreadyIntegrated.code !== 0) {
            throw new GitWorktreeError(
              "managed worktree is missing and its recorded deliverable is not integrated; retained for recovery"
            )
          }
          const stillIntegrated = await git(
            record.sourceRoot,
            ["merge-base", "--is-ancestor", headCommit, targetRef],
            operationTimeoutMs,
            input.signal
          )
          if (stillIntegrated.code !== 0) {
            throw new GitWorktreeError(
              "recorded source branch changed while confirming the existing integration",
              "source-busy"
            )
          }
          return finishMergedWorkflowWorktree(
            record,
            repo,
            headCommit,
            appDataRoot,
            operationTimeoutMs,
            input.signal
          )
        }
        const inspected = await inspectWorkflowWorktree(
          record.directory,
          record.baseCommit,
          operationTimeoutMs,
          input.signal
        )
        throwIfAborted()
        if (!inspected.headCommit) throw new GitWorktreeError("cannot resolve deliverable HEAD")
        if (inspected.dirty) {
          throw new GitWorktreeError(
            "commit or discard all worktree changes before merging",
            "dirty-deliverable"
          )
        }
        if (inspected.headCommit === record.baseCommit) {
          throw new GitWorktreeError("the worktree has no committed changes to merge")
        }
        const deliverableBranch = await git(record.directory, [
          "symbolic-ref",
          "--quiet",
          "--short",
          "HEAD"
        ])
        if (deliverableBranch.code !== 0 || deliverableBranch.stdout.trim() !== record.branch) {
          throw new GitWorktreeError(
            "deliverable HEAD is no longer attached to its recorded branch"
          )
        }
        await assertWorkflowWorktreeDeliverableDescendsFromBase(
          record.directory,
          record.baseCommit,
          inspected.headCommit,
          operationTimeoutMs,
          input.signal
        )
        await assertWorkflowWorktreeDeliverablePathsInScope(
          record.directory,
          record.baseCommit,
          inspected.headCommit,
          record.sourceRelativePath,
          operationTimeoutMs,
          input.signal
        )
        const targetRef = `refs/heads/${record.sourceBranch}`
        const alreadyIntegrated = await git(
          record.sourceRoot,
          ["merge-base", "--is-ancestor", inspected.headCommit, targetRef],
          operationTimeoutMs,
          input.signal
        )

        // An integration completed outside this action (a user/orchestrator
        // merge, or normal commits after one of our merges) needs no source
        // mutation. Ancestry is sufficient to preserve the deliverable; exact
        // app transaction ownership matters only when the active checkout still
        // needs repair after our expected-old ref CAS.
        let needsOwnedCheckoutRepair = false
        if (alreadyIntegrated.code === 0) {
          const recordedOwnedTip =
            (record.status === "integrating" || record.status === "recoverable") &&
            Boolean(record.integrationCommit && record.integrationParent)
          if (recordedOwnedTip) {
            const [targetTip, checkoutBranch] = await Promise.all([
              git(record.sourceRoot, ["rev-parse", targetRef]),
              git(record.sourceRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"])
            ])
            if (
              targetTip.code === 0 &&
              targetTip.stdout.trim() === record.integrationCommit &&
              checkoutBranch.code === 0 &&
              checkoutBranch.stdout.trim() === record.sourceBranch
            ) {
              const [targetTree, indexTree, parentTree] = await Promise.all([
                git(record.sourceRoot, ["rev-parse", `${targetRef}^{tree}`]),
                git(record.sourceRoot, ["write-tree"], operationTimeoutMs, input.signal),
                git(record.sourceRoot, ["rev-parse", `${record.integrationParent}^{tree}`])
              ])
              needsOwnedCheckoutRepair =
                targetTree.code === 0 &&
                indexTree.code === 0 &&
                parentTree.code === 0 &&
                indexTree.stdout.trim() === parentTree.stdout.trim() &&
                indexTree.stdout.trim() !== targetTree.stdout.trim()
            }
          }
          if (!needsOwnedCheckoutRepair) {
            const stillIntegrated = await git(
              record.sourceRoot,
              ["merge-base", "--is-ancestor", inspected.headCommit, targetRef],
              operationTimeoutMs,
              input.signal
            )
            if (stillIntegrated.code !== 0) {
              throw new GitWorktreeError(
                "recorded source branch changed while confirming the existing integration",
                "source-busy"
              )
            }
            return finishMergedWorkflowWorktree(
              record,
              repo,
              inspected.headCommit,
              appDataRoot,
              operationTimeoutMs,
              input.signal
            )
          }
        }

        const sourceBranch = await git(record.sourceRoot, [
          "symbolic-ref",
          "--quiet",
          "--short",
          "HEAD"
        ])
        if (sourceBranch.code !== 0 || sourceBranch.stdout.trim() !== record.sourceBranch) {
          throw new GitWorktreeError(
            `source checkout must remain on ${record.sourceBranch} before merging`,
            "source-busy"
          )
        }
        const existingOperation = await currentGitOperation(record.sourceRoot)
        if (existingOperation) {
          throw new GitWorktreeError(
            `source checkout has an in-progress Git operation (${existingOperation}); finish it before merging`,
            "source-busy"
          )
        }
        const sourceHeadResult = await git(record.sourceRoot, ["rev-parse", "HEAD"])
        const sourceHead = sourceHeadResult.code === 0 ? sourceHeadResult.stdout.trim() : ""
        if (!sourceHead) throw new GitWorktreeError("cannot resolve source HEAD")
        throwIfAborted()
        if (alreadyIntegrated.code !== 0) {
          const sourceStatus = await inspectWorkspaceStatus(
            record.sourceRoot,
            "",
            operationTimeoutMs,
            input.signal
          )
          if (sourceStatus.code !== 0) {
            throw new GitWorktreeError(
              gitFailure(sourceStatus, "failed to inspect source workspace")
            )
          }
          if (sourceStatus.stdout.trim()) {
            throw new GitWorktreeError(
              "source workspace must be clean before merging",
              "source-busy"
            )
          }

          const preflight = await git(
            record.sourceRoot,
            ["merge-tree", "--write-tree", sourceHead, inspected.headCommit],
            operationTimeoutMs,
            input.signal
          )
          throwIfAborted()
          if (preflight.code !== 0) {
            const conflict = isConfirmedMergeTreeConflict(preflight)
            throw new GitWorktreeError(
              conflict
                ? `merge conflict detected; source was not changed (${gitFailure(preflight, "merge-tree conflict")})`
                : `merge preflight failed without changing source (${gitFailure(preflight, "merge-tree failed")})`,
              conflict ? "merge-conflict" : "unsafe-state"
            )
          }
          const mergeTree = preflight.stdout.trim().split(/\s+/)[0]
          if (!/^[0-9a-f]{40,64}$/i.test(mergeTree)) {
            throw new GitWorktreeError("merge preflight did not return a valid result tree")
          }
          const integrationPaths = await listChangedGitPaths(
            record.sourceRoot,
            sourceHead,
            mergeTree,
            operationTimeoutMs,
            input.signal
          )
          assertGitPathsInScope(integrationPaths, record.sourceRelativePath)
          await assertNoGitlinkChanges(
            record.sourceRoot,
            sourceHead,
            mergeTree,
            integrationPaths,
            operationTimeoutMs,
            input.signal
          )
          await assertNoIgnoredSourceCollisions(
            record.sourceRoot,
            integrationPaths,
            operationTimeoutMs,
            input.signal
          )
          record = await transitionWorkflowWorktreeRecord(
            record,
            "integrating",
            { headCommit: inspected.headCommit, dirty: false, error: undefined },
            appDataRoot
          )
          const [
            branchBeforeMutation,
            headBeforeMutation,
            operationBeforeMutation,
            statusBeforeMutation
          ] = await Promise.all([
            git(record.sourceRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
            git(record.sourceRoot, ["rev-parse", "HEAD"]),
            currentGitOperation(record.sourceRoot),
            inspectWorkspaceStatus(record.sourceRoot, "", operationTimeoutMs, input.signal)
          ])
          if (
            branchBeforeMutation.code !== 0 ||
            branchBeforeMutation.stdout.trim() !== record.sourceBranch ||
            headBeforeMutation.code !== 0 ||
            headBeforeMutation.stdout.trim() !== sourceHead ||
            operationBeforeMutation ||
            statusBeforeMutation.code !== 0 ||
            statusBeforeMutation.stdout.trim()
          ) {
            throw new GitWorktreeError(
              "source checkout changed during merge preflight; no integration was attempted",
              "source-busy"
            )
          }
          throwIfAborted()

          // Build the merge commit without touching the user's index/worktree or
          // running repository hooks, then move only the recorded branch with an
          // expected-old atomic ref update. An IDE branch switch can no longer
          // redirect the integration into a different branch.
          const committed = await git(
            record.sourceRoot,
            [
              "-c",
              `core.hooksPath=${GIT_DISABLED_HOOKS_PATH}`,
              "-c",
              "commit.gpgsign=false",
              "commit-tree",
              mergeTree,
              "-p",
              sourceHead,
              "-p",
              inspected.headCommit,
              "-m",
              `Merge workflow worktree ${record.branch}`
            ],
            operationTimeoutMs,
            input.signal
          )
          const mergeCommit = committed.stdout.trim()
          if (committed.code !== 0 || !/^[0-9a-f]{40,64}$/i.test(mergeCommit)) {
            throw new GitWorktreeError(gitFailure(committed, "failed to create merge commit"))
          }
          record = await transitionWorkflowWorktreeRecord(
            record,
            "integrating",
            { integrationParent: sourceHead, integrationCommit: mergeCommit },
            appDataRoot
          )
          throwIfAborted()
          const advanced = await git(
            record.sourceRoot,
            [...GIT_NO_HOOKS_ARGS, "update-ref", targetRef, mergeCommit, sourceHead],
            GIT_QUERY_TIMEOUT_MS
          )
          if (advanced.code !== 0) {
            throw new GitWorktreeError(
              `source branch advanced during integration; no ref was overwritten (${gitFailure(advanced, "atomic ref update failed")})`,
              "source-busy"
            )
          }
          await input.testHooks?.afterSourceRefAdvanced?.()
          // Once the expected-old ref CAS succeeds, finish the checkout refresh
          // even if cancellation was requested. Aborting halfway would leave a
          // source branch pointing at the integration commit with a stale index;
          // the recovery record is safer than abandoning this transaction.
          const checkoutBranch = await git(record.sourceRoot, [
            "symbolic-ref",
            "--quiet",
            "--short",
            "HEAD"
          ])
          if (checkoutBranch.code !== 0 || checkoutBranch.stdout.trim() !== record.sourceBranch) {
            await rollbackAtomicWorkflowIntegration(
              record.sourceRoot,
              targetRef,
              mergeCommit,
              sourceHead,
              "source checkout switched branches during integration"
            )
          }
          try {
            await assertNoIgnoredSourceCollisions(
              record.sourceRoot,
              integrationPaths,
              operationTimeoutMs
            )
          } catch (error) {
            await rollbackAtomicWorkflowIntegration(
              record.sourceRoot,
              targetRef,
              mergeCommit,
              sourceHead,
              error instanceof Error ? error.message : String(error)
            )
          }
          // Use HEAD as the new tree. If an external checkout wins after the
          // branch check, HEAD follows that checkout instead of injecting the
          // workflow tree into the wrong branch's index/worktree.
          const refreshed = await git(
            record.sourceRoot,
            [...GIT_NO_HOOKS_ARGS, "read-tree", "-m", "-u", sourceHead, "HEAD"],
            operationTimeoutMs
          )
          if (refreshed.code !== 0) {
            await rollbackAtomicWorkflowIntegration(
              record.sourceRoot,
              targetRef,
              mergeCommit,
              sourceHead,
              `source checkout refresh was blocked (${gitFailure(refreshed, "git read-tree failed")})`
            )
          }
        }

        // A crash can occur after the expected-old ref update but before the
        // source index/worktree is refreshed. On retry, repair only the exact
        // merge commit we created and use read-tree's two-tree carry-forward
        // mode, which refuses overlap and preserves local working-tree edits.
        const targetParents = await git(record.sourceRoot, [
          "rev-list",
          "--parents",
          "-n",
          "1",
          targetRef
        ])
        const commits = targetParents.code === 0 ? targetParents.stdout.trim().split(/\s+/) : []
        const ownedIntegrationPresent =
          (record.status === "integrating" || record.status === "recoverable") &&
          Boolean(record.integrationCommit && record.integrationParent) &&
          (
            await git(
              record.sourceRoot,
              ["merge-base", "--is-ancestor", record.integrationCommit!, targetRef],
              operationTimeoutMs
            )
          ).code === 0
        const exactOwnedTip =
          ownedIntegrationPresent &&
          commits.length === 3 &&
          commits[0] === record.integrationCommit &&
          commits[1] === record.integrationParent &&
          commits[2] === inspected.headCommit
        if (!ownedIntegrationPresent) {
          throw new GitWorktreeError(
            "source branch contains the deliverable without a durable app-owned integration transaction; retained for review",
            "source-busy"
          )
        }

        const checkoutBeforeVerification = await git(record.sourceRoot, [
          "symbolic-ref",
          "--quiet",
          "--short",
          "HEAD"
        ])
        if (
          checkoutBeforeVerification.code !== 0 ||
          checkoutBeforeVerification.stdout.trim() !== record.sourceBranch
        ) {
          if (exactOwnedTip) {
            await rollbackAtomicWorkflowIntegration(
              record.sourceRoot,
              targetRef,
              record.integrationCommit!,
              record.integrationParent!,
              `source checkout left ${record.sourceBranch} before integration verification`
            )
          }
          throw new GitWorktreeError(
            `source checkout left ${record.sourceBranch}; the integrated branch was not changed`,
            "source-busy"
          )
        }
        const [targetTreeResult, indexTreeResult] = await Promise.all([
          git(record.sourceRoot, ["rev-parse", `${targetRef}^{tree}`]),
          git(record.sourceRoot, ["write-tree"], operationTimeoutMs)
        ])
        const targetTree = targetTreeResult.code === 0 ? targetTreeResult.stdout.trim() : ""
        let indexTree = indexTreeResult.code === 0 ? indexTreeResult.stdout.trim() : ""
        if (!targetTree || indexTree !== targetTree) {
          if (!exactOwnedTip) {
            throw new GitWorktreeError(
              "source index does not match the descendant of the app-owned integration; retained for review",
              "source-busy"
            )
          }
          const repairPaths = await listChangedGitPaths(
            record.sourceRoot,
            record.integrationParent!,
            record.integrationCommit!,
            operationTimeoutMs
          )
          try {
            await assertNoIgnoredSourceCollisions(
              record.sourceRoot,
              repairPaths,
              operationTimeoutMs
            )
          } catch (error) {
            await rollbackAtomicWorkflowIntegration(
              record.sourceRoot,
              targetRef,
              record.integrationCommit!,
              record.integrationParent!,
              error instanceof Error ? error.message : String(error)
            )
          }
          const repaired = await git(
            record.sourceRoot,
            [...GIT_NO_HOOKS_ARGS, "read-tree", "-m", "-u", record.integrationParent!, "HEAD"],
            operationTimeoutMs
          )
          if (repaired.code !== 0) {
            await rollbackAtomicWorkflowIntegration(
              record.sourceRoot,
              targetRef,
              record.integrationCommit!,
              record.integrationParent!,
              `source checkout has overlapping local work (${gitFailure(repaired, "safe read-tree repair failed")})`
            )
          }
          const repairedTree = await git(record.sourceRoot, ["write-tree"], operationTimeoutMs)
          indexTree = repairedTree.code === 0 ? repairedTree.stdout.trim() : ""
          if (indexTree !== targetTree) {
            throw new GitWorktreeError(
              "source checkout repair did not produce the integrated index; retained for recovery",
              "source-busy"
            )
          }
        }

        const integratedAfterMerge = await git(
          record.sourceRoot,
          ["merge-base", "--is-ancestor", inspected.headCommit, targetRef],
          operationTimeoutMs
        )
        if (integratedAfterMerge.code !== 0) {
          throw new GitWorktreeError(
            "recorded source branch no longer contains the deliverable; retained for recovery",
            "source-busy"
          )
        }
        return finishMergedWorkflowWorktree(
          record,
          repo,
          inspected.headCommit,
          appDataRoot,
          operationTimeoutMs
        )
      } catch (error) {
        const recoveryError = error instanceof Error ? error.message : String(error)
        const latest = await loadCurrentWorkflowWorktreeRecord(record, appDataRoot).catch(
          () => record
        )
        if (latest.status === "merged" || latest.status === "discarded") {
          // Terminal state is irreversible. Cleanup persistence may fail after
          // source integration already succeeded; never rewrite that durable
          // decision to recoverable and thereby reopen merge/discard semantics.
          throw new GitWorktreeError(
            `${recoveryError}; terminal worktree state was retained for explicit cleanup retry`,
            error instanceof GitWorktreeError ? error.code : "unsafe-state"
          )
        }
        const recovered = await transitionWorkflowWorktreeRecord(
          record,
          "recoverable",
          { error: recoveryError },
          appDataRoot
        ).catch(() => ({
          ...record,
          status: "recoverable" as const,
          error: recoveryError,
          updatedAt: new Date().toISOString()
        }))
        throw new GitWorktreeError(
          recovered.error ?? "worktree merge failed",
          error instanceof GitWorktreeError ? error.code : "unsafe-state"
        )
      }
    })
  })
}

/** Remove a terminal ownership manifest only after its run history is durable.
 * The checkout must already be gone. If its branch survived cleanup, delete it
 * with the same expected-tip guard used by normal cleanup; a late commit keeps the
 * manifest instead of becoming an invisible dangling branch. */
export async function finalizeWorkflowWorktreeRecord(
  record: WorkflowWorktreeRecord,
  appDataRoot?: string
): Promise<boolean> {
  return withWorktreeActionLock(record, async () => {
    const current = await loadCurrentWorkflowWorktreeRecord(record, appDataRoot)
    const manifestRoot = locatedWorkflowWorktreeAppDataRoot(current, appDataRoot)
    return withRepoLock(canonicalKey(current.commonDir), async () => {
      if (current.status !== "merged" && current.status !== "discarded") return false
      if (await pathExists(current.directory)) return false
      if (!current.branch.startsWith(`${WORKFLOW_WORKTREE_BRANCH_PREFIX}/`)) return false

      const listed = await git(current.gitRoot, ["worktree", "list", "--porcelain"])
      if (listed.code !== 0) return false
      const directoryKey = canonicalKey(await canonicalPath(current.directory))
      for (const entry of parseWorktreeList(listed.stdout)) {
        if (canonicalKey(await canonicalPath(entry.path)) === directoryKey) return false
      }

      const refName = `refs/heads/${current.branch}`
      const branchHead = await git(current.gitRoot, ["show-ref", "--verify", "--hash", refName])
      if (branchHead.code === 0) {
        const currentHead = branchHead.stdout.trim()
        const expectedHead = current.headCommit
        if (!expectedHead || currentHead !== expectedHead) return false
        const deleted = await git(current.gitRoot, [
          ...GIT_NO_HOOKS_ARGS,
          "update-ref",
          "-d",
          refName,
          expectedHead
        ])
        if (deleted.code !== 0) {
          const after = await git(current.gitRoot, ["show-ref", "--verify", "--hash", refName])
          const missing =
            after.code !== 0 &&
            !after.infrastructureFailure &&
            /not a valid ref|does not exist|not found/i.test(gitFailure(after, ""))
          if (!missing) return false
        }
      } else if (
        branchHead.infrastructureFailure ||
        !/not a valid ref|does not exist|not found/i.test(gitFailure(branchHead, ""))
      ) {
        return false
      }

      await deleteMatchingWorkflowWorktreeRecordCopies(
        current,
        appDataRoot === undefined ? undefined : manifestRoot
      )
      return true
    })
  })
}

interface WorktreeListEntry {
  path: string
  branch?: string
  head?: string
}

/** Parse `git worktree list --porcelain` into entries (primary checkout first). */
export function parseWorktreeList(text: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = []
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith("worktree ")) {
      entries.push({ path: line.slice("worktree ".length).trim() })
      continue
    }
    const current = entries[entries.length - 1]
    if (!current) continue
    if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim()
      continue
    }
    if (line.startsWith("branch ")) {
      current.branch = line
        .slice("branch ".length)
        .trim()
        .replace(/^refs\/heads\//, "")
    }
  }
  return entries
}
