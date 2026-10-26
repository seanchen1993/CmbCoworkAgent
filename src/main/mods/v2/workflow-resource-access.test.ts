import { resolve, join } from "node:path"
import { describe, expect, it } from "vitest"
import { assertWorkflowResourceProcess } from "./workflow-resource-access"
import { withWorkflowWorktreeActionScope } from "../../agent/workflow/worktree-action-scope"

const root = resolve("worktree-fixture")
const scope = { workspace: "workspace-key", threadId: "thread", runId: "run",
  boundary: { workspaceRoot: root, worktreeRoot: root, commonDir: resolve("main/.git"), branch: "feature" },
  assertCurrent: () => {} }
const request = (argv = ["python", "-c", "print('hello')"], cwd = root, env = {}) => ({ argv, cwd, env })

describe("native resource process admission", () => {
  it("keeps ordinary process permission unchanged and binds scoped work to the issued lease", async () => {
    expect(assertWorkflowResourceProcess("workspace-key", "thread", request())).toBeUndefined()
    let late!: () => void
    await withWorkflowWorktreeActionScope(scope, async () => {
      late = assertWorkflowResourceProcess("workspace-key", "thread", request())!
      expect(late).toBeTypeOf("function")
      late()
      expect(() => assertWorkflowResourceProcess("other", "thread", request())).toThrow("SCOPE_CHANGED")
    })
    expect(late).toThrow("SCOPE_CHANGED")
  })

  it("rejects cwd escape, Git environment routing and direct or wrapped branch mutation", async () => {
    await withWorkflowWorktreeActionScope(scope, async () => {
      expect(() => assertWorkflowResourceProcess("workspace-key", "thread", request(["python"], resolve(".."))))
        .toThrow("CWD_OUTSIDE")
      expect(() => assertWorkflowResourceProcess("workspace-key", "thread", request(["git", "status"], root,
        { GIT_DIR: "another/.git" }))).toThrow("GIT_ENV")
      for (const argv of [["git", "checkout", "main"], ["sh", "-c", "git checkout main"]])
        expect(() => assertWorkflowResourceProcess("workspace-key", "thread", request(argv)))
          .toThrow("PROCESS_FORBIDDEN")
      expect(() => assertWorkflowResourceProcess("workspace-key", "thread", request(["git", "status"], join(root, "src"))))
        .not.toThrow()
    })
  })
})
