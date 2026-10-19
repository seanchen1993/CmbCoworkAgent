import { afterEach, describe, expect, it, vi } from "vitest"
import { validateWorkspaceDirectory, WorkspaceValidationError } from "./workspace-validation"
import { probeWorkspaceDirectory } from "./workspace-probe-client"
import { WorkspaceProbeError } from "./workspace-probe-protocol"

vi.mock("./workspace-probe-client", () => ({ probeWorkspaceDirectory: vi.fn() }))

afterEach(() => {
  vi.resetAllMocks()
  vi.useRealTimers()
})

describe("workspace validation", () => {
  it.each(["", "   ", "relative/project", null, 42])("rejects invalid input %j", async (input) => {
    await expect(validateWorkspaceDirectory(input)).rejects.toMatchObject({
      code: "invalid_workspace_path"
    })
    expect(probeWorkspaceDirectory).not.toHaveBeenCalled()
  })

  it.each(["ENOENT", "EACCES", "ENOTDIR", "ELOOP"])(
    "turns %s into a recoverable workspace error, retaining the requested path",
    async (code) => {
      vi.mocked(probeWorkspaceDirectory).mockRejectedValue(
        Object.assign(new Error("raw lstat error"), { code })
      )
      const error = await validateWorkspaceDirectory("/Users/demo/project").catch((error) => error)
      expect(error).toBeInstanceOf(WorkspaceValidationError)
      expect(error.message).toContain("/Users/demo/project")
      expect(error.message).toContain("运行应用的机器")
      expect(error.message).not.toContain("lstat")
    }
  )

  it("rejects a regular file", async () => {
    vi.mocked(probeWorkspaceDirectory).mockRejectedValue(new WorkspaceProbeError("not-directory"))
    await expect(validateWorkspaceDirectory("/project.txt")).rejects.toThrow("不是目录")
  })

  it("returns the physical directory without changing case", async () => {
    vi.mocked(probeWorkspaceDirectory).mockResolvedValue("/home/demo/Project")
    await expect(validateWorkspaceDirectory("/home/demo/link")).resolves.toBe("/home/demo/Project")
    expect(probeWorkspaceDirectory).toHaveBeenCalledWith("/home/demo/link", undefined)
  })

  it("retains the original public timeout diagnostic without exposing worker internals", async () => {
    vi.mocked(probeWorkspaceDirectory).mockRejectedValue(new WorkspaceProbeError("timeout"))
    await expect(validateWorkspaceDirectory("/offline/project")).rejects.toThrow("访问超时")
  })
})
