/**
 * Regression tests for tool hook plumbing.
 *
 * Run:
 *   npx tsx tests/tool-hook-regression.spec.ts
 */

import { createToolHookMiddleware } from "../src/main/agent/tool-hooks.ts"
import { ToolMessage } from "@langchain/core/messages"
import { clearFailureFuseState, recordToolFailure } from "../src/main/agent/failure-fuse.ts"
import { clearFailureFiredState, markFailureFired } from "../src/main/hooks/tool-failure.ts"
import { mergeUpdatedInput } from "../src/main/hooks/updated-input.ts"
import type { HookScopeController } from "../src/main/hooks/scope.ts"

type MiddlewareRequest = {
  toolCall?: { name?: string; args?: unknown }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

function makeNoopHookScope(): HookScopeController {
  return {
    activePluginIds: new Set<string>(),
    activeSkillNames: new Set<string>(),
    activeSkillPaths: new Set<string>(),
    persistentHookKeys: new Set<string>(),
    activatePlugin() {
      return undefined
    },
    activateSkill() {
      return undefined
    },
    activatePersistentHooks() {
      return undefined
    },
    activatePersistentHookKeys() {
      return undefined
    },
    pruneActivations() {
      return undefined
    },
    snapshot() {
      return {
        activePluginIds: [],
        activeSkillNames: [],
        activeSkillPaths: [],
        persistentHookKeys: []
      }
    }
  }
}

function clearFailureFuseEnv(): void {
  delete process.env.CMB_AGENT_FAILURE_FUSE_WARN
  delete process.env.CMB_AGENT_FAILURE_FUSE_MODEL_FEEDBACK
  delete process.env.CMB_AGENT_FAIL_FAST
}

async function testMergeUpdatedInputSkipsUnsafeKeys(): Promise<void> {
  const base = {
    request: {
      headers: { a: "1" },
      body: { page: 1 }
    },
    keep: true
  }
  const updatedInput = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"prototype":{"polluted":true},"request":{"__proto__":{"nestedPolluted":true},"headers":{"b":"2"},"body":{"limit":10}},"fresh":{"__proto__":{"freshPolluted":true},"nested":{"constructor":{"prototype":{"deepPolluted":true}},"value":3},"label":"new"},"keep":false}'
  ) as Record<string, unknown>

  const merged = mergeUpdatedInput(base, updatedInput)
  const mergedRequest = merged.request as Record<string, unknown>
  const mergedHeaders = mergedRequest.headers as Record<string, unknown>
  const mergedBody = mergedRequest.body as Record<string, unknown>
  const mergedFresh = merged.fresh as Record<string, unknown>
  const mergedFreshNested = mergedFresh.nested as Record<string, unknown>

  assert(
    Object.getPrototypeOf(merged) === Object.prototype,
    "top-level merged object should stay on the plain-object prototype"
  )
  assert(
    Object.getPrototypeOf(mergedRequest) === Object.prototype,
    "nested merged object should stay on the plain-object prototype"
  )
  assert(
    Object.getPrototypeOf(mergedFresh) === Object.prototype,
    "fresh nested objects should also be sanitized to plain objects"
  )
  assert(
    !Object.prototype.hasOwnProperty.call(merged, "__proto__"),
    "unsafe __proto__ key should be skipped at the top level"
  )
  assert(
    !Object.prototype.hasOwnProperty.call(mergedRequest, "__proto__"),
    "unsafe __proto__ key should be skipped in nested merges too"
  )
  assert(!("polluted" in merged), "top-level prototype should not be polluted")
  assert(!("nestedPolluted" in mergedRequest), "nested prototype should not be polluted")
  assert(
    !Object.prototype.hasOwnProperty.call(mergedFresh, "__proto__"),
    "fresh nested objects should not keep __proto__ as an own property"
  )
  assert(
    !Object.prototype.hasOwnProperty.call(mergedFreshNested, "constructor"),
    "deep nested constructor keys should be skipped"
  )
  assert(merged.keep === false, "safe scalar updates should still apply")
  assert(mergedHeaders.b === "2", "safe nested updates should still merge")
  assert(mergedBody.limit === 10, "safe nested body updates should still merge")
  assert(mergedFresh.label === "new", "safe fresh nested values should still merge")
  assert(mergedFreshNested.value === 3, "safe deep nested values should still merge")
}

