import { readFileSync } from "node:fs"
import ts from "typescript"

/** Executes the original native IPC callback, without loading unrelated Electron singletons. */
export function actualAgentCancelHandler(context: Record<string, unknown>):
  (event: { sender: object }, input: { threadId: string; cancelWorkers?: boolean }) => Promise<boolean> {
  const path = new URL("../../src/main/ipc/agent.ts", import.meta.url)
  const source = ts.createSourceFile("agent.ts", readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest, true)
  let callback: ts.Expression | undefined
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(source) === "ipcMain" &&
        node.expression.name.text === "handle" &&
        ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === "agent:cancel") {
      if (callback) throw Error("Duplicate original agent:cancel callback")
      callback = node.arguments[1]
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!callback || !ts.isArrowFunction(callback)) throw Error("Original agent:cancel callback missing")
  const code = ts.transpileModule(`const callback = ${callback.getText(source)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  return new Function(...Object.keys(context), `${code}\nreturn callback`)(...Object.values(context))
}
