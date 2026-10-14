import { describe, expect, it } from "vitest"
import { parseFlowDefinition } from "./schema"
import type { FlowAttempt, HostFlowDefinition } from "./types"
import { projectPromptOnlyPrior, PROMPT_ONLY_PRIOR_MAX_BYTES } from "./prompt-only-prior"

function fixture(count = 2) {
  const definition = parseFlowDefinition({
    schemaVersion: 2,
    id: "flow",
    name: "Flow",
    execution: { kind: "host", profile: "prompt-only-v1" },
    goal: "Work",
    timeoutMs: 60000,
    maxExecutions: 32,
    steps: Array.from({ length: count + 1 }, (_, index) => ({
      id: `step-${index}`,
      name: `Step ${index}`,
      enabled: true,
      kind: "agent",
      prompt: "Work"
    }))
  }) as HostFlowDefinition
  const receipts: FlowAttempt[] = Array.from({ length: count }, (_, index) => ({
    executionId: `execution-${index}`,
    stepId: `step-${index}`,
    epoch: 0,
    attempt: 1,
    status: "passed",
    startedAt: 1,
    finishedAt: 2,
    result: { source: "agent", passed: true, summary: `summary-${index}` }
  }))
  return { definition, receipts, target: `step-${count}` }
}
describe("prompt-only-prior-v1 projection", () => {
  it("projects the first step as an empty JSON context", () => {
    const f = fixture(0)
    expect(projectPromptOnlyPrior(f.definition, f.target, f.receipts)).toEqual({
      version: "prompt-only-prior-v1",
      text: "[]",
      utf8Bytes: 2
    })
  })
  it("keeps exact ordered summary text and excludes receipt identities and private evidence", () => {
    const f = fixture()
    f.receipts[0].result!.summary = '  中文\n"quoted"\t<script>text</script>  '
    const copied = f.receipts.map((receipt) => ({
      ...receipt,
      reusedFrom: { runId: "PRIVATE-RUN", executionId: receipt.executionId },
      inputFingerprint: "PRIVATE-INPUT",
      outputFingerprint: "PRIVATE-OUTPUT",
      // Projection must not inspect or disclose even malformed opaque evidence payloads.
      recoveryEvidence: { secret: "PRIVATE-EVIDENCE" } as unknown as NonNullable<
        FlowAttempt["recoveryEvidence"]
      >,
      result: { ...receipt.result!, output: { secret: "PRIVATE-RESULT" } }
    }))
    const before = structuredClone(copied)
    const result = projectPromptOnlyPrior(f.definition, f.target, copied)
    expect(JSON.parse(result.text)).toEqual(
      f.receipts.map((r) => ({ stepId: r.stepId, summary: r.result!.summary }))
    )
    expect(result.text).not.toContain("PRIVATE")
    expect(result.text).not.toContain("execution-")
    expect(result.text).toBe(projectPromptOnlyPrior(f.definition, f.target, f.receipts).text)
    expect(copied).toEqual(before)
  })
  it("does not silently apply the ordinary profile's 12 item or 2000 character truncation", () => {
    const f = fixture(13)
    f.receipts[0].result!.summary = "x".repeat(8000)
    const result = JSON.parse(projectPromptOnlyPrior(f.definition, f.target, f.receipts).text)
    expect(result).toHaveLength(13)
    expect(result[0].summary).toHaveLength(8000)
  })
  it("uses UTF-8 bytes and rejects over-limit text without truncation", () => {
    const f = fixture(3)
    f.receipts.forEach((r) => {
      r.result!.summary = "界".repeat(8000)
    })
    expect(
      JSON.stringify(f.receipts.map((r) => ({ stepId: r.stepId, summary: r.result!.summary })))
        .length
    ).toBeLessThan(PROMPT_ONLY_PRIOR_MAX_BYTES)
    const before = structuredClone(f.receipts)
    expect(() => projectPromptOnlyPrior(f.definition, f.target, f.receipts)).toThrow(
      "FLOW_PROMPT_CONTEXT_LIMIT"
    )
    expect(f.receipts).toEqual(before)
  })
  it("accepts exactly 64KiB and rejects one additional byte", () => {
    const f = fixture(9)
    const rows = f.receipts.map((r) => ({ stepId: r.stepId, summary: "" }))
    let remaining =
      PROMPT_ONLY_PRIOR_MAX_BYTES - new TextEncoder().encode(JSON.stringify(rows)).length
    f.receipts.forEach((r, index) => {
      const size = Math.min(8000, remaining - (f.receipts.length - index - 1))
      r.result!.summary = "x".repeat(size)
      remaining -= size
    })
    expect(projectPromptOnlyPrior(f.definition, f.target, f.receipts).utf8Bytes).toBe(
      PROMPT_ONLY_PRIOR_MAX_BYTES
    )
    f.receipts.at(-1)!.result!.summary += "x"
    expect(() => projectPromptOnlyPrior(f.definition, f.target, f.receipts)).toThrow(
      "FLOW_PROMPT_CONTEXT_LIMIT"
    )
  })
  it("rejects missing, reordered, duplicate, invalidated, failed and malformed receipts", () => {
    for (const mutate of [
      (r: FlowAttempt[]) => {
        r.pop()
      },
      (r: FlowAttempt[]) => {
        r.reverse()
      },
      (r: FlowAttempt[]) => {
        r[1] = r[0]
      },
      (r: FlowAttempt[]) => {
        r[0].invalidated = true
      },
      (r: FlowAttempt[]) => {
        r[0].status = "failed"
      },
      (r: FlowAttempt[]) => {
        r[0].result!.source = "native-check"
      },
      (r: FlowAttempt[]) => {
        r[0].result!.summary = "x".repeat(8001)
      }
    ]) {
      const f = fixture()
      mutate(f.receipts)
      expect(() => projectPromptOnlyPrior(f.definition, f.target, f.receipts)).toThrow(
        "FLOW_PROMPT_CONTEXT_INVALID"
      )
    }
  })
  it("does not project disabled Agents and does not opt ordinary definitions into the mode", () => {
    const f = fixture()
    f.definition.steps[0].enabled = false
    expect(
      JSON.parse(projectPromptOnlyPrior(f.definition, f.target, f.receipts.slice(1)).text)
    ).toHaveLength(1)
    delete f.definition.execution.profile
    expect(() => projectPromptOnlyPrior(f.definition, f.target, f.receipts)).toThrow(
      "FLOW_PROMPT_PROFILE_REQUIRED"
    )
  })
})
