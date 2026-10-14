import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { expect, it, vi } from "vitest"

it("forwards optional reviewed workspace without changing legacy Flow start payload", async () => {
  const source = ts.createSourceFile(
    "index.ts",
    readFileSync(new URL("./index.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true
  )
  const methods: ts.PropertyAssignment[] = []
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === "flowStart")
      methods.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  expect(methods).toHaveLength(1)
  const invoke = vi.fn(async () => ({ id: "run" }))
  const method = runInNewContext(
    ts.transpile(`const bridge = ${methods[0].initializer.getText(source)}; bridge`, {
      target: ts.ScriptTarget.ES2022
    }),
    { ipcRenderer: { invoke } }
  )
  await method("thread", "flow", 1)
  expect(invoke).toHaveBeenLastCalledWith("mods:flow-start", {
    threadId: "thread",
    flowId: "flow",
    revision: 1
  })
  await method("thread", "flow", 1, undefined, "reviewed-project")
  expect(invoke).toHaveBeenLastCalledWith("mods:flow-start", {
    threadId: "thread",
    flowId: "flow",
    revision: 1,
    expectedWorkspace: "reviewed-project"
  })
})
