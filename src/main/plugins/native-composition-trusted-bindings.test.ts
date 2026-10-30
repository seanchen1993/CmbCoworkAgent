import { afterEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { ClawActionDescriptor } from "../../shared/mods/claw-actions"
import { compileNativeComposition, nativeCompositionSchema } from "./native-composition"
import { runtimeDigest } from "../harness-board/project-runtime/safe-files"
import { createAuthoringSourceBundle } from "../mods/devtools/authoring-bundle"
import { inspectProjectSource } from "../mods/devtools/project-doctor"
import { parseProjectRuntimeManifest } from "../../shared/project-runtime"
import { hostProjectFixture } from "../harness-board/project-runtime/host-fixtures.test-helper"
import { inspectHostPlanMigration } from "../harness-board/project-runtime/plan-migration"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const source = nativeCompositionSchema.parse({
    apiVersion: "devclaw.native-composition/v1",
    plugin: { id: "generic-review", version: "2.0.0", title: "Review", description: "Review" },
    resources: ["workflows/check.js", "tests/project-contract.json"], environment: [],
    modules: [{ id: "review", version: "1.0.0", title: "Review", skill: "modules/review/SKILL.md",
      inputs: [], outputs: [{ id: "report", path: "report.json", contract: "review/v1" }],
      checks: [
        { id: "evidence", artifactId: "report", kind: "action", format: "artifact-reference-v1",
          maxBytes: 28000, provider: { plugin: "proof", actionId: "verify" },
          bindProviderIdentity: "self", requestProvenance: "project-goal/v1",
          bindCheckProviderIdentities: { rules: { checkId: "business", actionId: "inspect" } },
          bindResourceDigests: { workflow: "workflows/check.js" } },
        { id: "business", artifactId: "report", kind: "action", format: "artifact-reference-v1",
          maxBytes: 28000, provider: { plugin: "policy", actionId: "verify" } }
      ] }]
  })
  const descriptor = (plugin: string, actionId: string): ClawActionDescriptor => ({
    plugin, actionId, pluginId: "installed-" + plugin, digest: (plugin === "proof" ? "a" : "b").repeat(64),
    name: actionId, platform: { id: "review", version: "1.0.0", action: actionId },
    inputSchema: { type: "object" }, outputSchema: { type: "object" }
  })
  const catalog = [descriptor("proof", "verify"), descriptor("policy", "verify"), descriptor("policy", "inspect")]
  const files = [
    { path: "modules/review/SKILL.md", bytes: Buffer.from("---\nname: review\ndescription: Review\n---\nReview.") },
    { path: "workflows/check.js", bytes: Buffer.from("// 原始资源\r\nreturn true\n") },
    { path: "tests/project-contract.json", bytes: Buffer.from(JSON.stringify({
      apiVersion: "devclaw.project-contract/v1",
      cases: [{ id: "missing", stageId: "review", files: [], expected: "failed" }]
    })) }
  ]
  const evidence = source.modules[0].checks[0]
  const business = source.modules[0].checks[1]
  if (evidence.kind !== "action" || business.kind !== "action") throw Error("fixture")
  return { source, files, catalog, evidence, business,
    compile: () => compileNativeComposition(source, { files, actionCatalog: catalog }) }
}

