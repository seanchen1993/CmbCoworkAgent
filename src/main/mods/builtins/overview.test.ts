import { describe, expect, it } from "vitest"
import type { ModAuditEntry } from "../../../shared/mods/types"
import { projectBuiltinRunOverview } from "./overview"
import { describeDevClawBuiltins } from "./registry"

const call = (id: string, threadId = "one", start = 100, end = 200): ModAuditEntry => ({
  cursor: 1,
  callId: id,
  toolId: "model.complete",
  identity: {
    callId: id,
    threadId,
    turnId: "turn",
    agentId: "main",
    workspace: "workspace",
    origin: "mod",
    grantEpoch: 1
  },
  status: "succeeded",
  startedAt: start,
  finishedAt: end,
  originalArgsHash: "original",
  finalArgsHash: null,
  policyDigest: null,
  publication: "published",
  ruleIds: [],
  reconciliation: null
})
const view = (records: ModAuditEntry[]) =>
  projectBuiltinRunOverview({
    threadId: "one",
    workspace: "workspace",
    capturedAt: 500,
    records,
    limited: false,
    instructions: { status: "unknown", message: "no facts" },
    policy: { required: true, denyTools: [] }
  })

describe("built-in fact projection", () => {
  it("filters other chats and deduplicates actual calls before counting", () => {
    const row = call("one")
    row.modelUsage = { modelRef: "local", outputTokenLimit: 100, inputTokens: 12, outputTokens: 0 }
    const result = view([row, row, call("foreign", "two")])
    expect(result.metrics.sampled).toBe(1)
    expect(result.metrics.inputTokens).toBe(12)
    expect(result.metrics.outputTokens).toBe(0)
    expect(result.metrics.cost).toBeNull()
    expect(result.instructions.status).toBe("unknown")
  })
  it("does not add parallel elapsed spans or turn missing usage into zero", () => {
    const result = view([call("a", "one", 100, 300), call("b", "one", 150, 400)])
    expect(result.metrics.durationMs).toBe(300)
    expect(result.metrics.inputTokens).toBeNull()
    expect(view([]).metrics.durationMs).toBeNull()
  })
  it("unknown operations suggest checking results rather than replaying", () => {
    const row = call("one")
    row.status = "unknown"
    row.publication = "blocked"
    const result = view([row])
    expect(result.metrics.succeeded).toBe(0)
    expect(result.suggestions.map((item) => item.id)).toEqual(["check-unknown", "inspect-policy"])
    expect(result.policy.recordedBlocks).toBe(1)
  })
  it("only fixed identities are listed and absent providers are unavailable", () => {
    const result = describeDevClawBuiltins({ "devclaw-project-instructions": "partial" })
    expect(result).toHaveLength(6)
    expect(result[0].state).toBe("partial")
    expect(result.slice(1).every((item) => item.state === "unavailable")).toBe(true)
    result[0].name = "changed"
    expect(describeDevClawBuiltins({})[0].name).toBe("项目规范")
  })
})
