import { describe, expect, it } from "vitest"
import {
  resolveAgentModeFromMetadata,
  resolveThreadExecutionModeFromMetadata
} from "./agent-mode-metadata"

describe("agent mode metadata", () => {
  it("resolves current and legacy coordinator metadata with explicit-mode precedence", () => {
    expect(resolveAgentModeFromMetadata({ coordinatorMode: "true" })).toBe("coordinator")
    expect(resolveAgentModeFromMetadata({ agentMode: "normal", coordinatorMode: true })).toBe(
      "normal"
    )
    expect(resolveAgentModeFromMetadata({ agentMode: "workflow", coordinatorMode: true })).toBe(
      "workflow"
    )
  })

  it("resolves the full execution profile used by mutation guards", () => {
    expect(resolveThreadExecutionModeFromMetadata({ coordinatorMode: "on" })).toBe("coordinator")
    expect(
      resolveThreadExecutionModeFromMetadata({ agentMode: "normal", subagentsEnabled: false })
    ).toBe("normal")
    expect(resolveThreadExecutionModeFromMetadata({ agentMode: "normal" })).toBe("multi")
    expect(resolveThreadExecutionModeFromMetadata({})).toBe("multi")
  })
})
