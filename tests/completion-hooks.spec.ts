/**
 * Unit tests for turn-completion hook orchestration.
 *
 * Run:
 *   npx tsx tests/completion-hooks.spec.ts
 */

import { join } from "path"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import {
  runCompletionHooksWithRevision,
  runPostSkillUseHooksForActivatedSkills
} from "../src/main/agent/skill-lifecycle/completion-hooks.ts"
import { createSkillUseTracker } from "../src/main/agent/skill-lifecycle/tracker.ts"
import { createHookScope } from "../src/main/hooks/scope.ts"
import type { HookContext } from "../src/main/hooks/runner.ts"
import type { HookConfig, HookEvent, HookResult } from "../src/main/hooks/types.ts"

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

function makeHook(partial: Partial<HookConfig> & Pick<HookConfig, "event">): HookConfig {
  return {
    id: partial.id ?? "test-hook",
    enabled: partial.enabled ?? true,
    type: "command",
    matcher: partial.matcher,
    command: partial.command ?? 'node -e ""',
    timeout: 1000,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...partial
  }
}

function blockingResult(reason: string): HookResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    blocked: true,
    decision: "block",
    reason
  }
}

function nonBlockingResult(): HookResult {
  return {
    exitCode: 0,
    stdout: "plain output",
    stderr: "",
    blocked: false,
    additionalContext: "extra context",
    systemMessage: "notice"
  }
}

function preventContinuationResult(reason: string): HookResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    blocked: false,
    continue: false,
    stopReason: reason
  }
}

async function testPostSkillUseMarksFiredEvenWhenBlocking(): Promise<void> {
  await withTempDir("completion-post-fired", async (base) => {
    const tracker = createSkillUseTracker()
    const pluginRoot = join(base, "plugin")
    const skillRoot = join(pluginRoot, "skills", "review")
    const skillPath = join(skillRoot, "SKILL.md")
    tracker.recordSkillUse(
      {
        name: "review",
        path: skillPath,
        rootDir: skillRoot,
        pluginId: "plugin-a",
        pluginName: "Plugin A",
        pluginRoot
      },
      { trigger: "read_file", triggerToolName: "read_file" }
    )

    let executed = 0
    const result = await runPostSkillUseHooksForActivatedSkills({
      threadId: "thread-test",
      workspacePath: base,
      getStopContext: () => ({ usedSkills: ["review"], assistantResponse: "done" }),
      hookScope: createHookScope(),
      skillUseTracker: tracker,
      resolveHooks: (event: HookEvent, context: HookContext) => {
        assert(event === "PostSkillUse", `expected PostSkillUse, got ${event}`)
        assert(context.pluginRoot === pluginRoot, `expected pluginRoot ${pluginRoot}`)
        assert(context.stopContext?.usedSkills?.[0] === "review", "expected stop_context")
        return [makeHook({ event: "PostSkillUse", matcher: "review" })]
      },
      executeHooks: async (_hooks, event, context) => {
        executed += 1
        assert(event === "PostSkillUse", `expected PostSkillUse executor, got ${event}`)
        assert(context.skillName === "review", "expected skill context")
        return blockingResult("needs revision")
      }
    })

    assert(executed === 1, `expected one PostSkillUse execution, got ${executed}`)
    assert(result?.decision === "block", "expected merged blocking result")
    assert(
      tracker.getPendingPostSkillUses().length === 0,
      "blocking PostSkillUse should still be marked fired"
    )
  })
}

