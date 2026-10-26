import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { adaptLegacyImport } from "./legacy-import-adapter"
import { hostProjectFixture } from "./host-fixtures.test-helper"

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "legacy-adapter-"))
  roots.push(root)
  const source = join(root, "source"),
    target = join(root, "target")
  mkdirSync(source)
  mkdirSync(target)
  writeFileSync(join(source, "state.json"), JSON.stringify({ feature: "done" }))
  const descriptor = {
    protocol: "devclaw.legacy-import-adapter/v1",
    adapters: [
      {
        id: "docs",
        title: "Docs",
        sourcePackageIds: ["docs"],
        parameters: [],
        checkpoint: { sourcePath: "state.json", pointers: [["feature"]] },
        stablePoints: [{ value: "done", prefixStageIds: ["draft"], reexecuteStageIds: [] }],
        artifacts: [
          {
            artifactId: "document",
            stageId: "draft",
            fields: {},
            files: [],
            trees: [{ sourcePath: "tree", targetPrefix: "tree", suffix: ".md", optional: false }]
          }
        ]
      }
    ]
  }
  const snapshot = {
    root: target,
    digest: "a".repeat(64),
    manifest: hostProjectFixture(target).manifest
  }
  const input = {
    sourceProjectId: "old",
    target: {
      projectId: "new",
      name: "Imported",
      workspace: target,
      installedPluginId: "target",
      goal: "Import"
    },
    adapterId: "docs",
    parameters: {}
  }
  const run = () => {
    writeFileSync(join(target, "devclaw.legacy-import.json"), JSON.stringify(descriptor))
    return adaptLegacyImport(snapshot, source, "docs", input)
  }
  return { root, source, target, descriptor, snapshot, input, run }
}
it("bounds all traversed entries including files which cannot match the declared suffix", () => {
  const f = fixture()
  mkdirSync(join(f.source, "tree"))
  for (let d = 0; d < 9; d++) {
    const dir = join(f.source, "tree", `dir${d}`)
    mkdirSync(dir)
    for (let i = 0; i < 240; i++) writeFileSync(join(dir, `${i}.ignored`), "")
  }
  expect(f.run).toThrow("IMPORT_ADAPTER_LIMIT")
})
it("bounds empty directories before any file is read", () => {
  const f = fixture()
  mkdirSync(join(f.source, "tree"))
  for (let d = 0; d < 20; d++) {
    const dir = join(f.source, "tree", `dir${d}`)
    mkdirSync(dir)
    for (let i = 0; i < 20; i++) mkdirSync(join(dir, `${i}`))
  }
  expect(f.run).toThrow("IMPORT_ADAPTER_LIMIT")
})
it("uses the actual AutoBiz descriptor to preserve design/plan bytes and reexecute incompatible upstream history", () => {
  const f = fixture()
  const descriptor = JSON.parse(
    readFileSync("resources/native-compositions/autobiz-import/devclaw.legacy-import.json", "utf8")
  )
  writeFileSync(join(f.target, "devclaw.legacy-import.json"), JSON.stringify(descriptor))
  const base = join(f.source, ".autobizdevops/features/example")
  mkdirSync(base, { recursive: true })
  writeFileSync(
    join(f.source, ".autobizdevops/state.json"),
    JSON.stringify({ features: { example: { checkpoint: "plan_done" } } })
  )
  const original = {
    "PRD.md": "Old PRD without any normalized source marker",
    "UI_CONTEXT.json": "Original single UI snapshot",
    "proposal.md": "Original proposal",
    "design.md": "Original design",
    ".design-contract.lock.json": "Original locked bytes unchanged",
    "plan.json": "Original task references unchanged",
    "PLAN.md": "Original plan narrative"
  }
  for (const [path, text] of Object.entries(original)) writeFileSync(join(base, path), text)
  const ids = ["convert", "prd", "specs", "design", "plan"]
  f.snapshot.manifest.stages = ids.map((id) => ({
    ...f.snapshot.manifest.stages[0],
    id,
    artifactIds: [id === "convert" ? "normalized" : id]
  }))
  f.snapshot.manifest.artifacts = ids.map((id) => ({
    id: id === "convert" ? "normalized" : id,
    path: id + ".bundle.json",
    required: true
  }))
  const result = adaptLegacyImport(f.snapshot, f.source, "autobiz-converted-requirements", {
    ...f.input,
    adapterId: "autobiz-documents",
    parameters: { feature: "example" }
  })
  expect(result.adaptation.reexecuteStageIds).toEqual(["convert", "prd", "specs"])
  expect([...result.outputs.keys()]).toEqual([
    "design.bundle.json",
    "plan.bundle.json",
    ".devclaw/import-source.json"
  ])
  expect(
    JSON.parse(result.outputs.get("design.bundle.json")!.toString()).files[
      ".design-contract.lock.json"
    ]
  ).toBe(original[".design-contract.lock.json"])
  expect(JSON.parse(result.outputs.get("plan.bundle.json")!.toString()).files).toEqual({
    "plan.json": original["plan.json"]
  })
  const material = JSON.parse(result.outputs.get(".devclaw/import-source.json")!.toString())
  expect(material.files[".autobizdevops/features/example/PRD.md"]).toBe(original["PRD.md"])
  expect(material.files[".autobizdevops/features/example/PLAN.md"]).toBe(original["PLAN.md"])
  expect(() =>
    adaptLegacyImport(f.snapshot, f.source, "unregistered-original", {
      ...f.input,
      adapterId: "autobiz-documents",
      parameters: { feature: "example" }
    })
  ).toThrow("UNAVAILABLE")
  writeFileSync(
    join(f.source, ".autobizdevops/state.json"),
    JSON.stringify({ features: { example: { checkpoint: "code_done" } } })
  )
  expect(() =>
    adaptLegacyImport(f.snapshot, f.source, "autobiz-converted-requirements", {
      ...f.input,
      adapterId: "autobiz-documents",
      parameters: { feature: "example" }
    })
  ).toThrow("CHECKPOINT_UNSUPPORTED")
})

