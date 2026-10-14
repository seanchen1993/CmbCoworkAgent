import { readFileSync } from "node:fs"
import { createContext, runInContext } from "node:vm"
import ts from "typescript"
import { expect, it } from "vitest"

// Exercise the actual provider's workspace publication and details-hydration blocks without
// mounting its unrelated stream/model/IPC subscriptions. AST selection keeps the fence under test.
const source = readFileSync(new URL("./thread-context.tsx", import.meta.url), "utf8")
const tree = ts.createSourceFile(
  "thread-context.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
)
function block(condition: string): string {
  let found = ""
  function visit(node: ts.Node) {
    if (ts.isIfStatement(node) && node.expression.getText(tree).includes(condition)) {
      if (found) throw Error("AMBIGUOUS_WORKSPACE_FENCE")
      found = node.getText(tree)
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  if (!found) throw Error("MISSING_WORKSPACE_FENCE")
  return found
}
function fixture() {
  const applied: string[] = []
  const context = createContext({
    threadId: "thread",
    workspaceStateGenerationRef: { current: {} },
    useAppStore: { getState: () => ({ syncThreadWorkspaceSummary: () => {} }) },
    actions: { setWorkspacePath: (value: string) => applied.push(value) }
  })
  const code = `globalThis.confirm = (path) => {
    const updates = { workspacePath: path }, current = { workspacePath: "A" };
    ${block("updates.workspacePath !== undefined")}
  };
  globalThis.hydrate = async (details) => {
    const workspaceHydrationGeneration = workspaceStateGenerationRef.current[threadId] ?? 0;
    const metadata = await details;
    ${block("workspaceHydrationGeneration")}
  };`
  runInContext(ts.transpile(code, { target: ts.ScriptTarget.ES2022 }), context)
  return {
    applied,
    confirm: context.confirm as (path: string) => void,
    hydrate: context.hydrate as (details: Promise<{ workspacePath: string }>) => Promise<void>
  }
}
it("a same-value confirmed selection invalidates older thread details", async () => {
  const f = fixture(),
    old = Promise.withResolvers<{ workspacePath: string }>()
  const loading = f.hydrate(old.promise)
  f.confirm("A")
  old.resolve({ workspacePath: "B" })
  await loading
  expect(f.applied).toEqual([])
})
it("allows current hydration but rejects an ABA selection's old details", async () => {
  const f = fixture()
  await f.hydrate(Promise.resolve({ workspacePath: "A" }))
  const old = Promise.withResolvers<{ workspacePath: string }>()
  const loading = f.hydrate(old.promise)
  f.confirm("B")
  f.confirm("A")
  old.resolve({ workspacePath: "C" })
  await loading
  expect(f.applied).toEqual(["A"])
})
