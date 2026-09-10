import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serialize } from "node:v8"
import { afterEach, describe, expect, it } from "vitest"
import { readHarnessKnowledgePreview } from "./knowledge-preview-reader"
import { HARNESS_KNOWLEDGE_PREVIEW_MAX_RESPONSE_BYTES } from "./knowledge-preview-protocol"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("Harness knowledge preview reader", () => {
  it("resolves plugin placeholders and returns a bounded file projection", async () => {
    const openworkDir = await mkdtemp(join(tmpdir(), "harness-knowledge-preview-"))
    roots.push(openworkDir)
    const pluginPath = join(openworkDir, "plugin-a")
    const knowledgePath = join(pluginPath, "knowledge")
    await mkdir(join(pluginPath, "board_core"), { recursive: true })
    await mkdir(join(knowledgePath, "nested"), { recursive: true })
    await writeFile(
      join(openworkDir, "plugins.json"),
      JSON.stringify([{ id: "adapter-a", name: "Adapter A", path: pluginPath }]),
      "utf8"
    )
    await writeFile(join(openworkDir, "leanstar-config.json"), JSON.stringify({ leanToken: "" }))
    await writeFile(
      join(pluginPath, "board_core", "board_config.json"),
      JSON.stringify({
        apiVersion: 1,
        inspectCommands: {
          [process.platform]: { knowledge_path: "${pluginPath}/knowledge" }
        }
      }),
      "utf8"
    )
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        writeFile(join(knowledgePath, "nested", `file-${index}.md`), `body ${index}`, "utf8")
      )
    )

    const result = readHarnessKnowledgePreview(
      "adapter-a",
      {
        openworkDir,
        pluginStorePath: join(openworkDir, "plugins.json"),
        leanTokenStorePath: join(openworkDir, "leanstar-config.json")
      },
      HARNESS_KNOWLEDGE_PREVIEW_MAX_RESPONSE_BYTES
    )

    expect(result).toMatchObject({
      adapterId: "adapter-a",
      adapterName: "Adapter A",
      configured: true,
      exists: true,
      path: knowledgePath
    })
    expect(result.files.some((file) => file.path === "/nested/file-39.md")).toBe(true)
    expect(serialize(result).byteLength).toBeLessThanOrEqual(
      HARNESS_KNOWLEDGE_PREVIEW_MAX_RESPONSE_BYTES
    )
  })

  it("honors cancellation before filesystem traversal", async () => {
    const openworkDir = await mkdtemp(join(tmpdir(), "harness-knowledge-cancel-"))
    roots.push(openworkDir)
    const flag = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
    Atomics.store(flag, 0, 1)

    expect(() =>
      readHarnessKnowledgePreview(
        "adapter-a",
        {
          openworkDir,
          pluginStorePath: join(openworkDir, "plugins.json"),
          leanTokenStorePath: join(openworkDir, "leanstar-config.json")
        },
        HARNESS_KNOWLEDGE_PREVIEW_MAX_RESPONSE_BYTES,
        flag
      )
    ).toThrow(expect.objectContaining({ name: "AbortError" }))
  })

  it("refuses a renderer-editable config that points outside the plugin root", async () => {
    const openworkDir = await mkdtemp(join(tmpdir(), "harness-knowledge-boundary-"))
    const outsideRoot = await mkdtemp(join(tmpdir(), "harness-knowledge-outside-"))
    roots.push(openworkDir, outsideRoot)
    const pluginPath = join(openworkDir, "plugin-a")
    await mkdir(join(pluginPath, "board_core"), { recursive: true })
    await writeFile(join(outsideRoot, "private.txt"), "must not be granted", "utf8")
    await writeFile(
      join(openworkDir, "plugins.json"),
      JSON.stringify([{ id: "adapter-a", name: "Adapter A", path: pluginPath }]),
      "utf8"
    )
    await writeFile(join(openworkDir, "leanstar-config.json"), "{}", "utf8")
    await writeFile(
      join(pluginPath, "board_core", "board_config.json"),
      JSON.stringify({
        apiVersion: 1,
        inspectCommands: {
          [process.platform]: { knowledge_path: outsideRoot }
        }
      }),
      "utf8"
    )

    const result = readHarnessKnowledgePreview(
      "adapter-a",
      {
        openworkDir,
        pluginStorePath: join(openworkDir, "plugins.json"),
        leanTokenStorePath: join(openworkDir, "leanstar-config.json")
      },
      HARNESS_KNOWLEDGE_PREVIEW_MAX_RESPONSE_BYTES
    )
    expect(result).toMatchObject({ configured: true, exists: false, files: [] })
    expect(result.error).toContain("未经用户授权")
    expect(result.path).toBeUndefined()
  })
})
