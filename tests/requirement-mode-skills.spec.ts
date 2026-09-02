/**
 * Regression tests for requirement-mode skill visibility.
 *
 * Run:
 *   npx tsx tests/requirement-mode-skills.spec.ts
 */

import { createRequirementSkillsBackend } from "../src/main/agent/library/requirement-mode.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

type Entry = { path: string; is_dir?: boolean }

function createBackend(entriesByPath: Record<string, Entry[]>): {
  lsInfo(path: string): Promise<Entry[]>
} {
  return {
    async lsInfo(path: string): Promise<Entry[]> {
      return entriesByPath[path] ?? []
    }
  }
}

async function testConfiguredSkillsOnly(): Promise<void> {
  const source = "/skills"
  const backend = createRequirementSkillsBackend(
    createBackend({
      [source]: [
        { path: "/skills/requirement-to-prd", is_dir: true },
        { path: "/skills/code-review", is_dir: true },
        { path: "/skills/README.md", is_dir: false }
      ]
    }),
    [source],
    ["/skills/requirement-to-prd"]
  )

  const entries = await backend.lsInfo(source)
  assert(entries.length === 2, "requirement mode should retain configured skill and source files")
  assert(
    entries.some((entry: Entry) => entry.path === "/skills/requirement-to-prd"),
    "configured skill should be visible"
  )
  assert(
    !entries.some((entry: Entry) => entry.path === "/skills/code-review"),
    "unconfigured skill should be hidden"
  )
}

async function testNoConfiguredSkillsExposesNone(): Promise<void> {
  const source = "/skills"
  const backend = createRequirementSkillsBackend(
    createBackend({
      [source]: [
        { path: "/skills/requirement-to-prd", is_dir: true },
        { path: "/skills/code-review", is_dir: true }
      ]
    }),
    [source],
    []
  )

  const entries = await backend.lsInfo(source)
  assert(entries.length === 0, "a missing configured skill must not expose every skill")
}

async function testCaseDistinctSkillsRemainDistinct(): Promise<void> {
  const source = "/skills"
  const backend = createRequirementSkillsBackend(
    createBackend({
      [source]: [
        { path: "/skills/requirement-to-prd", is_dir: true },
        { path: "/skills/Requirement-To-PRD", is_dir: true }
      ]
    }),
    [source],
    ["/skills/requirement-to-prd"]
  )

  const entries = await backend.lsInfo(source)
  assert(entries.length === 1, "case-distinct unconfigured skills must remain hidden")
  assert(
    entries[0]?.path === "/skills/requirement-to-prd",
    "only the configured skill path should be visible"
  )
}

async function testNestedReadsAreUnchanged(): Promise<void> {
  const source = "/skills"
  const skillRoot = "/skills/requirement-to-prd"
  const backend = createRequirementSkillsBackend(
    createBackend({ [skillRoot]: [{ path: `${skillRoot}/SKILL.md`, is_dir: false }] }),
    [source],
    [skillRoot]
  )

  const entries = await backend.lsInfo(skillRoot)
  assert(entries.length === 1, "skill contents must remain readable after root filtering")
}

async function run(): Promise<void> {
  await testConfiguredSkillsOnly()
  console.log("PASS requirement mode exposes only configured skills")
  await testNoConfiguredSkillsExposesNone()
  console.log("PASS missing requirement skills expose none")
  await testCaseDistinctSkillsRemainDistinct()
  console.log("PASS case-distinct unconfigured skills remain hidden")
  await testNestedReadsAreUnchanged()
  console.log("PASS requirement skill contents remain readable")
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
