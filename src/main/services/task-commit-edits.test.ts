import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { recordTaskCommitEdit, verifyTaskCommitEdits } from "./task-commit-edits"
import { hasCleanTaskCommitBaseline } from "./task-commit-baseline"

const rows = vi.hoisted(() => new Map<string, unknown[]>())
vi.mock("../db", () => ({
  getDb: () => ({
    run: (_query: string, params: unknown[]) => rows.set(String(params[2]), params.slice(3, 5)),
    exec: (_query: string, params: string[]) => [{ values: [rows.get(params[2])] }]
  })
}))
let root: string | undefined
afterEach(() => {
  rows.clear()
  if (root) rmSync(root, { recursive: true, force: true })
})

it("verifies CRLF blobs in a batch and rejects an unrelated executable mode change", async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "task-commit-bytes-")))
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true
    }).trim()
  git("init", "-q")
  git("config", "user.name", "Test")
  git("config", "user.email", "fixture@example.test")
  git("config", "core.autocrlf", "true")
  git("config", "commit.gpgsign", "false")
  const files = ["first file.txt", "second.txt"]
  for (const file of files) writeFileSync(path.join(root, file), "before\r\n")
  git("add", ".")
  git("commit", "-qm", "initial")
  const parent = git("rev-parse", "HEAD")
  for (const file of files) {
    writeFileSync(path.join(root, file), "after\r\n")
    recordTaskCommitEdit("task", "version", path.join(root, file), "before\r\n", "after\r\n")
  }
  const verify = (candidate?: { parent: string; sha: string }) =>
    verifyTaskCommitEdits("task", "version", root!, files, new Map(), candidate)
  expect(await verify()).toBe(true)
  git("add", ".")
  const candidate = () => ({
    parent,
    sha: git("commit-tree", git("write-tree"), "-p", parent, "-m", "candidate")
  })
  expect(await verify(candidate())).toBe(true)
  git("update-index", "--chmod=+x", "--", files[0])
  expect(await verify(candidate())).toBe(false)
}, 60_000)

it("treats a preexisting dirty directory as covering its descendants only", () => {
  const scope = path.resolve("fixture")
  const baseline = { [scope]: ["old", "index.txt"] }
  expect(hasCleanTaskCommitBaseline(baseline, scope, ["old/nested/new.txt"])).toBe(false)
  expect(hasCleanTaskCommitBaseline(baseline, scope, ["older/new.txt"])).toBe(true)
  expect(hasCleanTaskCommitBaseline({ [scope]: ["."] }, scope, ["new.txt"])).toBe(false)
})
