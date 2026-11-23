import { describe, expect, it } from "vitest"
import { hasBotWorkflowCapability } from "./bot-capability"

describe("Bot background workflow capability", () => {
  it.each([undefined, "normal", "workflow"])("recognizes a local Bot without mode switching (%s)", (agentMode) => {
    expect(hasBotWorkflowCapability({ botId: "b", botHostId: "local", agentMode })).toBe(true)
  })
  it.each([
    {},
    { botId: "b", botHostId: "remote" },
    { botId: "", botHostId: "local" },
    { botId: "b", botHostId: "local", agentMode: "coordinator" },
    { botId: "b", botHostId: "local", agentMode: "unexpected" }
  ])("does not grant a second orchestration path to an unbound or incompatible thread (%j)", (metadata) => {
    expect(hasBotWorkflowCapability(metadata)).toBe(false)
  })
})
