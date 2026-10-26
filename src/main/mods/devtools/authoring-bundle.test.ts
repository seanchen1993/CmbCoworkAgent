import { describe, expect, it } from "vitest"
import { createAuthoringSourceBundle, readAuthoringSourceBundle } from "./authoring-bundle"

const manifest = { path: "plugin.json", text: '{"name":"example"}' }
const source = { path: "hooks/main.ts", text: "export function register() {}\n" }

describe("authoring source snapshots", () => {
  it("retains up to 64 module/resource files while preserving the total byte budget", () => {
    const files = [
      manifest,
      ...Array.from({ length: 63 }, (_, index) => ({
        path: `resources/${index}.md`,
        text: "bounded"
      }))
    ]
    expect(createAuthoringSourceBundle(files).files).toHaveLength(64)
    expect(() =>
      createAuthoringSourceBundle([...files, { path: "resources/overflow.md", text: "x" }])
    ).toThrow("AUTHORING_SOURCE_LIMIT")
    expect(() =>
      createAuthoringSourceBundle(files.map((file) => ({ ...file, text: "x".repeat(5000) })))
    ).toThrow("AUTHORING_SOURCE_LIMIT")
  })
  it.each(["mjs", "cjs", "mts", "cts", "py", "sh", "ps1", "txt"])(
    "preserves bounded %s text bytes and revalidates their saved digest without executing them",
    (suffix) => {
      const resource = { path: `mods/resource.${suffix}`, text: "throw NEVER_EXECUTE_SOURCE\n" }
      const saved = createAuthoringSourceBundle([manifest, resource])
      expect(readAuthoringSourceBundle(JSON.parse(JSON.stringify(saved)))).toEqual(saved)
      expect(() =>
        readAuthoringSourceBundle({ ...saved, files: [manifest, { ...resource, text: "changed" }] })
      ).toThrow("AUTHORING_SOURCE_DIGEST_CHANGED")
    }
  )

  it("canonicalizes file order and detaches both caller and readback objects", () => {
    const files = [{ ...source }, { ...manifest }]
    const first = createAuthoringSourceBundle(files)
    expect(createAuthoringSourceBundle([...files].reverse()).digest).toBe(first.digest)
    files[0].text = "changed"
    expect(first.files[0].text).toBe(source.text)
    const read = readAuthoringSourceBundle(first)
    read.files[0].text = "another change"
    expect(first.files[0].text).toBe(source.text)
  })

  it("binds file names and exact source bytes, including line endings", () => {
    const original = createAuthoringSourceBundle([manifest, source])
    for (const changed of [
      { ...source, path: "hooks/other.ts" },
      { ...source, text: source.text.replace("\n", "\r\n") },
      { ...source, text: source.text + "// update\n" }
    ])
      expect(createAuthoringSourceBundle([manifest, changed]).digest).not.toBe(original.digest)
    expect(() => readAuthoringSourceBundle({ ...original, files: [manifest] })).toThrow(
      "AUTHORING_SOURCE_DIGEST_CHANGED"
    )
  })

  it.each([
    "../outside.ts",
    "/outside.ts",
    "C:/outside.ts",
    "hooks\\main.ts",
    "hooks//main.ts",
    "hooks/./main.ts",
    "hooks/../main.ts",
    "CON.ts",
    "hooks/nul.json",
    "hooks/COM1.ts",
    "file.ts:stream",
    "file.ts.",
    ".git/config.json",
    "node_modules/library.ts",
    ".env/config.json",
    ".env.local/config.json",
    "mods/.env.py",
    "mods/.env.local.sh",
    "mods/../outside.py",
    "binary.exe",
    "file.ts\0",
    "é.ts"
  ])("rejects nonportable or protected source path %s", (path) => {
    expect(() => createAuthoringSourceBundle([manifest, { path, text: "source" }])).toThrow()
  })

  it("rejects case collisions and file-directory prefix collisions", () => {
    expect(() =>
      createAuthoringSourceBundle([manifest, source, { ...source, path: "HOOKS/main.ts" }])
    ).toThrow("AUTHORING_SOURCE_COLLISION")
    expect(() =>
      createAuthoringSourceBundle([
        manifest,
        { path: "folder.ts", text: "" },
        { path: "folder.ts/main.ts", text: "" }
      ])
    ).toThrow("AUTHORING_SOURCE_COLLISION")
  })

  it("requires a complete package manifest and text bytes with explicit limits", () => {
    expect(() =>
      createAuthoringSourceBundle([{ ...manifest, path: "PLUGIN.JSON" }, source])
    ).toThrow("AUTHORING_SOURCE_PATH")
    expect(() =>
      createAuthoringSourceBundle([{ ...manifest, path: "Plugin.json" }, source])
    ).toThrow("AUTHORING_PLUGIN_MANIFEST_REQUIRED")
    expect(() => createAuthoringSourceBundle([source])).toThrow(
      "AUTHORING_PLUGIN_MANIFEST_REQUIRED"
    )
    expect(() => createAuthoringSourceBundle([])).toThrow("AUTHORING_SOURCE_LIMIT")
    expect(() =>
      createAuthoringSourceBundle([manifest, { ...source, text: "中".repeat(22000) }])
    ).toThrow("AUTHORING_SOURCE_TEXT")
    expect(() => createAuthoringSourceBundle([manifest, { ...source, text: "\ud800" }])).toThrow(
      "AUTHORING_SOURCE_TEXT"
    )
    expect(() =>
      createAuthoringSourceBundle([
        manifest,
        ...Array.from({ length: 5 }, (_, index) => ({
          path: `${index}.ts`,
          text: "x".repeat(60000)
        }))
      ])
    ).toThrow("AUTHORING_SOURCE_LIMIT")
  })

  it("does not execute getters, proxies, toJSON or sparse array accessors", () => {
    let reads = 0
    const hostile = {
      path: "main.ts",
      get text() {
        reads++
        return "source"
      }
    }
    const proxy = new Proxy(source, {
      ownKeys() {
        reads++
        return []
      }
    })
    for (const row of [
      hostile,
      proxy,
      {
        ...source,
        toJSON() {
          reads++
          return source
        }
      }
    ])
      expect(() => createAuthoringSourceBundle([manifest, row])).toThrow()
    const sparse = [manifest, source]
    Object.defineProperty(sparse, "1", {
      get() {
        reads++
        return source
      }
    })
    expect(() => createAuthoringSourceBundle(sparse)).toThrow()
    expect(reads).toBe(0)
  })
})
