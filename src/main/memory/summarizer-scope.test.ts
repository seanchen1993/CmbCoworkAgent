import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import type { ChatOpenAI } from "@langchain/openai"
vi.mock("../services/event-reporter", () => ({ trackEvent: vi.fn() }))
import { summarizeAndSave } from "./summarizer"
import { buildFrontmatter } from "./manifest"

it("scopes the extractor's manifest before prompting without reading an unscoped aggregate", async () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "memory-extractor-scope-"))
  try {
    for (const [file, name] of [
      ["reference_private.md", "PRIVATE_FACT"],
      ["reference_group.md", "GROUP_FACT"]
    ])
      writeFileSync(
        join(memoryDir, file),
        buildFrontmatter({ name, description: name, type: "reference" }) + name
      )
    writeFileSync(join(memoryDir, "MEMORY.md"), "UNSCOPED_AGGREGATE")
    const invoke = vi.fn(async () => ({ content: '{"operations":[],"memory_md":""}' }))
    const options = {
      model: { invoke } as unknown as ChatOpenAI,
      memoryDir,
      conversation: "New private preference",
      apply: vi.fn()
    }
    await summarizeAndSave({ ...options, allowedFilenames: ["reference_private.md"] })
    const scoped = String((invoke.mock.calls[0] as any)[0][1].content)
    expect(scoped).toContain("PRIVATE_FACT")
    expect(scoped).not.toContain("GROUP_FACT")
    expect(scoped).not.toContain("UNSCOPED_AGGREGATE")
    await summarizeAndSave(options)
    const ordinary = String((invoke.mock.calls[1] as any)[0][1].content)
    expect(ordinary).toContain("GROUP_FACT")
    expect(ordinary).toContain("UNSCOPED_AGGREGATE")
  } finally {
    rmSync(memoryDir, { recursive: true, force: true })
  }
})
