import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { prepareAutobizBusinessTrial } from "./autobiz-business-trial"
import { createProjectTemplate } from "../project-template"
import { parseProjectRuntimeManifest } from "../../../../shared/project-runtime"
import type { PluginMetadata } from "../../../types"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it("refuses a Host manifest before reading or executing the AutoBiz board protocol", async () => {
  const source = createProjectTemplate({ packageId: "independent", name: "Independent" })
  const manifest = parseProjectRuntimeManifest(
    JSON.parse(source.files.find((file) => file.path === "devclaw.project-runtime.json")!.text)
  )
  await expect(
    prepareAutobizBusinessTrial({ path: "not-read", enabled: true } as PluginMetadata, manifest)
  ).rejects.toThrow("BUSINESS_TRIAL_ADAPTER_UNSUPPORTED")
})

it("does not admit an unknown legacy protocol just because it has a board configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "unknown-legacy-trial-"))
  roots.push(root)
  const source = createProjectTemplate({ packageId: "independent", name: "Independent" })
  const host = JSON.parse(
    source.files.find((file) => file.path === "devclaw.project-runtime.json")!.text
  )
  const manifest = parseProjectRuntimeManifest({ ...host, mode: "legacy", stateOwner: "plugin" })
  const files = source.files.map((file) =>
    file.path === "devclaw.project-runtime.json"
      ? { path: file.path, text: JSON.stringify(manifest) }
      : file
  )
  files.push({
    path: "board_core/board_config.json",
    text: JSON.stringify({
      inspectCommands: {
        win32: Object.fromEntries(
          [
            "create_project",
            "create_feature",
            "project_status",
            "feature_status",
            "session_context_inject"
          ].map((name) => [name, `python board.py ${name}`])
        )
      }
    })
  })
  for (const file of files) {
    await mkdir(dirname(join(root, file.path)), { recursive: true })
    await writeFile(join(root, file.path), file.text)
  }
  await expect(
    prepareAutobizBusinessTrial(
      {
        id: "unknown",
        name: "independent",
        version: "0.1.0",
        path: root,
        enabled: true
      } as PluginMetadata,
      manifest
    )
  ).rejects.toThrow(
    process.platform === "win32"
      ? "COMPOSITION_LEGACY_PROTOCOL_UNSUPPORTED"
      : "COMPOSITION_LEGACY_PLATFORM_UNSUPPORTED"
  )
})
