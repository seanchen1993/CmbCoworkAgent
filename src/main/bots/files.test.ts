import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { resolveBotWorkspaceFile } from "./workspace-file"
import {
  botImportDestination,
  copyBotFile,
  copyBotFileBytes,
  exportBotFile,
  hashBotFile,
  snapshotBotDeliveryFile
} from "./file-copy"
import { openStableFileHandle } from "../services/stable-file-handle"

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
  it("rejects an oversized parser input before creating a copy, while ordinary imports retain their cap", async () => {
    const root = await fixture(), source = join(root, "input.txt"), target = join(root, "copy.txt")
    const limit = 5 * 1024 * 1024
    const handle = await open(source, "w")
    await handle.truncate(limit + 1)
    await handle.close()
    await expect(copyBotFile(root, source, target, undefined, limit)).rejects.toThrow("5 MiB")
    expect(await readdir(root)).toEqual(["input.txt"])
    await copyBotFile(root, source, target)
    expect((await stat(target)).size).toBe(limit + 1)
    await rm(target)
    const bounded = await open(source, "r+")
    await bounded.truncate(limit)
    await bounded.close()
    await copyBotFile(root, source, target, undefined, limit)
    expect((await stat(target)).size).toBe(limit)
    expect(() => copyBotFile(root, source, target, undefined, 101 * 1024 * 1024)).toThrow("限制无效")
  })
  it("retains a canonical snapshot path after an ordinary case-only source rename", async () => {
    const root = await fixture(), source = join(root, "report.md")
    const signal = new AbortController().signal
    await writeFile(source, "SENT VERSION")
    const first = await snapshotBotDeliveryFile(root, source, signal)
    const renamed = join(root, "Report.md")
    await rename(source, renamed)
    const second = await snapshotBotDeliveryFile(root, renamed, signal)
    expect(second.attachmentPath).toBe(await realpath(second.attachmentPath))
    expect(await readFile(first.attachmentPath, "utf8")).toBe("SENT VERSION")
    expect(await readFile(second.attachmentPath, "utf8")).toBe("SENT VERSION")
  })
  it("retains sent bytes and the original name across equal-size revisions without replacing an open snapshot", async () => {
    const root = await fixture(),
      source = join(root, "核验 报告.md")
    const signal = new AbortController().signal
    await writeFile(source, "V1_SENT")
    const first = await snapshotBotDeliveryFile(root, source, signal)
    const held = await openStableFileHandle(root, first.attachmentPath)
    try {
      const inode = (await stat(first.attachmentPath)).ino
      expect(await snapshotBotDeliveryFile(root, source, signal)).toEqual(first)
      expect((await stat(first.attachmentPath)).ino).toBe(inode)
      await held.assertPathIdentity()
      await writeFile(source, "V2_EDIT")
      const second = await snapshotBotDeliveryFile(root, source, signal)
      expect(second.attachmentPath).not.toBe(first.attachmentPath)
      expect(basename(first.attachmentPath)).toBe(basename(source))
      expect(first.size).toBe(second.size)
      expect(await readFile(first.attachmentPath, "utf8")).toBe("V1_SENT")
      expect(await readFile(second.attachmentPath, "utf8")).toBe("V2_EDIT")
      expect(await readFile(source, "utf8")).toBe("V2_EDIT")
      expect(await hashBotFile(root, source, signal)).not.toBe(
        await hashBotFile(root, first.attachmentPath, signal)
      )
      expect(await hashBotFile(root, source, signal)).toBe(
        await hashBotFile(root, second.attachmentPath, signal)
      )
      await rm(source)
      expect(await readFile(first.attachmentPath, "utf8")).toBe("V1_SENT")
      await held.assertPathIdentity()
    } finally {
      await held.handle.close()
    }
    expect(
      (await readdir(join(root, ".bot-deliveries"))).some((name) => name.endsWith(".part"))
    ).toBe(false)
  })
  it("saves delivered files above the import cap without relaxing internal copies", async () => {
    const root = await fixture(),
      source = join(root, "large.bin")
    const signal = new AbortController().signal
    const handle = await open(source, "w")
    await handle.close()
    const empty = await snapshotBotDeliveryFile(root, source, signal)
    expect(empty.size).toBe(0)
    expect((await stat(empty.attachmentPath)).size).toBe(0)
    await exportBotFile(root, empty.attachmentPath, join(root, "empty-saved.bin"), signal)
    expect((await stat(join(root, "empty-saved.bin"))).size).toBe(0)
    const large = await open(source, "r+")
    await large.truncate(100 * 1024 * 1024 + 1)
    await large.close()
    await expect(copyBotFile(root, source, join(root, "export.bin"), signal)).rejects.toThrow(
      "100 MiB"
    )
    const sent = await snapshotBotDeliveryFile(root, source, signal)
    expect(sent.size).toBe(100 * 1024 * 1024 + 1)
    expect((await stat(sent.attachmentPath)).size).toBe(sent.size)
    const saved = join(root, "saved.bin")
    await exportBotFile(root, sent.attachmentPath, saved, signal)
    expect((await stat(saved)).size).toBe(sent.size)
    expect(await hashBotFile(root, saved, signal)).toBe(
      await hashBotFile(root, sent.attachmentPath, signal)
    )
    expect((await stat(empty.attachmentPath)).size).toBe(0)
  })
  it("keeps export containment, cancellation and atomic publication protections", async () => {
    const root = await fixture(), workspace = join(root, "workspace")
    await mkdir(workspace)
    const source = join(workspace, "report.bin"), destination = join(root, "saved.bin")
    await writeFile(source, "NEW")
    await writeFile(destination, "KEEP")
    await expect(exportBotFile(workspace, destination, join(root, "escaped.bin"))).rejects.toThrow()
    const controller = new AbortController()
    controller.abort(new Error("cancelled"))
    await expect(exportBotFile(workspace, source, destination, controller.signal)).rejects.toThrow("cancelled")
    expect(await readFile(destination, "utf8")).toBe("KEEP")
    expect((await readdir(root)).some(name => name.endsWith(".part"))).toBe(false)
    await exportBotFile(workspace, source, destination)
    expect(await readFile(destination, "utf8")).toBe("NEW")
  })
  it("rejects changed snapshots, linked destinations, outside sources and cancellation without partial publication", async () => {
    const root = await fixture(),
      workspace = join(root, "workspace")
    await mkdir(workspace)
    const source = join(workspace, "report.md"),
      outside = join(root, "secret.md")
    const signal = new AbortController().signal
    await writeFile(source, "ORIGINAL")
    await writeFile(outside, "SECRET")
    const sent = await snapshotBotDeliveryFile(workspace, source, signal)
    await writeFile(sent.attachmentPath, "TAMPERED")
    await expect(snapshotBotDeliveryFile(workspace, source, signal)).rejects.toThrow("附件发生变化")
    await rm(sent.attachmentPath)
    await symlink(source, sent.attachmentPath)
    await expect(snapshotBotDeliveryFile(workspace, source, signal)).rejects.toThrow("附件发生变化")
    await expect(snapshotBotDeliveryFile(workspace, outside, signal)).rejects.toThrow()
    const aborted = new AbortController()
    aborted.abort(new Error("cancelled"))
    await expect(snapshotBotDeliveryFile(workspace, source, aborted.signal)).rejects.toThrow(
      "cancelled"
    )
    await expect(hashBotFile(workspace, source, aborted.signal)).rejects.toThrow("cancelled")
    expect(
      (await readdir(join(workspace, ".bot-deliveries"))).some((name) => name.endsWith(".part"))
    ).toBe(false)
    await rm(join(workspace, ".bot-deliveries"), { recursive: true })
    await symlink(
      root,
      join(workspace, ".bot-deliveries"),
      process.platform === "win32" ? "junction" : "dir"
    )
    await expect(snapshotBotDeliveryFile(workspace, source, signal)).rejects.toThrow("符号链接")
    expect(await readFile(outside, "utf8")).toBe("SECRET")
    expect(await realpath(source)).toBe(await resolveBotWorkspaceFile(workspace, "report.md"))
  })
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
  it("accepts ordinary differently-cased shared directories and reuses verified peer destinations", async () => {
    const root = await fixture()
    await mkdir(join(root, "Shared"))
    // macOS/Windows can resolve 'shared' to this ordinary 'Shared' directory;
    // case-sensitive filesystems may create a distinct ordinary directory.
    const upload = await botImportDestination(root, "input.txt")
    await writeFile(upload.path, "input")
    expect(await readFile(upload.path, "utf8")).toBe("input")
    const first = await botImportDestination(root, "result.txt", "verified-peer-receipt")
    await writeFile(first.path, "retained result")
    const replay = await botImportDestination(root, "result.txt", "verified-peer-receipt")
    expect(replay).toEqual(first)
    expect(await readFile(replay.path, "utf8")).toBe("retained result")
  })
  it("rejects a symlink substituted for a retained peer directory", async () => {
    const root = await fixture()
    const target = await botImportDestination(root, "result.txt", "verified-peer-receipt")
    await rm(dirname(target.path), { recursive: true })
    const outside = await fixture()
    await symlink(outside, dirname(target.path), process.platform === "win32" ? "junction" : "dir")
    await expect(botImportDestination(root, "result.txt", "verified-peer-receipt"))
      .rejects.toThrow("符号链接")
    expect(await readdir(outside)).toEqual([])
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
