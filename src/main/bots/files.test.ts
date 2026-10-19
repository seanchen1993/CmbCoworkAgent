import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { resolveBotWorkspaceFile } from "./workspace-file"
import { botImportDestination, copyBotFile, copyBotFileBytes } from "./file-copy"

const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bots-files-"))
  roots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe("Bot files", () => {
  it("accepts an absolute native workspace alias while keeping relative IDs and realpath boundaries strict", async () => {
    const root = await fixture(),
      workspace = join(root, "workspace"),
      alias = join(root, "old-workspace")
    await mkdir(workspace)
    await symlink(workspace, alias, process.platform === "win32" ? "junction" : "dir")
    await writeFile(join(workspace, "report.txt"), "original")
    expect(
      await resolveBotWorkspaceFile(workspace, join(alias, "report.txt"), { allowAbsolute: true })
    ).toBe(await resolveBotWorkspaceFile(workspace, "report.txt"))
    await expect(resolveBotWorkspaceFile(workspace, join(alias, "report.txt"))).rejects.toThrow()
    await writeFile(join(root, "private.txt"), "unrelated")
    await symlink(join(root, "private.txt"), join(workspace, "escape.txt"))
    await expect(
      resolveBotWorkspaceFile(workspace, join(alias, "escape.txt"), { allowAbsolute: true })
    ).rejects.toThrow()
  })
  it("accepts native Runtime paths only within the current workspace, without widening UI file IDs", async () => {
    const root = await fixture(),
      workspace = join(root, "workspace")
    await mkdir(join(workspace, "reports"), { recursive: true })
    const file = join(workspace, "reports", "资料.json"),
      outside = join(root, "secret.json")
    await writeFile(file, "{}")
    await writeFile(outside, "secret")
    await symlink(outside, join(workspace, "escape.json"))
    expect(await resolveBotWorkspaceFile(workspace, file, { allowAbsolute: true })).toBe(
      await resolveBotWorkspaceFile(workspace, "reports/资料.json")
    )
    await expect(resolveBotWorkspaceFile(workspace, file)).rejects.toThrow()
    for (const path of [
      outside,
      join(workspace, "escape.json"),
      "../secret.json",
      "C:\\secret.json",
      "reports"
    ])
      await expect(
        resolveBotWorkspaceFile(workspace, path, { allowAbsolute: true })
      ).rejects.toThrow()
  })
  it("rejects absolute paths, parent traversal, symlink escape and directories", async () => {
    const root = await fixture(),
      workspace = join(root, "workspace"),
      outside = join(root, "secret.txt")
    await mkdir(workspace)
    await writeFile(outside, "outside")
    await symlink(outside, join(workspace, "alias.txt"))
    for (const path of [outside, "../secret.txt", "alias.txt", "C:\\secret.txt", "."])
      await expect(resolveBotWorkspaceFile(workspace, path)).rejects.toThrow()
  })
  it("preserves upload basenames while isolating repeated imports and Windows reserved names", async () => {
    const root = await fixture()
    const first = await botImportDestination(root, "核验 报告.md")
    const second = await botImportDestination(root, "核验 报告.md")
    expect(basename(first.path)).toBe("核验 报告.md")
    expect(first.id).not.toBe(second.id)
    expect(basename((await botImportDestination(root, "CON.txt")).path)).toBe("_CON.txt")
  })
  it("copies an explicit shared file without retaining aliases to another Bot's workspace", async () => {
    const root = await fixture(),
      a = join(root, "a"),
      b = join(root, "b")
    await mkdir(a)
    await mkdir(b)
    const source = join(a, "方案.md")
    await writeFile(source, "first revision")
    const target = await botImportDestination(b, "方案.md")
    await copyBotFile(a, await resolveBotWorkspaceFile(a, "方案.md"), target.path)
    await writeFile(source, "second revision")
    expect(await readFile(target.path, "utf8")).toBe("first revision")
    expect(target.id).toMatch(/^shared\/[a-f0-9-]{36}\/方案\.md$/)
    expect((await readdir(dirname(target.path))).some((name) => name.endsWith(".part"))).toBe(false)
  })
  it("persists bounded dropped bytes atomically", async () => {
    const root = await fixture()
    const target = join(root, "dropped.json")
    const payload = new TextEncoder().encode('{"case":"drop"}').buffer
    await copyBotFileBytes(target, payload)
    expect(await readFile(target, "utf8")).toBe('{"case":"drop"}')
    await expect(
      copyBotFileBytes(join(root, "bad.json"), new ArrayBuffer(5 * 1024 * 1024 + 1))
    ).rejects.toThrow("5 MiB")
    expect((await readdir(root)).some((name) => name.endsWith(".part"))).toBe(false)
  })
  it("rejects a substituted import directory and leaves existing destinations unchanged on read failure", async () => {
    const root = await fixture(),
      a = join(root, "a"),
      b = join(root, "b")
    await mkdir(a)
    await mkdir(b)
    await symlink(b, join(a, "shared"), "dir")
    await expect(botImportDestination(a, "file.txt")).rejects.toThrow("符号链接")
    const target = join(b, "saved.txt")
    await writeFile(target, "keep")
    await expect(copyBotFile(a, join(a, "missing.txt"), target)).rejects.toThrow()
    expect(await readFile(target, "utf8")).toBe("keep")
  })
})
