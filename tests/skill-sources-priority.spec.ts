/**
 * Regression tests for runtime skill source precedence.
 *
 * Run:
 *   npx tsx tests/skill-sources-priority.spec.ts
 */

import { combineSkillMiddlewareSources } from "../src/main/agent/skill-sources.ts"

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

function run(): void {
  const standalone = ["C:/app/skills", "C:/Users/demo/.cmbcoworkagent/skills"]
  const plugin = ["C:/Users/demo/.cmbcoworkagent/plugins/demo/skills"]
  const combined = combineSkillMiddlewareSources(standalone, plugin)

  assert(
    combined.join("|") === [...plugin, ...standalone].join("|"),
    `plugin sources should be loaded before standalone sources so standalone wins same-name collisions: ${combined.join(",")}`
  )

  console.log("PASS skill middleware source priority keeps standalone skills last")
}

run()
