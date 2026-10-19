import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { snapshotDerivationSource, writeDerivationFiles } from "../src/main/plugins/derivation-source"
import { AUTOBIZ_WORKFLOW_TARGET_SHA256 } from "./prepare-autobiz-workflow-wakeup-source"

export const AUTOBIZ_SPEC_ROLE_INPUT_MANIFEST_SHA256 = "3e3f28032f0392a99d9168eca459509ca38a4c70f3cd73be6fd99dd5a334b094"
export const AUTOBIZ_SPEC_ROLE_INPUT_BOARD_SHA256 = "9015b3633fef9dc7176143d8cefe52ae62b5a3e02c60c798d982efb7a7a3cdb6"
export const AUTOBIZ_SPEC_ROLE_DEFINITION_SHA256 = "6a4bcc07c8d5a78209ff589f609c1d10c1c0da0ad53bfe472a1af420695a40b2"
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value

/** New local source, exact reviewed semantic correction; never patches a live/old package. */
export async function prepareAutobizSpecRoleSource(output: string, source: string) {
  const inside = relative(resolve(source), resolve(output))
  assert(inside && (inside.split(/[\\/]/)[0] === ".." || isAbsolute(inside)),
    "New source must be outside the read-only 1.0.2 source")
  const original = await snapshotDerivationSource(source)
  const files = new Map(original.files.map(file => [file.path, file]))
  assert.equal(files.get("workflows/code-batched-execution.workflow.js")?.digest,
    AUTOBIZ_WORKFLOW_TARGET_SHA256, "Exact reviewed completion wakeup must remain unchanged")
  assert.equal(files.get("board_core/board_config.json")?.digest, AUTOBIZ_SPEC_ROLE_INPUT_BOARD_SHA256)
  assert.equal(files.get("mods/business/manifest.json")?.digest, AUTOBIZ_SPEC_ROLE_INPUT_MANIFEST_SHA256)
  const explore = files.get("agents/explore_spec.md")!, critic = files.get("agents/critic.md")!
  assert.equal(explore?.digest, "90e1609a40b403f07cba18d3254aa3c0bb0b4360e55ee70129763476fca757dc")
  assert.equal(critic?.digest, "27028fcd1781cb3ef8f193d89ccaa4bd5b9ad842be3bf9ba437615fc9524a4bf")
  assert(/(?:^|\r?\n)name: Explore-autodev-spec(?:\r?\n)/.test(explore.bytes.toString("utf8")))
  assert(files.get("skills/autodev/autodev-specs/SKILL.md")!.bytes.toString("utf8")
    .includes("指定 Explore-autodev-spec 角色"), "Original Skill must declare the exact role")
  const board = JSON.parse(files.get("board_core/board_config.json")!.bytes.toString("utf8"))
  const manifest = JSON.parse(files.get("mods/business/manifest.json")!.bytes.toString("utf8"))
  assert.deepEqual({ id: manifest.kernel?.id, version: manifest.kernel?.version },
    { id: "autobiz.python-kernel", version: "1.0.2" })
  const module = manifest.modules.find((mod: { id: string }) => mod.id === "dev.specs")
  const node = board.workflow.nodes.find((item: { id: string }) => item.id === "dev.specs")
  for (const selected of [module.node, node]) {
    assert.deepEqual(selected.runtimePolicy.subagentConfig.customSubagentFiles,
      ["agents/explore.md", "agents/critic.md"])
    selected.runtimePolicy.subagentConfig.customSubagentFiles = ["agents/explore_spec.md", "agents/critic.md"]
  }
  assert.deepEqual(module.resources, [])
  module.resources = ["agents/explore_spec.md", "agents/critic.md"]
  assert.equal(digest(JSON.stringify(canonical(module))), AUTOBIZ_SPEC_ROLE_DEFINITION_SHA256,
    "Exact reviewed specs definition required")
  manifest.kernel.version = "1.0.3"
  const plugin = JSON.parse(files.get("plugin.json")!.bytes.toString("utf8"))
  plugin.name = "autobiz-spec-role-compatible"
  plugin.version = "1.0.3"
  plugin.description += "；规格阶段显式角色与资源归属修订 1.0.3"
  const runtime = JSON.parse(files.get("devclaw.project-runtime.json")!.bytes.toString("utf8"))
  const declaration = runtime.apiVersion === "devclaw.project-runtime/v2" ? runtime.runtime : runtime
  declaration.plugin = { id: plugin.name, version: plugin.version }
  const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + "\n")
  const changes = new Map([["board_core/board_config.json", json(board)],
    ["mods/business/manifest.json", json(manifest)], ["plugin.json", json(plugin)],
    ["devclaw.project-runtime.json", json(runtime)]])
  await mkdir(output)
  await writeDerivationFiles(output, original.files.map(file => changes.has(file.path)
    ? { ...file, bytes: changes.get(file.path)!, digest: digest(changes.get(file.path)!) } : file))
  const created = await snapshotDerivationSource(output)
  assert.equal(created.files.length, original.files.length)
  for (const file of original.files) assert.equal(created.files.find(row => row.path === file.path)?.digest,
    changes.has(file.path) ? digest(changes.get(file.path)!) : file.digest, file.path)
  assert.equal((await snapshotDerivationSource(source)).digest, original.digest)
  const receipt = { apiVersion: "devclaw.autobiz-spec-role/v1", kernelVersion: "1.0.3",
    source: resolve(source), output: resolve(output), fromDigest: original.digest, toDigest: created.digest,
    changedFiles: [...changes.keys()], changedModuleDefinition: { id: "dev.specs",
      digest: AUTOBIZ_SPEC_ROLE_DEFINITION_SHA256 }, workflowUnchangedSha256: AUTOBIZ_WORKFLOW_TARGET_SHA256,
    sourceUnchanged: true, noOverwrite: true }
  await writeFile(output + ".receipt.json", JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" })
  return receipt
}
if (process.argv[1] && resolve(process.argv[1]) === join(__dirname, "prepare-autobiz-spec-role-source.ts")) {
  assert(process.argv[2] && process.argv[3], "Explicit new output and exact 1.0.2-v2 source required")
  void prepareAutobizSpecRoleSource(resolve(process.argv[2]), resolve(process.argv[3]))
    .then(receipt => console.log(JSON.stringify(receipt)))
    .catch(error => { console.error(error); process.exitCode = 1 })
}
