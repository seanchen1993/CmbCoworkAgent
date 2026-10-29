import { expect, test, tier } from "claude-code/testing"

tier("user")
test("file operations raise absolute paths, allow rewrites and unwrap results", async ($, on) => {
  on("fs.read", (_, e) => {
    expect(e.path.replaceAll("\\", "/").endsWith("/fixture/hello.txt")).toBe(true)
    return { value: "hi" }
  })
  on("fs.list", (_, e) => {
    expect(e.path.replaceAll("\\", "/").endsWith("/fixture")).toBe(true)
    return { value: [{ name: "hello.txt", kind: "file", size: 2 }] }
  })
  on("fs.stat", () => ({ value: { kind: "file", size: 2, mtimeMs: 123 } }))
  on("fs.exists", (_, e) => ({ value: e.path.endsWith("hello.txt") }))
  const answer = await $.command.run({ command: "files-probe" })
  expect(JSON.parse(answer.text)).toEqual({
    text: "HI", absolute: true,
    entries: [{ name: "hello.txt", kind: "file", size: 2 }],
    exists: true, missing: false, stat: { kind: "file", size: 2, modified: true }
  })
})
