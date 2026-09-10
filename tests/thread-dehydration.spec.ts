import assert from "node:assert/strict"
import {
  createDehydratedThreadStatePatch,
  hasBlockingSpecialThreadActivity
} from "../src/renderer/src/lib/thread-dehydration"

const terminalWorkerStatuses = ["completed", "failed", "cancelled"] as const
for (const status of terminalWorkerStatuses) {
  assert.equal(
    hasBlockingSpecialThreadActivity({
      scheduledTaskLoading: false,
      goalStatus: "complete",
      workflowStatus: "completed",
      coordinatorWorkers: [{ status, notification_acknowledged: true }]
    }),
    false,
    `${status} acknowledged tasks are safe to dehydrate`
  )
}

for (const activity of [
  {
    scheduledTaskLoading: true,
    coordinatorWorkers: []
  },
  {
    scheduledTaskLoading: false,
    goalStatus: "active" as const,
    coordinatorWorkers: []
  },
  {
    scheduledTaskLoading: false,
    workflowStatus: "running" as const,
    coordinatorWorkers: []
  },
  {
    scheduledTaskLoading: false,
    coordinatorWorkers: [{ status: "running" as const }]
  },
  {
    scheduledTaskLoading: false,
    coordinatorWorkers: [{ status: "completed" as const }]
  }
]) {
  assert.equal(hasBlockingSpecialThreadActivity(activity), true)
}

assert.equal(
  hasBlockingSpecialThreadActivity({
    scheduledTaskLoading: false,
    goalStatus: "paused",
    coordinatorWorkers: []
  }),
  false,
  "a paused durable goal is safe to dehydrate and restore on reopen"
)

const dehydrated = createDehydratedThreadStatePatch()
for (const [name, value] of Object.entries({
  messages: dehydrated.messages,
  todos: dehydrated.todos,
  workspaceFiles: dehydrated.workspaceFiles,
  subagents: dehydrated.subagents,
  coordinatorWorkers: dehydrated.coordinatorWorkers,
  subagentInternalLogs: dehydrated.subagentInternalLogs,
  openFiles: dehydrated.openFiles
})) {
  assert.equal(value.length, 0, `${name} must be released by dehydration`)
}
assert.equal(Object.keys(dehydrated.fileContents).length, 0)
assert.equal(Object.keys(dehydrated.subagentTranscripts).length, 0)
assert.equal(dehydrated.workflowRun, null)
assert.equal(dehydrated.goalUi.goal, null)
assert.equal(
  dehydrated.historyLoading,
  true,
  "a dehydrated transcript must remain a loading shell until its bounded page is published"
)
assert.equal(dehydrated.dehydrated, true)

const dehydratedWithTabs = createDehydratedThreadStatePatch({
  openFiles: [{ path: "src/main.ts", name: "main.ts" }],
  activeTab: "src/main.ts"
})
assert.deepEqual(dehydratedWithTabs.openFiles, [
  { path: "src/main.ts", name: "main.ts" }
])
assert.equal(dehydratedWithTabs.activeTab, "src/main.ts")
assert.notEqual(
  dehydratedWithTabs.openFiles,
  dehydrated.openFiles,
  "retained tab paths must be copied, not share a mutable state array"
)
assert.equal(
  JSON.stringify(dehydrated.fileContents).length,
  2,
  "dehydrated file preview bytes must be reduced to an empty object"
)

console.log("thread dehydration activity contracts passed")
