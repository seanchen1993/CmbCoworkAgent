/**
 * Focused tests for tool-call display status helpers.
 *
 * Run:
 *   npx -y tsx tests/tool-call-display-state.spec.ts
 */

import { isResultlessCompletedToolCall } from "../src/renderer/src/lib/tool-call-display-state"

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}

async function testWriteTodosCanCompleteWithoutToolMessage(): Promise<void> {
  assert(
    isResultlessCompletedToolCall({
      name: "write_todos",
      args: { todos: [{ id: "1", content: "Inspect issue", status: "completed" }] }
    }),
    "write_todos carries the rendered task state in args and can complete without a ToolMessage"
  )
}

async function testOtherToolsStillRequireResults(): Promise<void> {
  assert(
    !isResultlessCompletedToolCall({
      name: "read_file",
      args: { file_path: "README.md" }
    }),
    "ordinary tools should still require a tool result to avoid being marked interrupted"
  )
}

async function run(): Promise<void> {
  await testWriteTodosCanCompleteWithoutToolMessage()
  console.log("PASS write_todos can complete without a tool message")
  await testOtherToolsStillRequireResults()
  console.log("PASS ordinary tools still require results")
}

run().catch((error: Error) => {
  console.error(`FAIL ${error.message}`)
  process.exit(1)
})
