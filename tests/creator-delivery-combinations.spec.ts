/** Real native modularization/assembly/contract validators; no Electron or model execution. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createAuthoringSourceBundle } from "../src/main/mods/devtools/authoring-bundle"
import { testProjectSource } from "../src/main/mods/devtools/project-contract"
import { assembleBusinessMods } from "../src/main/plugins/business-mod-assembler"
import { derivationDigest } from "../src/main/plugins/derivation-source"
import { createPluginModularizationCandidate } from "../src/main/plugins/plugin-modularization"
import { parseProjectRuntimeManifest } from "../src/shared/project-runtime"
import {
  CREATOR_DELIVERY_COMBINATIONS,
  creatorDeliveryCombination
} from "./support/creator-delivery-combinations"

async function main() {
  for (const id of CREATOR_DELIVERY_COMBINATIONS) {
    const fixture = creatorDeliveryCombination(id)
    const files = fixture.sourceFiles("http://127.0.0.1:9/retained-hook").map((file) => {
      const bytes = Buffer.from(file.text)
      return {
        path: file.path,
        bytes,
        mode: 0o644,
        digest: createHash("sha256").update(bytes).digest("hex")
      }
    })
    const snapshot = {
      root: "native-owned-combination",
      files,
      excluded: [],
      manifests: ["plugin.json"],
      totalBytes: files.reduce((sum, file) => sum + file.bytes.length, 0),
      digest: derivationDigest(files, []),
      name: `creator-raw-${id}`,
      version: "1.0.0"
    }
    assert(!files.some((file) => file.path === "devclaw.project-runtime.json"))
    const candidate = createPluginModularizationCandidate(snapshot, {
      confirmed: true,
      sourceDigest: snapshot.digest,
      catalog: fixture.catalog,
      modularizationFiles: fixture.addedFiles
    })
    for (const file of files)
      assert(candidate.files.find((value) => value.path === file.path)!.bytes.equals(file.bytes))
    const assembled = assembleBusinessMods(
      [
        {
          snapshot: { ...snapshot, files: candidate.files, digest: candidate.digest },
          catalog: candidate.catalog,
          modIds: fixture.stages.map((stage) => stage.id)
        }
      ],
      { sources: [], name: `new-independent-${id}`, version: "1.0.0" }
    )
    const runtime = parseProjectRuntimeManifest(
      JSON.parse(
        assembled.files
          .find((file) => file.path === "devclaw.project-runtime.json")!
          .bytes.toString("utf8")
      )
    )
    assert.deepEqual(
      runtime.stages.map((stage) => stage.id),
      fixture.stages.map((stage) => stage.id)
    )
    assert(runtime.stages.every((stage) => stage.approval === "human"))
    const metadata = JSON.parse(
      assembled.files.find((file) => file.path === "plugin.json")!.bytes.toString("utf8")
    )
    assert.equal(metadata.userConfig.customer.required, true)
    if (id === "middle-skill") {
      assert.match(runtime.stages[1].skill!, /refine-v2\/SKILL.md$/)
      assert(assembled.files.some((file) => file.path === "skills/refine-v1/SKILL.md"))
    }
    const bundle = createAuthoringSourceBundle(
      assembled.files.map((file) => ({ path: file.path, text: file.bytes.toString("utf8") }))
    )
    const report = await testProjectSource(bundle, runtime)
    assert.equal(report.valid, true, JSON.stringify(report))
    assert.equal(report.cases.length, fixture.stages.length * 2)
    assert(report.cases.every((value) => value.matched))
    console.log(
      `PASS ${id}: native modularization -> assembly -> every stage's missing/valid artifact contract`
    )
  }
}
main().catch((cause) => {
  console.error(cause)
  process.exitCode = 1
})
