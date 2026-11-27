// Run with node --test tests/task-commit-git-package.spec.mjs on Windows.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import builderUtil from "builder-util"
import afterPack from "../scripts/after-pack.js"

test(
  "Windows afterPack installs the complete, runnable Git distribution",
  {
    skip: process.platform !== "win32"
  },
  async () => {
    const appOutDir = await mkdtemp(path.join(tmpdir(), "cmb-task-git-package-"))
    try {
      await afterPack({
        electronPlatformName: "win32",
        arch: builderUtil.Arch[process.arch],
        appOutDir
      })
      const runtime = path.join(appOutDir, "resources", "task-commit-git")
      assert.match(
        await readFile(path.join(runtime, "LICENSE.txt"), "utf8"),
        /General Public License/i
      )
      const git = path.join(runtime, "cmd", "git.exe")
      assert.match(
        execFileSync(git, ["--version"], { encoding: "utf8" }),
        /git version 2\.56\.1\.windows\.1/
      )
      execFileSync(git, ["init", "--quiet", appOutDir])
      const result = execFileSync(git, ["-C", appOutDir, "update-ref", "--stdin"], {
        input: "start\nprepare\nabort\n",
        encoding: "utf8"
      })
      assert.match(result, /prepare: ok/)
      assert.match(result, /abort: ok/)
      await assert.rejects(
        afterPack({ electronPlatformName: "win32", arch: -1, appOutDir }),
        /No MinGit package/
      )
    } finally {
      await rm(appOutDir, { recursive: true, force: true, maxRetries: 3 })
    }
  }
)