describe("native composition trusted bindings", () => {
  it("binds forward sibling identities and exact declared bytes and survives actual doctor replay", () => {
    const f = fixture()
    const result = f.compile()
    expect(result.actionLock.bindings[0]).toMatchObject({
      requestProvenance: "project-goal/v1",
      config: {
        self: { pluginId: "installed-proof", plugin: "proof", digest: "a".repeat(64), actionId: "verify" },
        rules: { pluginId: "installed-policy", plugin: "policy", digest: "b".repeat(64), actionId: "inspect" },
        workflow: runtimeDigest(f.files[1].bytes)
      }
    })
    const bundle = createAuthoringSourceBundle(result.files.map((file) => ({
      path: file.path, text: file.bytes.toString("utf8")
    })))
    const report = inspectProjectSource(bundle, [], f.catalog).report
    expect(report.valid, JSON.stringify(report)).toBe(true)
    const before = result.actionLock.bindings[0].config.workflow
    f.files[1].bytes = Buffer.from("// 原始资源\nreturn true\n")
    expect(f.compile().actionLock.bindings[0].config.workflow).not.toBe(before)
  })

  it("rejects missing, ambiguous, cross-installation and cross-digest siblings", () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.catalog.pop() },
      (f: ReturnType<typeof fixture>) => { f.catalog.push({ ...f.catalog[2] }) },
      (f: ReturnType<typeof fixture>) => { f.catalog[2].pluginId = "other-installation" },
      (f: ReturnType<typeof fixture>) => { f.catalog[2].digest = "c".repeat(64) }
    ]) {
      const f = fixture()
      mutate(f)
      expect(() => f.compile()).toThrow("NATIVE_COMPOSITION_PROVIDER_CONTRACT_MISMATCH")
    }
  })

  it("validates sibling schemas and generated config against the consuming action schema", () => {
    const f = fixture()
    f.catalog[2].inputSchema = { type: "object", unsupportedKeyword: true }
    expect(() => f.compile()).toThrow("NATIVE_COMPOSITION_PROVIDER_CONTRACT_MISMATCH")
    f.catalog[2].inputSchema = { type: "object" }
    f.catalog[0].configSchema = { type: "object", additionalProperties: false, properties: {} }
    expect(() => f.compile()).toThrow("NATIVE_COMPOSITION_PROVIDER_CONTRACT_MISMATCH")
  })

  it("rejects undeclared checks/resources and all generated-key or provenance overrides", () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.evidence.bindCheckProviderIdentities!.rules.checkId = "missing" },
      (f: ReturnType<typeof fixture>) => { f.evidence.bindCheckProviderIdentities!.rules.checkId = "shape"
        f.source.modules[0].checks.push({ id: "shape", kind: "json-schema", artifactId: "report", schema: { type: "object" } }) },
      (f: ReturnType<typeof fixture>) => { f.evidence.bindResourceDigests!.workflow = "modules/review/SKILL.md" },
      (f: ReturnType<typeof fixture>) => { f.evidence.config = { rules: {} } },
      (f: ReturnType<typeof fixture>) => { f.evidence.bindResourceDigests = { rules: "workflows/check.js" } },
      (f: ReturnType<typeof fixture>) => { f.evidence.config = { requestProvenance: { sha256: "forged" } } }
    ]) {
      const f = fixture()
      mutate(f)
      expect(() => f.compile()).toThrow("NATIVE_COMPOSITION_PROVIDER_CONTRACT_MISMATCH")
    }
  })

  it("does not interpret reciprocal identity references as execution dependencies", () => {
    const f = fixture()
    f.business.bindCheckProviderIdentities = { proof: { checkId: "evidence", actionId: "verify" } }
    expect(f.compile().actionLock.bindings[1].config.proof).toMatchObject({ plugin: "proof" })
  })

  it("makes provenance an opt-in reference contract and rejects incompatible provider input", () => {
    const f = fixture()
    f.evidence.format = "json"
    expect(() => f.compile()).toThrow("NATIVE_COMPOSITION_REQUEST_PROVENANCE_CHECK_ONLY")
    f.evidence.format = "artifact-reference-v1"
    f.catalog[0].inputSchema = { type: "object", additionalProperties: false,
      properties: Object.fromEntries(["protocol", "projectId", "stageId", "version", "pluginDigest",
        "workspaceIdentity", "current", "sources"].map((key) => [key, {}])) }
    expect(() => f.compile()).toThrow("NATIVE_COMPOSITION_PROVIDER_CONTRACT_MISMATCH")
    delete f.evidence.requestProvenance
    expect(f.compile().actionLock.bindings[0]).not.toHaveProperty("requestProvenance")
  })

  it("replays retained sibling schemas for a future Skill migration without granting catalog access", () => {
    const f = fixture()
    const root = mkdtempSync(join(tmpdir(), "native-trusted-migration-"))
    roots.push(root)
    const save = (name: string) => {
      const compiled = f.compile()
      const directory = join(root, name)
      for (const file of compiled.files) {
        const path = join(directory, file.path)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, file.bytes)
      }
      return { compiled, directory, manifest: parseProjectRuntimeManifest(compiled.runtime) }
    }
    const original = save("original")
    f.files[0].bytes = Buffer.from(f.files[0].bytes.toString() + "\nUse the revised review instructions.")
    const revised = save("revised")
    expect(original.compiled.lock.providerContracts).toHaveLength(1)
    const state = { ...hostProjectFixture(root), packageId: "generic-review", stageIndex: 0,
      status: "active" as const, manifest: original.manifest }
    expect(inspectHostPlanMigration(state, revised.manifest, original.directory, revised.directory)
      .remainingStageIds).toEqual(["review"])
    // A persisted snapshot is deliberately not consulted by fresh/live compilation.
    f.catalog.pop()
    expect(() => f.compile()).toThrow("NATIVE_COMPOSITION_PROVIDER_CONTRACT_MISMATCH")
    const changed = structuredClone(revised.compiled.lock)
    changed.providerContracts![0].digest = "d".repeat(64)
    writeFileSync(join(revised.directory, "composition/lock.json"), JSON.stringify(changed) + "\n")
    expect(() => inspectHostPlanMigration(state, revised.manifest, original.directory, revised.directory))
      .toThrow("PLAN_MIGRATION_AUTHOR_SOURCE_INVALID")
  })
})
