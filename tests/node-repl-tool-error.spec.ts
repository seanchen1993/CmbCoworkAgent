/**
 * Focused tests for layered tool-result error detection.
 *
 * Run:
 *   npx -y tsx tests/node-repl-tool-error.spec.ts
 */

import { isNodeReplToolResultExceptionContent } from "../src/renderer/src/lib/node-repl-tool-error"
import { isToolResultError } from "../src/renderer/src/lib/tool-result-error"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

async function testRecognizesNodeReplExceptionPrefixes(): Promise<void> {
  assert(
    isNodeReplToolResultExceptionContent("TypeError: tab is undefined"),
    "node_repl TypeError output should be treated as a failure"
  )
  assert(
    isNodeReplToolResultExceptionContent("RAW RESULT\nReferenceError: tab is not defined"),
    "node_repl RAW RESULT exception output should be treated as a failure"
  )
}

async function testLayeredToolResultErrorFlow(): Promise<void> {
  assert(
    isToolResultError({
      toolName: "mcp__node_repl__js",
      content: "Error: Access denied"
    }),
    "node_repl tools should route plain exception prefixes through the dedicated detector"
  )
  assert(
    !isToolResultError({
      toolName: "read_file",
      content: "Error: Access denied"
    }),
    "non-node_repl tools should not infer failures from plain error prefixes"
  )
  assert(
    !isToolResultError({
      toolName: "mcp__node_repl__js",
      content: "Completed. Error count: 0"
    }),
    "node_repl should avoid false positives for ordinary text"
  )
  assert(
    isToolResultError({
      toolName: "read_file",
      content: "ok",
      is_error: true
    }),
    "explicit upstream is_error should remain authoritative for every tool"
  )
}

async function run(): Promise<void> {
  await testRecognizesNodeReplExceptionPrefixes()
  console.log("PASS node_repl exception prefixes are recognized")
  await testLayeredToolResultErrorFlow()
  console.log("PASS tool result error detection keeps node_repl scoped")
}

run().catch((error: Error) => {
  console.error(`FAIL ${error.message}`)
  process.exit(1)
})
