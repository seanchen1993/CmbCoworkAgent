import { readFileSync } from "fs"
import { resolve } from "path"
import { describe, expect, it } from "vitest"

const readRepositoryFile = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), "utf8")

const sourceBetween = (source: string, start: string, end: string): string => {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

describe("agent runtime settings integration", () => {
  const mainProcess = readRepositoryFile("src/main/index.ts")
  const storage = readRepositoryFile("src/main/storage.ts")
  const preload = readRepositoryFile("src/preload/index.ts")
  const preloadTypes = readRepositoryFile("src/preload/index.d.ts")
  const generalPanel = readRepositoryFile("src/renderer/src/components/customize/GeneralPanel.tsx")
  const customizeView = readRepositoryFile(
    "src/renderer/src/components/customize/CustomizeView.tsx"
  )

  it("validates unknown renderer input before persisting or applying it", () => {
    expect(mainProcess).toContain("(event, value: unknown): AgentRuntimeSettings")
    expect(mainProcess).toContain("if (!isAgentGraphRecursionLimit(value))")
    expect(mainProcess).toContain("if (!isWorkflowWorktreeTimeoutMinutes(value))")
    expect(mainProcess).toContain("if (!isWorkflowWorktreeRemoveTimeoutMinutes(value))")
    expect(mainProcess.indexOf("if (!isAgentGraphRecursionLimit(value))")).toBeLessThan(
      mainProcess.indexOf("setStoredAgentGraphRecursionLimit(value)")
    )
    expect(storage).toContain("if (!isAgentGraphRecursionLimit(value))")
    expect(storage).toContain("if (!isWorkflowWorktreeTimeoutMinutes(value))")
    expect(storage).toContain("if (!isWorkflowWorktreeRemoveTimeoutMinutes(value))")
  })

  it("keeps the renderer bridge narrow and typed", () => {
    expect(preload).toContain("getAgentRuntimeSettings")
    expect(preload).toContain("setAgentRuntimeRecursionLimit")
    expect(preload).toContain("setWorkflowWorktreeTimeoutMinutes")
    expect(preload).toContain("setWorkflowWorktreeRemoveTimeoutMinutes")
    expect(preloadTypes).toContain("getAgentRuntimeSettings: () => Promise<AgentRuntimeSettings>")
    expect(preloadTypes).toContain(
      "setAgentRuntimeRecursionLimit: (value: number) => Promise<AgentRuntimeSettings>"
    )
    expect(preloadTypes).toContain(
      "setWorkflowWorktreeTimeoutMinutes: (value: number) => Promise<AgentRuntimeSettings>"
    )
    expect(preloadTypes).toContain(
      "setWorkflowWorktreeRemoveTimeoutMinutes: (value: number) => Promise<AgentRuntimeSettings>"
    )
  })

  it("exposes the bounded graph-step setting in General settings", () => {
    expect(generalPanel).toContain("单次任务运行上限")
    expect(generalPanel).toContain("isAgentGraphRecursionLimit(value)")
    expect(generalPanel).toContain("任务异常时也可能运行更久")
    expect(generalPanel).toContain("setAgentRuntimeRecursionLimit(value)")
    expect(generalPanel).toContain("Git 操作等待时间")
    expect(generalPanel).toContain("不限制 Agent")
    expect(generalPanel).toContain("setWorkflowWorktreeTimeoutMinutes(value)")
    expect(generalPanel).toContain(">Worktree</h2>")
    expect(generalPanel).toContain("删除等待时间")
    expect(generalPanel).toContain("setWorkflowWorktreeRemoveTimeoutMinutes(value)")
  })

  it("routes scale-sensitive worktree create, merge, and save operations through the configured timeout", () => {
    const worktreeService = readRepositoryFile("src/main/services/git-worktree.ts")
    expect(worktreeService).toContain("getWorkflowWorktreeTimeoutMs()")
    expect(worktreeService).toContain("getWorkflowWorktreeRemoveTimeoutMs()")
    expect(worktreeService).not.toContain("GIT_CREATE_TIMEOUT_MS")
    expect(worktreeService).not.toContain("GIT_REMOVE_TIMEOUT_MS")
    expect(worktreeService).not.toContain("180_000")

    const scaleSensitiveHelpers = [
      [
        "async function assertWorkflowWorktreeDeliverablePathsInScope(",
        "function assertGitPathsInScope("
      ],
      ["async function listChangedGitPaths(", "async function assertNoGitlinkChanges("],
      ["async function assertNoGitlinkChanges(", "function gitPathBatches("],
      ["async function assertNoIgnoredSourceCollisions(", "// ── Per-repository serialization"],
      ["async function inspectWorkspaceStatus(", "interface SourceWorkspaceSnapshot"],
      ["async function inspectSourceWorkspaceForProvisioning(", "/** Resolve a path"],
      ["export async function inspectWorkflowWorktree(", "interface WorkflowWorktreeDiff"]
    ] as const
    for (const [start, end] of scaleSensitiveHelpers) {
      const helper = sourceBetween(worktreeService, start, end)
      expect(helper).toContain("timeoutMs = GIT_QUERY_TIMEOUT_MS")
      expect(helper).toContain("signal?: AbortSignal")
      expect(helper.match(/\btimeoutMs\b/g)?.length ?? 0).toBeGreaterThan(1)
    }

    const provisioning = sourceBetween(
      worktreeService,
      "export async function prepareWorkflowWorktreeSource(",
      "export async function createWorkflowWorktree("
    )
    expect(provisioning).toContain("getWorkflowWorktreeTimeoutMs()")
    expect(provisioning).toContain("signal?: AbortSignal")

    const mergeFinalization = sourceBetween(
      worktreeService,
      "async function finishMergedWorkflowWorktree(",
      "export async function diffWorkflowWorktree("
    )
    expect(mergeFinalization).toContain("operationTimeoutMs: number")
    expect(mergeFinalization).toContain("signal?: AbortSignal")
    expect(mergeFinalization).toMatch(/operationTimeoutMs,\r?\n\s+signal/)

    const merge = sourceBetween(
      worktreeService,
      "export async function mergeWorkflowWorktree(",
      "interface WorktreeListEntry"
    )
    expect(merge).toContain("const operationTimeoutMs = getWorkflowWorktreeTimeoutMs()")
    expect(merge.match(/\boperationTimeoutMs\b/g)?.length ?? 0).toBeGreaterThan(10)
    expect(merge).not.toMatch(/git\(record\.sourceRoot, \["write-tree"\]\)/)
    expect(merge).toMatch(/operationTimeoutMs,\r?\n\s+input\.signal/)

    const runtime = readRepositoryFile("src/main/agent/runtime.ts")
    expect(runtime).toContain(
      "timeout: options.worktreeIsolation ? getWorkflowWorktreeTimeoutMs() : 60_000"
    )
  })

  it("opens General by default while preserving explicit deep links", () => {
    expect(customizeView).toContain('(customizeInitialTab as CustomizeTab) || "general"')
    expect(customizeView).toContain('customizeInitialTab === "commitPolicy"')
  })

  it("routes every explicit main, background, workflow, and subagent stream through one getter", () => {
    const runtimeOwners = [
      "src/main/agent/runtime.ts",
      "src/main/agent/workflow/subagent.ts",
      "src/main/ipc/agent.ts",
      "src/main/services/im/remote-runner.ts",
      "src/main/services/heartbeat.ts",
      "src/main/services/scheduler.ts"
    ].map(readRepositoryFile)

    for (const source of runtimeOwners) {
      expect(source).toContain("recursionLimit: getAgentGraphRecursionLimit()")
      expect(source).not.toMatch(/recursionLimit:\s*(?:2000|2_000)/)
    }
  })
})
