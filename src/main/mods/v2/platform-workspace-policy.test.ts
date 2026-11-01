import { resolve, join } from "node:path"
import { beforeEach, expect, it, vi } from "vitest"
import type { ModsManager } from "../manager"
import type { NativePlatformCallContext } from "./platform-capabilities-types"
import { createWorkspaceReadPolicy } from "./platform-workspace-policy"

const mocks = vi.hoisted(() => ({ probe: vi.fn(), mode: "default" }))
vi.mock("../../agent/local-sandbox", () => ({
  LocalSandbox: { createPermissionProbe: () => mocks.probe }
}))
vi.mock("../../storage", () => ({ getWindowsSandboxMode: () => mocks.mode }))
beforeEach(() => {
  mocks.mode = "default"
  mocks.probe.mockReset().mockResolvedValue({ decision: "allow" })
})
function fixture() {
  const root = resolve("test-private-workspace")
  const controller = new AbortController()
  const context = {
    workspace: root,
    threadId: "thread",
    signal: controller.signal,
    assertCurrent: vi.fn()
  } as unknown as NativePlatformCallContext
  const runtime = {
    workspace: root,
    bound: true,
    assertLive: vi.fn(),
    queryTool: vi.fn(async () => ({ decision: "allow" }))
  }
  const manager = { functionRuntimeScope: vi.fn(() => runtime) }
  const authorize = createWorkspaceReadPolicy(
    manager as unknown as Pick<ModsManager, "functionRuntimeScope">
  )
  return { root, controller, context, runtime, manager, authorize }
}
it("uses both native sandbox and original runtime read checks", async () => {
  const f = fixture()
  await f.authorize(f.context, join(f.root, "Main.java"))
  expect(mocks.probe).toHaveBeenCalledWith("read_file", { file_path: join(f.root, "Main.java") })
  expect(f.runtime.queryTool).toHaveBeenCalledWith("host:read_file", {
    file_path: join(f.root, "Main.java")
  })
})
it.each(["ask", "deny"])("does not turn sandbox %s into an allow", async (decision) => {
  const f = fixture()
  mocks.probe.mockResolvedValue({ decision })
  await expect(f.authorize(f.context, f.root)).rejects.toThrow("PATH_DENIED")
  expect(f.runtime.queryTool).not.toHaveBeenCalled()
})
it("does not turn an original runtime ask into an allow", async () => {
  const f = fixture()
  f.runtime.queryTool.mockResolvedValue({ decision: "ask" })
  await expect(f.authorize(f.context, f.root)).rejects.toThrow("PATH_DENIED")
})
it("rejects outside and relative paths before querying permissions", async () => {
  const f = fixture()
  await expect(f.authorize(f.context, resolve(f.root, "../sibling"))).rejects.toThrow("PATH_DENIED")
  await expect(f.authorize(f.context, "relative.ts")).rejects.toThrow("PATH_DENIED")
  expect(mocks.probe).not.toHaveBeenCalled()
})
it("rejects an execution workspace different from this native conversation scope", async () => {
  const f = fixture()
  f.runtime.workspace = resolve("different-worktree")
  await expect(f.authorize(f.context, f.root)).rejects.toThrow("SCOPE_CHANGED")
  expect(mocks.probe).not.toHaveBeenCalled()
})
it("rechecks original binding and policy after an awaited permission", async () => {
  const f = fixture()
  mocks.probe.mockImplementation(async () => {
    f.runtime.assertLive.mockImplementation(() => {
      throw Error("BINDING_CHANGED")
    })
    return { decision: "allow" }
  })
  await expect(f.authorize(f.context, f.root)).rejects.toThrow("BINDING_CHANGED")
  expect(f.runtime.queryTool).not.toHaveBeenCalled()
})
it("rejects cancellation instead of publishing a permission answer", async () => {
  const f = fixture()
  mocks.probe.mockImplementation(async () => {
    f.controller.abort()
    return { decision: "allow" }
  })
  await expect(f.authorize(f.context, f.root)).rejects.toThrow()
})
it.skipIf(process.platform !== "win32")(
  "rejects a Windows mode changed during original permission",
  async () => {
    const f = fixture()
    f.runtime.queryTool.mockImplementation(async () => {
      mocks.mode = "different"
      return { decision: "allow" }
    })
    await expect(f.authorize(f.context, f.root)).rejects.toThrow("POLICY_CHANGED")
  }
)

it("keeps a captured original runtime fence live across separate authorization calls", async () => {
  const f = fixture()
  const check = f.authorize.capture(f.context)
  await f.authorize(f.context, f.root)
  f.runtime.assertLive.mockImplementation(() => {
    throw Error("OLD_RUNTIME_CHANGED")
  })
  expect(check).toThrow("OLD_RUNTIME_CHANGED")
})
