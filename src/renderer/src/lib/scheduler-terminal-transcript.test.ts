import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { expect, it, vi } from "vitest"

// Execute the actual hook callback without mounting the provider's unrelated
// workspace services. Its storage-failure branch must keep the live transcript.
const source = ts.createSourceFile(
  "thread-context.tsx",
  readFileSync(new URL("./thread-context.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
)
let callback = ""
function visit(node: ts.Node): void {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(source) === "processSchedulerEvent" &&
    node.initializer &&
    ts.isCallExpression(node.initializer)
  ) {
    callback = node.initializer.arguments[0].getText(source)
  }
  ts.forEachChild(node, visit)
}
visit(source)

it.each(["done", "error", "persistence-error"])(
  "settles %s without discarding unsaved visible messages",
  (ending) => {
    expect(callback).not.toBe("")
    const live = [{ id: "a", content: "visible answer", reasoning: "visible reasoning" }]
    let state = { messages: live, scheduledTaskLoading: true }
    const reload = vi.fn(() => {
      state = { ...state, messages: [] }
    })
    const processEvent = runInNewContext(
      ts.transpileModule(`(${callback})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
        .outputText,
      {
        clearSchedulerStreamingForThread: vi.fn(),
        finalizeRunningSubagentsForStoppedStream: vi.fn(),
        updateThreadState: (_id: string, update: (state: unknown) => object) => {
          state = { ...state, ...update(state) }
        },
        loadThreadHistory: reload
      }
    )
    processEvent("thread", {
      type: ending === "done" ? "done" : "error",
      error: "failure",
      ...(ending === "persistence-error" ? { transcriptPersisted: false } : {})
    })
    expect(state.scheduledTaskLoading).toBe(false)
    expect(reload).toHaveBeenCalledTimes(ending === "persistence-error" ? 0 : 1)
    if (ending === "persistence-error") expect(state.messages).toEqual(live)
  }
)
