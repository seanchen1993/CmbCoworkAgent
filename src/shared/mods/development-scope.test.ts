import { describe, expect, it } from "vitest"
import { isDevelopmentThreadMetadata } from "./development-scope"

describe("development thread eligibility", () => {
  it("accepts ordinary local chats", () => {
    expect(isDevelopmentThreadMetadata({})).toBe(true)
    expect(isDevelopmentThreadMetadata({ agentMode: "normal" })).toBe(true)
  })
  it("rejects background, remote, plugin, child and project metadata", () => {
    for (const key of [
      "workflowRunId",
      "parentThreadId",
      "remoteThread",
      "remoteState",
      "remoteReadOnly",
      "targetKind",
      "imDeliveryContext",
      "isHeartbeat",
      "scheduledTaskId",
      "pluginId",
      "pluginRoot",
      "isHarnessProjectSession",
      "harnessProjectId",
      "featureId"
    ])
      expect(isDevelopmentThreadMetadata({ [key]: "present" }), key).toBe(false)
    expect(
      isDevelopmentThreadMetadata({ harnessProjectSession: { projectId: "p", kind: "chat" } })
    ).toBe(false)
    expect(isDevelopmentThreadMetadata({ agentMode: "project" })).toBe(false)
    expect(isDevelopmentThreadMetadata(null)).toBe(false)
  })
})
