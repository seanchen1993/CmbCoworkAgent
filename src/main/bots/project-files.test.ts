import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, rename } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotProjectFiles } from "./project-files"
import { botProjectContext } from "./project-tools"
import * as iconv from "iconv-lite"

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "bot-project-"))
  directories.push(base)
  const root = join(base, "project")
  await mkdir(root)
  await writeFile(join(root, "app.ts"), "const value = 1\n")
  return { base, root, project: await BotProjectFiles.open(root) }
}

it("searches literal source text with Cmb decoding and scopes file, directory and glob targets", async () => {
  const { root, project } = await fixture()
  await mkdir(join(root, "src"))
  await writeFile(join(root, "src/a.ts"), "aXb\na.b exact\n")
  await writeFile(join(root, "src/b.ts"), "a.b sibling\n")
  await writeFile(join(root, "src/gbk.txt"), iconv.encode("第一行中文\n目标中文检索\n", "gbk"))
  await writeFile(
    join(root, "src/utf16.txt"),
    Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode("首行\n目标中文检索", "utf16le")])
  )
  expect(await project.search("a.b", "src/a.ts")).toMatchObject({
    matches: [{ path: "src/a.ts", line: 2, text: "a.b exact" }],
    incomplete: false
  })
  expect((await project.search("a.b", "src", "*.ts")).matches.map((match) => match.path)).toEqual([
    "src/a.ts",
    "src/b.ts"
  ])
  const chinese = await project.search("目标中文", "src", "*.txt")
  expect(chinese.matches).toEqual([
    { path: "src/gbk.txt", line: 2, text: "目标中文检索" },
    { path: "src/utf16.txt", line: 2, text: "目标中文检索" }
  ])
  expect(chinese.incomplete).toBe(false)
  expect((await project.search("a.b", "src\\a.ts", "*.ts")).matches).toHaveLength(1)
  expect((await project.search("a.b", "src/a.ts", "*.txt")).matches).toEqual([])
})

it("excludes private roots and links from search and rejects root replacement and cancelled scans", async () => {
  const { base, root } = await fixture()
  await mkdir(join(root, "private"))
  await writeFile(join(root, "private/keys.txt"), "PRIVATE_NEEDLE")
  await writeFile(join(base, "outside.txt"), "PRIVATE_NEEDLE")
  await symlink(join(base, "outside.txt"), join(root, "linked.txt"))
  const project = await BotProjectFiles.open(root, [join(root, "private")])
  expect((await project.search("PRIVATE_NEEDLE")).matches).toEqual([])
  for (const path of ["private/keys.txt", "../outside.txt", "linked.txt", ".git/config"])
    await expect(project.search("PRIVATE_NEEDLE", path)).rejects.toThrow()
  await expect(project.search("bad\nquery")).rejects.toThrow("单行")
  await expect(project.search("value", ".", "../*.ts")).rejects.toThrow()
  let checks = 0
  await expect(
    project.search("value", ".", "**/*", () => {
      if (++checks === 3) throw new Error("SCAN_CANCELLED")
    })
  ).rejects.toThrow("SCAN_CANCELLED")
  await rename(root, join(base, "old"))
  await mkdir(root)
  await expect(project.search("value")).rejects.toThrow("已被替换")
})

