import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { LocalSandbox } from "./local-sandbox"
import { validateFirstDesignWrite } from "../services/design/generation-prompt"

it("rejects broken frameworks but writes larger coherent frameworks on the first attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "design-first-write-"))
  const draft = join(root, "draft.html")
  let written = false
  const sandbox = new LocalSandbox({
    rootDir: root,
    runId: "first-design-write",
    validateFileWrite: (file, content) =>
      file === draft && !written ? validateFirstDesignWrite(content) : undefined,
    onFileMutation: (file) => {
      if (file === draft) written = true
    }
  })
  try {
    const oversized = `<!doctype html><html><body>${"内容".repeat(5000)}</body></html>`
    expect((await sandbox.write(draft, "<section>未闭合")).error).toContain("complete")
    await expect(readFile(draft, "utf8")).rejects.toThrow(/ENOENT/)
    expect(written).toBe(false)
    expect((await sandbox.write(draft, oversized)).error).toBeUndefined()
    expect(written).toBe(true)
    expect((await sandbox.edit(draft, "内容", "完整内容", true)).error).toBeUndefined()
    expect(Buffer.byteLength(await readFile(draft, "utf8"))).toBeGreaterThan(8192)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("fills known section anchors without extra reads and still detects external changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "design-known-edits-"))
  const draft = join(root, "draft.html")
  const sandbox = new LocalSandbox({ rootDir: root, runId: "known-design-edits" })
  const reads = vi.spyOn(sandbox, "read")
  const overview =
    '<section data-design-section="overview" data-design-pending><!-- design-slot:overview --></section>'
  const details =
    '<section data-design-section="details" data-design-pending><!-- design-slot:details --></section>'
  try {
    expect(
      (await sandbox.write(draft, `<!doctype html><html><body>${overview}${details}</body></html>`))
        .error
    ).toBeUndefined()
    expect(
      (
        await sandbox.edit(
          draft,
          overview,
          '<section data-design-section="overview">概览</section>'
        )
      ).error
    ).toBeUndefined()
    expect(
      (await sandbox.edit(draft, details, '<section data-design-section="details">明细</section>'))
        .error
    ).toBeUndefined()
    expect(reads).not.toHaveBeenCalled()

    const completed = await readFile(draft, "utf8")
    expect((await sandbox.edit(draft, "missing-anchor", "错误内容")).error).toBeTruthy()
    expect(await readFile(draft, "utf8")).toBe(completed)

    await writeFile(draft, completed.replace("明细", "外部更新"))
    const changedAt = new Date(Date.now() + 2000)
    await utimes(draft, changedAt, changedAt)
    expect((await sandbox.edit(draft, "概览", "新概览")).error).toContain("modified externally")
    expect(await readFile(draft, "utf8")).toContain("外部更新")

    await sandbox.read(draft, 0, 5)
    expect((await sandbox.edit(draft, "外部更新", "确认后的明细")).error).toBeUndefined()
    expect(reads).toHaveBeenCalledTimes(1)
    expect(await readFile(draft, "utf8")).toContain("确认后的明细")
  } finally {
    reads.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})
