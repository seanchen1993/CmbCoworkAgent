/**
 * Unit tests for Claude Code-compatible hooks in SKILL.md YAML frontmatter.
 *
 * Run:
 *   npx tsx tests/skill-frontmatter-hooks.spec.ts
 */

import { mkdir, mkdtemp, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { parseSkillFrontmatter } from "../src/main/skills/frontmatter.ts"
import { parseSkillFrontmatterHooks } from "../src/main/storage.ts"

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

async function withTempDir<T>(name: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), `${name}-`))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function testNestedYamlFrontmatterParsesHooks(): Promise<void> {
  const content = `---
name: demo-skill
description: demo
hooks:
  PreToolUse:
    - matcher: execute
      hooks:
        - id: audit
          type: command
          command: node ./hooks/audit.js
          timeout: 30
          timeoutMs: 1234
          enabled: true
          once: true
          persistAfterInterrupt: true
          forcedOutcome: always-revise
          forcedReason: 需要按技能规范修订
          onBlock:
            reason: 命令不符合规范
            systemMessage: 技能 Hook 已阻断
            additionalContext: 请重新生成命令
            requiredSkill: demo-skill
  PostSkillUse:
    - hooks:
        - id: final-check
          type: prompt
          prompt: 检查是否遵循技能要求
          model: fast-model
          fallback: block
---

# Demo
`

  const parsed = parseSkillFrontmatter(content)
  assert(parsed.frontmatter.name === "demo-skill", "name should parse from YAML frontmatter")
  assert(
    parsed.frontmatter.hooks && typeof parsed.frontmatter.hooks === "object",
    "nested hooks should parse as an object"
  )
}

async function testFrontmatterHooksBecomeHookConfigs(): Promise<void> {
  await withTempDir("skill-frontmatter-hooks", async (dir) => {
    const skillDir = join(dir, "demo-skill")
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---
name: demo-skill
description: demo
hooks:
  PreToolUse:
    - matcher: execute
      hooks:
        - id: audit
          type: command
          command: node ./hooks/audit.js
          timeout: 30
          timeoutMs: 1234
          once: true
          persistAfterInterrupt: true
          forcedOutcome: always-revise
          forcedReason: 需要按技能规范修订
          onBlock:
            reason: 命令不符合规范
            systemMessage: 技能 Hook 已阻断
            additionalContext: 请重新生成命令
            requiredSkill: demo-skill
  PostSkillUse:
    - hooks:
        - id: final-check
          type: prompt
          prompt: 检查是否遵循技能要求
          modelId: local-fast
          fallback: block
---

# Demo
`,
      "utf8"
    )

    const hooks = parseSkillFrontmatterHooks(skillDir, "demo-skill")
    assert(hooks.length === 2, `expected two hooks from frontmatter, got ${hooks.length}`)

    const pre = hooks.find((hook) => hook.event === "PreToolUse")
    assert(pre !== undefined, "PreToolUse hook should exist")
    assert(pre!.id === "skill:demo-skill/SKILL.md/PreToolUse:audit", `unexpected id ${pre!.id}`)
    assert(pre!.matcher === "execute", `matcher should be execute, got ${pre!.matcher}`)
    assert(pre!.command === "node ./hooks/audit.js", `command mismatch: ${pre!.command}`)
    assert(pre!.timeout === 1234, `timeoutMs should win over timeout seconds, got ${pre!.timeout}`)
    assert(pre!.once === true, "once:true should be preserved")
    assert(pre!.persistAfterInterrupt === true, "persistAfterInterrupt:true should be preserved")
    assert(pre!.forcedOutcome === "always-revise", "forcedOutcome should be preserved")
    assert(pre!.forcedReason === "需要按技能规范修订", "forcedReason should be preserved")
    assert(pre!.onBlock?.requiredSkill === "demo-skill", "onBlock.requiredSkill should parse")

    const post = hooks.find((hook) => hook.event === "PostSkillUse")
    assert(post !== undefined, "PostSkillUse hook should exist")
    assert(
      post!.matcher === "demo-skill",
      `PostSkillUse matcher should default to skill name, got ${post!.matcher}`
    )
    assert(post!.type === "prompt", `PostSkillUse should be prompt, got ${post!.type}`)
    assert(post!.modelId === "local-fast", `modelId should be preserved, got ${post!.modelId}`)
    assert(post!.fallback === "block", `fallback should be block, got ${post!.fallback}`)
  })
}

async function run(): Promise<void> {
  await testNestedYamlFrontmatterParsesHooks()
  console.log("PASS F1 nested YAML frontmatter hooks parse")
  await testFrontmatterHooksBecomeHookConfigs()
  console.log("PASS F2 frontmatter hooks preserve CMB extensions")
}

run().catch((err: Error) => {
  console.error(`FAIL ${err.message}`)
  console.error(err.stack)
  process.exit(1)
})
