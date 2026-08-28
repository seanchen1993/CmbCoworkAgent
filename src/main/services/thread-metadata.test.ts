import { describe, expect, it } from "vitest"
import {
  applyThreadMetadataPatch,
  assertNoActiveAgentModeTransition,
  assertNoTranscriptAgentModeTransition,
  getThreadExecutionMode,
  parseThreadMetadata,
  validateRendererThreadMetadataPatch,
  validateThreadMetadataPatch
} from "./thread-metadata"

describe("thread metadata patch", () => {
  it("rebases owned fields without replacing unrelated current metadata", () => {
    expect(
      applyThreadMetadataPatch(
        { workspacePath: "B", memoryEnabled: false, llmModifiedFiles: ["x"] },
        { set: { agentMode: "coordinator" }, remove: ["memoryEnabled"] }
      )
    ).toEqual({
      workspacePath: "B",
      agentMode: "coordinator",
      llmModifiedFiles: ["x"]
    })
  })

  it("rejects overlapping, duplicate, prototype and non-allowlisted keys", () => {
    expect(() =>
      validateThreadMetadataPatch({ set: { agentMode: "normal" }, remove: ["agentMode"] })
    ).toThrow(/set and removed/)
    expect(() => validateThreadMetadataPatch({ remove: ["model", "model"] })).toThrow(/Duplicate/)
    expect(() => validateThreadMetadataPatch({ remove: ["__proto__"] })).toThrow(/Invalid/)
    expect(() =>
      validateThreadMetadataPatch({ set: { workspacePath: "x" } }, new Set(["agentMode"]))
    ).toThrow(/not renderer-writable/)
  })

  it("recovers from malformed or non-object stored metadata", () => {
    expect(parseThreadMetadata("{")).toEqual({})
    expect(parseThreadMetadata("[]")).toEqual({})
    expect(parseThreadMetadata('{"workspacePath":"ok"}')).toEqual({ workspacePath: "ok" })
  })

  it("strictly bounds renderer values and serialized size", () => {
    expect(() =>
      validateRendererThreadMetadataPatch({ set: { agentMode: { mode: "normal" } } })
    ).toThrow(/Invalid agentMode/)
    expect(() =>
      validateRendererThreadMetadataPatch({ set: { memoryEnabled: "true" } })
    ).toThrow(/Invalid memoryEnabled/)
    expect(() =>
      validateRendererThreadMetadataPatch({ set: { coordinatorMode: true } })
    ).toThrow(/only be removed/)
    expect(() =>
      validateRendererThreadMetadataPatch({ set: { model: "x".repeat(1025) } })
    ).toThrow(/Invalid model/)
    expect(() =>
      validateRendererThreadMetadataPatch({
        remove: Array.from({ length: 2_000 }, () => "model")
      })
    ).toThrow()
    expect(() =>
      validateRendererThreadMetadataPatch({
        set: { agentMode: "workflow", outputStyle: "concise", model: "provider/model" }
      })
    ).not.toThrow()
  })

  it("rejects pathological renderer shapes before serializing their values", () => {
    const hugeValue = Object.create(null) as Record<string, unknown>
    for (let index = 0; index < 10_000; index += 1) {
      hugeValue[`field-${index}`] = index
    }

    expect(() =>
      validateRendererThreadMetadataPatch({ set: { model: hugeValue } })
    ).toThrow(/Invalid model/)
    expect(() =>
      validateRendererThreadMetadataPatch({
        remove: Array.from({ length: 10_000 }, (_, index) => `field-${index}`)
      })
    ).toThrow(/too many fields/)
  })

  it("rejects real mode changes during an active run but permits an idempotent patch", () => {
    expect(() =>
      assertNoActiveAgentModeTransition(
        { agentMode: "normal" },
        { agentMode: "workflow" },
        true
      )
    ).toThrow(/仍在响应中/)
    expect(() =>
      assertNoActiveAgentModeTransition(
        { agentMode: "normal" },
        { agentMode: "coordinator" },
        true
      )
    ).toThrow(/仍在响应中/)
    expect(() =>
      assertNoActiveAgentModeTransition(
        { agentMode: "normal" },
        { agentMode: "normal", model: "next" },
        true
      )
    ).not.toThrow()
    expect(() =>
      assertNoActiveAgentModeTransition(
        { agentMode: "normal", subagentsEnabled: false },
        { agentMode: "normal", subagentsEnabled: true },
        true
      )
    ).toThrow(/仍在响应中/)
  })

  it("locks execution-profile changes after durable or legacy transcript presence", () => {
    expect(() =>
      assertNoTranscriptAgentModeTransition(
        { agentMode: "normal", subagentsEnabled: false },
        { agentMode: "coordinator" },
        false
      )
    ).not.toThrow()
    expect(() =>
      assertNoTranscriptAgentModeTransition(
        { agentMode: "normal", subagentsEnabled: false },
        { agentMode: "coordinator" },
        true
      )
    ).toThrow(/已有对话消息/)
    expect(() =>
      assertNoTranscriptAgentModeTransition(
        { agentMode: "normal", subagentsEnabled: false },
        { agentMode: "normal", subagentsEnabled: true },
        true
      )
    ).toThrow(/已有对话消息/)
    expect(() =>
      assertNoTranscriptAgentModeTransition(
        { agentMode: "normal", subagentsEnabled: true },
        { agentMode: "normal", subagentsEnabled: true, model: "next" },
        true
      )
    ).not.toThrow()
  })

  it("uses the legacy coordinator flag consistently in all execution-mode guards", () => {
    expect(getThreadExecutionMode({ coordinatorMode: "true" })).toBe("coordinator")
    expect(() =>
      assertNoTranscriptAgentModeTransition(
        { coordinatorMode: true },
        { coordinatorMode: true, agentMode: "coordinator" },
        true
      )
    ).not.toThrow()
    expect(() =>
      assertNoTranscriptAgentModeTransition(
        { coordinatorMode: true },
        { agentMode: "normal", subagentsEnabled: true },
        true
      )
    ).toThrow(/已有对话消息/)
  })
})
