import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { describe, expect, it } from "vitest"

function findNestedNativeButtons(sourcePath: string): number[] {
  const source = ts.createSourceFile(
    sourcePath,
    readFileSync(sourcePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const nestedLines: number[] = []

  const visit = (node: ts.Node, insideButton: boolean): void => {
    const isButton =
      ts.isJsxElement(node) &&
      ts.isIdentifier(node.openingElement.tagName) &&
      node.openingElement.tagName.text === "button"
    if (isButton && insideButton) {
      nestedLines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1)
    }
    node.forEachChild((child) => visit(child, insideButton || isButton))
  }
  visit(source, false)
  return nestedLines
}

describe("native button structure", () => {
  it.each([
    "../renderer/src/components/chat/MessageBubble.tsx",
    "../renderer/src/components/tabs/TabBar.tsx"
  ])("does not nest interactive buttons in %s", (relativePath) => {
    const sourcePath = fileURLToPath(new URL(relativePath, import.meta.url))
    expect(findNestedNativeButtons(sourcePath)).toEqual([])
  })
})
