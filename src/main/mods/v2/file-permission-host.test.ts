import { beforeEach, expect, it, vi } from "vitest"
import { functionFileScope } from "./file-permission-host"
import type { ModsManager } from "../manager"

const { probe, mode } = vi.hoisted(() => ({ probe: vi.fn(), mode: vi.fn() }))
vi.mock("../../agent/local-sandbox", () => ({ LocalSandbox: { createPermissionProbe: probe } }))
vi.mock("../../storage", () => ({ getWindowsSandboxMode: mode }))
const plain = vi.fn(),
  query = vi.fn(),
  live = vi.fn()
const manager = { functionRuntimeScope: vi.fn<ModsManager["functionRuntimeScope"]>() }
const capture = () =>
  functionFileScope(manager as unknown as ModsManager, plain, "/project", "thread")
beforeEach(() => {
  vi.clearAllMocks()
  mode.mockReturnValue("none")
  query.mockResolvedValue({ decision: "allow" })
  probe.mockReturnValue(query)
  manager.functionRuntimeScope.mockReturnValue({
    workspace: "/worktree",
    bound: true,
    assertLive: live,
    queryTool: query
  })
})

it("uses the live backend and its execution root without constructing a project probe", async () => {
  const scope = capture()
  expect(scope.workspace).toBe("/worktree")
  expect(await scope.queryTool("host:read_file", { file_path: "/worktree/file" })).toEqual({
    decision: "allow"
  })
  expect(probe).not.toHaveBeenCalled()
  expect(plain).not.toHaveBeenCalled()
  scope.assertLive()
  expect(live).toHaveBeenCalled()
})

it("refuses an incomplete live backend instead of falling back to plain project authority", () => {
  manager.functionRuntimeScope.mockReturnValue({
    workspace: "/worktree",
    bound: true,
    assertLive: live,
    queryTool: undefined
  })
  expect(capture).toThrow("MODS_FS_CONTEXT_REQUIRED")
  expect(probe).not.toHaveBeenCalled()
})

it("permits only a validated plain thread to use a cold inert project probe", async () => {
  manager.functionRuntimeScope.mockReturnValue({
    workspace: "/project",
    bound: false,
    assertLive: live,
    queryTool: undefined
  })
  const scope = capture()
  expect(plain).toHaveBeenCalledWith("thread")
  await scope.queryTool("host:ls", { path: "/project" })
  expect(query).toHaveBeenCalledWith("ls", { path: "/project" })
  expect(live).toHaveBeenCalledTimes(2)
  plain.mockImplementationOnce(() => {
    throw Error("restricted thread")
  })
  expect(capture).toThrow("restricted thread")
})
