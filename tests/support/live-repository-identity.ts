import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { lstatSync, realpathSync } from "node:fs"
import { basename, join, resolve } from "node:path"

/** Test identity belongs only to the explicitly isolated repository, including its worktrees. */
export function configureLiveRepositoryIdentity(isolated: string, workspace: string) {
  const root = resolve(isolated)
  assert(basename(root).startsWith("run-"), "ISOLATED_RUN_REQUIRED")
  assert.equal(realpathSync(root), root, "ISOLATED_RUN_ALIAS_FORBIDDEN")
  assert.equal(resolve(workspace), join(root, "workspace"), "ISOLATED_WORKSPACE_REQUIRED")
  assert.equal(realpathSync(workspace), resolve(workspace), "WORKSPACE_ALIAS_FORBIDDEN")
  const git = lstatSync(join(workspace, ".git"))
  assert(git.isDirectory() && !git.isSymbolicLink(), "ISOLATED_REPOSITORY_REQUIRED")
  for (const [key, value] of [
    ["user.name", "Lean Acceptance"],
    ["user.email", "lean@example.invalid"]
  ]) {
    const result = spawnSync("git", ["config", "--local", key, value], {
      cwd: workspace,
      encoding: "utf8"
    })
    assert.equal(result.status, 0, result.stderr)
  }
}
