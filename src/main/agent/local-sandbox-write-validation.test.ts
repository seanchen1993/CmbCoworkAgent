import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
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
