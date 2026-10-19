import { createHash } from "node:crypto"
import { expect, it } from "vitest"
import type { BusinessModCatalog, BusinessModDefinition } from "../../shared/business-mods"
import type { DerivationSnapshot } from "./derivation-source"
import { assembleBusinessMods } from "./business-mod-assembler"
import { assertProjectAgentResourceClosure, projectNodeAgentResources } from "./project-agent-resources"

const node = (files: unknown) => ({ runtimePolicy: { subagentConfig: { customSubagentFiles: files } } })
const body = Buffer.from("---\nname: explicit-agent\n---\nRead the actual source.\n")
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
function mod(id: string, agent?: string): BusinessModDefinition {
  return { id, title: id, node: { id, skill: id, checkpoints: [`${id}_in_progress`, `${id}_done`],
    ...(agent ? node([agent]) : {}) }, skill: { entry: `skills/${id}/SKILL.md`, resources: [] },
    resources: [], dependencies: { required: [], advisory: [] }, checks: { validators: [], guards: [] } }
}
function source(catalog: BusinessModCatalog, assets: Record<string, Buffer> = {}) {
  const files = Object.entries({
    "plugin.json": Buffer.from(JSON.stringify({ name: "source", version: "1.0.0" })),
    "board_core/board_config.json": Buffer.from(JSON.stringify({ workflow: { nodes: [], skipPolicy: { lockedNodes: [] } } })),
    "hooks/check.py": Buffer.from("# shared checker"),
    ...Object.fromEntries(catalog.modules.map(item => [item.skill.entry, Buffer.from(`# ${item.id}`)])), ...assets
  }).map(([path, bytes]) => ({ path, bytes, digest: sha(bytes), mode: 0o644 }))
  const snapshot: DerivationSnapshot = { root: "/virtual/source", name: "source", files,
    digest: "a".repeat(64), excluded: [], totalBytes: files.reduce((sum, file) => sum + file.bytes.length, 0),
    manifests: ["plugin.json"] }
  return { snapshot, catalog, modIds: catalog.modules.map(item => item.id) }
}
const kernel = { id: "fixture.kernel", version: "1.0.0", resources: ["hooks/check.py"], boardConfigPath: "board_core/board_config.json" }
const request = { name: "assembled-agent-closure", version: "1.0.0", sources: [] }

it("uses only explicit main and dynamic node agent references", () => {
  const board = { workflow: { nodes: [node(["agents/a.md"])], dynamicStages: [
    { nodes: [node(["agents/b.md"])] }
  ] } }
  expect(assertProjectAgentResourceClosure(board, () => body)).toEqual(["agents/a.md", "agents/b.md"])
  expect(projectNodeAgentResources({ description: "Use agents/inferred.md" })).toEqual([])
  expect(() => assertProjectAgentResourceClosure(board, path => path.endsWith("a.md") ? body : undefined))
    .toThrow("PROJECT_AGENT_RESOURCE_MISSING: agents/b.md")
})

it.each([
  null, "agents/a.md", [null], ["../agent.md"], ["/outside.md"], ["C:/outside.md"],
  ["agents/../outside.md"], ["agents/a.js"], ["agents/a.md", "agents/A.md"],
  [".env/private.md"], Array(257).fill("agents/a.md")
].map(files => ({ files })))("rejects malformed, unbounded or unsafe explicit agent references: %j", ({ files }) => {
  expect(() => projectNodeAgentResources(node(files))).toThrow("PROJECT_AGENT_")
})

it("requires an exact readable Markdown file, never a directory prefix or empty placeholder", () => {
  const board = { workflow: { nodes: [node(["agents/a.md"])] } }
  for (const bytes of [undefined, Buffer.alloc(0), Buffer.from("  "), Buffer.alloc(256 * 1024 + 1)])
    expect(() => assertProjectAgentResourceClosure(board, () => bytes)).toThrow("PROJECT_AGENT_RESOURCE_")
  expect(() => assertProjectAgentResourceClosure(board, () => Buffer.from([0xff])))
    .toThrow()
})

it("closes a selected node's source-owned agent dependency without copying unrelated agents", () => {
  const selected = source({ apiVersion: "devclaw.business-mods/v1", kind: "catalog", kernel,
    modules: [mod("specs", "agents/explore.md")] }, {
    "agents/explore.md": body, "agents/unselected.md": Buffer.from("Must stay unselected")
  })
  const result = assembleBusinessMods([selected], request)
  expect(result.files.find(file => file.path === "agents/explore.md")?.bytes).toEqual(body)
  expect(result.files.some(file => file.path === "agents/unselected.md")).toBe(false)
  const lock = JSON.parse(result.files.find(file => file.path === "devclaw.business-assembly.json")!.bytes.toString())
  expect(lock.files).toContainEqual({ path: "agents/explore.md", digest: sha(body) })
  selected.snapshot.files = selected.snapshot.files.filter(file => file.path !== "agents/explore.md")
  expect(() => assembleBusinessMods([selected], request)).toThrow("PROJECT_AGENT_RESOURCE_MISSING")
})

it("preserves custom Mod namespaces and never borrows an agent from another source", () => {
  const main = source({ apiVersion: "devclaw.business-mods/v1", kind: "catalog", kernel,
    modules: [mod("base")] }, { "agents/foreign.md": body })
  const custom = source({ apiVersion: "devclaw.business-mods/v1", kind: "catalog", kernelRef: {
    id: kernel.id, version: kernel.version }, modules: [mod("user.check", "mods/business/user.check/agent.md")] }, {
    "mods/business/user.check/agent.md": body
  })
  expect(assembleBusinessMods([main, custom], request).files.some(file =>
    file.path === "mods/business/user.check/agent.md")).toBe(true)
  custom.catalog.modules[0].node.runtimePolicy = node(["agents/foreign.md"]).runtimePolicy
  expect(() => assembleBusinessMods([main, custom], request)).toThrow("PROJECT_AGENT_RESOURCE_MISSING")
  custom.snapshot.files.push({ path: "agents/foreign.md", bytes: body, digest: sha(body), mode: 0o644 })
  expect(() => assembleBusinessMods([main, custom], request)).toThrow("业务 Mod 资源必须位于自己的命名空间")
})