async function testWrapperToolsBypassToolHooks(): Promise<void> {
  const skippedToolNames = new Set(["search_tool", "inspect_tool", "invoke_deferred_tool"])
  const calls: Array<{ event: string; toolName: string }> = []
  const middleware = createToolHookMiddleware({
    workspacePath: "C:/workspace",
    threadId: "thread-test",
    hookScope: makeNoopHookScope(),
    resolveHooksForContext: (event, context) => {
      calls.push({ event, toolName: context.toolName })
      return []
    },
    skipToolNames: skippedToolNames
  })

  for (const toolName of skippedToolNames) {
    calls.length = 0
    let handlerCalls = 0
    const result = await middleware.wrapToolCall(
      {
        toolCall: {
          id: `${toolName}-call`,
          name: toolName,
          args: { probe: true }
        },
        state: { untouched: true }
      },
      async (request: MiddlewareRequest) => {
        handlerCalls += 1
        assert(request.toolCall?.name === toolName, "handler should receive the original tool")
        return { ok: true, toolName, args: request.toolCall?.args }
      }
    )

    assert(handlerCalls === 1, `${toolName} should still execute the tool handler`)
    assert(calls.length === 0, `${toolName} should bypass hook resolution entirely`)
    assert((result as { ok?: boolean }).ok === true, `${toolName} should return handler output`)
  }
}

async function testNonSkippedToolStillRunsHooks(): Promise<void> {
  const calls: Array<{ event: string; toolName: string }> = []
  const middleware = createToolHookMiddleware({
    workspacePath: "C:/workspace",
    threadId: "thread-test",
    hookScope: makeNoopHookScope(),
    resolveHooksForContext: (event, context) => {
      calls.push({ event, toolName: context.toolName })
      return []
    },
    skipToolNames: new Set(["search_tool", "inspect_tool", "invoke_deferred_tool"])
  })

  const result = await middleware.wrapToolCall(
    {
      toolCall: {
        id: "demo-call",
        name: "demo_tool",
        args: { probe: true }
      }
    },
    async (request: MiddlewareRequest) => ({
      ok: true,
      args: request.toolCall?.args
    })
  )

  assert(
    calls.length === 2,
    `non-skipped tools should resolve pre and post hooks, got ${calls.length}`
  )
  assert(
    calls[0]?.event === "PreToolUse",
    `expected first hook event to be PreToolUse, got ${calls[0]?.event}`
  )
  assert(
    calls[1]?.event === "PostToolUse",
    `expected second hook event to be PostToolUse, got ${calls[1]?.event}`
  )
  assert(
    (result as { ok?: boolean }).ok === true,
    "non-skipped tool should still return handler output"
  )
}

async function testFailureFuseWarnsThenStrongWarnsInAwaitedToolHookFlow(): Promise<void> {
  clearFailureFuseState()
  clearFailureFuseEnv()
  process.env.CMB_AGENT_FAILURE_FUSE_WARN = "1"
  process.env.CMB_AGENT_FAILURE_FUSE_MODEL_FEEDBACK = "1"
  const events: string[] = []
  const notices: string[] = []
  try {
    const middleware = createToolHookMiddleware({
      workspacePath: "C:/workspace",
      threadId: "thread-fuse",
      hookTurnId: "turn-fuse",
      hookScope: makeNoopHookScope(),
      resolveHooksForContext: (event) => {
        events.push(event)
        return []
      },
      onToolFailureDecision: ({ toolName, toolCallId, toolArgs, signal }) =>
        recordToolFailure({
          threadId: "thread-fuse",
          turnId: "turn-fuse",
          toolName,
          toolCallId,
          toolArgs,
          signal,
          mode: "warn"
        }),
      onFailureFuseNotice: (decision) => {
        notices.push(decision.action)
      }
    })

    const request = {
      toolCall: {
        id: "execute-call",
        name: "execute",
        args: { command: "npm test" }
      }
    }
    const failingHandler = async () => "boom\n[Command failed with exit code 1]"

    const first = await middleware.wrapToolCall(request, failingHandler)
    assert(
      String(first).includes("[Command failed with exit code 1]"),
      "first failure should still return the tool result"
    )

    const second = await middleware.wrapToolCall(request, failingHandler)
    assert(
      String(second).includes("[Failure fuse warning]"),
      "second same failure should inject a failure fuse warning"
    )

    const third = await middleware.wrapToolCall(request, failingHandler)
    assert(
      String(third).includes("[Failure fuse strong warning]"),
      "third same failure should inject a strong failure fuse warning"
    )
    assert(
      events.filter((event) => event === "PostToolUse").length === 3,
      "PostToolUse should observe the failure that trips the strong reminder"
    )
    assert(
      notices.join(",") === "warn,strong_warn",
      `expected user-visible notices for warn/strong_warn only, got ${notices.join(",")}`
    )
  } finally {
    clearFailureFuseEnv()
  }
}

