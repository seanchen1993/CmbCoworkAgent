import { relative, resolve, isAbsolute, sep } from "node:path"
import type { FunctionProcessRequest } from "./process-sdk"
import { currentWorkflowWorktreeActionScope } from "../../agent/workflow/worktree-action-scope"
import { getWorktreeShellIsolationViolation, assessCommandSafety } from "../../agent/exec-policy"

/** Keeps native process authorization; a checkout cwd is not an operating-system sandbox. */
export function assertWorkflowResourceProcess(
  workspace: string, threadId: string, request: Readonly<FunctionProcessRequest>
): (() => void) | undefined {
  const scope = currentWorkflowWorktreeActionScope(workspace, threadId)
  if (!scope) return undefined
  const local = relative(resolve(scope.boundary.workspaceRoot), resolve(request.cwd))
  if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local))
    throw Error("WORKTREE_ACTION_PROCESS_CWD_OUTSIDE")
  if (Object.keys(request.env).some(key => /^GIT_/i.test(key)))
    throw Error("WORKTREE_ACTION_GIT_ENV_FORBIDDEN")
  // Inspect argv as quoted POSIX tokens only; this string is never executed as a shell.
  const command = request.argv.map(value => `'${value.replaceAll("'", "'\\''")}'`).join(" ")
  const violation = getWorktreeShellIsolationViolation(command, request.cwd, scope.boundary, [], "posix")
  const safety = assessCommandSafety(command, request.cwd, { nativeGitWorktree: true, shellSyntax: "posix" })
  if (violation || safety.level === "forbidden") throw Error("WORKTREE_ACTION_PROCESS_FORBIDDEN")
  scope.assertCurrent()
  return () => {
    if (currentWorkflowWorktreeActionScope(workspace, threadId) !== scope)
      throw Error("WORKTREE_ACTION_SCOPE_CHANGED")
    scope.assertCurrent()
  }
}