async function testNonBlockingPostSkillOutputIsObservableOnly(): Promise<void> {
  await withTempDir("completion-post-non-block", async (base) => {
    const tracker = createSkillUseTracker()
    const skillRoot = join(base, "skills", "review")
    const skillPath = join(skillRoot, "SKILL.md")
    tracker.recordSkillUse(
      {
        name: "review",
        path: skillPath,
        rootDir: skillRoot
      },
      { trigger: "read_file", triggerToolName: "read_file" }
    )

    let executed = 0
    let observedAdditionalContext = ""
    let observedSystemMessage = ""
    const result = await runPostSkillUseHooksForActivatedSkills({
      threadId: "thread-test",
      workspacePath: base,
      getStopContext: () => ({ usedSkills: ["review"], assistantResponse: "done" }),
      hookScope: createHookScope(),
      skillUseTracker: tracker,
      resolveHooks: () => [makeHook({ event: "PostSkillUse", matcher: "review" })],
      executeHooks: async (hooks, event, _context, onHookResult) => {
        executed += 1
        const hookResult = nonBlockingResult()
        onHookResult?.(event, hooks[0], hookResult)
        return hookResult
      },
      onHookResult: (_event, _hook, hookResult) => {
        observedAdditionalContext = hookResult.additionalContext ?? ""
        observedSystemMessage = hookResult.systemMessage ?? ""
      }
    })

    assert(executed === 1, `expected one PostSkillUse execution, got ${executed}`)
    assert(result === null, "non-blocking PostSkillUse output should not affect completion")
    assert(
      tracker.getPendingPostSkillUses().length === 0,
      "non-blocking PostSkillUse should still be marked fired"
    )
    assert(
      observedAdditionalContext === "extra context",
      "additionalContext should remain observable through hook result callback"
    )
    assert(
      observedSystemMessage === "notice",
      "systemMessage should remain observable through hook result callback"
    )
  })
}

async function testAbortSkipsCompletionHooks(): Promise<void> {
  const abortController = new AbortController()
  abortController.abort()
  let postCalls = 0
  let stopCalls = 0

  const ok = await runCompletionHooksWithRevision({
    threadId: "thread-abort",
    workspacePath: "workspace",
    abortSignal: abortController.signal,
    getStopContext: () => ({ assistantResponse: "aborted" }),
    hookScope: createHookScope(),
    runRevision: async () => {},
    sendNotice: () => {},
    sendError: () => {},
    maxRevisionAttempts: 2,
    revisionPromptPrefix: "[[TEST]]",
    runPostSkillUseHooks: async () => {
      postCalls += 1
      return null
    },
    runStopHooks: async () => {
      stopCalls += 1
      return null
    }
  })

  assert(ok === "failed", `aborted completion should return "failed", got ${ok}`)
  assert(postCalls === 0, `aborted turn should not run PostSkillUse, got ${postCalls}`)
  assert(stopCalls === 0, `aborted turn should not run Stop, got ${stopCalls}`)
}

async function testNonBlockingPostSkillNoticeDoesNotSurface(): Promise<void> {
  const abortController = new AbortController()
  const notices: string[] = []

  const ok = await runCompletionHooksWithRevision({
    threadId: "thread-non-block-notice",
    workspacePath: "workspace",
    abortSignal: abortController.signal,
    getStopContext: () => ({ assistantResponse: "done" }),
    hookScope: createHookScope(),
    runRevision: async () => {},
    sendNotice: (message) => {
      notices.push(message)
    },
    sendError: () => {},
    maxRevisionAttempts: 2,
    revisionPromptPrefix: "[[TEST]]",
    runPostSkillUseHooks: async () => nonBlockingResult(),
    runStopHooks: async () => null
  })

  assert(ok === "passed", `completion should pass with non-blocking PostSkillUse output, got ${ok}`)
  assert(
    notices.length === 0,
    `non-blocking PostSkillUse systemMessage should not send notices, got ${notices.join("\n")}`
  )
}

async function testPostAndStopRevisionCountsAreIndependent(): Promise<void> {
  const abortController = new AbortController()
  let postBlocksRemaining = 2
  let stopBlocksRemaining = 2
  const revisions: string[] = []
  const errors: string[] = []

  const ok = await runCompletionHooksWithRevision({
    threadId: "thread-revision",
    workspacePath: "workspace",
    abortSignal: abortController.signal,
    getStopContext: () => ({ assistantResponse: "draft" }),
    hookScope: createHookScope(),
    runRevision: async (prompt) => {
      revisions.push(prompt)
    },
    sendNotice: () => {},
    sendError: (message) => {
      errors.push(message)
    },
    maxRevisionAttempts: 2,
    revisionPromptPrefix: "[[TEST]]",
    runPostSkillUseHooks: async () => {
      if (postBlocksRemaining <= 0) return null
      postBlocksRemaining -= 1
      return blockingResult("post revision")
    },
    runStopHooks: async () => {
      if (stopBlocksRemaining <= 0) return null
      stopBlocksRemaining -= 1
      return blockingResult("stop revision")
    }
  })

  assert(
    ok === "passed",
    `completion should pass after independent PostSkillUse and Stop revisions, got ${ok}`
  )
  assert(errors.length === 0, `expected no errors, got ${errors.join("\n")}`)
  assert(revisions.length === 4, `expected four revision prompts, got ${revisions.length}`)
  assert(
    revisions.filter((prompt) => prompt.includes("Hook type: PostSkillUse")).length === 2,
    "expected two PostSkillUse revision prompts"
  )
  assert(
    revisions.filter((prompt) => prompt.includes("Hook type: Stop")).length === 2,
    "expected two Stop revision prompts"
  )
}

