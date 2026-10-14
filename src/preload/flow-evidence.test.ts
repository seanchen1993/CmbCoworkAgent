import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { expect, it, vi } from "vitest"

it("forwards only thread and run identity for a read-only evidence query", async () => {
  const text = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  const source = ts.createSourceFile("index.ts", text, ts.ScriptTarget.Latest, true)
  const methods: ts.PropertyAssignment[] = []
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === "flowEvidence")
      methods.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  expect(methods).toHaveLength(1)
  const response = Promise.resolve({ runId: "run" })
  const invoke = vi.fn(() => response)
  const method = runInNewContext(
    ts.transpile(`const bridge = ${methods[0].initializer.getText(source)}; bridge`, {
      target: ts.ScriptTarget.ES2022
    }),
    { ipcRenderer: { invoke } }
  ) as (thread: string, run: string) => Promise<unknown>
  expect(method("thread", "run")).toBe(response)
  expect(invoke).toHaveBeenCalledExactlyOnceWith("mods:flow-evidence", {
    threadId: "thread",
    runId: "run"
  })
})
