import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import {
  createClawSkillPolicy,
  createFlowSkillSourceResolver,
  listClawSkillSources
} from "../src/main/mods/claw-skills"

async function main() {
  const folder = mkdtempSync(join(tmpdir(), "cmb-claw-perf-"))
  const results: Record<string, unknown> = {
    scope:
      "512 local small SKILL.md files; no model or network latency; no machine-specific threshold"
  }
  let scans = 0
  const access = {
    sources: async () => {
      scans++
      return [{ sourceDir: folder }]
    },
    currentSources: () => [{ sourceDir: folder }],
    disabledDirs: () => []
  }
  try {
    for (let index = 0; index < 512; index++) {
      const skill = join(folder, `skill-${index}`)
      mkdirSync(skill)
      writeFileSync(
        join(skill, "SKILL.md"),
        `---\nname: skill-${index}\ndescription: Performance fixture\n---\nBody`
      )
    }
    const before = performance.now()
    assert.equal(await createClawSkillPolicy(undefined, access), undefined)
    assert.equal(await createClawSkillPolicy({ mode: "all", items: [] }, access), undefined)
    results.inheritedTwoCallsMs = performance.now() - before
    assert.equal(scans, 0)
    const catalogStart = performance.now()
    const sources = await listClawSkillSources(access)
    results.catalogMs = performance.now() - catalogStart
    assert.equal(sources.length, 512)
    const policyStart = performance.now()
    const policy = (await createClawSkillPolicy({ mode: "selected", items: sources }, access))!
    results.policyMs = performance.now() - policyStart
    const samples: number[] = []
    for (let index = 0; index < 5; index++) {
      const started = performance.now()
      policy.assertAllCurrent()
      samples.push(performance.now() - started)
    }
    results.modelBoundary512SamplesMs = samples
    results.modelBoundary512MedianMs = [...samples].sort((a, b) => a - b)[2]
    assert.equal(scans, 2, "Model boundaries must not rediscover the entire source directory")
    results.directoryScans = scans
    const flowStart = performance.now()
    const scansBeforeFlow = scans
    const resolveSource = await createFlowSkillSourceResolver(() => undefined, access)
    const nodes = Array.from({ length: 64 }, () => resolveSource(sources[0]))
    results.flow64SameSourcePrepareMs = performance.now() - flowStart
    assert.equal(scans - scansBeforeFlow, 1, "64 nodes in one run must share one catalog scan")
    const flowSamples: number[] = []
    for (let index = 0; index < 5; index++) {
      const started = performance.now()
      for (const node of nodes) node.assertCurrent()
      flowSamples.push(performance.now() - started)
    }
    assert.equal(scans - scansBeforeFlow, 1, "Node rechecks must not rediscover the catalog")
    results.flowDirectoryScans = scans - scansBeforeFlow
    results.flow64SameSourceBoundarySamplesMs = flowSamples
    results.flow64SameSourceBoundaryMedianMs = [...flowSamples].sort((a, b) => a - b)[2]
    writeFileSync(nodes[0].trustedExplicitSkill.path, "changed after flow preparation")
    assert.throws(() => nodes[0].assertCurrent(), /SOURCE_CHANGED/)
    assert.throws(() => resolveSource(sources[0]), /SOURCE_CHANGED/)
    results.stalePinRejected = true
    const output = resolve("output/mods-claw-sources-performance.json")
    writeFileSync(output, JSON.stringify(results, null, 2))
    console.log(JSON.stringify(results))
  } finally {
    assert(resolve(folder).startsWith(resolve(tmpdir()) + sep + "cmb-claw-perf-"))
    rmSync(folder, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