async function testPostSkillUseContinueFalseStopsTurnImmediately(): Promise<void> {
  const abortController = new AbortController()
  const notices: string[] = []
  const errors: string[] = []
  let revisionCalls = 0
  let stopCalls = 0

  const ok = await runCompletionHooksWithRevision({
    threadId: "thread-prevent",
    workspacePath: "workspace",
    abortSignal: abortController.signal,
    getStopContext: () => ({ assistantResponse: "draft" }),
    hookScope: createHookScope(),
    runRevision: async () => {
      revisionCalls += 1
    },
    sendNotice: (m) => notices.push(m),
    sendError: (m) => errors.push(m),
    maxRevisionAttempts: 5,
    revisionPromptPrefix: "[[TEST]]",
    runPostSkillUseHooks: async () => preventContinuationResult("user policy violated"),
    runStopHooks: async () => {
      stopCalls += 1
      return null
    }
  })

  assert(ok === "halted", `continue:false in PostSkillUse must halt the turn, got ${ok}`)
  assert(revisionCalls === 0, "continue:false must skip revision flow entirely")
  assert(stopCalls === 0, "continue:false must short-circuit before Stop hooks fire")
  assert(errors.length === 0, `continue:false should not raise errors, got ${errors.join("\n")}`)
  assert(
    notices.some((m) => m.includes("user policy violated")),
    `expected stop notice with reason; got ${notices.join("\n")}`
  )
}

async function testPreventContinuationBeatsRevisionOnSameHook(): Promise<void> {
  const abortController = new AbortController()
  const errors: string[] = []
  let revisionCalls = 0

  // A hook that asks for both revision AND halt — halt must win.
  const conflicting: HookResult = {
    exitCode: 0,
    stdout: "",
    stderr: "",
    blocked: true,
    decision: "block",
    reason: "needs revision",
    continue: false,
    stopReason: "actually halt"
  }

  const ok = await runCompletionHooksWithRevision({
    threadId: "thread-priority",
    workspacePath: "workspace",
    abortSignal: abortController.signal,
    getStopContext: () => ({ assistantResponse: "draft" }),
    hookScope: createHookScope(),
    runRevision: async () => {
      revisionCalls += 1
    },
    sendNotice: () => {},
    sendError: (m) => errors.push(m),
    maxRevisionAttempts: 3,
    revisionPromptPrefix: "[[TEST]]",
    runStopHooks: async () => conflicting
  })

  assert(ok === "halted", `halt+revision combo must halt the turn, got ${ok}`)
  assert(revisionCalls === 0, "halt priority should suppress revision")
  assert(errors.length === 0, "halt should not surface as error")
}

async function run(): Promise<void> {
  await testPostSkillUseMarksFiredEvenWhenBlocking()
  console.log("PASS C1 blocking PostSkillUse is marked fired")
  await testNonBlockingPostSkillOutputIsObservableOnly()
  console.log("PASS C1b non-blocking PostSkillUse output is observable-only")
  await testAbortSkipsCompletionHooks()
  console.log("PASS C2 abort skips completion hooks")
  await testNonBlockingPostSkillNoticeDoesNotSurface()
  console.log("PASS C2b non-blocking PostSkillUse notice does not surface")
  await testPostAndStopRevisionCountsAreIndependent()
  console.log("PASS C3 PostSkillUse and Stop revision counts are independent")
  await testPostSkillUseContinueFalseStopsTurnImmediately()
  console.log("PASS C4 PostSkillUse continue:false stops the turn immediately")
  await testPreventContinuationBeatsRevisionOnSameHook()
  console.log("PASS C5 prevent-continuation has priority over revision on same hook")
}

run().catch((err: Error) => {
  console.error(`FAIL ${err.message}`)
  console.error(err.stack)
  process.exit(1)
})
