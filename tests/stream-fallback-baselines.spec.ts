import assert from "node:assert/strict"
import type { Message } from "../src/renderer/src/types"
import { updateFallbackIndexBaselineCache } from "../src/renderer/src/lib/stream-fallback-baselines"

function message(id: string, role: Message["role"], content = id): Message {
  return { id, role, content } as Message
}

const first = [
  message("user-1", "user"),
  message("assistant-1", "assistant"),
  message("tool-1", "tool"),
  message("system-1", "system")
]
const initial = updateFallbackIndexBaselineCache(undefined, first)
assert.deepEqual(initial.baselines, { ai: 1, tool: 1, system: 1, human: 0 })

const appended = [
  ...first,
  message(
    "goal-1",
    "user",
    "[Starting active goal]\n<untrusted_objective>finish</untrusted_objective>"
  ),
  message("assistant-2", "assistant")
]
const advanced = updateFallbackIndexBaselineCache(initial, appended)
assert.deepEqual(advanced.baselines, { ai: 2, tool: 1, system: 1, human: 1 })

// The immutable append fast path must preserve the previous result object when
// React renders again with the exact same messages reference.
assert.equal(updateFallbackIndexBaselineCache(advanced, appended), advanced)

// A replacement is not an append. Recount it from zero instead of carrying the
// old AI/tool counters into a different transcript.
const replacement = [message("replacement-system", "system")]
assert.deepEqual(updateFallbackIndexBaselineCache(advanced, replacement).baselines, {
  ai: 0,
  tool: 0,
  system: 1,
  human: 0
})

console.log("stream fallback baseline tests passed")
