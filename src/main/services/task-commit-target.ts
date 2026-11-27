import { realpath } from "node:fs/promises"
import path from "node:path"
import { resolveGitOperationPath } from "./git-repository-discovery"
import { readTaskCommitBinding } from "./task-commit-binding"

type TaskCommitTarget = { worktreePath: string; gitRoot: string; external: boolean }

function isInside(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate)
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)
}

/** A task binding authorizes commit reads and writes only in its registered checkouts. */
export async function resolveTaskCommitTarget(
  threadId: string,
  workspacePath: string,
  requestedPath?: string | null,
  bindingVersion?: string
): Promise<TaskCommitTarget | { error: string }> {
  const binding = bindingVersion ? await readTaskCommitBinding(threadId) : null
  if (
    bindingVersion &&
    (!binding ||
      binding.version !== bindingVersion ||
      path.relative(workspacePath, binding.workspacePath) !== "")
  ) {
    return { error: "当前任务的提交设置已变更，请重新发起提交" }
  }

  if (!binding) {
    const local = await resolveGitOperationPath(workspacePath, requestedPath)
    return "error" in local ? local : { ...local, external: false }
  }

  const requested =
    requestedPath ?? (binding.repositoryPaths.length === 1 ? binding.repositoryPaths[0] : null)
  if (!requested || !path.isAbsolute(requested)) return { error: "请选择已登记的提交仓库" }
  const workspace = await realpath(workspacePath)
  for (const scope of binding.repositoryPaths) {
    if (!isInside(scope, requested)) continue
    // Only the session directory itself may be registered below a checkout root.
    // A parent of that directory must never grant access to its siblings.
    if (path.relative(scope, workspace) && isInside(scope, workspace)) continue
    const target = await resolveGitOperationPath(scope, requested)
    if ("error" in target) return target
    const expectedRoot = binding.checkoutRoots?.[scope] ?? scope
    const actualRoot = await realpath(target.gitRoot)
    if (!path.relative(expectedRoot, actualRoot)) {
      return { ...target, gitRoot: actualRoot, external: !isInside(workspace, target.worktreePath) }
    }
  }
  return { error: "目标 Git 工作树未登记到当前任务" }
}