it("reports bounded partial results and skipped oversized or binary files instead of claiming a complete scan", async () => {
  const { root, project } = await fixture()
  await writeFile(join(root, "matches.ts"), "needle\n".repeat(201))
  const count = await project.search("needle", "matches.ts")
  expect(count).toMatchObject({ incomplete: true, stoppedReason: "matches", scannedFiles: 1 })
  expect(count.matches).toHaveLength(200)
  await writeFile(join(root, "long.ts"), `needle${"x".repeat(2000)}\n`.repeat(80))
  const long = await project.search("needle", "long.ts")
  expect(long.incomplete).toBe(true)
  expect(long.matches.length).toBeLessThan(24)
  expect(long.matches[0].text).toHaveLength(1014)
  expect(long.matches[0].text.endsWith("...(truncated)")).toBe(true)
  await writeFile(join(root, "oversized.txt"), Buffer.alloc(2 * 1024 * 1024 + 1, 65))
  await writeFile(join(root, "binary.data"), Buffer.from([0, 1, 2, 255]))
  for (const path of ["oversized.txt", "binary.data"])
    expect(await project.search("needle", path)).toMatchObject({
      matches: [],
      scannedFiles: 1,
      skippedFiles: 1,
      incomplete: true
    })
  await mkdir(join(root, "many"))
  await Promise.all(
    Array.from({ length: 1001 }, (_, index) =>
      writeFile(join(root, "many", `${String(index).padStart(4, "0")}.ts`), "")
    )
  )
  expect(await project.search("absent", "many")).toMatchObject({
    matches: [],
    scannedFiles: 1000,
    incomplete: true,
    stoppedReason: "files"
  })
})

it("globs a literal project subdirectory without exposing links, Host data or an escaped root", async () => {
  const { base, root } = await fixture()
  const directory = join(root, "source[1]")
  const protectedRoot = join(directory, "host")
  await mkdir(protectedRoot, { recursive: true })
  await writeFile(join(directory, "selected.ts"), "selected")
  await writeFile(join(protectedRoot, "private.ts"), "PRIVATE")
  await writeFile(join(base, "outside.ts"), "OUTSIDE")
  await symlink(join(base, "outside.ts"), join(directory, "linked.ts"))
  await symlink(base, join(root, "escape"))
  const project = await BotProjectFiles.open(root, [protectedRoot])
  expect(await project.glob("**/*.ts", "source[1]")).toEqual(["source[1]/selected.ts"])
  expect(await project.glob("**/*.ts")).toEqual(["app.ts", "source[1]/selected.ts"])
  await expect(project.assertGlob("**/*.ts", "source[1]")).resolves.toBeUndefined()
  for (const [pattern, directory] of [
    ["../*.ts", "."],
    ["*.ts", "../"],
    ["C:\\secret\\*.ts", "."],
    ["*.ts", "escape"],
    ["*.ts", "app.ts"],
    ["*.ts", "source[1]/host"]
  ]) {
    await expect(project.assertGlob(pattern, directory)).rejects.toThrow()
    await expect(project.glob(pattern, directory)).rejects.toThrow()
  }
  await rename(root, join(base, "original"))
  await mkdir(root)
  await expect(project.glob("**/*.ts")).rejects.toThrow("已被替换")
})

it("cancels file discovery while enumerating without exposing partially validated paths", async () => {
  const { root, project } = await fixture()
  await Promise.all(
    Array.from({ length: 12 }, (_, index) => writeFile(join(root, `${index}.ts`), ""))
  )
  const validation = vi.spyOn(project, "assertReadable")
  let checks = 0
  await expect(
    project.glob("**/*", ".", () => {
      if (++checks === 4) throw new Error("GLOB_CANCELLED")
    })
  ).rejects.toThrow("GLOB_CANCELLED")
  expect(validation).not.toHaveBeenCalled()
  expect(await project.glob("app.ts")).toEqual(["app.ts"])
})

it("includes directory discovery in the search time budget and opens no content after it expires", async () => {
  const { project } = await fixture()
  const now = vi.spyOn(performance, "now").mockReturnValue(0)
  const original = project.assertReadable.bind(project)
  let validations = 0
  const validation = vi.spyOn(project, "assertReadable").mockImplementation(async (relative) => {
    await original(relative)
    if (++validations === 2) now.mockReturnValue(10_001)
  })
  expect(await project.search("value")).toEqual({
    matches: [],
    scannedFiles: 0,
    skippedFiles: 0,
    incomplete: true,
    stoppedReason: "time"
  })
  expect(validation).toHaveBeenCalledTimes(2)
})

