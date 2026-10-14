import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { ProjectFunctionFiles } from "./file-access"
import { functionAncestorsRequest, validateFunctionAncestorsResult } from "./file-ancestors"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mods-ancestors-")))
  roots.push(root)
  await mkdir(join(root, "a", "b"), { recursive: true })
  return {
    root,
    signal: new AbortController().signal,
    files: new ProjectFunctionFiles(
      root,
      () => {},
      async (value) => value
    )
  }
}

it("reads root first, respects names order, skips missing files and expands shared imports once", async () => {
  const f = await fixture()
  await writeFile(join(f.root, "AGENTS.md"), "Root @shared.md")
  await writeFile(join(f.root, "shared.md"), "Shared")
  await writeFile(join(f.root, "a", "AGENTS.md"), "Child @../shared.md")
  await writeFile(join(f.root, "a", "OTHER.md"), "Other")
  const result = await f.files.ancestors(
    { names: ["AGENTS.md", "OTHER.md"], of: "a/b/file.ts" },
    f.signal
  )
  expect(result).toEqual([
    {
      dir: f.root,
      name: "AGENTS.md",
      content: "Root @shared.md\n\nShared",
      parts: [
        { path: join(f.root, "AGENTS.md"), content: "Root @shared.md" },
        { path: join(f.root, "shared.md"), content: "Shared" }
      ]
    },
    {
      dir: join(f.root, "a"),
      name: "AGENTS.md",
      content: "Child @../shared.md",
      parts: [{ path: join(f.root, "a", "AGENTS.md"), content: "Child @../shared.md" }]
    },
    {
      dir: join(f.root, "a"),
      name: "OTHER.md",
      content: "Other",
      parts: [{ path: join(f.root, "a", "OTHER.md"), content: "Other" }]
    }
  ])
})

it("honors below as exclusive and of as a file, never an alternative root", async () => {
  const f = await fixture()
  await writeFile(join(f.root, "AGENTS.md"), "Root")
  await writeFile(join(f.root, "a", "AGENTS.md"), "Child")
  expect(
    await f.files.ancestors({ names: ["AGENTS.md"], below: f.root, of: "a/file.ts" }, f.signal)
  ).toMatchObject([{ dir: join(f.root, "a"), content: "Child" }])
  expect(
    await f.files.ancestors({ names: ["AGENTS.md"], below: "a", of: "a/file.ts" }, f.signal)
  ).toEqual([])
  expect(
    await f.files.ancestors({ names: ["AGENTS.md"], below: "a", of: "file.ts" }, f.signal)
  ).toEqual([])
  await expect(
    f.files.ancestors({ names: ["AGENTS.md"], of: "../outside/file.ts" }, f.signal)
  ).rejects.toThrow("MODS_FS_OUTSIDE_PROJECT")
})

it("ignores code and HTML imports but handles escaped spaces and fragments in text", async () => {
  const f = await fixture()
  const text =
    "Text @two\\ words.md#heading\n\n`@../private.md`\n\n```\n@../private.md\n```\n\n<!-- @../private.md -->"
  await writeFile(join(f.root, "AGENTS.md"), text)
  await writeFile(join(f.root, "two words.md"), "Included")
  const result = await f.files.ancestors({ names: ["AGENTS.md"] }, f.signal)
  expect(result).toMatchObject([
    { content: `${text}\n\nIncluded`, parts: [{ content: text }, { content: "Included" }] }
  ])
})

it("deduplicates cycles and rejects excessive include depth rather than returning a partial pass", async () => {
  const f = await fixture()
  await writeFile(join(f.root, "AGENTS.md"), "@AGENTS.md\n@next.md")
  await writeFile(join(f.root, "next.md"), "@AGENTS.md")
  expect(await f.files.ancestors({ names: ["AGENTS.md"] }, f.signal)).toMatchObject([
    { parts: [{}, {}] }
  ])
  for (let i = 0; i < 6; i++) await writeFile(join(f.root, `depth${i}.md`), `@depth${i + 1}.md`)
  await expect(f.files.ancestors({ names: ["depth0.md"] }, f.signal)).rejects.toThrow(
    "MODS_FS_ANCESTORS_DEPTH"
  )
})

it("rejects outside imports and junction traversal", async () => {
  const f = await fixture()
  await writeFile(join(f.root, "AGENTS.md"), "@../private.md")
  await expect(f.files.ancestors({ names: ["AGENTS.md"] }, f.signal)).rejects.toThrow(
    "MODS_FS_OUTSIDE_PROJECT"
  )
  await symlink(tmpdir(), join(f.root, "link"), process.platform === "win32" ? "junction" : "dir")
  await writeFile(join(f.root, "AGENTS.md"), "@link/private.md")
  // An existing outside file proves the resolver cannot read through the junction.
  const outside = await realpath(await mkdtemp(join(tmpdir(), "mods-ancestors-")))
  roots.push(outside)
  await writeFile(join(outside, "AGENTS.md"), "Private")
  await symlink(outside, join(f.root, "outside"), process.platform === "win32" ? "junction" : "dir")
  await writeFile(join(f.root, "AGENTS.md"), "@outside/AGENTS.md")
  await expect(f.files.ancestors({ names: ["AGENTS.md"] }, f.signal)).rejects.toThrow(
    "MODS_FS_OUTSIDE_PROJECT"
  )
})

it("enforces read permission and rechecks cancellation after publication", async () => {
  const f = await fixture()
  await writeFile(join(f.root, "AGENTS.md"), "Secret")
  const denied = new ProjectFunctionFiles(
    f.root,
    () => {},
    async (value) => value,
    async () => ({ decision: "deny", source: "test" }) as never
  )
  await expect(denied.ancestors({ names: ["AGENTS.md"] }, f.signal)).rejects.toThrow(
    "MODS_FS_ACCESS_DENIED"
  )
  const controller = new AbortController()
  const cancelled = new ProjectFunctionFiles(
    f.root,
    () => {},
    async (value) => {
      if (Array.isArray(value)) controller.abort(Error("cancelled"))
      return value
    }
  )
  await expect(cancelled.ancestors({ names: ["AGENTS.md"] }, controller.signal)).rejects.toThrow(
    "cancelled"
  )
})

it("protects every part before returning it and limits combined content", async () => {
  const f = await fixture()
  await writeFile(join(f.root, "AGENTS.md"), "SECRET @part.md")
  await writeFile(join(f.root, "part.md"), "SECRET")
  const protectedFiles = new ProjectFunctionFiles(
    f.root,
    () => {},
    async (value) => (typeof value === "string" ? value.replaceAll("SECRET", "REDACTED") : value)
  )
  const result = await protectedFiles.ancestors({ names: ["AGENTS.md"] }, f.signal)
  expect(JSON.stringify(result)).not.toContain("SECRET")
  validateFunctionAncestorsResult(result)
  await writeFile(join(f.root, "AGENTS.md"), "x".repeat(256 * 1024 + 1))
  await expect(f.files.ancestors({ names: ["AGENTS.md"] }, f.signal)).rejects.toThrow(
    "MODS_FS_ANCESTORS_LIMIT"
  )
})

it.each([
  {},
  { names: [] },
  { names: ["../AGENTS.md"] },
  { names: [".claude/CLAUDE.md"] },
  { names: ["secrets.env"] },
  { names: ["AGENTS.md"], below: "" },
  { names: ["AGENTS.md"], unknown: true }
])("rejects malformed or outside-name request %j", (input) => {
  expect(() => functionAncestorsRequest(input)).toThrow("MODS_FS_ANCESTORS_ARGUMENT")
})
