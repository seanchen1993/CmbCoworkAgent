import { readFileSync } from "fs"
import { join } from "path"
import { describe, expect, it } from "vitest"

const modelsSource = readFileSync(join(process.cwd(), "src/main/ipc/models.ts"), "utf-8")
const gitWorktreeSource = readFileSync(
  join(process.cwd(), "src/main/services/git-worktree.ts"),
  "utf-8"
)
const workspacePickerSource = readFileSync(
  join(process.cwd(), "src/renderer/src/components/chat/WorkspacePicker.tsx"),
  "utf-8"
)

function handlerSlice(channel: string, nextChannel: string): string {
  const start = new RegExp(`ipcMain\\.handle\\(\\s*"${channel}"`).exec(modelsSource)?.index ?? -1
  const end =
    new RegExp(`ipcMain\\.handle\\(\\s*"${nextChannel}"`, "g").exec(modelsSource.slice(start + 1))
      ?.index ?? -1
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThanOrEqual(0)
  return modelsSource.slice(start, start + 1 + end)
}

describe("workspace worktree concurrency contract", () => {
  it("coalesces duplicate creates in the renderer and across renderer windows", () => {
    const source = handlerSlice("workspace:createWorktree", "workspace:saveWorktreeContext")
    const coordinator = source.indexOf("return manualWorktreeCreateCoordinator.run({")
    const create = source.indexOf("creationAttempted = true", coordinator)

    expect(coordinator).toBeGreaterThanOrEqual(0)
    expect(create).toBeGreaterThan(coordinator)
    expect(workspacePickerSource).toContain("if (worktreeCreateInFlightRef.current) return")
    expect(workspacePickerSource).toContain("worktreeCreateInFlightRef.current = true")
    expect(workspacePickerSource).toContain("worktreeCreateInFlightRef.current = false")
  })

  it("revalidates and removes a manual worktree under the shared repository lock", () => {
    const source = handlerSlice("workspace:removeWorktree", "workspace:createWorktree")
    const lock = source.indexOf("await withGitWorktreeRepositoryLock(gitRoot")
    const latestThread = source.indexOf("const latestThread = getThreadCoreSync(threadId)", lock)
    const liveRegistry = source.indexOf(
      "const worktrees = await listWorktrees(latestGitRoot)",
      lock
    )
    const manifestRead = source.indexOf("listWorkflowWorktreeRecordsForPrune(", liveRegistry)
    const canonicalBindingScan = source.indexOf(
      "await findCanonicalPersistedWorkspaceBindingConflict(",
      manifestRead
    )
    const activeWorkflow = source.indexOf(
      "workflowRunManager.activeManagedWorktreeOwner(target.path)",
      canonicalBindingScan
    )
    const removal = source.indexOf("await removeWorkflowWorktree({", activeWorkflow)
    const finalBindingRead = source.lastIndexOf("getPersistedThreadWorkspaceBindings()", removal)

    expect(lock).toBeGreaterThanOrEqual(0)
    expect(latestThread).toBeGreaterThan(lock)
    expect(liveRegistry).toBeGreaterThan(latestThread)
    expect(manifestRead).toBeGreaterThan(liveRegistry)
    expect(canonicalBindingScan).toBeGreaterThan(manifestRead)
    expect(activeWorkflow).toBeGreaterThan(canonicalBindingScan)
    expect(finalBindingRead).toBeGreaterThan(activeWorkflow)
    expect(removal).toBeGreaterThan(finalBindingRead)
    expect(source.slice(finalBindingRead, removal)).not.toContain("await ")
    expect(source.slice(removal, removal + 180)).toContain("gitRoot: latestGitRoot")
    expect(source).not.toContain('["worktree", "prune"]')
  })

  it("serializes manual creation and rollback with workflow worktree mutations", () => {
    const source = handlerSlice("workspace:createWorktree", "workspace:saveWorktreeContext")
    expect(source.match(/withGitWorktreeRepositoryLock\(gitRoot/g)).toHaveLength(2)

    const creationLock = source.lastIndexOf("await withGitWorktreeRepositoryLock(gitRoot")
    const worktreeList = source.indexOf("const worktrees = await listWorktrees(gitRoot)")
    const stableBase = source.indexOf("prepareWorkflowWorktreeSource(gitRoot)")
    const attempted = source.indexOf("creationAttempted = true", stableBase)
    const worktreeAdd = source.indexOf("source.sourceRoot", stableBase)
    expect(creationLock).toBeGreaterThanOrEqual(0)
    expect(worktreeList).toBeGreaterThan(creationLock)
    expect(stableBase).toBeGreaterThan(worktreeList)
    expect(attempted).toBeGreaterThan(stableBase)
    expect(worktreeAdd).toBeGreaterThan(stableBase)
    expect(worktreeAdd).toBeGreaterThan(attempted)
    expect(source.slice(worktreeAdd, worktreeAdd + 240)).toContain("baseCommit")
  })

  it("bounds manual create, rollback, remove, and registry Git operations", () => {
    const createSource = handlerSlice("workspace:createWorktree", "workspace:saveWorktreeContext")
    const add = createSource.indexOf("await runGit(")
    const rollback = createSource.indexOf("await rollbackAttemptedWorktreeCreation({")
    expect(add).toBeGreaterThanOrEqual(0)
    expect(createSource.slice(add, add + 260)).toContain("getWorkflowWorktreeTimeoutMs()")
    expect(rollback).toBeGreaterThanOrEqual(0)
    expect(createSource.slice(rollback, rollback + 260)).toContain("expectedBaseCommit: baseCommit")
    expect(createSource.slice(rollback, rollback + 260)).toContain("branchWasAbsentBeforeAttempt")

    const listStart = modelsSource.indexOf("async function listWorktrees(")
    const listSource = modelsSource.slice(listStart, listStart + 1_200)
    expect(listSource).toContain("timeoutMs: GIT_CONTEXT_QUERY_TIMEOUT_MS")

    const removeStart = gitWorktreeSource.indexOf("export async function removeWorkflowWorktree(")
    const removeSource = gitWorktreeSource.slice(removeStart, removeStart + 7_000)
    expect(removeSource).toContain("getWorkflowWorktreeRemoveTimeoutMs()")
  })

  it.each([
    ["workspace:set", "workspace:select"],
    ["workspace:select", "workspace:fileScanOpen"]
  ])("revalidates %s after watcher startup before publishing its response", (channel, next) => {
    const source = handlerSlice(channel, next)
    const watcherSettled = source.lastIndexOf("await watcherStart")
    const publication = source.indexOf("resolveWorkspaceMutationPublication(", watcherSettled)
    const response = source.indexOf("if (!publication.committed)", publication)
    expect(watcherSettled).toBeGreaterThanOrEqual(0)
    expect(publication).toBeGreaterThan(watcherSettled)
    expect(response).toBeGreaterThan(publication)
  })

  it("publishes create from durable metadata after watcher and guards orphan rollback", () => {
    const source = handlerSlice("workspace:createWorktree", "workspace:saveWorktreeContext")
    const watcherSettled = source.lastIndexOf("await watcherStart")
    const latestMetadata = source.indexOf(
      "const currentMetadata = parseThreadMetadata(currentThread?.metadata)",
      watcherSettled
    )
    const publication = source.indexOf("resolveCreatedWorktreePublication(", latestMetadata)
    const orphan = source.indexOf("if (!publication.durablyBound)", publication)
    const success = source.indexOf("path: publication.path", orphan)
    const canonicalRollbackScan = source.indexOf(
      "await findCanonicalPersistedWorkspaceBindingConflict(",
      source.indexOf("const rollbackCreatedWorktree")
    )
    const rollbackMutation = source.indexOf(
      "await rollbackAttemptedWorktreeCreation({",
      canonicalRollbackScan
    )
    const durableRollbackRead = source.lastIndexOf(
      "getPersistedThreadWorkspaceBindings()",
      rollbackMutation
    )

    expect(watcherSettled).toBeGreaterThanOrEqual(0)
    expect(latestMetadata).toBeGreaterThan(watcherSettled)
    expect(publication).toBeGreaterThan(latestMetadata)
    expect(orphan).toBeGreaterThan(publication)
    expect(success).toBeGreaterThan(orphan)
    expect(canonicalRollbackScan).toBeGreaterThanOrEqual(0)
    expect(durableRollbackRead).toBeGreaterThan(canonicalRollbackScan)
    expect(rollbackMutation).toBeGreaterThan(durableRollbackRead)
    expect(source.slice(durableRollbackRead, rollbackMutation)).not.toContain("await ")
  })
})
