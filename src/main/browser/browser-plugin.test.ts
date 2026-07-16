import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { describe, expect, it } from "vitest"
import { readPluginManifest } from "../plugins/manifest"
import { isBrowserPluginManifest, resolveBrowserPluginRuntime } from "./browser-plugin"

describe("browser plugin runtime discovery", () => {
  it("recognizes the bundled Browser plugin manifest shape", () => {
    expect(
      isBrowserPluginManifest({
        name: "browser",
        version: "26.623.141536",
        description: "OpenAI Browser plugin with @browser alias",
        skills: "./skills/"
      })
    ).toBe(true)
  })

  it("requires the Browser plugin runtime client and skills directory", () => {
    const root = mkdtempSync(join(tmpdir(), "cmb-browser-plugin-"))
    try {
      const plugin = { id: "plugin-browser", name: "browser", path: root }
      const manifest = { name: "browser", version: "1.0.0", skills: "./skills/" }

      expect(resolveBrowserPluginRuntime(plugin, manifest)).toBeNull()

      mkdirSync(join(root, "scripts"), { recursive: true })
      writeFileSync(join(root, "scripts", "browser-client.mjs"), "export {};")
      mkdirSync(join(root, "skills"), { recursive: true })

      expect(resolveBrowserPluginRuntime(plugin, manifest)).toMatchObject({
        pluginId: "plugin-browser",
        pluginName: "browser",
        pluginRoot: root,
        clientPath: join(root, "scripts", "browser-client.mjs")
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("ignores unrelated plugins even if they have a scripts directory", () => {
    const root = mkdtempSync(join(tmpdir(), "cmb-other-plugin-"))
    try {
      mkdirSync(join(root, "scripts"), { recursive: true })
      mkdirSync(join(root, "skills"), { recursive: true })
      writeFileSync(join(root, "scripts", "browser-client.mjs"), "export {};")

      expect(
        resolveBrowserPluginRuntime(
          { id: "plugin-other", name: "other", path: root },
          { name: "other", version: "1.0.0", skills: "./skills/" }
        )
      ).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("discovers the checked-in plugins/broswer official runtime bundle", () => {
    const root = join(process.cwd(), "plugins/broswer")
    const manifestResult = readPluginManifest(root)

    expect(manifestResult?.relPath).toBe(".codex-plugin/plugin.json")
    expect(manifestResult?.manifest).toEqual(
      expect.objectContaining({
        name: "broswer",
        keywords: expect.arrayContaining(["browser", "browser-use"]),
        skills: "./skills/"
      })
    )
    expect(
      resolveBrowserPluginRuntime(
        { id: "plugin-broswer", name: manifestResult?.manifest.name ?? "broswer", path: root },
        manifestResult!.manifest
      )
    ).toMatchObject({
      pluginId: "plugin-broswer",
      pluginName: "broswer",
      pluginRoot: root,
      clientPath: join(root, "scripts", "browser-client.mjs")
    })
  })
})
