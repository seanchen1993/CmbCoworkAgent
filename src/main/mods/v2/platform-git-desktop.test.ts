import { afterEach, expect, it, vi } from "vitest"
import type { ModsManager } from "../manager"
import type { NativePlatformCallContext } from "./platform-capabilities-types"
import type { GitInspectionDependencies } from "./platform-git-provider"

const mocks = vi.hoisted(() => ({
  probe: vi.fn(),
  mode: vi.fn(() => "none"),
  provider: vi.fn((dependencies: unknown) => dependencies)
}))
vi.mock("electron", () => ({ dialog: { showMessageBox: vi.fn() } }))
vi.mock("../../agent/local-sandbox", () => ({
  LocalSandbox: { createPermissionProbe: () => mocks.probe }
}))
vi.mock("../../storage", () => ({ getWindowsSandboxMode: mocks.mode }))
vi.mock("./platform-git-provider", () => ({
  createGitInspectionPlatformProvider: mocks.provider
}))
import { createDesktopGitInspectionProvider } from "./platform-git-desktop"

afterEach(() => vi.clearAllMocks())

for (const channel of ["sandbox", "original-runtime"] as const) {
  it.each(["unchanged", "runtime", "context", "cancel", "mode"] as const)(
    `checks global authority before treating a delayed ${channel} denial as partial: %s`,
    async (change) => {
      if (change === "mode" && process.platform !== "win32") return
      const entered = Promise.withResolvers<void>()
      const answer = Promise.withResolvers<{ decision: string }>()
      const controller = new AbortController()
      let runtimeRevoked = false
      let contextRevoked = false
      mocks.mode.mockReturnValue("none")
      const delayed = async () => {
        entered.resolve()
        return answer.promise
      }
      mocks.probe.mockImplementation(
        channel === "sandbox" ? delayed : async () => ({ decision: "allow" })
      )
      const runtime = {
        bound: true,
        assertLive() {
          if (runtimeRevoked) throw Error("RUNTIME_REVOKED")
        },
        queryTool: vi.fn(
          channel === "original-runtime" ? delayed : async () => ({ decision: "allow" })
        )
      }
      const manager = { functionRuntimeScope: () => runtime } as unknown as ModsManager
      const dependencies = createDesktopGitInspectionProvider(
        manager,
        () => null
      ) as unknown as GitInspectionDependencies
      const context = {
        workspace: "/workspace",
        threadId: "thread",
        signal: controller.signal,
        assertCurrent() {
          controller.signal.throwIfAborted()
          if (contextRevoked) throw Error("CONTEXT_REVOKED")
        }
      } as NativePlatformCallContext
      const pending = dependencies.authorizePath(context, "/repository", "/repository/private.txt")
      await entered.promise
      if (change === "runtime") runtimeRevoked = true
      if (change === "context") contextRevoked = true
      if (change === "cancel") controller.abort(Error("QUERY_CANCELLED"))
      if (change === "mode") mocks.mode.mockReturnValue("changed")
      answer.resolve({ decision: "deny" })
      const expected = {
        unchanged: "MODS_GIT_PATH_DENIED",
        runtime: "RUNTIME_REVOKED",
        context: "CONTEXT_REVOKED",
        cancel: "QUERY_CANCELLED",
        mode: "MODS_GIT_POLICY_CHANGED"
      }[change]
      await expect(pending).rejects.toThrow(expected)
      if (channel === "sandbox") expect(runtime.queryTool).not.toHaveBeenCalled()
    }
  )
}
