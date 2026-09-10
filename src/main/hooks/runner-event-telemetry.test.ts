import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../services/event-reporter", () => ({
  trackEvent: vi.fn()
}))

import { trackEvent } from "../services/event-reporter"
import type { HookConfig } from "./types"
import { runHooks } from "./runner"

const successfulCommand = process.platform === "win32" ? "cmd /c exit 0" : "true"

function makeHook(): HookConfig {
  return {
    id: "telemetry-hook",
    event: "PreToolUse",
    matcher: "read_file",
    type: "command",
    command: successfulCommand,
    enabled: true,
    timeout: 5_000,
    createdAt: "",
    updatedAt: ""
  }
}

beforeEach(() => {
  vi.mocked(trackEvent).mockClear()
})

describe("hook execution telemetry", () => {
  it("includes project, feature and workflow-stage attribution", async () => {
    await runHooks([makeHook()], "PreToolUse", {
      toolName: "read_file",
      sessionId: "thread-1",
      turnId: "turn-1",
      agentId: "agent-1",
      pluginId: "plugin-1",
      pluginName: "Plugin One",
      harnessProjectId: "project-1",
      featureId: "feature-1",
      harnessAdapterName: "adapter-1",
      harnessAdapterVersion: "1.0.0",
      harnessNodeName: "Dev-代码实现",
      harnessNodeStatus: "进行中"
    })

    expect(trackEvent).toHaveBeenCalledTimes(1)
    expect(trackEvent).toHaveBeenCalledWith(
      "hook.executed",
      "hook",
      expect.objectContaining({
        event: "PreToolUse",
        threadId: "thread-1",
        turnId: "turn-1",
        agentId: "agent-1",
        pluginId: "plugin-1",
        pluginName: "Plugin One",
        harnessProjectId: "project-1",
        harnessFeatureSlug: "feature-1",
        harnessAdapterName: "adapter-1",
        harnessAdapterVersion: "1.0.0",
        harnessNodeName: "Dev-代码实现",
        harnessNodeStatus: "进行中",
        blocked: false
      })
    )
  })
})
