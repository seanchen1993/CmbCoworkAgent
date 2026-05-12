/**
 * Regression tests for tool hook plumbing.
 *
 * Run:
 *   npx tsx tests/tool-hook-regression.spec.ts
 */

import { createToolHookMiddleware } from "../src/main/agent/tool-hooks.ts"
import { mergeUpdatedInput } from "../src/main/hooks/updated-input.ts"
import type { HookScopeController } from "../src/main/hooks/scope.ts"

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
      async (request: any) => {
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
    async (request: any) => ({
      ok: true,
      args: request.toolCall?.args
    })
  )

  assert(calls.length === 2, `non-skipped tools should resolve pre and post hooks, got ${calls.length}`)
  assert(calls[0]?.event === "PreToolUse", `expected first hook event to be PreToolUse, got ${calls[0]?.event}`)
  assert(calls[1]?.event === "PostToolUse", `expected second hook event to be PostToolUse, got ${calls[1]?.event}`)
  assert((result as { ok?: boolean }).ok === true, "non-skipped tool should still return handler output")
}

async function run(): Promise<void> {
  await testMergeUpdatedInputSkipsUnsafeKeys()
  console.log("PASS R1 mergeUpdatedInput skips unsafe keys")
  await testWrapperToolsBypassToolHooks()
  console.log("PASS R2 wrapper tools bypass outer tool hooks")
  await testNonSkippedToolStillRunsHooks()
  console.log("PASS R3 non-skipped tools still run outer tool hooks")
}

run().catch((err: Error) => {
  console.error(`FAIL ${err.message}`)
  console.error(err.stack)
  process.exit(1)
})
