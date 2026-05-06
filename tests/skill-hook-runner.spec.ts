/**
 * Unit tests for the hook runner's PreSkillUse / PostSkillUse handling.
 *
 * Verifies:
 *  - matcher matches against `skillName` (not `toolName`) for skill events
 *  - blocking semantics (exit code 2, JSON decision=block)
 *  - additionalContext / systemMessage propagation from PostSkillUse
 *  - SKILL_NAME / SKILL_PATH / SKILL_ROOT env var injection
 *  - stdin payload contains skill_* fields
 *
 * Run:
 *   npx tsx tests/skill-hook-runner.spec.ts
 */

import { mkdir, mkdtemp, rm, writeFile, readFile } from "fs/promises"
import { existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { SystemMessage } from "@langchain/core/messages"
import { createSkillHookContextMiddleware } from "../src/main/agent/runtime.ts"
import { runHooks, type HookContext } from "../src/main/hooks/runner.ts"
import type { HookConfig } from "../src/main/hooks/types.ts"

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

const isWin = process.platform === "win32"

function makeHook(
  partial: Partial<HookConfig> & Pick<HookConfig, "event" | "command">
): HookConfig {
  return {
    id: partial.id ?? "test-hook",
    enabled: partial.enabled ?? true,
    type: "command",
    matcher: partial.matcher,
    timeout: 8000,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...partial
  }
}

// Cross-platform helpers for shell snippets
const trueCmd = isWin ? "cmd /c exit 0" : "true"
const exit2Cmd = isWin ? "cmd /c exit 2" : 'sh -c "exit 2"'

function nodeCommand(script: string): string {
  const encoded = Buffer.from(script, "utf8").toString("base64")
  return `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`
}

function getSystemContent(message: unknown): string {
  const content = (message as { content?: unknown }).content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text?: unknown }).text ?? "")
        }
        return ""
      })
      .join("")
  }
  return ""
}

async function testMatcherStarMatchesAnySkill(): Promise<void> {
  const hook = makeHook({
    event: "PreSkillUse",
    matcher: "*",
    command: trueCmd
  })
  const result = await runHooks([hook], "PreSkillUse", { skillName: "anything" })
  assert(result !== null, "matched hook should produce non-null result")
  assert(!result!.blocked, "true command should not block")
}

async function testMatcherExactSkillName(): Promise<void> {
  const hook = makeHook({
    event: "PreSkillUse",
    matcher: "imagegen",
    command: trueCmd
  })
  const matched = await runHooks([hook], "PreSkillUse", { skillName: "imagegen" })
  assert(matched !== null, "exact match should run")

  const unmatched = await runHooks([hook], "PreSkillUse", { skillName: "other-skill" })
  assert(unmatched === null, "non-matching skillName should NOT run hook")
}

async function testMatcherUsesSkillNameNotToolName(): Promise<void> {
  // Critical: for skill events, matcher applies to skillName.
  // toolName is "read_file" (the trigger tool), but matcher should ignore it.
  const hook = makeHook({
    event: "PreSkillUse",
    matcher: "weather",
    command: trueCmd
  })
  const ctx: HookContext = { toolName: "read_file", skillName: "weather" }
  const result = await runHooks([hook], "PreSkillUse", ctx)
  assert(result !== null, "matcher should match skillName not toolName")

  // Sanity: matcher = read_file should NOT match (skillName is "weather")
  const wrong = makeHook({
    event: "PreSkillUse",
    matcher: "read_file",
    command: trueCmd
  })
  const wrongResult = await runHooks([wrong], "PreSkillUse", ctx)
  assert(wrongResult === null, "matcher='read_file' should NOT match skillName='weather'")
}

async function testMatcherRegex(): Promise<void> {
  const hook = makeHook({
    event: "PreSkillUse",
    matcher: "^image-",
    command: trueCmd
  })
  const matched = await runHooks([hook], "PreSkillUse", { skillName: "image-edit" })
  assert(matched !== null, "regex matcher should match image-edit")

  const unmatched = await runHooks([hook], "PreSkillUse", { skillName: "video-edit" })
  assert(unmatched === null, "regex matcher should not match video-edit")
}

async function testPreSkillBlocksOnExit2(): Promise<void> {
  const hook = makeHook({
    event: "PreSkillUse",
    matcher: "*",
    command: exit2Cmd
  })
  const result = await runHooks([hook], "PreSkillUse", { skillName: "any" })
  assert(result !== null, "blocked hook still produces result")
  assert(result!.blocked === true, `expected blocked=true, got ${result!.blocked}`)
}

async function testPreSkillBlocksOnJsonDecision(): Promise<void> {
  const command = nodeCommand(
    "console.log(JSON.stringify({decision:'block',reason:'policy violation'}))"
  )
  const hook = makeHook({
    event: "PreSkillUse",
    matcher: "*",
    command
  })
  const result = await runHooks([hook], "PreSkillUse", { skillName: "any" })
  assert(result !== null, "decision=block hook should produce result")
  assert(result!.blocked === true, `expected blocked=true, got ${result!.blocked}`)
  assert(
    result!.reason === "policy violation",
    `expected reason="policy violation", got "${result!.reason}"`
  )
}

