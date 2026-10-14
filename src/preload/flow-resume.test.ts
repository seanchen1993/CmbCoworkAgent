import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { expect, it, vi } from "vitest"

it("forwards only the explicit resume identity and reviewed source digest through preload", async () => {
  const text = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  const source = ts.createSourceFile("index.ts", text, ts.ScriptTarget.Latest, true)
  const methods: ts.PropertyAssignment[] = []
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === "flowResume")
      methods.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  expect(methods).toHaveLength(1)
  const response = Promise.resolve({ id: "reserved-child" })
  const invoke = vi.fn(() => response)
  // Execute the real bridge method without starting Electron or the rest of preload.
  const method = runInNewContext(
    ts.transpile(`const bridge = ${methods[0].initializer.getText(source)}; bridge`, {
      target: ts.ScriptTarget.ES2022
    }),
    { ipcRenderer: { invoke } }
  ) as (threadId: string, runId: string, digest: string) => Promise<unknown>
  const result = method("thread", "source", "a".repeat(64))
  expect(result).toBe(response)
  expect(invoke).toHaveBeenCalledExactlyOnceWith("mods:flow-resume", {
    threadId: "thread",
    runId: "source",
    expectedSourceDigest: "a".repeat(64)
  })
  await expect(result).resolves.toEqual({ id: "reserved-child" })
})
