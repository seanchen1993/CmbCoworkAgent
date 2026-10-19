import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import type { CompositionRun } from "../../../shared/project-runtime/composition-api"
import { runtimeDigest } from "./safe-files"
import { readCompositionArtifact } from "./composition-artifact"
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
it("reads only proof-bound artifacts, rejects replaced files and never executes markup", () => {
  const root = mkdtempSync(join(tmpdir(), "composition-artifact-")); roots.push(root)
  const content = "<script>must remain text</script>"
  writeFileSync(join(root, "result.md"), content)
  const definition: CompositionRun["definition"] = { apiVersion: "devclaw.project-composition/v1",
    parentProjectId: "parent", workspace: root, units: [{ id: "first", kind: "flow",
      source: { pluginId: "installed", capabilityId: "flow", packageDigest: "a".repeat(64) },
      inputs: [], outputs: [{ id: "result", path: "result.md" }] }] }
  const run: CompositionRun = { id: "run", requestId: "request", version: 1, definition,
    definitionDigest: "a".repeat(64), status: "failed", createdAt: 1, updatedAt: 1,
    units: [{ id: "first", status: "succeeded", proof: { kind: "flow-completed", engineRunId: "first",
      evidenceDigest: "b".repeat(64), artifacts: [{ id: "result", path: "result.md", digest: runtimeDigest(content) }] } }] }
  expect(readCompositionArtifact(run, "first", "result", () => root).content).toBe(content)
  expect(() => readCompositionArtifact(run, "first", "../outside", () => root)).toThrow("UNVERIFIED")
  expect(() => readCompositionArtifact(run, "first", "result", () => undefined)).toThrow("UNAVAILABLE")
  writeFileSync(join(root, "result.md"), "replaced")
  expect(() => readCompositionArtifact(run, "first", "result", () => root)).toThrow("CHANGED")
  const binary = Buffer.from([0, 1, 2])
  writeFileSync(join(root, "result.md"), binary)
  run.units[0].proof!.artifacts[0].digest = runtimeDigest(binary)
  expect(readCompositionArtifact(run, "first", "result", () => root).content).toBeNull()
  run.units[0].status = "failed"
  expect(() => readCompositionArtifact(run, "first", "result", () => root)).toThrow("UNVERIFIED")
})