async function testPostSkillAdditionalContextFlows(): Promise<void> {
  const command = nodeCommand("console.log(JSON.stringify({additionalContext:'extra hint'}))")
  const hook = makeHook({
    event: "PostSkillUse",
    matcher: "*",
    command
  })
  const result = await runHooks([hook], "PostSkillUse", { skillName: "any" })
  assert(result !== null, "PostSkillUse hook should produce result")
  // For post events, additionalContext is collected into result.additionalContext
  assert(
    (result!.additionalContext ?? "").includes("extra hint"),
    `expected additionalContext to include "extra hint", got "${result!.additionalContext}"`
  )
}

async function testEnvVarsAreInjected(): Promise<void> {
  await withTempDir("hook-env", async (dir) => {
    const skillRoot = join(dir, "skills", "test-skill")
    await mkdir(skillRoot, { recursive: true })
    const out = join(dir, "env.txt")
    const command = nodeCommand(`
const fs = require('fs')
fs.writeFileSync(${JSON.stringify(out)}, [
  process.env.SKILL_NAME || '',
  process.env.SKILL_PATH || '',
  process.env.SKILL_ROOT || ''
].join('|'))
`)
    const hook = makeHook({
      event: "PreSkillUse",
      matcher: "*",
      command
    })
    await runHooks([hook], "PreSkillUse", {
      skillName: "test-skill",
      skillPath: join(skillRoot, "SKILL.md"),
      skillRoot
    })
    assert(existsSync(out), "hook should have written output file")
    const content = (await readFile(out, "utf8")).trim()
    assert(content.includes("test-skill"), `SKILL_NAME should appear in output, got "${content}"`)
    assert(
      content.includes("test-skill/SKILL.md") || content.includes("test-skill\\SKILL.md"),
      `SKILL_PATH should appear in output, got "${content}"`
    )
    assert(content.includes(skillRoot), `SKILL_ROOT should appear in output, got "${content}"`)
  })
}

async function testStdinPayloadIncludesSkillFields(): Promise<void> {
  await withTempDir("hook-stdin", async (dir) => {
    const skillRoot = join(dir, "skills", "stdin-skill")
    const skillPath = join(skillRoot, "SKILL.md")
    await mkdir(skillRoot, { recursive: true })
    const out = join(dir, "stdin.json")
    const command = nodeCommand(`
let d = ''
process.stdin.on('data', (c) => { d += c })
process.stdin.on('end', () => require('fs').writeFileSync(${JSON.stringify(out)}, d))
`)
    const hook = makeHook({
      event: "PreSkillUse",
      matcher: "*",
      command
    })
    await runHooks([hook], "PreSkillUse", {
      skillName: "test-skill",
      skillPath,
      skillRoot,
      skillTriggerToolName: "read_file"
    })
    assert(existsSync(out), "hook should have written stdin payload")
    const raw = await readFile(out, "utf8")
    const parsed = JSON.parse(raw) as Record<string, unknown>
    assert(parsed.hook_event_name === "PreSkillUse", "hook_event_name should be PreSkillUse")
    assert(
      parsed.skill_name === "test-skill",
      `skill_name should be test-skill, got ${parsed.skill_name}`
    )
    assert(parsed.skill_path === skillPath, `skill_path mismatch: ${parsed.skill_path}`)
    assert(parsed.skill_root === skillRoot, `skill_root mismatch: ${parsed.skill_root}`)
    assert(
      parsed.skill_trigger_tool_name === "read_file",
      `skill_trigger_tool_name mismatch: ${parsed.skill_trigger_tool_name}`
    )
  })
}

async function testSkillRootIsDefaultCommandCwd(): Promise<void> {
  await withTempDir("hook-cwd", async (dir) => {
    const skillRoot = join(dir, "skills", "cwd-skill")
    await writeFile(join(dir, "workspace-marker.txt"), "workspace", "utf8")
    await mkdir(skillRoot, { recursive: true })
    const out = join(dir, "cwd.txt")
    const command = nodeCommand(`
const fs = require('fs')
fs.writeFileSync(${JSON.stringify(out)}, process.cwd())
`)
    const hook = makeHook({
      event: "PreToolUse",
      matcher: "*",
      command
    })
    await runHooks([hook], "PreToolUse", {
      toolName: "execute",
      workspacePath: dir,
      skillRoot
    })
    assert(existsSync(out), "hook should have written cwd output")
    const cwd = (await readFile(out, "utf8")).trim().replace(/\\/g, "/").toLowerCase()
    const expected = skillRoot.replace(/\\/g, "/").toLowerCase()
    assert(cwd === expected, `hook command cwd should default to skillRoot, got ${cwd}`)
  })
}

async function testSkillEventDoesNotMatchToolEvent(): Promise<void> {
  // matcher="*" PreSkillUse hook should NOT fire on PreToolUse calls
  const hook = makeHook({
    event: "PreSkillUse",
    matcher: "*",
    command: trueCmd
  })
  const result = await runHooks([hook], "PreToolUse", { toolName: "read_file" })
  assert(result === null, "PreSkillUse hook must not be triggered for PreToolUse events")
}

