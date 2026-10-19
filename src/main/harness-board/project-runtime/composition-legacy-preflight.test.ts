import { afterEach, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { PluginMetadata } from "../../types"
import { preflightLegacyCompositionSource } from "./composition-legacy-preflight"
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
it("checks the actual legacy declaration and original command contracts without running them", async () => {
  const path = mkdtempSync(join(tmpdir(), "composition-preflight-"))
  roots.push(path)
  mkdirSync(join(path, "board_core"))
  writeFileSync(
    join(path, "devclaw.project-runtime.json"),
    readFileSync("examples/autobiz-fullstack-mods/devclaw.project-runtime.json")
  )
  const commands = {
    create_project: "do-not-execute",
    create_feature: "do-not-execute",
    project_status: "do-not-execute",
    feature_status: "do-not-execute",
    session_context_inject: "do-not-execute"
  }
  const save = () =>
    writeFileSync(
      join(path, "board_core/board_config.json"),
      JSON.stringify({ apiVersion: 1, inspectCommands: { [process.platform]: commands } })
    )
  save()
  const plugin = { path, enabled: true } as PluginMetadata
  const before = readdirSync(path)
  await expect(preflightLegacyCompositionSource(plugin)).rejects.toThrow("PROTOCOL_UNSUPPORTED")
  expect(readdirSync(path)).toEqual(before)
  await expect(preflightLegacyCompositionSource(plugin, "alternate.json")).rejects.toThrow(
    "ENTRY_UNSUPPORTED"
  )
  commands.feature_status = ""
  save()
  await expect(preflightLegacyCompositionSource(plugin)).rejects.toThrow(
    "COMMAND_REQUIRED:feature_status"
  )
})
