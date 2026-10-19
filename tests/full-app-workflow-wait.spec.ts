import assert from "node:assert/strict"
import { waitForOriginalWorkflowTerminal } from "./support/full-app-workflow-wait"

async function main() {
  const aborted = new AbortController()
  aborted.abort(new Error("original fixture failed"))
  let observed = 0
  await assert.rejects(waitForOriginalWorkflowTerminal({ readTerminal: () => undefined,
    deadline: Date.now() + 900000, signal: aborted.signal, observe: () => { observed++ } }),
  /original fixture failed/)
  assert.equal(observed, 0)

  const cleanup = new AbortController()
  const waiting = waitForOriginalWorkflowTerminal({ readTerminal: () => undefined,
    deadline: Date.now() + 900000, signal: cleanup.signal, observe: () => { observed++ } })
  assert.equal(observed, 1, "The actual wait started before cleanup")
  cleanup.abort(new Error("fixture finally cleanup"))
  await assert.rejects(waiting, /aborted/)
  assert.equal(observed, 1, "Cleanup must not leave the50ms poll alive until the15min deadline")

  const active = new AbortController()
  const originalFailure = { status: "error", error: "MODS_SESSION_CAPACITY" }
  const result = await waitForOriginalWorkflowTerminal({ readTerminal: () => originalFailure,
    deadline: Date.now() + 900000, signal: active.signal, observe: () => assert.fail("No pending wait") })
  assert.equal(result, originalFailure, "The helper must never turn an actual failed terminal into success")
  const missing = await waitForOriginalWorkflowTerminal({ readTerminal: () => undefined,
    deadline: Date.now() - 1, signal: active.signal, observe: () => assert.fail("Deadline already elapsed") })
  assert.equal(missing, undefined, "Deadline expiry cannot invent a terminal result")
  await assert.rejects(waitForOriginalWorkflowTerminal({ readTerminal: () => undefined,
    deadline: Date.now() + 900000, signal: active.signal,
    observe: () => { throw Error("original90s gate failed") } }), /original90s gate failed/)
  console.log("PASS fixture Workflow wait: owned abort before/during poll, original failures/deadlines unchanged, no fabricated terminal")
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
