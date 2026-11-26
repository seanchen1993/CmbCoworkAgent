import type { ExecFileOptionsWithStringEncoding } from "child_process"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { promisify } from "util"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { AdoptionWorktrees } from "./adoption-worktree"

const io = vi.hoisted(() => ({
  root: "",
  realpath: vi.fn<(dir: string) => Promise<string>>(),
  git: vi.fn<
    (
      executable: string,
      args: string[],
      options: ExecFileOptionsWithStringEncoding
    ) => Promise<{ stdout: string }>
  >()
}))
vi.mock("../storage", () => ({ getOpenworkDir: () => io.root }))
vi.mock("fs/promises", async (original) => ({
  ...(await original<typeof import("fs/promises")>()),
  realpath: io.realpath
}))
vi.mock("child_process", async (original) => ({
  ...(await original<typeof import("child_process")>()),
  execFile: Object.assign(vi.fn(), { [(await import("util")).promisify.custom]: io.git })
}))

beforeEach(async () => {
  const fs = await vi.importActual<typeof import("fs/promises")>("fs/promises")
  io.realpath.mockReset().mockImplementation((dir) => fs.realpath(dir))
  io.git.mockReset()
  io.root = await realpath(await mkdtemp(join(tmpdir(), "adoption-stall-")))
  vi.stubEnv("GIT_CEILING_DIRECTORIES", "")
  vi.stubEnv("GIT_DIR", "")
  vi.stubEnv("GIT_WORK_TREE", "")
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await rm(io.root, { recursive: true, force: true })
})

it("bounds OS calls even after 1,000 lookups on an unresponsive drive time out", async () => {
  const tracker = new AdoptionWorktrees()
  let releaseDrive!: (dir: string) => void
  const stalled = new Promise<string>((resolve) => {
    releaseDrive = resolve
  })
  io.realpath.mockClear().mockReturnValue(stalled)
  vi.useFakeTimers()
  const burst = Promise.all(
    Array.from({ length: 1000 }, (_, i) => tracker.check(join(io.root, String(i), "a.ts")))
  )
  await vi.advanceTimersByTimeAsync(301)
  expect(new Set(await burst)).toEqual(new Set(["unknown"]))
  expect(io.realpath).toHaveBeenCalledTimes(2)
  // Even the OS call's own timeout must not free an occupied worker.
  await vi.advanceTimersByTimeAsync(1600)
  const retry = tracker.check(join(io.root, "retry.ts"), "retry")
  await vi.advanceTimersByTimeAsync(301)
  expect(await retry).toBe("unknown")
  expect(io.realpath).toHaveBeenCalledTimes(2)
  releaseDrive(io.root)
  vi.useRealTimers()
  await new Promise<void>((resume) => setImmediate(resume))
  expect(await tracker.check(join(io.root, "recovered.ts"))).toBe("outside")
  expect(io.git).not.toHaveBeenCalled()
})

it("keeps a registered repo available during Git timeouts and cools down across fresh repos", async () => {
  const child = await vi.importActual<typeof import("child_process")>("child_process")
  const run = promisify(child.execFile)
  const timedOut: unknown[] = []
  io.git.mockImplementation(async (_binary, _args, options) => {
    try {
      // Use a real child that never finishes. Keep the production timeout and kill signal.
      return await run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options)
    } catch (e) {
      timedOut.push(e)
      throw e
    }
  })
  const root = join(io.root, "healthy")
  await mkdir(join(root, ".git"), { recursive: true })
  await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n")
  const registry = join(io.root, "git-hooks", "repos.json")
  await mkdir(dirname(registry))
  await writeFile(registry, JSON.stringify([{ gitRoot: root }]))
  const files = await Promise.all(
    Array.from({ length: 80 }, async (_, i) => {
      const dir = join(io.root, String(i))
      await mkdir(join(dir, ".git"), { recursive: true })
      return join(dir, "file.ts")
    })
  )
  const tracker = new AdoptionWorktrees()
  const burst = await Promise.all(files.slice(0, 40).map((file) => tracker.check(file)))
  expect(new Set(burst)).toEqual(new Set(["unknown"]))
  expect(io.git).toHaveBeenCalledTimes(4)
  expect(timedOut).toHaveLength(0)
  expect(await tracker.check(join(root, "ok.ts"))).toBe("inside")
  expect(timedOut).toHaveLength(0)

  await vi.waitFor(() => expect(timedOut).toHaveLength(4), { timeout: 7500, interval: 50 })
  for (const failure of timedOut) expect(failure).toMatchObject({ killed: true })
  expect(new Set(await Promise.all(files.slice(40).map((file) => tracker.check(file))))).toEqual(
    new Set(["unknown"])
  )
  expect(io.git).toHaveBeenCalledTimes(4)
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000)
  io.git.mockResolvedValue({ stdout: "true\n" })
  expect(await tracker.check(files[40], "retry")).toBe("inside")
  expect(io.git).toHaveBeenCalledTimes(5)
}, 12000)
