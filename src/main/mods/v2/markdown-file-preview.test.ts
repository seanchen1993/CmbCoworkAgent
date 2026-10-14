import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FunctionMarkdownFilePreviews, functionMarkdownFilePath } from "./markdown-file-preview"
import { FUNCTION_READ_LIMIT, ProjectFunctionFiles } from "./file-access"
import type { ModJson } from "../../../shared/mods/types"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mods-markdown-preview-")))
  roots.push(root)
  const workspace = join(root, "project")
  await mkdir(workspace)
  const path = join(workspace, "report.txt")
  const href = pathToFileURL(path).href
  const previews = new FunctionMarkdownFilePreviews()
  let alive = true
  const assertCurrent = () => {
    if (!alive) throw Error("drawing retired")
  }
  const queryTool = vi.fn(async () => ({ decision: "allow" as const }))
  const scope = { workspace, assertLive: assertCurrent, queryTool }
  const signal = new AbortController().signal
  const publish = vi.fn(async (value: ModJson) => value)
  return {
    root,
    workspace,
    path,
    href,
    previews,
    scope,
    signal,
    publish,
    assertCurrent,
    revoke: () => {
      alive = false
    }
  }
}

describe("protected Markdown file previews", () => {
  it("checks real file permission, reads a bounded stable handle and returns only protected text", async () => {
    const f = await fixture()
    await writeFile(f.path, "SECRET 中文\r\n")
    const publish = vi.fn(async (value: ModJson) =>
      typeof value === "string" ? value.replaceAll("SECRET", "HIDDEN") : value
    )
    const preview = await f.previews.read(f.href, f.scope, f.assertCurrent, publish, f.signal)
    expect(preview).toEqual({
      receipt: expect.any(String),
      title: "模组文件预览",
      text: "HIDDEN 中文\r\n"
    })
    expect(Object.keys(preview)).toEqual(["receipt", "title", "text"])
    expect(f.scope.queryTool).toHaveBeenCalledWith("host:read_file", { file_path: f.path })
    expect(publish).toHaveBeenCalledExactlyOnceWith("SECRET 中文\r\n", f.signal)
    expect(f.previews.current(preview.receipt)).toBe(true)
    f.revoke()
    expect(f.previews.current(preview.receipt)).toBe(false)
  })

  it("rejects raw remote, localhost, encoded separators and malformed file addresses", () => {
    for (const href of [
      "file://localhost/C:/report.txt",
      "file://server/report.txt",
      "file:////server/report.txt",
      "file://user@localhost/report",
      "file:///C:/a%2fb",
      "file:///C:/a%5cb",
      "file:///C:/a%00b",
      "file:///C:/a?query",
      "https://example.test"
    ])
      expect(() => functionMarkdownFilePath(href)).toThrow("MODS_UI_MARKDOWN_FILE_INVALID")
  })

  it("rejects missing permission, traversal and real outside junctions before publishing", async () => {
    const f = await fixture()
    await writeFile(f.path, "data")
    await expect(
      f.previews.read(
        f.href,
        { ...f.scope, queryTool: async () => ({ decision: "deny" }) },
        f.assertCurrent,
        f.publish,
        f.signal
      )
    ).rejects.toThrow("MODS_FS_ACCESS_DENIED")
    const outside = join(f.root, "outside")
    await mkdir(outside)
    await writeFile(join(outside, "outside.txt"), "private")
    await symlink(
      outside,
      join(f.workspace, "link"),
      process.platform === "win32" ? "junction" : "dir"
    )
    for (const path of [join(outside, "outside.txt"), join(f.workspace, "link", "outside.txt")])
      await expect(
        f.previews.read(pathToFileURL(path).href, f.scope, f.assertCurrent, f.publish, f.signal)
      ).rejects.toThrow("MODS_FS_OUTSIDE_PROJECT")
    expect(f.publish).not.toHaveBeenCalled()
  })

  it("rejects binary controls, invalid UTF-8 and oversized data while retaining old fs.read semantics", async () => {
    const f = await fixture()
    for (const bytes of [
      Buffer.from([0xc3, 0x28]),
      Buffer.from("a\u0000b"),
      Buffer.alloc(FUNCTION_READ_LIMIT + 1, 65)
    ]) {
      await writeFile(f.path, bytes)
      await expect(
        f.previews.read(f.href, f.scope, f.assertCurrent, f.publish, f.signal)
      ).rejects.toThrow(
        bytes.length > FUNCTION_READ_LIMIT ? "MODS_FS_READ_LIMIT" : "MODS_FS_NOT_TEXT"
      )
    }
    expect(f.publish).not.toHaveBeenCalled()
    await writeFile(f.path, Buffer.from([0xc3, 0x28]))
    const files = new ProjectFunctionFiles(f.workspace, f.assertCurrent, async (value) => value)
    await expect(files.run("fs.read", f.path, f.signal)).resolves.toBe("\ufffd(")
  })

  it("drops canceled or invalidated publication and rejects protection that turns text into a path", async () => {
    const f = await fixture()
    await writeFile(f.path, "data")
    await expect(
      f.previews.read(f.href, f.scope, f.assertCurrent, async () => ({ path: f.path }), f.signal)
    ).rejects.toThrow("MODS_UI_MARKDOWN_PREVIEW_INVALID")
    await expect(
      f.previews.read(
        f.href,
        f.scope,
        f.assertCurrent,
        async (value) => {
          f.revoke()
          return value
        },
        f.signal
      )
    ).rejects.toThrow("drawing retired")
    const g = await fixture()
    await writeFile(g.path, "data")
    const controller = new AbortController()
    controller.abort(Error("canceled"))
    await expect(
      g.previews.read(g.href, g.scope, g.assertCurrent, g.publish, controller.signal)
    ).rejects.toThrow("canceled")
    expect(g.publish).not.toHaveBeenCalled()
  })

  it("retains all eight pending reads through close until the actual permission calls settle", async () => {
    const f = await fixture()
    await writeFile(f.path, "data")
    const completions: (() => void)[] = []
    const scope = {
      ...f.scope,
      queryTool: async () => {
        await new Promise<void>((resolve) => {
          completions.push(resolve)
        })
        return { decision: "allow" as const }
      }
    }
    const pending = Array.from({ length: 8 }, () =>
      f.previews.read(f.href, scope, f.assertCurrent, f.publish, f.signal)
    )
    const settled = Promise.allSettled(pending)
    await Promise.resolve()
    expect(completions).toHaveLength(8)
    await expect(
      f.previews.read(f.href, scope, f.assertCurrent, f.publish, f.signal)
    ).rejects.toThrow("MODS_UI_MARKDOWN_PREVIEW_LIMIT")
    f.previews.close()
    await expect(
      f.previews.read(f.href, scope, f.assertCurrent, f.publish, f.signal)
    ).rejects.toThrow("MODS_UI_MARKDOWN_STALE")
    expect(f.publish).not.toHaveBeenCalled()
    for (const complete of completions) complete()
    expect((await settled).every((result) => result.status === "rejected")).toBe(true)
    expect(f.publish).not.toHaveBeenCalled()
  })

  it("rejects a file replaced during protection and never exposes an unprotected filename", async () => {
    const f = await fixture()
    const secretPath = join(f.workspace, "SECRET-report.txt")
    await writeFile(secretPath, "SECRET body")
    const preview = await f.previews.read(
      pathToFileURL(secretPath).href,
      f.scope,
      f.assertCurrent,
      async (value) => (typeof value === "string" ? value.replaceAll("SECRET", "HIDDEN") : value),
      f.signal
    )
    expect(JSON.stringify(preview)).not.toContain("SECRET")
    await writeFile(f.path, "original")
    await expect(
      f.previews.read(
        f.href,
        f.scope,
        f.assertCurrent,
        async (value) => {
          await rename(f.path, join(f.workspace, "retired.txt"))
          await writeFile(f.path, "replacement")
          return value
        },
        f.signal
      )
    ).rejects.toThrow("MODS_FS_CHANGED")
  })

  it("clears protected snapshots even if the closing renderer's notification throws", async () => {
    const f = await fixture()
    await writeFile(f.path, "data")
    const previews = new FunctionMarkdownFilePreviews(() => {
      throw Error("window closed")
    })
    const first = await previews.read(f.href, f.scope, f.assertCurrent, f.publish, f.signal)
    expect(() => previews.close()).not.toThrow()
    expect(previews.snapshot(first.receipt)).toBeNull()
    const g = await fixture()
    await writeFile(g.path, "data")
    const live = new FunctionMarkdownFilePreviews(() => {
      throw Error("window closed")
    })
    const second = await live.read(g.href, g.scope, g.assertCurrent, g.publish, g.signal)
    g.revoke()
    expect(live.snapshot(second.receipt)).toBeNull()
  })
})
