import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { afterEach, expect, test, vi } from "vitest"

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>()
  const { promisify } = await import("node:util")
  const run = promisify(actual.execFile)
  const execFile = vi.fn()
  Object.defineProperty(execFile, promisify.custom, {
    value: async (executable: string, args: string[], options: object) => {
      const result = await run(executable, args, options)
      if (args.at(-1) === "--git-common-dir") {
        const cwd = args[args.indexOf("-C") + 1]
        const root = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
          encoding: "utf8"
        }).trim()
        if (resolve(cwd) !== resolve(root)) {
          // Reproduce the reported relative output from a nested workspace.
          return { ...result, stdout: `${join(relative(root, cwd), ".git")}\n` }
        }
      }
      return result
    }
  })
  return { ...actual, execFile }
})

import { identifyRepository } from "./git-worktree"

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

test.each([false, true])(
  "identifies a repository from a nested workspace (linked worktree: %s)",
  async (linked) => {
    const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), "cmb-wt-identity-")))
    temporaryRoots.push(temporaryRoot)
    const repo = join(temporaryRoot, "repository")
    mkdirSync(repo)
    const git = (args: string[]) => execFileSync("git", ["-C", repo, ...args])
    git(["init", "-q"])
    let checkout = repo
    if (linked) {
      git([
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-qm",
        "base"
      ])
      checkout = join(temporaryRoot, "linked")
      git(["worktree", "add", "--detach", checkout])
    }
    const workspace = join(checkout, "后台服务", "零售客户经营", "项目")
    mkdirSync(workspace, { recursive: true })

    await expect(identifyRepository(workspace)).resolves.toEqual({
      gitRoot: repo,
      sourceRoot: checkout,
      commonDir: join(repo, ".git")
    })
  }
)
