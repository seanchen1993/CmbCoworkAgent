/**
 * Unit tests for the hook runner's PreSkillUse / PostSkillUse handling.
 *
 * Verifies:
 *  - matcher matches against `skillName` (not `toolName`) for skill events
 *  - blocking semantics (exit code 2, JSON decision=block)
 *  - non-blocking PostSkillUse output remains observable-only
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
import {
  clearOnceStateForHook,
  clearOnceStateForSession,
  resetHookOnceStateForTests,
  runHooks,
  type HookContext
} from "../src/main/hooks/runner.ts"
import type { HookConfig, HookResult } from "../src/main/hooks/types.ts"

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

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert(false, message)
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

async function testPostSkillNonBlockingOutputIsObservableOnly(): Promise<void> {
  const command = nodeCommand(
    "console.log(JSON.stringify({additionalContext:'extra hint', systemMessage:'notice'}))"
  )
  const hook = makeHook({
    event: "PostSkillUse",
    matcher: "*",
    command
  })
  let observedAdditionalContext = ""
  let observedSystemMessage = ""
  const result = await runHooks(
    [hook],
    "PostSkillUse",
    { skillName: "any" },
    (_event, _hook, hookResult) => {
      observedAdditionalContext = hookResult.additionalContext ?? ""
      observedSystemMessage = hookResult.systemMessage ?? ""
    }
  )
  assert(result === null, "non-blocking PostSkillUse output should not return aggregate context")
  assert(
    observedAdditionalContext.includes("extra hint"),
    "additionalContext should remain visible to hook logs"
  )
  assert(
    observedSystemMessage.includes("notice"),
    "systemMessage should remain visible to hook logs"
  )
}

async function testPostSkillOnlyBlockingOutputFeedsRevision(): Promise<void> {
  const nonBlockingHook = makeHook({
    id: "non-blocking",
    event: "PostSkillUse",
    matcher: "*",
    command: nodeCommand(
      "console.log(JSON.stringify({additionalContext:'non-block context', systemMessage:'non-block notice'}))"
    )
  })
  const blockingHook = makeHook({
    id: "blocking",
    event: "PostSkillUse",
    matcher: "*",
    command: nodeCommand(
      "console.log(JSON.stringify({decision:'block', reason:'needs revision', additionalContext:'block context', systemMessage:'block notice'}))"
    )
  })

  const observedHookIds: string[] = []
  const result = await runHooks(
    [nonBlockingHook, blockingHook],
    "PostSkillUse",
    { skillName: "any" },
    (_event, hook) => {
      observedHookIds.push(hook.id)
    }
  )

  assert(observedHookIds.length === 2, "both PostSkillUse hooks should be logged")
  assert(result?.decision === "block", "blocking PostSkillUse should return aggregate block")
  assert(result.reason?.includes("needs revision"), "blocking reason should feed revision")
  assert(
    result.additionalContext === "block context",
    `only blocking additionalContext should feed revision, got "${result.additionalContext}"`
  )
  assert(
    result.systemMessage === "block notice",
    `only blocking systemMessage should feed revision, got "${result.systemMessage}"`
  )
}

async function testPostSkillContinueFalsePropagatesAsHalt(): Promise<void> {
  const haltHook = makeHook({
    id: "halt",
    event: "PostSkillUse",
    matcher: "*",
    command: nodeCommand(
      "console.log(JSON.stringify({continue:false, stopReason:'policy violated'}))"
    )
  })
  const reviseHook = makeHook({
    id: "revise",
    event: "PostSkillUse",
    matcher: "*",
    command: nodeCommand("console.log(JSON.stringify({decision:'block', reason:'wants revision'}))")
  })

  const result = await runHooks([haltHook, reviseHook], "PostSkillUse", { skillName: "any" })

  assert(result?.continue === false, "halt should produce continue:false at runner level")
  assert(result.decision === undefined, "halt result must not also carry decision:block")
  assert(result.blocked === false, "halt result must not flip blocked flag")
  assert(
    typeof result.stopReason === "string" && result.stopReason.includes("policy violated"),
    `halt should preserve stopReason; got ${result.stopReason}`
  )
}

async function testForcedOutcomeAlwaysHaltOverridesScript(): Promise<void> {
  // Hook script outputs decision=block (revision) but config forces halt.
  const hook = makeHook({
    id: "force-halt",
    event: "Stop",
    matcher: "*",
    command: nodeCommand(
      "console.log(JSON.stringify({decision:'block', reason:'wants revision'}))"
    ),
    forcedOutcome: "always-halt",
    forcedReason: "policy override"
  })

  const result = await runHooks([hook], "Stop", {})

  assert(result?.continue === false, "force-halt must produce continue:false")
  assert(result.decision === undefined, "force-halt must clear decision:block")
  assert(
    typeof result.stopReason === "string" && result.stopReason.includes("policy override"),
    `force-halt should use forcedReason; got ${result.stopReason}`
  )
}

async function testForcedOutcomeAlwaysReviseOverridesHaltScript(): Promise<void> {
  // Hook script outputs continue:false but config forces revision.
  const hook = makeHook({
    id: "force-revise",
    event: "Stop",
    matcher: "*",
    command: nodeCommand("console.log(JSON.stringify({continue:false, stopReason:'wants halt'}))"),
    forcedOutcome: "always-revise",
    forcedReason: "must revise"
  })

  const result = await runHooks([hook], "Stop", {})

  assert(result?.decision === "block", "force-revise must produce decision:block")
  assert(result.continue !== false, "force-revise must clear continue:false from script")
  assert(
    typeof result.reason === "string" && result.reason.includes("must revise"),
    `force-revise should use forcedReason; got ${result.reason}`
  )
}

async function testForcedOutcomeFallbackReason(): Promise<void> {
  // No forcedReason set — should fall back to the script's reason.
  const hook = makeHook({
    id: "force-halt-fallback",
    event: "PostSkillUse",
    matcher: "*",
    command: nodeCommand(
      "console.log(JSON.stringify({decision:'block', reason:'script said this'}))"
    ),
    forcedOutcome: "always-halt"
  })

  const result = await runHooks([hook], "PostSkillUse", { skillName: "any" })

  assert(result?.continue === false, "force-halt should still produce continue:false")
  assert(
    typeof result.stopReason === "string" && result.stopReason.includes("script said this"),
    `forcedReason fallback should use script's reason; got ${result.stopReason}`
  )
}

async function testForcedOutcomeAlwaysHaltAppliesToFireAndForget(): Promise<void> {
  let observed: HookResult | undefined
  const hook = makeHook({
    id: "force-halt-session",
    event: "SessionStart",
    matcher: "*",
    command: nodeCommand(
      "console.log(JSON.stringify({decision:'block', reason:'script wants revision'}))"
    ),
    forcedOutcome: "always-halt",
    forcedReason: "session should stop"
  })

  const result = await runHooks(
    [hook],
    "SessionStart",
    { sessionId: "session-1" },
    (_event, _hook, hookResult) => {
      observed = hookResult
    }
  )

  assert(result === null, "fire-and-forget hook should not block the caller")
  await waitFor(() => observed !== undefined, "SessionStart hook callback should fire")
  assert(observed?.continue === false, "force-halt should be visible in hook result callback")
  assert(observed.decision === undefined, "force-halt should clear decision:block")
  assert(observed.blocked === false, "force-halt should clear blocked flag")
  assert(
    typeof observed.stopReason === "string" && observed.stopReason.includes("session should stop"),
    `force-halt should use forcedReason for fire-and-forget; got ${observed.stopReason}`
  )
}

async function testForcedOutcomeAlwaysReviseAppliesToFireAndForget(): Promise<void> {
  let observed: HookResult | undefined
  const hook = makeHook({
    id: "force-revise-notification",
    event: "Notification",
    matcher: "*",
    command: nodeCommand(
      "console.log(JSON.stringify({continue:false, stopReason:'script wants halt'}))"
    ),
    forcedOutcome: "always-revise",
    forcedReason: "notification should revise"
  })

  const result = await runHooks([hook], "Notification", {}, (_event, _hook, hookResult) => {
    observed = hookResult
  })

  assert(result === null, "fire-and-forget hook should not block the caller")
  await waitFor(() => observed !== undefined, "Notification hook callback should fire")
  assert(observed?.decision === "block", "force-revise should be visible in hook result callback")
  assert(observed.continue !== false, "force-revise should clear continue:false")
  assert(
    typeof observed.reason === "string" && observed.reason.includes("notification should revise"),
    `force-revise should use forcedReason for fire-and-forget; got ${observed.reason}`
  )
}

async function testSubagentStopContinueFalseReturnsHalt(): Promise<void> {
  let observed: HookResult | undefined
  const hook = makeHook({
    id: "subagent-halt",
    event: "SubagentStop",
    matcher: "*",
    command: nodeCommand("console.log(JSON.stringify({continue:false, stopReason:'task stop'}))")
  })

  const result = await runHooks(
    [hook],
    "SubagentStop",
    { sessionId: "session-1", subagent: { id: "task-1", status: "completed" } },
    (_event, _hook, hookResult) => {
      observed = hookResult
    }
  )

  assert(observed?.continue === false, "SubagentStop callback should see continue:false")
  assert(result?.continue === false, "SubagentStop should return a halt result")
  assert(result.blocked === false, "SubagentStop halt should not become revision/block feedback")
  assert(
    typeof result.stopReason === "string" && result.stopReason.includes("task stop"),
    `SubagentStop should preserve stopReason, got ${result.stopReason}`
  )
}

async function testOnceHookRunsOnlyOncePerSession(): Promise<void> {
  resetHookOnceStateForTests()
  await withTempDir("hook-once", async (dir) => {
    const out = join(dir, "once.txt")
    const skillRoot = join(dir, "skills", "demo")
    await mkdir(skillRoot, { recursive: true })
    const hook = makeHook({
      id: "once-success",
      event: "PreToolUse",
      matcher: "execute",
      command: nodeCommand(`
const fs = require('fs')
fs.appendFileSync(${JSON.stringify(out)}, 'hit\\n')
`),
      once: true,
      hookSourceType: "skill",
      hookSourceRoot: skillRoot,
      hookSourcePath: join(skillRoot, "SKILL.md")
    })

    await runHooks([hook], "PreToolUse", { toolName: "execute", sessionId: "session-a" })
    const second = await runHooks([hook], "PreToolUse", {
      toolName: "execute",
      sessionId: "session-a"
    })
    await runHooks([hook], "PreToolUse", { toolName: "execute", sessionId: "session-b" })

    assert(second === null, "once hook should be skipped on second run in same session")
    const hits = (await readFile(out, "utf8")).trim().split(/\r?\n/).filter(Boolean)
    assert(hits.length === 2, `once hook should run once per session, got ${hits.length}`)
  })
}

async function testOnceHookFailureDoesNotConsume(): Promise<void> {
  resetHookOnceStateForTests()
  await withTempDir("hook-once-fail", async (dir) => {
    const out = join(dir, "once-fail.txt")
    const hook = makeHook({
      id: "once-failure",
      event: "PreToolUse",
      matcher: "execute",
      command: nodeCommand(`
const fs = require('fs')
fs.appendFileSync(${JSON.stringify(out)}, 'fail\\n')
process.exit(2)
`),
      once: true
    })

    await runHooks([hook], "PreToolUse", { toolName: "execute", sessionId: "same-session" })
    await runHooks([hook], "PreToolUse", { toolName: "execute", sessionId: "same-session" })

    const hits = (await readFile(out, "utf8")).trim().split(/\r?\n/).filter(Boolean)
    assert(hits.length === 2, `failing once hook should not be consumed, got ${hits.length}`)
  })
}

async function testClearOnceStateForSessionResetsThatSessionOnly(): Promise<void> {
  resetHookOnceStateForTests()
  await withTempDir("hook-once-session-clear", async (dir) => {
    const out = join(dir, "session-clear.txt")
    const hook = makeHook({
      id: "once-session-clear",
      event: "PreToolUse",
      matcher: "execute",
      command: nodeCommand(`
const fs = require('fs')
fs.appendFileSync(${JSON.stringify(out)}, 'hit\\n')
`),
      once: true
    })

    // Two sessions both consume once.
    await runHooks([hook], "PreToolUse", { toolName: "execute", sessionId: "session-x" })
    await runHooks([hook], "PreToolUse", { toolName: "execute", sessionId: "session-y" })

    // Clear only session-x.
    clearOnceStateForSession("session-x")

    // session-x can fire again, session-y still suppressed.
    await runHooks([hook], "PreToolUse", { toolName: "execute", sessionId: "session-x" })
    const skipped = await runHooks([hook], "PreToolUse", {
      toolName: "execute",
      sessionId: "session-y"
    })

    assert(skipped === null, "session-y once should still be consumed after clearing session-x only")
    const hits = (await readFile(out, "utf8")).trim().split(/\r?\n/).filter(Boolean)
    assert(
      hits.length === 3,
      `expected 3 hits (session-x x2 + session-y x1), got ${hits.length}`
    )
  })
}

async function testClearOnceStateForHookResetsAcrossSessions(): Promise<void> {
  resetHookOnceStateForTests()
  await withTempDir("hook-once-hook-clear", async (dir) => {
    const out = join(dir, "hook-clear.txt")
    const hook = makeHook({
      id: "once-hook-clear",
      event: "PreToolUse",
      matcher: "execute",
      command: nodeCommand(`
const fs = require('fs')
fs.appendFileSync(${JSON.stringify(out)}, 'hit\\n')
`),
      once: true
    })

    // Two sessions consume once.
    await runHooks([hook], "PreToolUse", { toolName: "execute", sessionId: "s1" })
    await runHooks([hook], "PreToolUse", { toolName: "execute", sessionId: "s2" })

    // Simulate hook update — drops once-state across all sessions.
    clearOnceStateForHook("once-hook-clear")

    // Both sessions can fire again.
    await runHooks([hook], "PreToolUse", { toolName: "execute", sessionId: "s1" })
    await runHooks([hook], "PreToolUse", { toolName: "execute", sessionId: "s2" })

    const hits = (await readFile(out, "utf8")).trim().split(/\r?\n/).filter(Boolean)
    assert(hits.length === 4, `expected 4 hits after hook reset, got ${hits.length}`)
  })
}

async function testClearOnceStateForHookDoesNotAffectOtherHooks(): Promise<void> {
  resetHookOnceStateForTests()
  await withTempDir("hook-once-other-hook", async (dir) => {
    const outA = join(dir, "hook-a.txt")
    const outB = join(dir, "hook-b.txt")
    const hookA = makeHook({
      id: "once-a",
      event: "PreToolUse",
      matcher: "execute",
      command: nodeCommand(`require('fs').appendFileSync(${JSON.stringify(outA)}, 'A\\n')`),
      once: true
    })
    const hookB = makeHook({
      id: "once-b",
      event: "PreToolUse",
      matcher: "execute",
      command: nodeCommand(`require('fs').appendFileSync(${JSON.stringify(outB)}, 'B\\n')`),
      once: true
    })

    await runHooks([hookA, hookB], "PreToolUse", { toolName: "execute", sessionId: "shared" })
    clearOnceStateForHook("once-a")
    await runHooks([hookA, hookB], "PreToolUse", { toolName: "execute", sessionId: "shared" })

    const hitsA = (await readFile(outA, "utf8")).trim().split(/\r?\n/).filter(Boolean)
    const hitsB = (await readFile(outB, "utf8")).trim().split(/\r?\n/).filter(Boolean)
    assert(hitsA.length === 2, `hookA should fire twice after its once-state is cleared, got ${hitsA.length}`)
    assert(hitsB.length === 1, `hookB once should remain consumed, got ${hitsB.length}`)
  })
}

async function testStopContinueFalsePropagatesAsHalt(): Promise<void> {
  const haltHook = makeHook({
    id: "halt",
    event: "Stop",
    matcher: "*",
    command: nodeCommand("console.log(JSON.stringify({continue:false, stopReason:'turn done'}))")
  })
  const reviseHook = makeHook({
    id: "revise",
    event: "Stop",
    matcher: "*",
    command: nodeCommand("console.log(JSON.stringify({decision:'block', reason:'try again'}))")
  })

  const result = await runHooks([haltHook, reviseHook], "Stop", {})

  assert(result?.continue === false, "Stop halt should produce continue:false")
  assert(result.decision === undefined, "Stop halt must not double-set decision:block")
  assert(
    typeof result.stopReason === "string" && result.stopReason.includes("turn done"),
    `Stop halt should preserve stopReason; got ${result.stopReason}`
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

function normalizePathForAssert(value: string): string {
  return value.trim().replace(/\\/g, "/").toLowerCase()
}

async function testHookSourceRootControlsCommandCwd(): Promise<void> {
  await withTempDir("hook-source-cwd", async (dir) => {
    const globalRoot = join(dir, "openwork")
    const workspaceRoot = join(dir, "360用户文件")
    const skillRoot = join(dir, "skills", "cwd-skill")
    await mkdir(globalRoot, { recursive: true })
    await mkdir(workspaceRoot, { recursive: true })
    await mkdir(skillRoot, { recursive: true })
    const out = join(dir, "cwd.json")
    const command = nodeCommand(`
const fs = require('fs')
let input = ''
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({
    cwd: process.cwd(),
    hookSourceType: process.env.HOOK_SOURCE_TYPE || '',
    hookSourceRoot: process.env.HOOK_SOURCE_ROOT || '',
    hookSourcePath: process.env.HOOK_SOURCE_PATH || '',
    workspacePath: process.env.WORKSPACE_PATH || '',
    skillRoot: process.env.SKILL_ROOT || '',
    stdin: JSON.parse(input)
  }))
})
`)
    const hook = makeHook({
      event: "PreToolUse",
      matcher: "*",
      command,
      hookSourceType: "global",
      hookSourceRoot: globalRoot,
      hookSourcePath: join(globalRoot, "hooks.json")
    })
    await runHooks([hook], "PreToolUse", {
      toolName: "execute",
      workspacePath: workspaceRoot,
      skillRoot
    })
    assert(existsSync(out), "hook should have written cwd output")
    const payload = JSON.parse(await readFile(out, "utf8")) as Record<string, unknown>
    const cwd = normalizePathForAssert(String(payload.cwd))
    const expected = normalizePathForAssert(globalRoot)
    assert(cwd === expected, `hook command cwd should use hookSourceRoot, got ${cwd}`)
    assert(
      payload.hookSourceType === "global",
      `HOOK_SOURCE_TYPE mismatch: ${payload.hookSourceType}`
    )
    assert(
      payload.hookSourceRoot === globalRoot,
      `HOOK_SOURCE_ROOT mismatch: ${payload.hookSourceRoot}`
    )
    assert(
      payload.workspacePath === workspaceRoot,
      `WORKSPACE_PATH mismatch: ${payload.workspacePath}`
    )
    assert(
      payload.skillRoot === skillRoot,
      `SKILL_ROOT should remain event context, got ${payload.skillRoot}`
    )
    const stdin = payload.stdin as Record<string, unknown>
    assert(stdin.cwd === globalRoot, `stdin cwd should use hookSourceRoot, got ${stdin.cwd}`)
    assert(
      stdin.hook_source_root === globalRoot,
      `stdin hook_source_root mismatch: ${stdin.hook_source_root}`
    )
    assert(
      stdin.skill_root === skillRoot,
      `stdin skill_root should remain event context, got ${stdin.skill_root}`
    )
  })
}

async function testWorkspaceHookCwdSupportsChinesePath(): Promise<void> {
  await withTempDir("hook-workspace-cwd", async (dir) => {
    const workspaceRoot = join(dir, "360用户文件")
    const skillRoot = join(dir, "skills", "cwd-skill")
    await mkdir(workspaceRoot, { recursive: true })
    await mkdir(skillRoot, { recursive: true })
    const out = join(dir, "workspace-cwd.txt")
    const command = nodeCommand(`
const fs = require('fs')
fs.writeFileSync(${JSON.stringify(out)}, process.cwd())
`)
    const hook = makeHook({
      event: "PreToolUse",
      matcher: "*",
      command,
      hookSourceType: "workspace",
      hookSourceRoot: workspaceRoot,
      hookSourcePath: join(workspaceRoot, ".cmbdevclaw", "hooks", "check.json")
    })
    await runHooks([hook], "PreToolUse", {
      toolName: "execute",
      workspacePath: workspaceRoot,
      skillRoot
    })
    assert(existsSync(out), "workspace hook should have written cwd output")
    const cwd = normalizePathForAssert(await readFile(out, "utf8"))
    const expected = normalizePathForAssert(workspaceRoot)
    assert(cwd === expected, `workspace hook cwd should support Chinese path, got ${cwd}`)
  })
}

async function testSkillHookSourceRootDefaultsToSkillDir(): Promise<void> {
  await withTempDir("hook-skill-cwd", async (dir) => {
    const workspaceRoot = join(dir, "360用户文件")
    const skillRoot = join(dir, "skills", "cwd-skill")
    await mkdir(workspaceRoot, { recursive: true })
    await mkdir(skillRoot, { recursive: true })
    const out = join(dir, "skill-cwd.txt")
    const command = nodeCommand(`
const fs = require('fs')
fs.writeFileSync(${JSON.stringify(out)}, process.cwd())
`)
    const hook = makeHook({
      event: "PreToolUse",
      matcher: "*",
      command,
      hookSourceType: "skill",
      hookSourceRoot: skillRoot,
      hookSourcePath: join(skillRoot, "hooks", "hooks.json"),
      skillName: "cwd-skill",
      skillPath: skillRoot,
      skillRoot
    } as Partial<HookConfig> & Pick<HookConfig, "event" | "command">)
    await runHooks([hook], "PreToolUse", {
      toolName: "execute",
      workspacePath: workspaceRoot
    })
    assert(existsSync(out), "skill hook should have written cwd output")
    const cwd = normalizePathForAssert(await readFile(out, "utf8"))
    const expected = normalizePathForAssert(skillRoot)
    assert(cwd === expected, `skill hook cwd should default to skill source root, got ${cwd}`)
  })
}

async function testPluginHookSourceRootDefaultsToPluginDir(): Promise<void> {
  await withTempDir("hook-plugin-cwd", async (dir) => {
    const workspaceRoot = join(dir, "360用户文件")
    const pluginRoot = join(dir, "plugins", "demo-plugin")
    const skillRoot = join(dir, "skills", "cwd-skill")
    await mkdir(workspaceRoot, { recursive: true })
    await mkdir(pluginRoot, { recursive: true })
    await mkdir(skillRoot, { recursive: true })
    const out = join(dir, "plugin-cwd.json")
    const command = nodeCommand(`
const fs = require('fs')
fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({
  cwd: process.cwd(),
  hookSourceType: process.env.HOOK_SOURCE_TYPE || '',
  hookSourceRoot: process.env.HOOK_SOURCE_ROOT || '',
  pluginRoot: process.env.PLUGIN_ROOT || '',
  workspacePath: process.env.WORKSPACE_PATH || '',
  skillRoot: process.env.SKILL_ROOT || ''
}))
`)
    const hook = makeHook({
      event: "PreToolUse",
      matcher: "*",
      command,
      hookSourceType: "plugin",
      hookSourceRoot: pluginRoot,
      hookSourcePath: join(pluginRoot, "hooks", "hooks.json"),
      pluginId: "demo-plugin",
      pluginName: "Demo Plugin",
      pluginRoot
    } as Partial<HookConfig> & Pick<HookConfig, "event" | "command">)
    await runHooks([hook], "PreToolUse", {
      toolName: "execute",
      workspacePath: workspaceRoot,
      skillRoot
    })
    assert(existsSync(out), "plugin hook should have written cwd output")
    const payload = JSON.parse(await readFile(out, "utf8")) as Record<string, unknown>
    const cwd = normalizePathForAssert(String(payload.cwd))
    const expected = normalizePathForAssert(pluginRoot)
    assert(cwd === expected, `plugin hook cwd should default to plugin source root, got ${cwd}`)
    assert(
      payload.hookSourceType === "plugin",
      `HOOK_SOURCE_TYPE mismatch: ${payload.hookSourceType}`
    )
    assert(
      payload.hookSourceRoot === pluginRoot,
      `HOOK_SOURCE_ROOT mismatch: ${payload.hookSourceRoot}`
    )
    assert(payload.pluginRoot === pluginRoot, `PLUGIN_ROOT mismatch: ${payload.pluginRoot}`)
    assert(
      payload.workspacePath === workspaceRoot,
      `WORKSPACE_PATH mismatch: ${payload.workspacePath}`
    )
    assert(
      payload.skillRoot === skillRoot,
      `SKILL_ROOT should remain event context, got ${payload.skillRoot}`
    )
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
  await testPostSkillNonBlockingOutputIsObservableOnly()
  console.log("PASS B7a non-blocking PostSkillUse output is observable-only")
  await testPostSkillOnlyBlockingOutputFeedsRevision()
  console.log("PASS B7b only blocking PostSkillUse output feeds revision")
  await testPostSkillContinueFalsePropagatesAsHalt()
  console.log("PASS B7c PostSkillUse continue:false propagates as halt, not revision")
  await testStopContinueFalsePropagatesAsHalt()
  console.log("PASS B7d Stop hook continue:false propagates as halt, not revision")
  await testForcedOutcomeAlwaysHaltOverridesScript()
  console.log("PASS B7e forcedOutcome=always-halt overrides script's decision:block")
  await testForcedOutcomeAlwaysReviseOverridesHaltScript()
  console.log("PASS B7f forcedOutcome=always-revise overrides script's continue:false")
  await testForcedOutcomeFallbackReason()
  console.log("PASS B7g forcedOutcome falls back to script reason when forcedReason missing")
  await testForcedOutcomeAlwaysHaltAppliesToFireAndForget()
  console.log("PASS B7h forcedOutcome=always-halt applies to fire-and-forget hooks")
  await testForcedOutcomeAlwaysReviseAppliesToFireAndForget()
  console.log("PASS B7i forcedOutcome=always-revise applies to fire-and-forget hooks")
  await testSubagentStopContinueFalseReturnsHalt()
  console.log("PASS B7i2 SubagentStop continue:false returns halt to caller")
  await testOnceHookRunsOnlyOncePerSession()
  console.log("PASS B7j once hook runs only once per session")
  await testOnceHookFailureDoesNotConsume()
  console.log("PASS B7k failing once hook is not consumed")
  await testClearOnceStateForSessionResetsThatSessionOnly()
  console.log("PASS B7l clearOnceStateForSession resets that session only")
  await testClearOnceStateForHookResetsAcrossSessions()
  console.log("PASS B7m clearOnceStateForHook resets a hook id across sessions")
  await testClearOnceStateForHookDoesNotAffectOtherHooks()
  console.log("PASS B7n clearOnceStateForHook does not affect other hook ids")
  await testEnvVarsAreInjected()
  console.log("PASS B8 SKILL_NAME/SKILL_PATH/SKILL_ROOT env vars injected")
  await testStdinPayloadIncludesSkillFields()
  console.log("PASS B9 stdin payload includes skill_* fields")
  await testHookSourceRootControlsCommandCwd()
  console.log("PASS B11 hook source root controls command cwd")
  await testWorkspaceHookCwdSupportsChinesePath()
  console.log("PASS B12 workspace hook cwd supports Chinese path")
  await testSkillHookSourceRootDefaultsToSkillDir()
  console.log("PASS B13 skill hook command cwd defaults to skill source root")
  await testPluginHookSourceRootDefaultsToPluginDir()
  console.log("PASS B14 plugin hook command cwd defaults to plugin source root")
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
