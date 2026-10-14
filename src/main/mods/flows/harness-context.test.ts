import { beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({
  metadata: {} as Record<string, unknown>,
  context: vi.fn(),
  adapter: vi.fn(),
  plugins: [{ id: "p", enabled: true, path: "/plugin", version: "1" }]
}))
vi.mock("../../db", () => ({ getThreadCore: () => ({ metadata: JSON.stringify(mocks.metadata) }) }))
vi.mock("../../storage", () => ({ getPlugins: () => mocks.plugins }))
vi.mock("../../agent/standard-thread-turn", () => ({ getHarnessAgentContext: mocks.context }))
vi.mock("../../harness-board/service", () => ({ getHarnessProjectAdapterSnapshot: mocks.adapter }))
import { prepareFlowHarnessContext, constrainFlowHarnessContext } from "./harness-context"
import { isOrdinaryFlowMetadata } from "../../../shared/mods/flows/scope"
beforeEach(() => {
  mocks.metadata = {
    workspacePath: "/repo",
    agentMode: "normal",
    harnessFeature: { projectId: "project", slug: "f" }
  }
  mocks.plugins[0].enabled = true
  mocks.context.mockReset().mockResolvedValue({
    pluginId: "p",
    harnessProjectId: "project",
    featureId: "f",
    pluginPromptInject: "original",
    enableAgentsPrompt: true
  })
  mocks.adapter
    .mockReset()
    .mockResolvedValue({ id: "p", name: "Plugin", version: "1", type: "plugin" })
})
it("pins trusted context while allowing a title change", async () => {
  const bound = await prepareFlowHarnessContext("thread", "/repo")
  mocks.metadata.title = "new title"
  expect(() => bound.assertCurrent()).not.toThrow()
  expect(bound.childMetadata).toMatchObject({ harnessFeature: { projectId: "project", slug: "f" } })
  expect(constrainFlowHarnessContext(bound.context, true)).toMatchObject({
    managedExecution: true,
    enableAgentsPrompt: false
  })
  mocks.metadata.harnessFeature = { projectId: "project", slug: "other" }
  expect(() => bound.assertCurrent()).toThrow("BINDING_CHANGED")
})
it("revokes disabled plugins and changed context without polling expensive worker reads", async () => {
  const bound = await prepareFlowHarnessContext("thread", "/repo")
  bound.assertCurrent()
  expect(mocks.context).toHaveBeenCalledTimes(1)
  mocks.context.mockResolvedValue({ ...bound.context, pluginPromptInject: "changed" })
  await expect(bound.refresh()).rejects.toThrow("CONTEXT_CHANGED")
  mocks.plugins[0].enabled = false
  expect(() => bound.assertCurrent()).toThrow("BINDING_CHANGED")
})
it("rejects unresolved feature and malformed scopes", async () => {
  mocks.context.mockResolvedValue({})
  await expect(prepareFlowHarnessContext("thread", "/repo")).rejects.toThrow("CONTEXT_UNAVAILABLE")
  for (const metadata of [
    { harnessFeature: {} },
    { harnessProjectSession: {} },
    { featureId: "fake" },
    { harnessFeature: { projectId: "p", slug: "f", runId: "managed" } },
    { agentMode: "workflow" },
    { agentMode: "coordinator" },
    { remoteThread: true },
    { parentThreadId: "p" }
  ])
    expect(isOrdinaryFlowMetadata(metadata)).toBe(false)
  expect(isOrdinaryFlowMetadata({ harnessProjectSession: { projectId: "p", kind: "chat" } })).toBe(
    true
  )
})

it("verifies project sessions without inventing a feature context", async () => {
  mocks.metadata = {
    workspacePath: "/repo",
    harnessProjectSession: { projectId: "project", kind: "chat" }
  }
  mocks.context.mockResolvedValue({ isHarnessProjectSession: true })
  const bound = await prepareFlowHarnessContext("thread", "/repo")
  expect(bound.context).toEqual({ isHarnessProjectSession: true })
  mocks.adapter.mockResolvedValue(null)
  await expect(bound.refresh()).rejects.toThrow("PROJECT_CHANGED")
  await expect(prepareFlowHarnessContext("thread", "/repo")).rejects.toThrow("PROJECT_UNAVAILABLE")
})

it("allows progress status changes but rejects switching the captured stage", async () => {
  mocks.context.mockResolvedValue({
    pluginId: "p",
    harnessProjectId: "project",
    featureId: "f",
    harnessNodeName: "Dev",
    harnessNodeStatus: "pending"
  })
  const bound = await prepareFlowHarnessContext("thread", "/repo")
  mocks.context.mockResolvedValue({ ...bound.context, harnessNodeStatus: "running" })
  await expect(bound.refresh()).resolves.toBeUndefined()
  mocks.context.mockResolvedValue({ ...bound.context, harnessNodeName: "Release" })
  await expect(bound.refresh()).rejects.toThrow("CONTEXT_CHANGED")
})
