import { afterEach, expect, it, vi } from "vitest"
import type { PluginMetadata } from "../types"
const mock = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock("./runner", () => ({ runHooks: mock.run, clearOnceStateForSession: vi.fn() }))
vi.mock("./scope", () => ({ resolveEnabledHooksForRun: vi.fn(() => []) }))
vi.mock("../services/setup-state", () => ({
  hasWorkspaceBeenInitialised: () => true,
  markWorkspaceInitialised: vi.fn()
}))
import { fireSessionStartOnce, fireSessionEnd, fireSessionEndAll } from "./session-lifecycle"
import {
  currentRuntimePluginSource,
  issueRuntimePluginSourceToken,
  withRuntimePluginSource
} from "../plugins/runtime-source-scope"

afterEach(async () => {
  await fireSessionEndAll(50)
  vi.clearAllMocks()
})
it("retains the original fixed source for deferred delete and shutdown SessionEnd", async () => {
  const observed: Array<[string, string | undefined]> = []
  mock.run.mockImplementation(async (_hooks, event) => {
    observed.push([event, currentRuntimePluginSource()?.packageDigest])
    return null
  })
  const token = issueRuntimePluginSourceToken({
    threadId: "thread",
    incarnationKey: "initial",
    projectId: "project",
    operationId: "operation",
    workspace: "workspace",
    packageDigest: "a".repeat(64),
    stageId: "stage",
    plugin: { id: "plugin", path: "fixed" } as PluginMetadata
  })
  await withRuntimePluginSource(token, () => fireSessionStartOnce("thread", "workspace"))
  expect(currentRuntimePluginSource()).toBeUndefined()
  await fireSessionEnd("thread")
  await withRuntimePluginSource(token, () => fireSessionStartOnce("second-thread", "workspace"))
  await fireSessionEndAll(50)
  expect(observed.filter(([event]) => event === "SessionEnd")).toEqual([
    ["SessionEnd", "a".repeat(64)],
    ["SessionEnd", "a".repeat(64)]
  ])
})

it("does not fall back to live source when the retained snapshot fails revalidation", async () => {
  mock.run.mockResolvedValue(null)
  let valid = true
  const token = issueRuntimePluginSourceToken(
    {
      threadId: "changed",
      incarnationKey: "initial",
      projectId: "project",
      operationId: "operation",
      workspace: "workspace",
      packageDigest: "a".repeat(64),
      stageId: "stage",
      plugin: { id: "plugin", path: "fixed" } as PluginMetadata
    },
    () => {
      if (!valid) throw Error("snapshot changed")
    }
  )
  await withRuntimePluginSource(token, () => fireSessionStartOnce("changed", "workspace"))
  valid = false
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
  try {
    await fireSessionEnd("changed")
    expect(mock.run.mock.calls.filter((call) => call[1] === "SessionEnd")).toHaveLength(0)
    expect(warning).toHaveBeenCalled()
  } finally {
    warning.mockRestore()
  }
})
