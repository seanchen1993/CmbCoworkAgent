import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  createCompletedResourceProjector,
  type ResourceMessage
} from "../src/renderer/src/lib/latest-completed-resource"

const persisted: ResourceMessage[] = Array.from({ length: 10_000 }, (_, index) => ({
  id: `persisted-${index}`,
  role: "assistant"
}))
persisted[9_998] = {
  id: "persisted-edit",
  role: "assistant",
  tool_calls: [
    {
      id: "persisted-call",
      name: "edit_file",
      args: { path: "docs/old.md", old_string: "old", new_string: "new" }
    }
  ]
}
persisted[9_999] = {
  id: "persisted-result",
  role: "tool",
  tool_call_id: "persisted-call"
}

let poisonStreamingPrefix = false
const streaming = Array.from({ length: 2_000 }, (_, index): ResourceMessage => {
  const message = { id: `stream-${index}`, type: "ai", content: `content-${index}` }
  if (index === 1_999) return message
  return new Proxy(message, {
    get(target, property, receiver) {
      if (poisonStreamingPrefix) {
        throw new Error(`stable streaming prefix was read at ${String(property)}`)
      }
      return Reflect.get(target, property, receiver)
    }
  })
})

const project = createCompletedResourceProjector()
let result = project(persisted, streaming)
assert.equal(result.latestResourceEvent?.path, "docs/old.md")
assert.deepEqual(result.latestCompletedLlmBatch?.files, ["docs/old.md"])

poisonStreamingPrefix = true
for (let frame = 0; frame < 1_000; frame += 1) {
  const next = streaming.slice()
  next[1_999] = { id: "stream-1999", type: "ai", content: `tail-${frame}` }
  result = project(persisted, next)
  streaming[1_999] = next[1_999]
}
assert.equal(result.latestResourceEvent?.path, "docs/old.md")
poisonStreamingPrefix = false

streaming.push(
  {
    id: "streaming-edit",
    type: "ai",
    tool_calls: [
      {
        id: "streaming-call",
        name: "write_file",
        args: { path: "src/new.ts", content: "export const value = 1" }
      }
    ]
  },
  {
    id: "streaming-result",
    type: "tool",
    tool_call_id: "streaming-call"
  }
)
result = project(persisted, streaming)
assert.equal(result.latestResourceEvent?.path, "src/new.ts")
assert.equal(result.latestResourceEvent?.source, "streaming")
assert.deepEqual(result.latestCompletedLlmBatch?.files, ["src/new.ts"])

const prependedHistory = [{ id: "older-page", role: "user" }, ...persisted]
assert.equal(
  project(prependedHistory, streaming).latestResourceEvent?.path,
  "src/new.ts",
  "prepending an older page should conservatively rebuild without changing the latest event"
)

const changedTool = streaming.slice()
changedTool[2_000] = {
  id: "streaming-edit",
  type: "ai",
  tool_calls: [
    {
      id: "streaming-call",
      name: "write_file",
      args: { path: "src/renamed.ts", content: "export const value = 2" }
    }
  ]
}
assert.equal(project(prependedHistory, changedTool).latestResourceEvent?.path, "src/renamed.ts")

const panelSource = readFileSync(
  resolve(__dirname, "../src/renderer/src/components/panels/RightPanel.tsx"),
  "utf8"
).replace(/\r\n/g, "\n")
assert.match(panelSource, /createCompletedResourceProjector\(\)/)
assert.doesNotMatch(
  panelSource,
  /persisted\.map\(\(m\) => \(\{ source: "persisted"/,
  "RightPanel must not rebuild full persisted resource arrays on content tokens"
)
const streamEffectsStart = panelSource.indexOf("const RightPanelStreamEffects = memo(")
const panelStart = panelSource.indexOf("export function RightPanel", streamEffectsStart)
assert.ok(streamEffectsStart >= 0 && panelStart > streamEffectsStart)
assert.match(
  panelSource.slice(streamEffectsStart, panelStart),
  /useThreadStream\(threadId\)/,
  "a small resource-effect child must own the high-frequency stream subscription"
)
assert.doesNotMatch(
  panelSource.slice(panelStart),
  /useThreadStream\(/,
  "ordinary content tokens must not rerender the full RightPanel tree"
)
assert.doesNotMatch(
  panelSource,
  /useThreadState\(/,
  "RightPanel sections must subscribe to narrow projections instead of the full ThreadState"
)
assert.match(
  panelSource,
  /useThreadStateSelector\(/,
  "RightPanel sections must keep unrelated token updates outside their render boundary"
)

console.log("latest completed resource projector tests passed")
