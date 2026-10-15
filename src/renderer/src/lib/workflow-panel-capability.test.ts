import { describe, expect, it } from "vitest"
import { hasWorkflowPanelCapability, isWorkflowModeMetadata } from "./coordinator-mode-helpers"

describe("workflow panel restoration", () => {
  it("restores local Bot workflows without changing private or group conversation mode", () => {
    for (const extra of [{}, { botGroupId: "group" }]) {
      const metadata = { botHostId: "local", botId: "bot", agentMode: "normal", ...extra }
      expect(hasWorkflowPanelCapability(metadata)).toBe(true)
      expect(isWorkflowModeMetadata(metadata)).toBe(false)
    }
    expect(hasWorkflowPanelCapability({ agentMode: "workflow" })).toBe(true)
  })

  it.each([
    undefined,
    null,
    [],
    {},
    { agentMode: "normal" },
    { agentMode: "coordinator" },
    { agentMode: "normal", goalId: "goal" },
    { botId: "bot" },
    { botId: "bot", botHostId: "remote" },
    { botId: "", botHostId: "local" },
    { botId: "bot", botHostId: "local", agentMode: "coordinator" }
  ])("does not hydrate workflows for unrelated or unbound conversations (%j)", (metadata) => {
    expect(hasWorkflowPanelCapability(metadata)).toBe(false)
  })
})
