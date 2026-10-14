import { expect, it, vi } from "vitest"
import { probeAutobizEnvironment } from "./autobiz-environment"
import { AUTOBIZ_KANBAN_COMMIT } from "./autobiz-source"

it("checks pinned Git objects and Python without executing project scripts", async () => {
  const probe = vi.fn(async (command: string) => (command === "git" ? "commit\n" : "Python 3.12.1"))
  expect(await probeAutobizEnvironment("D:/source", "python3", "win32", probe)).toEqual({
    ready: true,
    source: "D:/source",
    issues: [],
    stageSupported: true
  })
  expect(probe.mock.calls).toHaveLength(2)
  expect(probe).toHaveBeenCalledWith("git", [
    "--no-replace-objects",
    "-C",
    "D:/source",
    "cat-file",
    "-t",
    AUTOBIZ_KANBAN_COMMIT
  ])
  expect(probe).toHaveBeenCalledWith("python3", ["--version"])
})

it("reports all missing dependencies instead of accepting a partial environment", async () => {
  const result = await probeAutobizEnvironment("missing", "python", "linux", async () => {
    throw Error("not installed")
  })
  expect(result.ready).toBe(false)
  expect(result.stageSupported).toBe(false)
  expect(result.issues).toHaveLength(2)
})

it("rejects a wrong Git object type and unsupported Python version", async () => {
  const result = await probeAutobizEnvironment("source", "python", "win32", async (command) =>
    command === "git" ? "blob" : "Python 2.7.18"
  )
  expect(result.ready).toBe(false)
  expect(result.issues).toHaveLength(2)
})