it("copies binary templates byte-for-byte, refuses existing targets and fences replaced project roots", async () => {
  const { base, root, project } = await fixture()
  const bytes = Buffer.from([0x50, 0x4b, 0, 0xff, 0x42])
  await project.assertNewArtifact("template.docx")
  await project.createArtifact("template.docx", bytes, () => {})
  expect((await readFile(join(root, "template.docx"))).equals(bytes)).toBe(true)
  await expect(
    project.createArtifact("template.docx", Buffer.from("overwrite"), () => {})
  ).rejects.toThrow("已存在")
  expect((await readFile(join(root, "template.docx"))).equals(bytes)).toBe(true)
  for (const path of ["../escape.bin", "NUL", "file:stream", "missing/file.bin"])
    await expect(project.createArtifact(path, bytes, () => {})).rejects.toThrow()
  await rename(root, join(base, "original"))
  await mkdir(root)
  await writeFile(join(root, "app.ts"), "UNAUTHORIZED_REPLACEMENT")
  await expect(project.read("app.ts")).rejects.toThrow("已被替换")
  await expect(project.createArtifact("escape.bin", bytes, () => {})).rejects.toThrow("已被替换")
  await expect(readFile(join(root, "escape.bin"))).rejects.toThrow()
})

it("uses Cmb edit matching and commits only the file version reviewed by the user", async () => {
  const { root, project } = await fixture()
  const before = await project.read("app.ts")
  const change = await project.prepare({
    path: "app.ts",
    expectedHash: before.sha256,
    oldText: "const value = 1",
    newText: "const value = 2"
  })
  expect(change.diff).toContain("-const value = 1")
  await project.commit(change, () => {})
  expect(await readFile(join(root, "app.ts"), "utf8")).toBe("const value = 2\n")
  await expect(project.commit(change, () => {})).rejects.toThrow("审批期间文件已变化")
})

it("rejects traversal, Windows aliases, links and nested repository writes", async () => {
  const { base, root, project } = await fixture()
  await writeFile(join(base, "secret"), "outside")
  await symlink(join(base, "secret"), join(root, "linked"))
  await link(join(base, "secret"), join(root, "hardlink"))
  for (const name of [
    "../secret",
    "/etc/passwd",
    "C:\\Windows\\file",
    "app.ts:stream",
    ".git/config",
    "NUL.txt",
    "foo./bar",
    "linked",
    "hardlink"
  ]) {
    await expect(project.read(name)).rejects.toThrow()
    await expect(project.readArtifact(name)).rejects.toThrow()
  }
  const original = await project.read("app.ts")
  const change = await project.prepare({
    path: "app.ts",
    expectedHash: original.sha256,
    content: "changed"
  })
  await link(join(root, "app.ts"), join(base, "late-link"))
  await expect(project.commit(change, () => {})).rejects.toThrow("硬链接")
  expect((await project.glob("**/*")).includes("hardlink")).toBe(false)
  expect((await project.search("outside")).matches).toEqual([])
  await mkdir(join(root, "nested", ".git"), { recursive: true })
  await writeFile(join(root, "nested", "file"), "nested")
  const nested = await project.read("nested/file")
  await expect(
    project.prepare({ path: "nested/file", expectedHash: nested.sha256, content: "new" })
  ).rejects.toThrow("嵌套 Git")
  expect(await readFile(join(base, "secret"), "utf8")).toBe("outside")
})

it("exports actual binary output through stable project handles with the artifact size limit", async () => {
  const { root, project } = await fixture()
  const content = Buffer.from([0, 255, 1, 2, 0, 128])
  await writeFile(join(root, "output.pdf"), content)
  const result = await project.readArtifact("output.pdf")
  expect(result.bytes).toEqual(content)
  expect(result.sha256).toMatch(/^[a-f0-9]{64}$/)
  await writeFile(join(root, "oversized.bin"), Buffer.alloc(25 * 1024 * 1024 + 1))
  await expect(project.readArtifact("oversized.bin")).rejects.toThrow()
})

