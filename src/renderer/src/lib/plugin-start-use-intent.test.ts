import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { PluginStartUseReport } from "../../../shared/plugin-start-use"

const mocks = vi.hoisted(() => ({
  current: true,
  accountRevision: 1,
  navigate: vi.fn(() => true),
  board: vi.fn(),
  legacy: vi.fn(),
  threads: [{ thread_id: "chat", metadata: { workspacePath: "C:/owned" } }]
}))
vi.mock("./store", () => ({
  useAppStore: {
    getState: () => ({
      accountRevision: mocks.accountRevision,
      threads: mocks.threads,
      setShowHarnessBoardView: mocks.board
    })
  }
}))
vi.mock("./configuration-target", () => ({
  goToConfigurationThread: mocks.navigate,
  configurationTargetValid: () => mocks.current
}))
vi.mock("./derived-project-intent", () => ({ openDerivedProject: mocks.legacy }))
import {
  dismissHostPluginStartUse,
  hostPluginStartUseCurrent,
  openPluginStartUse,
  readHostPluginStartUseIntent
} from "./plugin-start-use-intent"

const input = {
  threadId: "chat",
  expectedWorkspace: "C:/owned",
  pluginId: "installed",
  expected: { name: "warehouse", version: "1.0.0" }
}
const report: PluginStartUseReport = {
  identity: { pluginId: "installed", name: "warehouse", version: "1.0.0", digest: "a".repeat(64) },
  kind: "host-project",
  canOpen: true,
  issues: []
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.current = true
  mocks.accountRevision = 1
  mocks.navigate.mockReturnValue(true)
})
afterEach(() => {
  const pending = readHostPluginStartUseIntent()
  if (pending) dismissHostPluginStartUse(pending.id)
})

it("retains the exact reviewed Host identity for the native create form", () => {
  openPluginStartUse(input, report)
  const pending = readHostPluginStartUseIntent()!
  expect(pending.input.expected.digest).toBe(report.identity.digest)
  expect(pending.input.pluginId).toBe("installed")
  expect(mocks.board).toHaveBeenCalledExactlyOnceWith(true)
  expect(mocks.legacy).not.toHaveBeenCalled()
  report.issues.push({
    code: "permission",
    message: "Later native consent",
    resolution: "project-form"
  })
  expect(pending.report.issues).toEqual([])
  report.issues.length = 0
})

it("uses the existing original legacy project form and ordinary chat route separately", () => {
  openPluginStartUse(input, { ...report, kind: "plugin-project" })
  expect(mocks.legacy).toHaveBeenCalledExactlyOnceWith("installed", "warehouse", input)
  expect(mocks.board).not.toHaveBeenCalled()
  mocks.legacy.mockClear()
  openPluginStartUse(input, { ...report, kind: "chat" })
  expect(mocks.legacy).not.toHaveBeenCalled()
  expect(mocks.board).not.toHaveBeenCalled()
  expect(readHostPluginStartUseIntent()).toBeNull()
})

it("never navigates an unavailable, foreign or content-changed report", () => {
  for (const next of [
    { ...report, canOpen: false },
    { ...report, identity: { ...report.identity, pluginId: "foreign" } }
  ])
    expect(() => openPluginStartUse(input, next)).toThrow("IDENTITY_CHANGED")
  expect(() =>
    openPluginStartUse(
      { ...input, expected: { ...input.expected, digest: "b".repeat(64) } },
      report
    )
  ).toThrow("IDENTITY_CHANGED")
  expect(mocks.navigate).not.toHaveBeenCalled()
})

it("rejects changed navigation scope and retires an old account or changed thread target", () => {
  mocks.navigate.mockReturnValue(false)
  expect(() => openPluginStartUse(input, report)).toThrow("SCOPE_CHANGED")
  expect(mocks.board).not.toHaveBeenCalled()
  mocks.navigate.mockReturnValue(true)
  openPluginStartUse(input, report)
  const pending = readHostPluginStartUseIntent()!
  expect(hostPluginStartUseCurrent(pending)).toBe(true)
  mocks.accountRevision++
  expect(hostPluginStartUseCurrent(pending)).toBe(false)
  mocks.accountRevision--
  mocks.current = false
  expect(hostPluginStartUseCurrent(pending)).toBe(false)
})
