import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import AdmZip from "adm-zip"
import {
  initProjectPlugin,
  packProjectPlugin,
  prepareProjectDevelopment,
  testProjectPlugin
} from "./project-tooling"
import { doctorProjectPlugin } from "./project-doctor"
import { readProjectSource } from "./project-source"
import { compileFunctionPlugin } from "../v2/loader"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "project-mixed-")),
    source = join(root, "source")
  roots.push(root)
  await initProjectPlugin(source, { packageId: "mixed", name: "Mixed" })
  const metadata = JSON.parse(readFileSync(join(source, "plugin.json"), "utf8"))
  writeFileSync(
    join(source, "plugin.json"),
    JSON.stringify({ ...metadata, mods: "mods/manifest.json", mcpServers: ".mcp.json" })
  )
  mkdirSync(join(source, "mods"))
  writeFileSync(
    join(source, "mods/manifest.json"),
    JSON.stringify({ apiVersion: "cmb.mods/v2", id: "mixed-native", entry: "main.ts" })
  )
  writeFileSync(
    join(source, "mods/main.ts"),
    "import {title} from './title';export function register(on){on('ui.render',async()=>({type:'text',text:title}))}"
  )
  writeFileSync(join(source, "mods/title.ts"), "export const title='Real package extension'")
  writeFileSync(
    join(source, ".mcp.json"),
    JSON.stringify({ mcpServers: { example: { command: process.execPath, args: ["--version"] } } })
  )
  return { root, source }
}
it("retains real Mod imports/Skill/MCP resources through doctor, actual compilation, trial snapshot and ZIP", async () => {
  const f = await fixture(),
    read = await readProjectSource(f.source)
  expect(read.excluded).toEqual([])
  expect((await doctorProjectPlugin(f.source)).valid).toBe(true)
  expect((await testProjectPlugin(f.source)).valid).toBe(true)
  const prepared = await prepareProjectDevelopment(
    f.source,
    join(f.root, "trial"),
    read.bundle.digest
  )
  expect((await compileFunctionPlugin(prepared.packagePath)).name).toBe("mixed-native")
  expect(readFileSync(join(prepared.packagePath, "mods/title.ts"), "utf8")).toContain(
    "Real package extension"
  )
  const zip = join(f.root, "mixed.zip")
  await packProjectPlugin(f.source, zip, read.bundle.digest)
  expect(new AdmZip(zip).getEntries().map((entry) => entry.entryName)).toEqual(
    expect.arrayContaining(["mods/main.ts", "mods/title.ts", ".mcp.json", "skills/draft/SKILL.md"])
  )
})
it("rejects missing compiler imports without granting, preparing a runnable trial or exporting partial code", async () => {
  const f = await fixture()
  rmSync(join(f.source, "mods/title.ts"))
  await expect(prepareProjectDevelopment(f.source, join(f.root, "trial"))).rejects.toThrow()
  await expect(packProjectPlugin(f.source, join(f.root, "broken.zip"))).rejects.toThrow()
})
it("keeps path/closure and MCP declarations explicit rather than silently dropping unsupported resources", async () => {
  const f = await fixture()
  writeFileSync(
    join(f.source, "mods/manifest.json"),
    JSON.stringify({ apiVersion: "cmb.mods/v2", id: "mixed-native", entry: "/outside.ts" })
  )
  expect((await doctorProjectPlugin(f.source)).valid).toBe(false)
  await expect(prepareProjectDevelopment(f.source, join(f.root, "trial"))).rejects.toThrow(
    "PROJECT_DEV_DOCTOR_FAILED"
  )
})
