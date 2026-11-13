import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { expect, it, vi } from "vitest"
import { retainsFunctionSitePresentation as retains } from "./function-site-transition"
import type { ModObject } from "../../../shared/mods/types"

it("reuses exact next facts serialization without repeating whole-message stringify", () => {
  const before = JSON.stringify({ text: "x".repeat(100000), isFirstOfReply: true })
  const next = { text: "x".repeat(100000) + "\ud800 tail", isFirstOfReply: true }
  const nextKey = JSON.stringify(next)
  const stringify = vi.spyOn(JSON, "stringify")
  let optimizedCalls = -1, legacyCalls = -1
  const optimized: boolean[] = [], legacy: boolean[] = []
  try {
    for (let index = 0; index < 10; index++) optimized.push(retains("AssistantMessage", before, next, nextKey))
    optimizedCalls = stringify.mock.calls.filter(call => call[0] === next).length
    stringify.mockClear()
    for (let index = 0; index < 10; index++) legacy.push(retains("AssistantMessage", before, next))
    legacyCalls = stringify.mock.calls.filter(call => call[0] === next).length
  } finally { stringify.mockRestore() }
  expect(optimized).toEqual(Array(10).fill(true))
  expect(legacy).toEqual(optimized)
  expect(optimizedCalls).toBe(0)
  expect(legacyCalls).toBe(10)
})

it("preserves all facts, exact UTF-16 content and replacement decisions with a supplied key", () => {
  const old = { text: "protected\ud800", isFirstOfReply: true }
  const oldKey = JSON.stringify(old)
  const cases: Array<{ next: ModObject; expected: boolean }> = [
    { next: old, expected: false },
    { next: { ...old, text: old.text + " more" }, expected: true },
    { next: { ...old, text: "protected\ud801" }, expected: false },
    { next: { ...old, text: "protected\ud801 more" }, expected: false },
    { next: { ...old, text: "replacement" }, expected: false },
    { next: { ...old, text: "protected" }, expected: false },
    { next: { ...old, text: old.text + " more", isFirstOfReply: false }, expected: false },
    { next: { ...old, text: old.text + " more", extra: true }, expected: false }
  ]
  for (const { next, expected } of cases) {
    expect(retains("AssistantMessage", oldKey, next, JSON.stringify(next))).toBe(expected)
    expect(retains("AssistantMessage", oldKey, next)).toBe(expected)
  }
})

function actualPairs(relativePath: string): string[][] {
  const path = fileURLToPath(new URL(relativePath, import.meta.url))
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const pairs: string[][] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) &&
      node.expression.getText(source) === "retainsFunctionSitePresentation")
      pairs.push(node.arguments.slice(2).map(argument => argument.getText(source)))
    ts.forEachChild(node, visit)
  }
  visit(source)
  return pairs
}

it("pairs actual render, captured IPC and committed callback facts with their own exact key", () => {
  expect(actualPairs("../components/chat/FunctionSite.tsx")).toEqual([
    ["input", "inputKey"], ["input", "inputKey"],
    ["inputRef.current", "inputVersion.current.key"],
    ["capturedInput", "capturedInputKey"],
    ["inputRef.current", "inputVersion.current.key"],
    ["inputRef.current", "inputVersion.current.key"],
    ["inputRef.current", "inputVersion.current.key"],
    ["inputRef.current", "inputVersion.current.key"],
    ["inputRef.current", "currentInputKey"]
  ])
  expect(actualPairs("./function-site-presentation-controller.ts")).toEqual([
    ["input", "inputKey"], ["input.input", "input.inputKey"], ["input.input", "input.inputKey"]
  ])
})
