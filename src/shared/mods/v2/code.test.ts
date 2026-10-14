import { expect, it } from "vitest"
import { functionCodeRows, functionCodeLanguage, functionCodeView } from "./code"
import { validateFunctionTree } from "./ui"

it("renders unified hunks with independent old/new gutters and skips file metadata", () => {
  const source =
    "--- a/order.ts\n+++ b/order.ts\n@@ -2,2 +2,3 @@ export\n stable\n-old\n+new\n+more\n\\ No newline at end of file\n"
  expect(functionCodeRows({ source, format: "diff", startLine: 99 })).toEqual([
    { kind: "header", text: "@@ -2,2 +2,3 @@ export" },
    { kind: "context", text: "stable", oldLine: 2, newLine: 2 },
    { kind: "remove", text: "old", oldLine: 3 },
    { kind: "add", text: "new", newLine: 3 },
    { kind: "add", text: "more", newLine: 4 }
  ])
  expect(() =>
    validateFunctionTree({ type: "Code", props: { source, format: "diff" } })
  ).not.toThrow()
})

it("accepts zero length sides, shorthand counts and multiple hunks", () => {
  expect(
    functionCodeRows({ source: "@@ -0,0 +1 @@\n+one\n@@ -3 +4,0 @@\n-three", format: "diff" })
  ).toEqual([
    { kind: "header", text: "@@ -0,0 +1 @@" },
    { kind: "add", text: "one", newLine: 1 },
    { kind: "header", text: "@@ -3 +4,0 @@" },
    { kind: "remove", text: "three", oldLine: 3 }
  ])
})

it("falls back to plain unnumbered source for malformed diffs", () => {
  for (const source of [
    "plain source",
    "--- a\n+++ b",
    "@@ -1 +1 @@\n-old",
    "@@ -1 +1 @@\n+new",
    "@@ -1 +1 @@\n same\n extra",
    "@@ -1 +1 @@\nmissing marker",
    "@@ -99999999999999999 +1 @@\n-old\n+new",
    "@@ -1,0 +1,0 @@",
    "@@ -1 +1 @@\n-x\n+x\ntrailing",
    "+".repeat(10001)
  ])
    expect(functionCodeView({ source, format: "diff", startLine: 17 })).toEqual({
      source,
      diff: false,
      diffFallback: true,
      rows: source.split("\n").map((text) => ({ kind: "source", text }))
    })
})

it("accepts long sources while preserving full validation and the original transport limit", () => {
  const source = "界".repeat(120000)
  const props = { source, startLine: 42 }
  expect(functionCodeView(props).source).toBe(source.slice(0, 100000))
  expect(props.source).toBe(source)
  expect(() => validateFunctionTree({ type: "Code", props })).not.toThrow()
  expect(() =>
    validateFunctionTree({ type: "Code", props: { source: source + "\u0000" } })
  ).toThrow("MODS_UI_TREE_INVALID")
  expect(() => functionCodeView({ source: source + "\u0000" })).toThrow("MODS_UI_CODE_INVALID")
  expect(() =>
    validateFunctionTree({ type: "Code", props: { source: "x".repeat(1024 * 1024) } })
  ).toThrow()
})

it("falls back safely when the display boundary cuts through a valid diff hunk", () => {
  const source =
    "@@ -0,0 +1,2000 @@\n" + Array.from({ length: 2000 }, () => "+" + "b".repeat(59)).join("\n")
  const props = { source, format: "diff", startLine: 99 }
  const view = functionCodeView(props)
  expect(view.source).toBe(source.slice(0, 100000))
  expect(view.diff).toBe(false)
  expect(view.diffFallback).toBe(true)
  expect(
    view.rows.every(
      (row) => row.kind === "source" && row.oldLine === undefined && row.newLine === undefined
    )
  ).toBe(true)
  expect(props.source).toBe(source)
})

it("keeps a truncated long diff line when its declared hunk counts still parse", () => {
  const source = "@@ -1 +1 @@\n-" + "a".repeat(60000) + "\n+" + "b".repeat(60000)
  const view = functionCodeView({ source, format: "diff" })
  expect(view.source).toBe(source.slice(0, 100000))
  expect(view.diff).toBe(true)
  expect(view.diffFallback).toBe(false)
  expect(view.rows.map((row) => row.kind)).toEqual(["header", "remove", "add"])
})

it("numbers source only on request and resolves language without touching the path", () => {
  expect(functionCodeRows({ source: "one\ntwo", startLine: 7 })).toEqual([
    { kind: "source", text: "one", newLine: 7 },
    { kind: "source", text: "two", newLine: 8 }
  ])
  expect(functionCodeRows({ source: "plain" })).toEqual([{ kind: "source", text: "plain" }])
  expect(functionCodeLanguage({ source: "", path: "never/read/private.py" })).toBe("python")
  expect(functionCodeLanguage({ source: "", path: "file.py", language: "ts" })).toBe("typescript")
  expect(functionCodeLanguage({ source: "#!/bin/bash\necho ok" })).toBe("bash")
  expect(functionCodeLanguage({ source: "", language: "unregistered" })).toBeNull()
  expect(functionCodeLanguage({ source: "", language: "constructor" })).toBeNull()
})
