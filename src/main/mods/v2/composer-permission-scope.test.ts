import { beforeEach, expect, it, vi } from "vitest"
import { createComposerPermissionScope } from "./composer-permission-scope"

const { probe, mode, query } = vi.hoisted(() => ({
  probe: vi.fn(),
  mode: vi.fn(),
  query: vi.fn()
}))
vi.mock("../../agent/local-sandbox", () => ({ LocalSandbox: { createPermissionProbe: probe } }))
vi.mock("../../storage", () => ({ getWindowsSandboxMode: mode,
  captureWindowsSandboxModeData: () => ({ mode: "none", assertDataCurrent() {} }) }))
beforeEach(() => {
  vi.clearAllMocks()
  mode.mockReturnValue("none")
  probe.mockReturnValue(query)
  query.mockResolvedValue({ decision: "allow" })
})

it("only queries read permissions and refuses writable or executable operations", async () => {
  const scope = await createComposerPermissionScope(
    "/project",
    "thread",
    () => {},
    new AbortController().signal
  )
  expect(await scope.queryTool("host:read_file", { file_path: "/project/file" })).toEqual({
    decision: "allow"
  })
  expect(query).toHaveBeenCalledWith("read_file", { file_path: "/project/file" })
  for (const method of ["execute", "write_file", "edit_file", "task", "function:read_file"]) {
    expect(await scope.queryTool(method, {})).toEqual({
      decision: "deny",
      reason: "MODS_RUNTIME_TOOL_DENIED"
    })
  }
  expect(query).toHaveBeenCalledTimes(1)
})

it("rechecks the physical owner after asynchronous permission queries", async () => {
  let live = true
  const scope = await createComposerPermissionScope(
    "/project",
    "thread",
    () => {
      if (!live) throw Error("expired")
    },
    new AbortController().signal
  )
  query.mockImplementation(async () => {
    live = false
    return { decision: "allow" }
  })
  await expect(scope.queryTool("ls", { path: "/project" })).rejects.toThrow("expired")
})

it.skipIf(process.platform !== "win32")("rejects a changed Windows sandbox setting", async () => {
  const scope = await createComposerPermissionScope(
    "/project",
    "thread",
    () => {},
    new AbortController().signal
  )
  mode.mockReturnValue("elevated")
  await expect(scope.queryTool("ls", {})).rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
  expect(query).not.toHaveBeenCalled()
})
