import fs from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { writeDesignFilesAtomically } from "./artifact-storage"

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = fs.mkdtempSync(path.join(tmpdir(), "design-commit-"))
  roots.push(root)
  const html = path.join(root, "index.html"),
    metadata = path.join(root, "artifact.json")
  fs.writeFileSync(html, "old HTML")
  fs.writeFileSync(metadata, "old metadata")
  const files = [
    { filePath: metadata, content: "new metadata" },
    { filePath: html, content: "new HTML" }
  ]
  return { root, html, metadata, files }
}

it("commits metadata and HTML together and removes temporary files", () => {
  const f = fixture()
  writeDesignFilesAtomically(f.files)
  expect(fs.readFileSync(f.html, "utf8")).toBe("new HTML")
  expect(fs.readFileSync(f.metadata, "utf8")).toBe("new metadata")
  expect(fs.readdirSync(f.root).sort()).toEqual(["artifact.json", "index.html"])
})

it("never changes the formal files when staging fails", () => {
  const f = fixture(),
    write = fs.writeFileSync
  vi.spyOn(fs, "writeFileSync").mockImplementation((file, ...args) => {
    if (String(file).includes(".index.html-")) throw new Error("disk full")
    return write(file, ...args)
  })
  expect(() => writeDesignFilesAtomically(f.files)).toThrow("disk full")
  expect(fs.readFileSync(f.html, "utf8")).toBe("old HTML")
  expect(fs.readFileSync(f.metadata, "utf8")).toBe("old metadata")
  expect(fs.readdirSync(f.root).length).toBe(2)
})

it("restores already replaced metadata if the HTML commit fails", () => {
  const f = fixture(),
    rename = fs.renameSync
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (to === f.html) throw new Error("HTML replace denied")
    return rename(from, to)
  })
  expect(() => writeDesignFilesAtomically(f.files)).toThrow("HTML replace denied")
  expect(fs.readFileSync(f.html, "utf8")).toBe("old HTML")
  expect(fs.readFileSync(f.metadata, "utf8")).toBe("old metadata")
  expect(fs.readdirSync(f.root).length).toBe(2)
})

it("removes newly created metadata when a first HTML commit fails", () => {
  const f = fixture(),
    rename = fs.renameSync
  fs.rmSync(f.metadata)
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (to === f.html) throw new Error("HTML replace denied")
    return rename(from, to)
  })
  expect(() => writeDesignFilesAtomically(f.files)).toThrow("HTML replace denied")
  expect(fs.existsSync(f.metadata)).toBe(false)
  expect(fs.readFileSync(f.html, "utf8")).toBe("old HTML")
})
