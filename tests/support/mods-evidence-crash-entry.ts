import { ModControlStore } from "../../src/main/mods/control-store"

// A real process that deliberately does not close SQLite before the parent kills it.
const store = new ModControlStore(process.argv[2])
const base = {
  workspace: "project",
  threadId: "thread",
  turnId: "turn",
  runId: "run",
  phase: "capture.started" as const,
  status: "running" as const,
  binding: null,
  capture: {
    workspace: "project",
    threadId: "thread",
    turnId: "turn",
    runId: "run",
    pluginDigests: { review: "digest" },
    runtimeGeneration: 1,
    configFingerprint: "config"
  },
  at: 1
}
store.saveCompletionEvidence({
  ...base,
  id: "pending",
  idempotencyKey: "pending",
  detail: { attempt: "pending" }
})
store.saveCompletionEvidence({
  ...base,
  id: "settled",
  idempotencyKey: "settled",
  detail: { attempt: "settled" }
})
store.saveCompletionEvidence({
  ...base,
  id: "error",
  idempotencyKey: "error",
  phase: "capture.failed",
  status: "error",
  detail: { attempt: "settled", error: "COMPLETION_EVIDENCE_LINK" },
  at: 2
})
process.stdout.write("CAPTURE_DURABLE\n")
setInterval(() => {}, 1000)
