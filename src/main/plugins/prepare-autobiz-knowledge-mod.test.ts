import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { prepareAutobizKnowledgeMod } from "../../../scripts/prepare-autobiz-knowledge-mod"
import { snapshotDerivationSource, writeDerivationFiles } from "./derivation-source"
import { businessModCatalog } from "./business-mod-manifest"
import { portableBusinessModFiles } from "./business-mod-portable-source"
import { assembleBusinessMods } from "./business-mod-assembler"
import { compileFunctionPlugin } from "../mods/v2/loader"
import { FunctionGuestRuntime } from "../mods/v2/guest-runtime"
import { getPluginSkillSearchSources, readPluginManifest } from "./manifest"
import { projectRuntimeExtensionContract } from "../../shared/project-runtime"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canonical-knowledge-mod-"))
  roots.push(root)
  const source = join(root, "knowledge-source")
  const generated = await prepareAutobizKnowledgeMod(source)
  return { root, source, generated }
}
async function write(root: string, path: string, value: unknown) {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), typeof value === "string" ? value : JSON.stringify(value))
}

it("generates a closed six-file source and compiles its actual named register after original assembly", async () => {
  const f = await fixture()
  expect(f.generated).toMatchObject({ directory: f.source, files: 6 })
  const snapshot = await snapshotDerivationSource(f.source)
  const catalog = businessModCatalog(snapshot)
  expect(catalog.extensions).toHaveLength(1)
  expect(catalog.extensions![0]).toMatchObject({ id: "autobiz.knowledge",
    contextProvider: { required: true, knowledgeBinding: "knowledgeRoot" },
    userConfig: { knowledgeRoot: { type: "directory", required: false } } })
  expect(portableBusinessModFiles(snapshot).map(file => file.path).sort())
    .toEqual(snapshot.files.map(file => file.path).sort())
  expect(snapshot.files).toHaveLength(6)

  // A local minimal shared-kernel fixture exercises the original assembler and compiler.
  // This verifies canonical packaging, not the separate reviewed AutoBiz source admission.
  const kernel = join(f.root, "kernel")
  const step = { id: "doc", title: "Document", node: { id: "doc", skill: "make-doc",
    order: 10, checkpoints: ["doc_in_progress", "doc_done"], validators: [], guards: [] },
    skill: { entry: "skills/make-doc/SKILL.md", resources: [] }, resources: [],
    dependencies: { required: [], advisory: [] }, checks: { validators: [], guards: [] } }
  await write(kernel, "plugin.json", { name: "kernel-source", version: "1.0.0" })
  await write(kernel, "mods/business/manifest.json", { apiVersion: "devclaw.business-mods/v1",
    kind: "catalog", kernel: { id: "autobiz.python-kernel", version: "1.0.0",
      boardConfigPath: "board_core/board_config.json", resources: ["hooks/hooks.json"],
      pluginFields: { hooks: "hooks/hooks.json" } }, modules: [step] })
  await write(kernel, "hooks/hooks.json", await readFile(
    new URL("../../../tests/fixtures/autobiz-reviewed-hooks.json", import.meta.url), "utf8"))
  await write(kernel, step.skill.entry, "---\nname: make-doc\ndescription: Local test step.\n---\nProduce document.")
  await write(kernel, "board_core/board_config.json", { apiVersion: 1,
    knowledge_config: { nextAction: { slashSkill: "knowledge-sync" } },
    workflow: { nodes: [step.node], skipPolicy: { lockedNodes: [] } } })
  const kernelSnapshot = await snapshotDerivationSource(kernel)
  const assembled = assembleBusinessMods([
    { snapshot: kernelSnapshot, catalog: businessModCatalog(kernelSnapshot), modIds: ["doc"] },
    { snapshot, catalog, modIds: ["autobiz.knowledge"] }
  ], { name: "canonical-knowledge-composed", version: "1.0.0", sources: [] })
  expect(assembled.missingProviders).toEqual([])
  const output = join(f.root, "assembled")
  await writeDerivationFiles(output, assembled.files)
  const compiled = await compileFunctionPlugin(output)
  expect(compiled.components?.map(component => component.id)).toEqual(["autobiz.knowledge"])
  const guest = await FunctionGuestRuntime.create(compiled.code)
  try { expect(guest.registrations).toEqual([]) } finally { guest.dispose() }
  const sources = getPluginSkillSearchSources(output, readPluginManifest(output)?.manifest)
  expect(sources.some(source => source.relPath ===
    "mods/business/autobiz.knowledge/skills/knowledge-sync")).toBe(true)
  const runtime = JSON.parse(await readFile(join(output, "devclaw.project-runtime.json"), "utf8"))
  expect(projectRuntimeExtensionContract(runtime)?.context?.provider?.entry)
    .toBe("mods/business/autobiz.knowledge/provider.py")
  for (const resource of catalog.extensions![0].resources)
    expect(await readFile(join(output, resource), "utf8"))
      .toBe(snapshot.files.find(file => file.path === resource)!.bytes.toString("utf8"))
  await write(output, catalog.extensions![0].entry, "export default function register() {}")
  await expect(compileFunctionPlugin(output)).rejects.toThrow()
})

it("refuses an existing output without overwriting user edits or adding files", async () => {
  const f = await fixture()
  await write(f.source, "mods/business/autobiz.knowledge/register.ts", "USER_EDIT_MUST_SURVIVE")
  const before = await snapshotDerivationSource(f.source)
  await expect(prepareAutobizKnowledgeMod(f.source)).rejects.toMatchObject({ code: "EEXIST" })
  expect((await snapshotDerivationSource(f.source)).digest).toBe(before.digest)
})