it.each(["parameters", "stablePoints", "artifacts"])(
  "rejects ambiguous duplicate adapter %s",
  (kind) => {
    const f = fixture()
    const adapter = f.descriptor.adapters[0]
    if (kind === "parameters") {
      Object.assign(adapter, {
        parameters: [
          { id: "feature", label: "Feature" },
          { id: "feature", label: "Duplicate" }
        ]
      })
    } else if (kind === "stablePoints")
      adapter.stablePoints.push(structuredClone(adapter.stablePoints[0]))
    else adapter.artifacts.push(structuredClone(adapter.artifacts[0]))
    expect(f.run).toThrow("IMPORT_ADAPTER_INVALID")
  }
)

it("stops a large single directory at the bounded streaming admission", () => {
  const f = fixture()
  mkdirSync(join(f.source, "tree"))
  for (let i = 0; i < 257; i++) writeFileSync(join(f.source, "tree", `${i}.ignored`), "")
  expect(f.run).toThrow("IMPORT_ADAPTER_LIMIT")
})
it.each(["one-bundle", "all-recipes"])(
  "bounds repeated source expansion before constructing unbounded output (%s)",
  (mode) => {
    const f = fixture()
    writeFileSync(join(f.source, "repeat.txt"), "\u0000".repeat(128 * 1024))
    const adapter = f.descriptor.adapters[0]
    if (mode === "one-bundle") {
      Object.assign(adapter.artifacts[0], {
        trees: [],
        files: Array.from({ length: 24 }, (_, index) => ({
          sourcePath: "repeat.txt",
          path: `copy-${index}.txt`
        }))
      })
    } else {
      Object.assign(adapter.stablePoints[0], { reexecuteStageIds: ["draft"] })
      Object.assign(adapter, {
        artifacts: Array.from({ length: 48 }, (_, index) => ({
          artifactId: `copy-${index}`,
          stageId: "draft",
          fields: {},
          trees: [],
          files: [
            { sourcePath: "repeat.txt", path: "one.txt" },
            { sourcePath: "repeat.txt", path: "two.txt" }
          ]
        }))
      })
    }
    expect(f.run).toThrow("IMPORT_ADAPTER_LIMIT")
  }
)
it("preserves a UTF-8 BOM in original bundle text instead of silently changing locked bytes", () => {
  const f = fixture()
  mkdirSync(join(f.source, "tree"))
  const original = "\uFEFForiginal design bytes\n"
  writeFileSync(join(f.source, "tree/design.md"), original)
  const adapted = f.run()
  expect(JSON.parse(adapted.outputs.get("document.md")!.toString()).files["tree/design.md"]).toBe(
    original
  )
})
