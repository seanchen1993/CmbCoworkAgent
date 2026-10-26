import { expect, it } from "vitest"
import { ToolMessage } from "@langchain/core/messages"
import { observeWorkflowRun } from "./observation"
import type { PersistedWorkflowRun } from "./types"
import { filterModResult } from "../../mods/publication"
import { captureNativeMessage } from "../native-message-capture"

function source(count: number): PersistedWorkflowRun {
  return {
    version: 1,
    runId: "run",
    threadId: "thread",
    workflowName: "test",
    status: "running",
    phases: [],
    currentPhase: null,
    startedAt: "start",
    updatedAt: "update",
    script: "private-script",
    scriptSha256: "script-sha",
    logs: ["private-log"],
    journal: [],
    stats: { agentsTotal: count, agentsCached: 0, agentsFailed: 0, outputTokens: 0, durationMs: 0 },
    agents: Array.from({ length: count }, (_, index) => ({
      index,
      label: "任务".repeat(300),
      phase: "实现".repeat(300),
      status: "running",
      outputTokens: 0,
      startedAt: "start",
      promptPreview: "private-prompt",
      resultPreview: "private-result"
    })),
    worktrees: []
  }
}

it("provides bounded pages without losing access to remaining original rows or exposing content", () => {
  const run = source(100)
  const indices: number[] = []
  let offset: number | null = 0
  do {
    const page = observeWorkflowRun(run, { agentOffset: offset, limit: 32 })
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(16000)
    expect(page.agents.length).toBeGreaterThan(0)
    indices.push(...page.agents.map((agent) => agent.index))
    expect(JSON.stringify(page)).not.toContain("private-")
    offset = page.nextAgentOffset
  } while (offset !== null)
  expect(indices).toEqual(Array.from({ length: 100 }, (_, index) => index))
  expect(run.agents).toHaveLength(100)
  expect(run.agents[0].label.length).toBe(600)
})

it("rejects non-progressing or unbounded pages", () => {
  for (const value of [0, -1, NaN, Infinity, 1.5, 33])
    expect(() => observeWorkflowRun(source(1), { limit: value })).toThrow()
})

it("projects the original declared repository reference without inferring one from paths", () => {
  const run = source(0)
  run.worktrees = [undefined, "secondary"].map((workspaceRef, index) => ({
    id: `tree-${index}`, runId: run.runId, threadId: run.threadId,
    branch: `workflow/${index}`, directory: `/private/tree-${index}`,
    workspaceDirectory: `/private/tree-${index}`, sourceRoot: "/private/source",
    sourceRelativePath: "", sourceBranch: "main", gitRoot: "/private/source",
    commonDir: "/private/source/.git", baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40), integrationCommit: "c".repeat(40),
    dirty: false, status: "merged", updatedAt: "updated",
    resource: { id: String(index).repeat(64), generation: 1, state: "sealed",
      sourceIdentity: "source", parentIdentity: "parent", ownerToken: "private-owner",
      sealedCommit: "b".repeat(40), ...(workspaceRef ? { workspaceRef } : {}) }
  }))
  const page = observeWorkflowRun(run)
  expect(page.worktrees.map(row => row.resource?.workspaceRef)).toEqual([null, "secondary"])
  expect(page.worktrees[1]).toMatchObject({ integrationCommit: "c".repeat(40),
    resource: { sealedCommit: "b".repeat(40), state: "sealed" } })
  expect(page.worktrees[1].resource).not.toHaveProperty("ownerToken")
  run.result = { detail: "x".repeat(5900) }
  run.worktrees = [run.worktrees[0]]
  const startedAt = 1000
  run.worktrees[0].resource!.budgets = [{
    budgetId: "large-history", generation: 1, startedAt, firstDeadlineAt: 2000, deadlineAt: 3000,
    policy: { firstExecutionMs: 1000, totalMs: 2000, commandMs: 500 }, status: "active",
    commands: [{ commandId: "ut", argv: ["x".repeat(6000)], status: "prepared" }]
  }]
  const bounded = observeWorkflowRun(run)
  expect(bounded.worktrees).toHaveLength(1)
  expect(bounded.nextWorktreeOffset).toBeNull()
  expect(bounded.worktrees[0].resource?.budgetsTruncated).toBe(true)
  expect(bounded.worktrees[0].resource?.budgets).toEqual([])
  expect(run.worktrees[0].resource!.budgets[0].commands[0].argv[0]).toHaveLength(6000)
})

it("preserves complete workflow pages through protected Mod publication and native capture", () => {
  const run = source(2)
  const pages = [0, 1].map((agentOffset) => {
    const page = observeWorkflowRun(run, { agentOffset, limit: 1 })
    const message = new ToolMessage({
      id: `workflow-page-${agentOffset}`,
      tool_call_id: `inspect-${agentOffset}`,
      content: "Authoritative workflow page",
      artifact: { status: "succeeded", value: { found: true, run: page } }
    })
    const captured = captureNativeMessage(filterModResult(message, true))
    expect(captured.data.artifact).toEqual(message.artifact)
    expect(page).not.toHaveProperty("truncated")
    return page
  })
  expect(pages.map((page) => page.hasMore)).toEqual([true, false])
  expect(pages.flatMap((page) => page.agents.map((agent) => agent.index))).toEqual([0, 1])
  const command = new ToolMessage({
    id: "incomplete-command", tool_call_id: "execute", content: "Command result",
    artifact: { exitCode: 2, output: "partial private output", truncated: true }
  })
  expect(captureNativeMessage(filterModResult(command, true)).data.artifact).toEqual({
    exitCode: 2, output: "[Incomplete output suppressed by project policy]", truncated: true
  })
})
