import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  rename,
  symlink,
  mkdir,
  realpath
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"
import {
  beginShellFileCapture,
  noteFileToolWrite,
  type ShellFileCapture
} from "./shell-file-effects"

const roots: string[] = []
const git = (root: string, ...args: string[]): void => {
  execFileSync("git", ["-C", root, ...args], { stdio: "pipe" })
}
async function repo(): Promise<string> {
  const raw = await mkdtemp(path.join(tmpdir(), "shell-effects-"))
  roots.push(raw)
  const root = await realpath(raw)
  git(root, "init", "-q")
  git(root, "config", "user.name", "Test")
  git(root, "config", "user.email", "test@example.invalid")
  await writeFile(path.join(root, "a.ts"), "const a = 1\n")
  await writeFile(path.join(root, "b.ts"), "const a = 1\n")
  git(root, "add", ".")
  git(root, "commit", "-qm", "seed")
  return root
}
async function capture(
  root: string,
  command = "sed -i 's/1/2/' a.ts",
  limits = {}
): Promise<ShellFileCapture> {
  const c = await beginShellFileCapture({
    workspaceRoot: root,
    command,
    cwd: root,
    isCodeFile: (p) => p.endsWith(".ts"),
    limits
  })
  expect(c).not.toBeNull()
  return c!
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

describe("shell file effects against real Git repositories", () => {
  it("captures the clean HEAD preimage and changed content", async () => {
    const root = await repo(),
      c = await capture(root)
    await writeFile(path.join(root, "a.ts"), "const a = 2\n")
    const changes = (await c.finish()).changes
    expect(changes).toHaveLength(1)
    expect(changes[0].decision).toBe("counted")
    expect(changes[0].before?.toString()).toBe("const a = 1\n")
    expect(changes[0].after?.toString()).toBe("const a = 2\n")
    expect(await c.finish()).toEqual({ changes })
  })

  it("uses a dirty preimage, not HEAD, and ignores preexisting unchanged dirt", async () => {
    const root = await repo()
    await writeFile(path.join(root, "a.ts"), "human change\n")
    await writeFile(path.join(root, "b.ts"), "existing dirt\n")
    const c = await capture(root)
    await writeFile(path.join(root, "a.ts"), "agent change\n")
    const changes = (await c.finish()).changes
    expect(changes).toHaveLength(1)
    expect(changes[0].before?.toString()).toBe("human change\n")
  })

  it("handles identical HEAD blob hashes in the same cat-file batch", async () => {
    const root = await repo(),
      c = await capture(root, "unknown-editor")
    await writeFile(path.join(root, "a.ts"), "A\n")
    await writeFile(path.join(root, "b.ts"), "B\n")
    const changes = (await c.finish()).changes
    expect(changes.filter((x) => x.decision === "counted")).toHaveLength(2)
    expect(changes.every((x) => x.before?.toString() === "const a = 1\n")).toBe(true)
  })

  it("handles new and empty files, deletions and dirty-to-clean reverts", async () => {
    const root = await repo()
    await writeFile(path.join(root, "b.ts"), "dirty\n")
    const c = await capture(root, "unknown-editor")
    await writeFile(path.join(root, "new.ts"), "new\n")
    await writeFile(path.join(root, "empty.ts"), "")
    await rm(path.join(root, "a.ts"))
    git(root, "restore", "b.ts")
    const changes = (await c.finish()).changes
    expect(changes.find((x) => x.absPath.endsWith("new.ts"))?.before?.toString()).toBe("")
    expect(changes.find((x) => x.absPath.endsWith("a.ts"))?.after?.toString()).toBe("")
    expect(changes.find((x) => x.absPath.endsWith("b.ts"))?.after?.toString()).toBe("const a = 1\n")
    expect(changes.some((x) => x.absPath.endsWith("empty.ts"))).toBe(true)
  })

  it.each(["prettier --write .", "cp b.ts a.ts", "git restore a.ts"])(
    "attributes non-model writes without code-gen: %s",
    async (command) => {
      const root = await repo(),
        c = await capture(root, command)
      await writeFile(path.join(root, "a.ts"), "changed\n")
      expect((await c.finish()).changes.map((x) => x.decision)).toEqual(["attributed"])
    }
  )

  it("does not double-count a successful file-tool write", async () => {
    const root = await repo(),
      c = await capture(root)
    await writeFile(path.join(root, "a.ts"), "file tool\n")
    await noteFileToolWrite(path.join(root, "a.ts"), "file tool\n")
    expect((await c.finish()).changes).toEqual([])
  })

  it("does not evaluate lazy file-tool content outside an observation window", async () => {
    const root = await repo()
    let encoded = false
    await noteFileToolWrite(path.join(root, "a.ts"), () => {
      encoded = true
      return "never encoded"
    })
    expect(encoded).toBe(false)
  })

  it("counts only Shell changes made after an overlapping file-tool write", async () => {
    const root = await repo(),
      c = await capture(root)
    await writeFile(path.join(root, "a.ts"), "file tool\n")
    await noteFileToolWrite(path.join(root, "a.ts"), "file tool\n")
    await writeFile(path.join(root, "a.ts"), "shell afterward\n")
    expect((await c.finish()).changes[0].before?.toString()).toBe("file tool\n")
  })

  it("does not count ambiguous unnamed overlapping windows, even the last to finish", async () => {
    const root = await repo(),
      a = await capture(root, "editor-one"),
      b = await capture(root, "editor-two")
    await writeFile(path.join(root, "a.ts"), "ambiguous\n")
    expect((await a.finish()).changes[0].decision).toBe("unattributed")
    expect((await b.finish()).changes[0].decision).toBe("unattributed")
  })

  it("prefers the window naming the file", async () => {
    const root = await repo(),
      unknown = await capture(root, "editor-one"),
      explicit = await capture(root)
    await writeFile(path.join(root, "a.ts"), "named\n")
    expect((await unknown.finish()).changes[0].decision).toBe("unattributed")
    expect((await explicit.finish()).changes[0].decision).toBe("counted")
  })

  it("uses the completed named window as the next overlapping window's preimage", async () => {
    const root = await repo(),
      a = await capture(root),
      b = await capture(root)
    await writeFile(path.join(root, "a.ts"), "first\n")
    await a.finish()
    await writeFile(path.join(root, "a.ts"), "second\n")
    expect((await b.finish()).changes[0].before?.toString()).toBe("first\n")
  })

  it("long commands only attribute named paths", async () => {
    const root = await repo(),
      c = await capture(root, "sed -i 's/1/2/' a.ts", { shortMs: 0 })
    await writeFile(path.join(root, "a.ts"), "named\n")
    await writeFile(path.join(root, "b.ts"), "other\n")
    const changes = (await c.finish()).changes
    expect(changes.find((x) => x.absPath.endsWith("a.ts"))?.decision).toBe("counted")
    expect(changes.find((x) => x.absPath.endsWith("b.ts"))?.decision).toBe("unattributed")
  })

  it("formatter scopes override model edits in the same command", async () => {
    const root = await repo(),
      c = await capture(root, "sed -i 's/1/2/' a.ts && prettier --write .")
    await writeFile(path.join(root, "a.ts"), "formatted\n")
    expect((await c.finish()).changes[0].decision).toBe("attributed")
  })

  it("uses raw bytes, supports dirty cache invalidation and skips oversized content", async () => {
    const root = await repo()
    await writeFile(path.join(root, "a.ts"), Buffer.from([0xc4, 0xe3, 10]))
    const c = await capture(root)
    await writeFile(path.join(root, "a.ts"), Buffer.from([0xba, 0xc3, 10]))
    expect(Buffer.isBuffer((await c.finish()).changes[0].before)).toBe(true)
    const large = await capture(root, "editor", { fileBytes: 4 })
    await writeFile(path.join(root, "a.ts"), "too large\n")
    expect((await large.finish()).changes[0].decision).toBe("attributed")
  })

  it("does not follow symlinks, count directory entries or untracked nested repos", async () => {
    const root = await repo(),
      c = await capture(root, "editor")
    await symlink(path.join(root, "a.ts"), path.join(root, "linked.ts"))
    await mkdir(path.join(root, "nested"))
    git(path.join(root, "nested"), "init", "-q")
    await writeFile(path.join(root, "nested", "secret.ts"), "nested\n")
    await mkdir(path.join(root, "folder.ts"))
    expect((await c.finish()).changes).toEqual([])
  })

  it("handles rename as deletion plus creation", async () => {
    const root = await repo(),
      c = await capture(root, "mv a.ts renamed.ts")
    await rename(path.join(root, "a.ts"), path.join(root, "renamed.ts"))
    expect((await c.finish()).changes).toHaveLength(2)
  })

  it("skips entry-budget overflow without changing the command outcome", async () => {
    const root = await repo()
    await writeFile(path.join(root, "a.ts"), "dirty\n")
    await writeFile(path.join(root, "b.ts"), "dirty\n")
    expect(
      await beginShellFileCapture({
        workspaceRoot: root,
        cwd: root,
        command: "editor",
        isCodeFile: () => true,
        limits: { entries: 1 }
      })
    ).toBeNull()
    expect(await readFile(path.join(root, "a.ts"), "utf8")).toBe("dirty\n")
  })

  it("does not capture read-only commands or background execution", async () => {
    const root = await repo()
    for (const command of ["cat a.ts", "npm test", "echo x > a.ts &"])
      expect(
        await beginShellFileCapture({
          workspaceRoot: root,
          cwd: root,
          command,
          isCodeFile: () => true
        })
      ).toBeNull()
  })

  it("supports a workspace containing multiple repositories", async () => {
    const raw = await mkdtemp(path.join(tmpdir(), "shell-workspace-"))
    roots.push(raw)
    const workspace = await realpath(raw),
      first = await repo(),
      second = await repo()
    await rename(first, path.join(workspace, "first"))
    await rename(second, path.join(workspace, "second"))
    const c = await beginShellFileCapture({
      workspaceRoot: workspace,
      cwd: workspace,
      command: "editor",
      isCodeFile: (p) => p.endsWith(".ts")
    })
    expect(c).not.toBeNull()
    await writeFile(path.join(workspace, "first", "a.ts"), "first edit\n")
    await writeFile(path.join(workspace, "second", "a.ts"), "second edit\n")
    expect((await c!.finish()).changes.filter((x) => x.decision === "counted")).toHaveLength(2)
  })

  it("captures initialized tracked submodules without counting their directory entries", async () => {
    const root = await repo(),
      source = await repo()
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "child")
    git(root, "commit", "-qm", "submodule")
    const c = await capture(root, "editor")
    await writeFile(path.join(root, "child", "a.ts"), "submodule edit\n")
    const changes = (await c.finish()).changes
    expect(changes).toHaveLength(1)
    expect(changes[0].absPath).toBe(path.join(root, "child", "a.ts"))
    expect(changes[0].before?.toString()).toBe("const a = 1\n")
  })

  it("does not observe files outside a selected workspace subdirectory", async () => {
    const root = await repo(),
      workspace = path.join(root, "selected")
    await mkdir(workspace)
    await writeFile(path.join(workspace, "in.ts"), "inside\n")
    git(root, "add", ".")
    git(root, "commit", "-qm", "workspace")
    const c = await beginShellFileCapture({
      workspaceRoot: workspace,
      cwd: root,
      command: "editor",
      isCodeFile: (p) => p.endsWith(".ts")
    })
    await writeFile(path.join(root, "a.ts"), "outside\n")
    await writeFile(path.join(workspace, "in.ts"), "new inside\n")
    expect((await c!.finish()).changes.map((x) => x.absPath)).toEqual([
      path.join(workspace, "in.ts")
    ])
  })

  it("falls back to attribution-only when the dirty-preimage byte budget is exhausted", async () => {
    const root = await repo()
    await writeFile(path.join(root, "a.ts"), "dirty and larger than budget\n")
    const c = await capture(root, "editor", { snapshotBytes: 4 })
    await writeFile(path.join(root, "a.ts"), "new value\n")
    expect((await c.finish()).changes[0].decision).toBe("attributed")
  })
})