async function testFailureFuseUserNoticeDoesNotInjectModelFeedback(): Promise<void> {
  clearFailureFuseState()
  clearFailureFuseEnv()
  process.env.CMB_AGENT_FAILURE_FUSE_WARN = "1"
  const notices: string[] = []
  try {
    const middleware = createToolHookMiddleware({
      workspacePath: "C:/workspace",
      threadId: "thread-fuse-notice-only",
      hookTurnId: "turn-fuse-notice-only",
      hookScope: makeNoopHookScope(),
      resolveHooksForContext: () => [],
      onToolFailureDecision: ({ toolName, toolCallId, toolArgs, signal }) =>
        recordToolFailure({
          threadId: "thread-fuse-notice-only",
          turnId: "turn-fuse-notice-only",
          toolName,
          toolCallId,
          toolArgs,
          signal,
          mode: "warn"
        }),
      onFailureFuseNotice: (decision) => {
        notices.push(decision.action)
      }
    })
    const request = {
      toolCall: {
        id: "notice-only-call",
        name: "execute",
        args: { command: "npm test" }
      }
    }
    const failingHandler = async () => "boom\n[Command failed with exit code 1]"

    await middleware.wrapToolCall(request, failingHandler)
    const second = await middleware.wrapToolCall(request, failingHandler)

    assert(
      !String(second).includes("[Failure fuse warning]"),
      "user-only reminder should not inject feedback into the model-visible tool result"
    )
    assert(
      notices.join(",") === "warn",
      `expected a user-visible warning notice only, got ${notices.join(",")}`
    )
  } finally {
    clearFailureFuseEnv()
  }
}

async function testFailureFuseModelFeedbackDoesNotNotifyUser(): Promise<void> {
  clearFailureFuseState()
  clearFailureFuseEnv()
  process.env.CMB_AGENT_FAILURE_FUSE_WARN = "0"
  process.env.CMB_AGENT_FAILURE_FUSE_MODEL_FEEDBACK = "1"
  const notices: string[] = []
  try {
    const middleware = createToolHookMiddleware({
      workspacePath: "C:/workspace",
      threadId: "thread-fuse-model-only",
      hookTurnId: "turn-fuse-model-only",
      hookScope: makeNoopHookScope(),
      resolveHooksForContext: () => [],
      onToolFailureDecision: ({ toolName, toolCallId, toolArgs, signal }) =>
        recordToolFailure({
          threadId: "thread-fuse-model-only",
          turnId: "turn-fuse-model-only",
          toolName,
          toolCallId,
          toolArgs,
          signal,
          mode: "warn"
        }),
      onFailureFuseNotice: (decision) => {
        notices.push(decision.action)
      }
    })
    const request = {
      toolCall: {
        id: "model-only-call",
        name: "execute",
        args: { command: "npm test" }
      }
    }
    const failingHandler = async () => "boom\n[Command failed with exit code 1]"

    await middleware.wrapToolCall(request, failingHandler)
    const second = await middleware.wrapToolCall(request, failingHandler)

    assert(
      String(second).includes("[Failure fuse warning]"),
      "model-feedback-only mode should inject feedback into the model-visible tool result"
    )
    assert(
      notices.length === 0,
      `model-feedback-only mode should not send user notices, got ${notices.join(",")}`
    )
  } finally {
    clearFailureFuseEnv()
  }
}

async function testObjectToolFailureFeedsFailureFuse(): Promise<void> {
  clearFailureFuseState()
  const actions: string[] = []
  let successCount = 0
  const middleware = createToolHookMiddleware({
    workspacePath: "C:/workspace",
    threadId: "thread-object-fuse",
    hookTurnId: "turn-object-fuse",
    hookScope: makeNoopHookScope(),
    resolveHooksForContext: () => [],
    onToolFailureDecision: ({ toolName, toolCallId, toolArgs, signal }) => {
      const decision = recordToolFailure({
        threadId: "thread-object-fuse",
        turnId: "turn-object-fuse",
        toolName,
        toolCallId,
        toolArgs,
        signal,
        mode: "warn"
      })
      actions.push(decision.action)
      return decision
    },
    onToolSuccess: () => {
      successCount += 1
    }
  })

  const request = {
    toolCall: {
      id: "object-failure-call",
      name: "object_tool",
      args: { probe: true }
    }
  }
  const failingHandler = async () => ({ success: false, error: "object failed" })

  await middleware.wrapToolCall(request, failingHandler)
  await middleware.wrapToolCall(request, failingHandler)
  await middleware.wrapToolCall(request, failingHandler)

  assert(
    actions.join(",") === "observe,warn,strong_warn",
    `unexpected fuse actions: ${actions.join(",")}`
  )
  assert(successCount === 0, "object-shaped failures should not be recorded as successes")
}

