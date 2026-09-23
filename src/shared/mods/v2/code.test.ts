import { expect, it } from "vitest"
import { functionCodeRows, functionCodeLanguage } from "./code"
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

it("refuses malformed or unbounded diffs instead of treating them as source", () => {
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
    expect(() => functionCodeRows({ source, format: "diff" })).toThrow("MODS_UI_CODE_INVALID")
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
