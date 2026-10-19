import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"
import ts from "typescript"

/** Real host reader bodies for isolated IPC VMs. These cases have ordinary persisted threads;
 * only the two native child-owner registries are absent, never the original DB error/getter.
 */
export function nativeChildThreadReaders<T>(getThreadCore: (threadId: string) => T | undefined): {
  readNativeChildModsContext(threadId: string): undefined
  readNativeChildModsThread(threadId: string): { child: undefined; thread: T | undefined }
} {
  const source = ts.createSourceFile(
    "native-child-mods-context.ts",
    readFileSync(resolve("src/main/agent/native-child-mods-context.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true
  )
  const names = ["readNativeChildModsContext", "readNativeChildModsThread"]
  const declarations = source.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && !!node.name && names.includes(node.name.text)
  )
  if (declarations.length !== 2) throw Error("Missing actual native child reader")
  const printer = ts.createPrinter()
  const expressions = declarations.map((node) => {
    if (!node.name || !node.body) throw Error("Missing actual native child reader body")
    const fn = ts.factory.createFunctionExpression(
      undefined,
      node.asteriskToken,
      node.name,
      node.typeParameters,
      node.parameters,
      node.type,
      node.body
    )
    return `const ${node.name.text}=(${printer.printNode(ts.EmitHint.Expression, fn, source)})`
  })
  const code = ts.transpileModule(expressions.join("\n") + `\n;({${names.join(",")}})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  return runInNewContext(code, {
    getThreadCore,
    readCoordinatorWorkerModsContext: () => undefined,
    readWorkflowChildModsContext: () => undefined
  })
}
