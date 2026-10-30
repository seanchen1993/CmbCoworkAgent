import { realpath, stat } from "node:fs/promises"
import { afterEach, describe, expect, it, vi } from "vitest"
import { validateWorkspaceDirectory, WorkspaceValidationError } from "./workspace-validation"

vi.mock("node:fs/promises", () => ({ realpath: vi.fn(), stat: vi.fn() }))

afterEach(() => {
  vi.resetAllMocks()
  vi.useRealTimers()
})

describe("workspace validation", () => {
  it.each(["", "   ", "relative/project", null, 42])("rejects invalid input %j", async (input) => {
    await expect(validateWorkspaceDirectory(input)).rejects.toMatchObject({
      code: "invalid_workspace_path"
    })
    expect(realpath).not.toHaveBeenCalled()
  })

  it.each(["ENOENT", "EACCES", "ENOTDIR", "ELOOP"])(
    "turns %s into a recoverable workspace error, retaining the requested path",
    async (code) => {
      vi.mocked(realpath).mockRejectedValue(Object.assign(new Error("raw lstat error"), { code }))
      const error = await validateWorkspaceDirectory("/Users/demo/project").catch((error) => error)
      expect(error).toBeInstanceOf(WorkspaceValidationError)
      expect(error.message).toContain("/Users/demo/project")
      expect(error.message).toContain("运行应用的机器")
      expect(error.message).not.toContain("lstat")
      expect(stat).not.toHaveBeenCalled()
    }
  )

  it("rejects a regular file", async () => {
    vi.mocked(realpath).mockResolvedValue("/project.txt")
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => false } as Awaited<
      ReturnType<typeof stat>
    >)
    await expect(validateWorkspaceDirectory("/project.txt")).rejects.toThrow("不是目录")
  })

  it("returns the physical directory without changing case", async () => {
    vi.mocked(realpath).mockResolvedValue("/home/demo/Project")
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as Awaited<
      ReturnType<typeof stat>
    >)
    await expect(validateWorkspaceDirectory("/home/demo/link")).resolves.toBe("/home/demo/Project")
    expect(stat).toHaveBeenCalledWith("/home/demo/Project")
  })

  it("bounds stalled filesystem probes and handles late rejection", async () => {
    vi.useFakeTimers()
    let rejectProbe!: (error: Error) => void
    vi.mocked(realpath).mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectProbe = reject
        })
    )
    const result = validateWorkspaceDirectory("/offline/project")
    const rejected = expect(result).rejects.toThrow("访问超时")
    await vi.advanceTimersByTimeAsync(3_000)
    await rejected
    rejectProbe(new Error("late filesystem failure"))
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(0)
  })
})
