/**
 * Regression tests for plugin skill source discovery.
 *
 * Run:
 *   npx tsx tests/plugin-skill-sources.spec.ts
 */

import { mkdir, mkdtemp, writeFile } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import { getPluginSkillSearchSources } from "../src/main/plugins/manifest.ts"

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

async function writeSkill(dir: string, name: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: test skill\n---\n`,
    "utf-8"
  )
}

async function run(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "plugin-skill-sources-"))
  await writeSkill(root, "root-skill")
  await writeSkill(join(root, "skills", "default-skill"), "default-skill")
  await writeSkill(join(root, "custom-skills", "manifest-skill"), "manifest-skill")

  const sources = getPluginSkillSearchSources(root, {
    name: "demo-plugin",
    skills: "custom-skills"
  })
  const byRelPath = new Map(sources.map((source) => [source.relPath, source]))

  assert(byRelPath.has("custom-skills"), "manifest skills path should be included")
  assert(byRelPath.has("skills"), "default skills/ path should still be included")
  assert(byRelPath.get(".")?.maxDepth === 0, "root SKILL.md should be included root-only")

  console.log("PASS plugin manifest skills supplement default discovery")
}

void run()