it("keeps Host credentials inaccessible even when the chosen project contains the data directory", async () => {
  const { root } = await fixture()
  const protectedRoot = join(root, "host")
  await mkdir(protectedRoot)
  await writeFile(join(protectedRoot, "models.private"), "private-key")
  const project = await BotProjectFiles.open(root, [protectedRoot])
  await expect(project.read("host/models.private")).rejects.toThrow("禁止访问")
  await expect(
    project.prepare({ path: "host/control.json", expectedHash: null, content: "replacement" })
  ).rejects.toThrow("禁止访问")
  await expect(BotProjectFiles.open(protectedRoot, [protectedRoot])).rejects.toThrow("不能作为项目")
})

it("serializes competing Bots and refuses to overwrite a newly appeared file", async () => {
  const { root, project } = await fixture()
  const other = await BotProjectFiles.open(root)
  const before = await project.read("app.ts")
  const a = await project.prepare({ path: "app.ts", expectedHash: before.sha256, content: "A" })
  const b = await other.prepare({ path: "app.ts", expectedHash: before.sha256, content: "B" })
  const outcomes = await Promise.allSettled([
    project.commit(a, () => {}),
    other.commit(b, () => {})
  ])
  expect(outcomes.map((result) => result.status)).toEqual(["fulfilled", "rejected"])
  const created = await project.prepare({ path: "new.ts", expectedHash: null, content: "mine" })
  await writeFile(join(root, "new.ts"), "user")
  await expect(project.commit(created, () => {})).rejects.toThrow()
  expect(await readFile(join(root, "new.ts"), "utf8")).toBe("user")
})

it("checks cancellation at commit and rejects oversized, ambiguous and non-text input", async () => {
  const { root, project } = await fixture()
  const before = await project.read("app.ts")
  const change = await project.prepare({
    path: "app.ts",
    expectedHash: before.sha256,
    content: "new"
  })
  await expect(
    project.commit(change, () => {
      throw new Error("stopped")
    })
  ).rejects.toThrow("stopped")
  expect((await project.read("app.ts")).sha256).toBe(before.sha256)
  await writeFile(join(root, "binary"), Buffer.from([0, 1]))
  await expect(project.read("binary")).rejects.toThrow("二进制")
  await writeFile(join(root, "large"), Buffer.alloc(2 * 1024 * 1024 + 1, 65))
  await expect(project.read("large")).rejects.toThrow("too large")
  await writeFile(join(root, "repeat"), "x x")
  const repeat = await project.read("repeat")
  await expect(
    project.prepare({ path: "repeat", expectedHash: repeat.sha256, oldText: "x", newText: "y" })
  ).rejects.toThrow("multiple matches")
})

it("loads Cmb project instructions without crossing the Bot workspace boundary", async () => {
  const { base, root } = await fixture()
  await mkdir(join(base, ".git"))
  await writeFile(join(base, "AGENTS.md"), "PARENT_PRIVATE_INSTRUCTION")
  await writeFile(join(root, "AGENTS.md"), "PROJECT_INSTRUCTION")
  let prompt = await botProjectContext(root, [])
  expect(prompt).toContain("PROJECT_INSTRUCTION")
  expect(prompt).not.toContain("PARENT_PRIVATE_INSTRUCTION")
  await writeFile(join(root, "AGENTS.override.md"), "OVERRIDE_INSTRUCTION")
  prompt = await botProjectContext(root, [])
  expect(prompt).toContain("OVERRIDE_INSTRUCTION")
  expect(prompt).not.toContain("PROJECT_INSTRUCTION")
  await rm(join(root, "AGENTS.override.md"))
  await rm(join(root, "AGENTS.md"))
  await symlink(join(base, "AGENTS.md"), join(root, "AGENTS.md"))
  expect(await botProjectContext(root, [])).not.toContain("PARENT_PRIVATE_INSTRUCTION")
  await expect(botProjectContext(root, [base])).rejects.toThrow("后台数据目录")
})
