import assert from "node:assert/strict"
import {
  projectKanbanSubagents,
  type KanbanSubagentSummary
} from "../src/renderer/src/lib/thread-state-summary"
import type { Subagent } from "../src/renderer/src/types"

const initial: Subagent[] = Array.from({ length: 2_000 }, (_, index) => ({
  id: `subagent-${index}`,
  name: `Subagent ${index}`,
  description: `Description ${index}`,
  status: index === 1_999 ? "running" : "completed",
  currentTool: "read_file",
  lastActivityAt: "2026-08-21T00:00:00.000Z"
}))

const first = projectKanbanSubagents(initial, undefined, undefined)
let poisonReads = false
const stable = new Proxy(initial, {
  get(target, property, receiver) {
    if (poisonReads && typeof property === "string" && /^\d+$/.test(property)) {
      throw new Error(`stable subagent summary prefix was read at ${property}`)
    }
    return Reflect.get(target, property, receiver)
  }
})
const stableProjection = projectKanbanSubagents(stable, undefined, undefined)
poisonReads = true
assert.equal(
  projectKanbanSubagents(stable, stable, stableProjection),
  stableProjection,
  "content-only thread frames must reuse the existing subagent projection"
)
poisonReads = false

const activityOnly = initial.map((subagent, index) =>
  index === 1_999
    ? { ...subagent, currentTool: "write_file", lastActivityAt: "2026-08-21T00:00:01.000Z" }
    : subagent
)
assert.equal(
  projectKanbanSubagents(activityOnly, initial, first),
  first,
  "activity-only subagent updates must not wake Kanban subscribers"
)

const statusChanged = activityOnly.map((subagent, index) =>
  index === 1_999 ? { ...subagent, status: "completed" as const } : subagent
)
const changed = projectKanbanSubagents(statusChanged, activityOnly, first)
assert.notEqual(changed, first, "status changes must publish a new Kanban summary")
assert.equal((changed as readonly KanbanSubagentSummary[])[1_999].status, "completed")

console.log("thread state summary tests passed")
