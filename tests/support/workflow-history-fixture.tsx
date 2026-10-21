import { createRoot } from "react-dom/client"
import { WorkflowRunsDialog } from "../../src/renderer/src/components/chat/WorkflowRunsDialog"
import { WorkflowRunPanel } from "../../src/renderer/src/components/chat/WorkflowRunPanel"
import {
  workflowRunViewFromPersisted,
  type PersistedWorkflowRunDTO
} from "../../src/renderer/src/lib/workflow-run-view"

type Mode =
  | "healthy"
  | "error"
  | "missing"
  | "worktree-error"
  | "malformed-worktree"
  | "action-error"
  | "action-read-error"
const root = createRoot(document.getElementById("root")!)
let mode: Mode = "healthy"
let renderId = 0
const run: PersistedWorkflowRunDTO = {
  runId: "wf_browserhistory",
  workflowName: "已完成的 worktree 工作流",
  status: "completed",
  phases: [],
  currentPhase: null,
  agents: [],
  logs: ["工作流执行日志仍可查看"],
  result: "已保存的工作流结果",
  script: "return 'workflow result'",
  startedAt: "2026-10-21T00:00:00.000Z",
  stats: { agentsTotal: 0, agentsCached: 0, agentsFailed: 0, outputTokens: 42, durationMs: 1000 },
  worktrees: [
    {
      id: "history-worktree",
      branch: "cmbcowork/wf/history",
      directory: "C:/worktrees/history",
      workspaceDirectory: "C:/worktrees/history",
      status: "ready",
      dirty: false,
      updatedAt: "2026-10-21T00:00:00.000Z"
    }
  ]
}

function response(): PersistedWorkflowRunDTO | null {
  if (mode === "error") throw new Error("simulated IPC read failure")
  if (mode === "missing") return null
  if (mode === "worktree-error" || mode === "malformed-worktree") {
    return {
      ...run,
      worktreeReadError:
        "Worktree 状态核对失败，交付物暂为只读。运行结果和日志仍可查看，请刷新后重试。",
      worktrees: mode === "malformed-worktree" ? [{} as never] : run.worktrees
    }
  }
  return run
}

Object.defineProperty(window, "api", {
  value: {
    workflows: {
      listRuns: async () => ({ runs: [{ ...run, agentCount: 0 }], nextCursor: null }),
      getRun: async () => response(),
      onWorkflowEvents: () => () => undefined,
      worktreeAction: async () => {
        mode = mode === "action-read-error" ? "error" : "worktree-error"
        throw new Error("unexpected worktree action")
      }
    }
  }
})

function renderWorkflowHistoryFixture(next: Mode, panel = false): void {
  mode = next
  renderId += 1
  root.render(
    <main style={{ padding: 24 }} key={renderId}>
      {panel ? (
        <WorkflowRunPanel
          threadId="history-thread"
          run={workflowRunViewFromPersisted(response()!)}
        />
      ) : (
        <WorkflowRunsDialog threadId="history-thread" open onOpenChange={() => undefined} />
      )}
    </main>
  )
}

Object.assign(window, {
  renderWorkflowHistoryFixture,
  setWorkflowHistoryResponse: (next: Mode) => {
    mode = next
  }
})
renderWorkflowHistoryFixture("worktree-error")