async function testToolEventDoesNotMatchSkillEvent(): Promise<void> {
  // Symmetric: PreToolUse hook should not fire when only PreSkillUse fires
  const hook = makeHook({
    event: "PreToolUse",
    matcher: "*",
    command: trueCmd
  })
  const result = await runHooks([hook], "PreSkillUse", { skillName: "x" })
  assert(result === null, "PreToolUse hook must not be triggered for PreSkillUse events")
}

async function testMiddlewareNoopOnEmptyQueue(): Promise<void> {
  const request = { systemMessage: new SystemMessage("base prompt") }
  let captured: unknown
  const middleware = createSkillHookContextMiddleware({
    drainSkillHookContexts: () => []
  })
  await middleware.wrapModelCall(request, (nextRequest: unknown) => {
    captured = nextRequest
    return "ok"
  })
  assert(captured === request, "empty hook context queue should pass original request through")
}

async function testMiddlewareInjectsContextWithSeparator(): Promise<void> {
  const request = { systemMessage: new SystemMessage("base prompt") }
  let captured: { systemMessage: unknown } | undefined
  const middleware = createSkillHookContextMiddleware({
    drainSkillHookContexts: () => ["Skill: imagegen\nSkill path: /x/SKILL.md\npost guidance"]
  })
  await middleware.wrapModelCall(request, (nextRequest: { systemMessage: unknown }) => {
    captured = nextRequest
    return "ok"
  })
  const content = getSystemContent(captured?.systemMessage)
  assert(content.includes("## Skill Hook Context"), `expected injected heading, got ${content}`)
  assert(
    content.includes("base prompt\n\n## Skill Hook Context"),
    `expected blank-line separator before hook context, got ${content}`
  )
  assert(content.includes("post guidance"), `expected hook guidance, got ${content}`)
}

async function testMiddlewareDrainExceptionFallsBack(): Promise<void> {
  const request = { systemMessage: new SystemMessage("base prompt") }
  let captured: unknown
  const middleware = createSkillHookContextMiddleware({
    drainSkillHookContexts: () => {
      throw new Error("boom")
    }
  })
  const originalWarn = console.warn
  try {
    console.warn = () => undefined
    await middleware.wrapModelCall(request, (nextRequest: unknown) => {
      captured = nextRequest
      return "ok"
    })
  } finally {
    console.warn = originalWarn
  }
  assert(captured === request, "drain failures should fall back to original request")
}

async function testMiddlewareNoopWithoutProvider(): Promise<void> {
  const request = { systemMessage: new SystemMessage("base prompt") }
  let captured: unknown
  const middleware = createSkillHookContextMiddleware({})
  await middleware.wrapModelCall(request, (nextRequest: unknown) => {
    captured = nextRequest
    return "ok"
  })
  assert(captured === request, "backend without drainSkillHookContexts should be a no-op")
}

async function run(): Promise<void> {
  await testMatcherStarMatchesAnySkill()
  console.log("PASS B1 matcher * matches any skill")
  await testMatcherExactSkillName()
  console.log("PASS B2/B3 exact skill name match/no-match")
  await testMatcherUsesSkillNameNotToolName()
  console.log("PASS B10 matcher uses skillName not toolName")
  await testMatcherRegex()
  console.log("PASS B4 regex matcher")
  await testPreSkillBlocksOnExit2()
  console.log("PASS B5 PreSkillUse blocks on exit 2")
  await testPreSkillBlocksOnJsonDecision()
  console.log("PASS B6 PreSkillUse blocks on decision=block")
  await testPostSkillAdditionalContextFlows()
  console.log("PASS B7 PostSkillUse additionalContext flows")
  await testEnvVarsAreInjected()
  console.log("PASS B8 SKILL_NAME/SKILL_PATH/SKILL_ROOT env vars injected")
  await testStdinPayloadIncludesSkillFields()
  console.log("PASS B9 stdin payload includes skill_* fields")
  await testSkillRootIsDefaultCommandCwd()
  console.log("PASS B11 skill hook command cwd defaults to SKILL_ROOT")
  await testSkillEventDoesNotMatchToolEvent()
  console.log("PASS event isolation: PreSkillUse hooks don't fire on PreToolUse")
  await testToolEventDoesNotMatchSkillEvent()
  console.log("PASS event isolation: PreToolUse hooks don't fire on PreSkillUse")
  await testMiddlewareNoopOnEmptyQueue()
  console.log("PASS E1 empty hook context queue is no-op")
  await testMiddlewareInjectsContextWithSeparator()
  console.log("PASS E2/E3 hook context injects with separator")
  await testMiddlewareDrainExceptionFallsBack()
  console.log("PASS E4 drain exception falls back")
  await testMiddlewareNoopWithoutProvider()
  console.log("PASS E5 backend without drain is no-op")
}

run().catch((err: Error) => {
  console.error(`FAIL ${err.message}`)
  console.error(err.stack)
  process.exit(1)
})
