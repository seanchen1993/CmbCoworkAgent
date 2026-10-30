import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { expect, it, vi } from "vitest"

const observed = vi.hoisted(() => ({
  active: 0,
  peak: 0,
  started: 0,
  onFour: () => {},
  files: 0,
  peakFiles: 0
}))
vi.mock("./stable-file-handle", async (importOriginal) => {
  const original = await importOriginal<typeof import("./stable-file-handle")>()
  return {
    ...original,
    openStableFileHandle: async (...args: Parameters<typeof original.openStableFileHandle>) => {
      const opened = await original.openStableFileHandle(...args)
      observed.files++
      observed.peakFiles = Math.max(observed.peakFiles, observed.files)
      const close = opened.handle.close.bind(opened.handle)
      opened.handle.close = async () => {
        try {
          await close()
        } finally {
          observed.files--
        }
      }
      return opened
    }
  }
})
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>()
  return {
    ...original,
    spawn: ((...args: Parameters<typeof original.spawn>) => {
      const child = original.spawn(...args)
      observed.started++
      observed.active++
      observed.peak = Math.max(observed.peak, observed.active)
      if (observed.active === 4) observed.onFour()
      child.once("close", () => {
        observed.active--
      })
      return child
    }) as typeof original.spawn
  }
})
import { createModsGitInspection } from "./mods-git-inspection"

it("bounds real Git processes across services and releases queued cancellations and deadlines", async () => {
  const root = mkdtempSync(join(tmpdir(), "mods-git-concurrency-"))
  try {
    execFileSync("git", ["init", "-q"], { cwd: root, windowsHide: true })
    observed.active = observed.peak = observed.started = 0
    let four!: () => void
    const ready = new Promise<void>((resolve) => {
      four = resolve
    })
    observed.onFour = four
    const controllers = Array.from({ length: 16 }, () => new AbortController())
    const pending = controllers.map((controller) =>
      createModsGitInspection()
        .inspectDirectory(root, { signal: controller.signal })
        .catch((error) => error)
    )
    await ready
    // Admission is counted in the original deadline, rather than granting a new timeout.
    const timed = createModsGitInspection({ timeoutMs: 1 }).inspectDirectory(root)
    await expect(timed).rejects.toMatchObject({ code: "QUERY_TIMEOUT" })
    controllers.forEach((controller) => controller.abort())
    const results = await Promise.all(pending)
    expect(results.every((result) => result.code === "QUERY_CANCELLED")).toBe(true)
    expect(observed.peak).toBeLessThanOrEqual(4)
    expect(observed.started).toBe(4)
    expect(observed.active).toBe(0)
    const next = await createModsGitInspection().inspectDirectory(root)
    expect(next.root.replaceAll("\\", "/").toLowerCase()).toBe(
      root.replaceAll("\\", "/").toLowerCase()
    )
    expect(observed.active).toBe(0)
  } finally {
    cleanup(root)
  }
}, 15000)

it("bounds physical file handles across scans while authorizing every tracked path", async () => {
  const root = mkdtempSync(join(tmpdir(), "mods-git-concurrency-"))
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      windowsHide: true,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid"
      }
    }).trim()
  try {
    git("init", "-q")
    git("config", "core.autocrlf", "false")
    for (let index = 0; index < 50; index++)
      writeFileSync(join(root, `file-${index}.txt`), "unchanged\n")
    git("add", ".")
    git("commit", "-qm", "base")
    const baseCommit = git("rev-parse", "HEAD")
    observed.files = observed.peakFiles = 0
    const seen = [new Set<string>(), new Set<string>()]
    const services = seen.map((paths) =>
      createModsGitInspection({
        authorizePath: async (path) => {
          paths.add(path)
        }
      })
    )
    const identity = await services[0].inspectDirectory(root)
    const pages = await Promise.all(
      services.map((service) => service.listChanges(identity, { baseCommit }))
    )
    expect(pages.every((page) => page.total === 0)).toBe(true)
    expect(seen.map((paths) => paths.size)).toEqual([50, 50])
    expect(observed.peakFiles).toBeGreaterThan(1)
    expect(observed.peakFiles).toBeLessThanOrEqual(4)
    expect(observed.files).toBe(0)
    await expect(
      createModsGitInspection({
        authorizePath: async (path) => {
          if (path === "file-10.txt") throw Error("REVOKED_PATH")
        }
      }).listChanges(identity, { baseCommit })
    ).rejects.toThrow("REVOKED_PATH")
    expect(observed.files).toBe(0)
  } finally {
    cleanup(root)
  }
}, 15000)

function cleanup(target: string) {
  if (dirname(target) !== tmpdir() || !basename(target).startsWith("mods-git-concurrency-"))
    throw Error("UNEXPECTED_TEST_CLEANUP_PATH")
  rmSync(target, { recursive: true, force: true })
}
