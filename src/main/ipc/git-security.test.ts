import { readFileSync } from "node:fs"
import * as ts from "typescript"
import { describe, expect, it } from "vitest"

const sourceText = readFileSync(new URL("./git.ts", import.meta.url), "utf8")
const sourceFile = ts.createSourceFile(
  "git.ts",
  sourceText,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS
)

function collectStringArguments(
  matchesCall: (call: ts.CallExpression) => boolean
): Array<string | null> {
  const values: Array<string | null> = []

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && matchesCall(node)) {
      const firstArgument = node.arguments[0]
      values.push(firstArgument && ts.isStringLiteral(firstArgument) ? firstArgument.text : null)
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return values
}

describe("Git IPC command surface", () => {
  it("does not register raw command-string channels", () => {
    const channels = collectStringArguments(
      (call) =>
        ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "handle"
    )

    expect(channels).toContain("git-status")
    expect(channels).toContain("git:currentBranch")
    expect(channels).not.toContain("execute-command")
    expect(channels).not.toContain("execute-git-command")
  })

  it("pins every low-level command execution to the git executable", () => {
    const executables = collectStringArguments(
      (call) => ts.isIdentifier(call.expression) && call.expression.text === "execFileAsync"
    )

    expect(executables).toEqual(["git"])
  })
})
