import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { expect, it, vi } from "vitest"

function deletionHandler(scope: Record<string, unknown>): (event: object, id: string) => Promise<void> {
  const source = ts.createSourceFile("threads.ts",
    readFileSync(new URL("./threads.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true)
  let callback: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "performThreadDeletion")
      callback = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(source)
  expect(callback).toBeDefined()
  return runInNewContext(ts.transpileModule(`(${callback!.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText, { console: { log: () => {} }, ...scope })
}

it.each([false, true])("restores the prior disposal mark %s when Mods admission fails", async (prior) => {
  for (const stage of ["manager", "prepare", "database"] as const) {
    const marks = new Set(prior ? ["thread"] : [])
    const failure = Error(`failed ${stage}`)
    const finish = vi.fn()
    const rollback = vi.fn((id: string, previous: boolean) => {
      if (previous) marks.add(id)
      else marks.delete(id)
    })
    const getDb = vi.fn(() => { throw failure })
    const remove = deletionHandler({
      isWorkflowThreadMarkedDisposed: (id: string) => marks.has(id),
      markWorkflowThreadDisposed: (id: string) => marks.add(id),
      rollbackWorkflowThreadDisposal: rollback,
      getModsManager: () => {
        if (stage === "manager") throw failure
        return { prepareFunctionEnd: () => {
          if (stage === "prepare") throw failure
          return { finish }
        } }
      }, getDb
    })
    await expect(remove({}, "thread")).rejects.toBe(failure)
    expect(rollback).toHaveBeenCalledExactlyOnceWith("thread", prior)
    expect(marks.has("thread")).toBe(prior)
    expect(getDb).toHaveBeenCalledTimes(stage === "database" ? 1 : 0)
    expect(finish).toHaveBeenCalledTimes(stage === "database" ? 1 : 0)
  }
})
