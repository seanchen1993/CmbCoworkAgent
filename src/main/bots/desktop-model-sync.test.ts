import { expect, it, vi } from "vitest"
vi.mock("./desktop-mods-config", () => ({ desktopBotModsConfig: () => undefined }))
vi.mock("./desktop-skills-config", () => ({
  desktopBotSkillSources: async () => ({ pluginsStorePath: "/settings/plugins.json" })
}))
vi.mock("node:fs", () => ({ existsSync: () => true }))
vi.mock("./model-config-fence", () => ({
  botModelSnapshotGeneration: () => null,
  completeBotModelSnapshotGeneration: () => {}
}))
vi.mock("../mcp/desktop-sources", () => ({ readDesktopMcpSources: () => [] }))
vi.mock("./desktop-execution-config", () => ({
  desktopBotExecutionConfig: () => ({ windowsSandbox: "none", resourceDirectory: "/resources" })
}))
const f = vi.hoisted(() => ({ config: { ref: "first" }, write: vi.fn() }))
vi.mock("../models/registry", () => ({
  getAvailableModelConfigOrDefault: () => f.config,
  getModelConfigs: () => [f.config]
}))
vi.mock("./model-config", () => ({
  writeBotModelSnapshot: f.write,
  readBotModelSnapshot: async () => {
    throw new Error("Fixture snapshot missing")
  }
}))
import { syncDesktopBotModels } from "./desktop-model-sync"
import { runtimeTimezone } from "../agent/runtime-time-context"
import { getCmbCoworkAgentsHome } from "../agent/agents-md"
import {
  configureAgentGraphRecursionLimit,
  configureAgentToolStrategy,
  configureWorkflowWorktreeTimeoutMinutes,
  configureWorkflowWorktreeRemoveTimeoutMinutes,
  AGENT_GRAPH_RECURSION_LIMIT_DEFAULT
} from "../../shared/agent-runtime-limits"

it("serializes concurrent refreshes, publishes the newest config and retries failed writes", async () => {
  let release!: () => void
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  f.write.mockImplementationOnce(() => hold).mockResolvedValue(undefined)
  const first = syncDesktopBotModels("root-a")
  await vi.waitFor(() => expect(f.write).toHaveBeenCalledTimes(1))
  f.config = { ref: "second" }
  const others = Array.from({ length: 5 }, () => syncDesktopBotModels("root-a"))
  release()
  await Promise.all([first, ...others])
  expect(f.write).toHaveBeenCalledTimes(2)
  expect(f.write.mock.calls[1][1].defaultRef).toBe("second")
  expect(f.write.mock.calls[1][1].hookSources).toEqual({ root: "/settings" })
  expect(f.write.mock.calls[1][1].timezone).toBe(runtimeTimezone())
  expect(f.write.mock.calls[1][1].instructionSources).toEqual({
    agentsHome: getCmbCoworkAgentsHome()
  })
  await syncDesktopBotModels("root-b")
  expect(f.write).toHaveBeenCalledTimes(3)
  f.config = { ref: "third" }
  f.write.mockRejectedValueOnce(new Error("disk failure"))
  await expect(syncDesktopBotModels("root-a")).rejects.toThrow("disk failure")
  await syncDesktopBotModels("root-a")
  expect(f.write).toHaveBeenCalledTimes(5)
  expect(f.write.mock.calls[4][1].defaultRef).toBe("third")
})

it("publishes a changed desktop timezone independently of model credentials", async () => {
  f.write.mockClear()
  const originalDateTimeFormat = Intl.DateTimeFormat
  const format = vi.spyOn(Intl, "DateTimeFormat")
  let timezone = "Asia/Shanghai"
  format.mockImplementation(
    (locales, options) => new originalDateTimeFormat(locales, options ?? { timeZone: timezone })
  )
  try {
    await syncDesktopBotModels("runtime-timezone")
    const original = f.write.mock.calls[0][1]
    expect(original.timezone).toBe("Asia/Shanghai")
    timezone = "America/New_York"
    await syncDesktopBotModels("runtime-timezone")
    expect(f.write).toHaveBeenCalledTimes(2)
    expect(f.write.mock.calls[1][1]).toEqual({ ...original, timezone: "America/New_York" })
  } finally {
    format.mockRestore()
  }
})

it("publishes execution limit changes even when the model configuration is unchanged", async () => {
  f.write.mockClear()
  try {
    configureAgentGraphRecursionLimit(25)
    await syncDesktopBotModels("runtime-limits")
    expect(f.write.mock.calls[0][1].graphRecursionLimit).toBe(25)
    configureAgentGraphRecursionLimit(500)
    await syncDesktopBotModels("runtime-limits")
    expect(f.write).toHaveBeenCalledTimes(2)
    expect(f.write.mock.calls[1][1].graphRecursionLimit).toBe(500)
  } finally {
    configureAgentGraphRecursionLimit(AGENT_GRAPH_RECURSION_LIMIT_DEFAULT)
  }
})

it("publishes tool preference changes without changing model credentials", async () => {
  f.write.mockClear()
  try {
    configureAgentToolStrategy("standard")
    await syncDesktopBotModels("tool-strategy")
    const original = f.write.mock.calls[0][1]
    configureAgentToolStrategy("shell-first-relaxed")
    await syncDesktopBotModels("tool-strategy")
    expect(f.write).toHaveBeenCalledTimes(2)
    expect(f.write.mock.calls[1][1]).toEqual({ ...original, toolStrategy: "shell-first-relaxed" })
  } finally {
    configureAgentToolStrategy("standard")
  }
})

it("publishes worktree budgets independently of model changes", async () => {
  f.write.mockClear()
  try {
    await syncDesktopBotModels("worktree-settings")
    configureWorkflowWorktreeTimeoutMinutes(17)
    configureWorkflowWorktreeRemoveTimeoutMinutes(4)
    await syncDesktopBotModels("worktree-settings")
    expect(f.write).toHaveBeenCalledTimes(2)
    expect(f.write.mock.calls[1][1]).toMatchObject({
      workflowWorktreeTimeoutMinutes: 17,
      workflowWorktreeRemoveTimeoutMinutes: 4
    })
  } finally {
    configureWorkflowWorktreeTimeoutMinutes(3)
    configureWorkflowWorktreeRemoveTimeoutMinutes(1)
  }
})

it("publishes failure feedback settings without changing model credentials", async () => {
  f.write.mockClear()
  try {
    vi.stubEnv("CMB_AGENT_FAIL_FAST", "0")
    vi.stubEnv("CMB_AGENT_FAILURE_FUSE_WARN", "1")
    vi.stubEnv("CMB_AGENT_FAILURE_FUSE_MODEL_FEEDBACK", "0")
    await syncDesktopBotModels("failure-policy")
    const original = f.write.mock.calls[0][1]
    expect(original.failureFuse).toEqual({
      mode: "warn",
      userNoticeEnabled: true,
      modelFeedbackEnabled: false
    })
    vi.stubEnv("CMB_AGENT_FAIL_FAST", "1")
    vi.stubEnv("CMB_AGENT_FAILURE_FUSE_WARN", "0")
    vi.stubEnv("CMB_AGENT_FAILURE_FUSE_MODEL_FEEDBACK", "1")
    await syncDesktopBotModels("failure-policy")
    expect(f.write).toHaveBeenCalledTimes(2)
    expect(f.write.mock.calls[1][1]).toEqual({
      ...original,
      failureFuse: { mode: "debug", userNoticeEnabled: false, modelFeedbackEnabled: true }
    })
  } finally {
    vi.unstubAllEnvs()
  }
})