async function testRecoveredToolMessageErrorFeedsFailureFuse(): Promise<void> {
  clearFailureFuseState()
  clearFailureFiredState()
  const actions: string[] = []
  let successCount = 0
  const middleware = createToolHookMiddleware({
    workspacePath: "C:/workspace",
    threadId: "thread-tool-message-fuse",
    hookTurnId: "turn-tool-message-fuse",
    hookScope: makeNoopHookScope(),
    resolveHooksForContext: () => [],
    onToolFailureDecision: ({ toolName, toolCallId, toolArgs, signal }) => {
      const decision = recordToolFailure({
        threadId: "thread-tool-message-fuse",
        turnId: "turn-tool-message-fuse",
        toolName,
        toolCallId,
        toolArgs,
        signal,
        mode: "warn"
      })
      actions.push(decision.action)
      return decision
    },
    onToolSuccess: () => {
      successCount += 1
    }
  })

  const request = {
    toolCall: {
      id: "tool-message-failure-call",
      name: "throwing_tool",
      args: { probe: true }
    }
  }
  const failingHandler = async () =>
    new ToolMessage({
      content: "Tool execution failed: boom",
      tool_call_id: "tool-message-failure-call",
      name: "throwing_tool",
      status: "error"
    })

  await middleware.wrapToolCall(request, failingHandler)
  await middleware.wrapToolCall(request, failingHandler)
  await middleware.wrapToolCall(request, failingHandler)

  assert(
    actions.join(",") === "observe,warn,strong_warn",
    `unexpected fuse actions: ${actions.join(",")}`
  )
  assert(successCount === 0, "ToolMessage status=error should not be recorded as success")
}

async function testRecoveredThrowPathToolMessageDoesNotDoubleCount(): Promise<void> {
  clearFailureFuseState()
  clearFailureFiredState()
  const actions: string[] = []
  const toolCallId = "already-recorded-throw-call"
  markFailureFired(toolCallId)
  const middleware = createToolHookMiddleware({
    workspacePath: "C:/workspace",
    threadId: "thread-tool-message-dedupe",
    hookTurnId: "turn-tool-message-dedupe",
    hookScope: makeNoopHookScope(),
    resolveHooksForContext: () => [],
    onToolFailureDecision: ({ toolName, toolCallId, toolArgs, signal }) => {
      const decision = recordToolFailure({
        threadId: "thread-tool-message-dedupe",
        turnId: "turn-tool-message-dedupe",
        toolName,
        toolCallId,
        toolArgs,
        signal,
        mode: "warn"
      })
      actions.push(decision.action)
      return decision
    }
  })

  await middleware.wrapToolCall(
    {
      toolCall: {
        id: toolCallId,
        name: "throwing_tool",
        args: { probe: true }
      }
    },
    async () =>
      new ToolMessage({
        content: "Tool execution failed: boom",
        tool_call_id: toolCallId,
        name: "throwing_tool",
        status: "error"
      })
  )

  assert(
    actions.length === 0,
    `already-recorded throw-path ToolMessage should not count again, got ${actions.join(",")}`
  )
  clearFailureFiredState()
}

async function run(): Promise<void> {
  await testMergeUpdatedInputSkipsUnsafeKeys()
  console.log("PASS R1 mergeUpdatedInput skips unsafe keys")
  await testWrapperToolsBypassToolHooks()
  console.log("PASS R2 wrapper tools bypass outer tool hooks")
  await testNonSkippedToolStillRunsHooks()
  console.log("PASS R3 non-skipped tools still run outer tool hooks")
  await testFailureFuseWarnsThenStrongWarnsInAwaitedToolHookFlow()
  console.log("PASS R4 failure fuse warns then strong-warns in awaited tool hook flow")
  await testFailureFuseUserNoticeDoesNotInjectModelFeedback()
  console.log("PASS R5 user-only failure fuse notice does not inject model feedback")
  await testFailureFuseModelFeedbackDoesNotNotifyUser()
  console.log("PASS R6 model-only failure fuse feedback does not notify user")
  await testObjectToolFailureFeedsFailureFuse()
  console.log("PASS R7 object-shaped tool failures feed failure fuse")
  await testRecoveredToolMessageErrorFeedsFailureFuse()
  console.log("PASS R8 recovered ToolMessage status=error failures feed failure fuse")
  await testRecoveredThrowPathToolMessageDoesNotDoubleCount()
  console.log("PASS R9 recovered throw-path ToolMessage failures do not double-count")
}

run().catch((err: Error) => {
  console.error(`FAIL ${err.message}`)
  console.error(err.stack)
  process.exit(1)
})
