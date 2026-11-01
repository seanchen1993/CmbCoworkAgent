import { expect, it } from "vitest"
import { createProjectTemplate } from "../../src/main/mods/devtools/project-template"
import { nativeCompositionSchema } from "../../src/main/plugins/native-composition"
import { assertMatrixAssembly, assertMatrixOrigin, creatorProjectMatrixMode,
  matrixFirstPrompt, matrixFollowupPrompt, type MatrixCandidate, type MatrixSeed
} from "../support/creator-project-matrix"

function fixture() {
  const bundle = createProjectTemplate({ packageId: "report", name: "Report", template: "native-modular" })
  const source = nativeCompositionSchema.parse(JSON.parse(bundle.files.find(file => file.path === "composition/source.json")!.text))
  const before: MatrixCandidate = { draftId: "report", revision: 2, digest: "a".repeat(64), source,
    skills: Object.fromEntries(source.modules.map(module => [module.id, bundle.files.find(file => file.path === module.skill)!.text])) }
  const after = structuredClone(before)
  after.revision++
  after.digest = "b".repeat(64)
  const output = source.modules.at(-1)!.outputs[0]
  after.source.modules.push({ id: "audit", version: "1.0.0", title: "Audit", skill: "modules/audit/SKILL.md",
    inputs: [{ artifactId: output.id, contract: output.contract }],
    outputs: [{ id: "audit", path: "audit.json", contract: "audit/v1" }],
    checks: [{ id: "audit-check", kind: "json-schema", artifactId: "audit", schema: { type: "object", required: ["summary", "findings"], properties: { summary: { type: "string", minLength: 1 }, findings: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } } } } }],
    approval: "none", resultApproval: "human" })
  after.skills.audit = "audit"
  return { before, after }
}
it("accepts additive assembly and rejects changed identity, contracts, skills and settings", () => {
  const { before, after } = fixture()
  expect(() => assertMatrixAssembly(before, after)).not.toThrow()
  for (const change of [
    (value: MatrixCandidate) => { value.draftId = "another" },
    (value: MatrixCandidate) => { value.revision = before.revision },
    (value: MatrixCandidate) => { value.skills.draft = "overwritten" },
    (value: MatrixCandidate) => { value.source.modules[0].checks = [] },
    (value: MatrixCandidate) => { value.source.environment.push({ id: "extra", description: "extra", required: true }) }
  ]) {
    const changed = structuredClone(after)
    change(changed)
    expect(() => assertMatrixAssembly(before, changed)).toThrow()
  }
})
it("requires successful exact installed derivation evidence and preserves initial stages", () => {
  const { before, after } = fixture()
  const seed: MatrixSeed = { ...before, installedPluginId: "installed-1", name: "Report", directory: "unused", origin: "installed-reference-fixture" }
  const trace = [{ id: "call", request: { action: "project_from_plugin", pluginId: seed.installedPluginId }, response: { ok: true } }]
  expect(() => assertMatrixOrigin("report-derived", before, seed, trace, [])).not.toThrow()
  expect(() => assertMatrixOrigin("report-derived", after, seed, trace, [])).toThrow()
  expect(() => assertMatrixOrigin("report-derived", before, seed, trace, [{ id: "call" }])).toThrow()
  expect(() => assertMatrixOrigin("report-derived", before, seed, [{ ...trace[0], response: undefined }], [])).toThrow()
  expect(() => assertMatrixOrigin("report-derived", before, seed, [], [])).toThrow()
})
it("uses bounded declared modes and explicit model-authored source boundaries", () => {
  const { before } = fixture()
  expect(() => creatorProjectMatrixMode("fake")).toThrow()
  expect(matrixFirstPrompt("autobiz-from-zero")).toContain("不能派生或读取现有AutoBiz项目作者源码")
  expect(matrixFollowupPrompt(before)).toContain(before.draftId)
  expect(matrixFollowupPrompt(before)).toContain("其他所有阶段、Skill")
})

it("requires the sample provider's additive stage mapping without changing old knowledge or identity", () => {
  const { before, after } = fixture()
  before.source.contextAction = { id: "knowledge.context", provider: { plugin: "knowledge", actionId: "context" }, input: {},
    config: { stageTags: { draft: ["baseline"], review: ["delivery", "archive"] } } }
  after.source.contextAction = structuredClone(before.source.contextAction)
  expect(() => assertMatrixAssembly(before, after, "autobiz-derived")).toThrow("STAGE_MAPPING_REQUIRED:audit")
  const context = after.source.contextAction
  context.config!.stageTags = { draft: ["baseline"], review: ["delivery", "archive"], audit: ["delivery", "archive"] }
  expect(() => assertMatrixAssembly(before, after, "autobiz-derived")).not.toThrow()
  const extra = structuredClone(after)
  extra.source.contextAction!.config!.stageTags = { draft: ["baseline"], review: ["delivery", "archive"], audit: ["delivery", "archive", "audit"] }
  expect(() => assertMatrixAssembly(before, extra, "autobiz-derived")).not.toThrow()
  for (const change of [
    (value: MatrixCandidate) => { value.source.contextAction!.provider.plugin = "unreviewed" },
    (value: MatrixCandidate) => { value.source.contextAction!.config!.stageTags = { draft: ["changed"], review: ["delivery", "archive"], audit: ["delivery", "archive"] } },
    (value: MatrixCandidate) => { value.source.contextAction!.config!.stageTags = { draft: ["baseline"], review: ["delivery", "archive"], audit: ["delivery"] } },
    (value: MatrixCandidate) => { value.source.contextAction!.config!.stageTags = { draft: ["baseline"], review: ["delivery", "archive"], audit: ["audit"] } }
  ]) {
    const changed = structuredClone(after)
    change(changed)
    expect(() => assertMatrixAssembly(before, changed, "autobiz-derived")).toThrow()
  }
})
