import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { readKnowledgeBasePreview } from "./knowledge-preview-reader"
import { HARNESS_KNOWLEDGE_PREVIEW_MAX_RESPONSE_BYTES } from "./knowledge-preview-protocol"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("Harness knowledge preview reader", () => {
  it("scans a framework knowledge directory directly by idKey", async () => {
    const root = await mkdtemp(join(tmpdir(), "framework-knowledge-preview-"))
    roots.push(root)
    await mkdir(join(root, "docs"), { recursive: true })
    await writeFile(join(root, "docs", "AGENTS.md"), "knowledge", "utf8")

    const result = readKnowledgeBasePreview(
      { idKey: "kb-payment", name: "支付知识库", path: root },
      HARNESS_KNOWLEDGE_PREVIEW_MAX_RESPONSE_BYTES
    )

    expect(result).toMatchObject({
      exists: true,
      path: root
    })
    expect(result.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/docs", is_dir: true }),
        expect.objectContaining({ path: "/docs/AGENTS.md", is_dir: false })
      ])
    )
  })

  it("honors cancellation before filesystem traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "framework-knowledge-cancel-"))
    roots.push(root)
    const flag = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
    Atomics.store(flag, 0, 1)

    expect(() =>
      readKnowledgeBasePreview(
        { idKey: "kb-payment", name: "支付知识库", path: root },
        HARNESS_KNOWLEDGE_PREVIEW_MAX_RESPONSE_BYTES,
        flag
      )
    ).toThrow(expect.objectContaining({ name: "AbortError" }))
  })
})
