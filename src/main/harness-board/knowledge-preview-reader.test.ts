import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serialize } from "node:v8"
import { afterEach, describe, expect, it } from "vitest"
import { readHarnessKnowledgePreview } from "./knowledge-preview-reader"
import { HARNESS_KNOWLEDGE_PREVIEW_MAX_RESPONSE_BYTES } from "./knowledge-preview-protocol"
import { createProjectTemplate } from "../mods/devtools/project-template"
import { CONTEXT_HANDOFF_PROTOCOL, parseProjectRuntimeManifest, wrapProjectRuntimeManifest } from "../../shared/project-runtime"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("Harness knowledge preview reader", () => {
  it("rejects a plain native Host target before interpreting ordinary same-named board data", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-knowledge-host-boundary-"))
    roots.push(root)
    const pluginPath = join(root, "plugin")
    await mkdir(join(pluginPath, "board_core"), { recursive: true })
    const source = createProjectTemplate({ packageId: "host-only", name: "Host" })
    await writeFile(join(pluginPath, "devclaw.project-runtime.json"),
      source.files.find((file) => file.path === "devclaw.project-runtime.json")!.text)
    await writeFile(join(pluginPath, "board_core/board_config.json"), "ordinary text")
    await writeFile(join(root, "plugins.json"), JSON.stringify([
      { id: "host", name: "Host", path: pluginPath }
    ]))
    expect(() => readHarnessKnowledgePreview("host", {
      openworkDir: root, pluginStorePath: join(root, "plugins.json"),
      leanTokenStorePath: join(root, "lean.json")
    }, HARNESS_KNOWLEDGE_PREVIEW_MAX_RESPONSE_BYTES)).toThrow("插件未安装或不支持项目模式")
  })

  it.each([0, 300 * 1024])("reads a v2 provider cache with %s extra board bytes only under the exact grant", async (padding) => {
    const root = await mkdtemp(join(tmpdir(), "harness-knowledge-v2-preview-"))
    roots.push(root)
    const pluginPath = join(root, "plugin")
    const knowledge = join(root, "host-cache")
    await mkdir(join(pluginPath, "board_core"), { recursive: true })
    await mkdir(knowledge)
    await writeFile(join(knowledge, "governed.md"), "knowledge")
    const template = createProjectTemplate({ packageId: "preview-v2", name: "Preview" })
    const runtime = parseProjectRuntimeManifest(JSON.parse(template.files.find(file =>
      file.path === "devclaw.project-runtime.json")!.text))
    await writeFile(join(pluginPath, "provider.py"), "print('context')")
    await writeFile(join(pluginPath, "devclaw.project-runtime.json"), JSON.stringify(
      wrapProjectRuntimeManifest(runtime, { apiVersion: "devclaw.extension-contract/v1",
        requires: [CONTEXT_HANDOFF_PROTOCOL], context: { sourceAccess: "read-only",
          mutableData: "host", configuration: "host-resolved", knowledge: { required: true },
          provider: { entry: "provider.py", operations: ["session-context"] } } })))
    await writeFile(join(pluginPath, "board_core/board_config.json"), JSON.stringify({
      apiVersion: 2, padding: "x".repeat(padding),
      inspectCommands: { [process.platform]: { knowledge_path: knowledge } } }))
    await writeFile(join(root, "plugins.json"), JSON.stringify([{ id: "v2", name: "Preview", path: pluginPath }]))
    const source = { openworkDir: root, pluginStorePath: join(root, "plugins.json"),
      leanTokenStorePath: join(root, "leanstar-config.json") }
    const grant = { pluginId: "v2", pluginPath, root: knowledge }
    const approved = readHarnessKnowledgePreview("v2", { ...source, authorizedKnowledge: grant },
      HARNESS_KNOWLEDGE_PREVIEW_MAX_RESPONSE_BYTES)
    expect(approved).toMatchObject({ configured: true, exists: true, path: knowledge })
    expect(approved.files).toContainEqual(expect.objectContaining({ path: "/governed.md" }))
    for (const invalid of [{ ...grant, pluginId: "another" },
      { ...grant, pluginPath: join(root, "another-plugin") }]) {
      expect(readHarnessKnowledgePreview("v2", { ...source, authorizedKnowledge: invalid },
        HARNESS_KNOWLEDGE_PREVIEW_MAX_RESPONSE_BYTES))
        .toMatchObject({ exists: false, files: [], error: expect.stringContaining("未经用户授权") })
    }
  })

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
