import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const source = readFileSync(join(process.cwd(), "src/main/ipc/agent.ts"), "utf8")

assert.equal(
  source.match(/createStreamMessageSideEffectBuffer\(/g)?.length,
  3,
  "invoke, resume, and interrupt streams must all use the attempt-local buffer"
)
assert.equal(source.match(/\.drain\(\)/g)?.length, 3)
assert.match(source, /getPremergedStreamSideEffectReasoning\(payload\)/)
assert.match(source, /private assistantText = ""/)
assert.match(source, /MAX_STOP_CONTEXT_TEXT_CHARS \+ 1 - this\.assistantText\.length/)
assert.doesNotMatch(source, /assistantChunks/)

console.log("stream side-effect plumbing tests passed")
