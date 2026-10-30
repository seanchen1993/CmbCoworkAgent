import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { expect, it } from "vitest"
import { createModsGitInspection } from "./mods-git-inspection"

it("never executes a clean filter introduced after the configuration snapshot", async () => {
  const parent = mkdtempSync(join(tmpdir(), "mods-git-filter-race-"))
  const root = join(parent, "repo")
  mkdirSync(root)
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      windowsHide: true,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_AUTHOR_NAME: "Filter Race",
        GIT_AUTHOR_EMAIL: "race@example.test",
        GIT_COMMITTER_NAME: "Filter Race",
        GIT_COMMITTER_EMAIL: "race@example.test"
      }
    }).trim()
  try {
    git("init", "-q")
    git("config", "core.autocrlf", "false")
    writeFileSync(join(root, ".gitattributes"), "*.txt filter=late\n")
    writeFileSync(join(root, "tracked.txt"), "before\n")
    git("add", ".")
    git("commit", "-qm", "baseline")
    const baseCommit = git("rev-parse", "HEAD")
    writeFileSync(join(root, "tracked.txt"), "after\n")
    const marker = join(parent, "clean-filter-ran.txt")
    const script = join(parent, "filter.cjs")
    writeFileSync(
      script,
      "require('node:fs').writeFileSync(process.argv[2],'executed');process.stdin.pipe(process.stdout)\n"
    )
    let injected = false
    const service = createModsGitInspection({
      onMeasure(event) {
        if (!injected && event.phase === "git.config") {
          injected = true
          const quoted = [process.execPath, script, marker].map(
            (path) => '"' + path.replace(/\\/g, "/") + '"'
          )
          git("config", "filter.late.clean", quoted.join(" "))
        }
      }
    })
    const identity = await service.inspectDirectory(root)
    const page = await service.listChanges(identity, { baseCommit })
    const preview = await service.readFile(identity, { ...page, path: "tracked.txt" })
    expect(preview.patch).toContain("+after")
    expect(preview.limitations).toContain("working-tree-conversion-not-applied")
    expect(injected).toBe(true)
    expect(existsSync(marker)).toBe(false)
  } finally {
    cleanup(parent)
  }
}, 30000)

function cleanup(target: string) {
  if (dirname(target) !== tmpdir() || !basename(target).startsWith("mods-git-filter-race-"))
    throw Error("UNEXPECTED_TEST_CLEANUP_PATH")
  rmSync(target, { recursive: true, force: true })
}
