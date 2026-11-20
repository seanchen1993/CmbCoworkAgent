import { afterEach, describe, expect, it } from "vitest"
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { mirrorRequiredDirectorySync } from "./directory-mirror"

const temporaryDirectories: string[] = []

function makeTemporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "cmb-directory-mirror-"))
  temporaryDirectories.push(root)
  return root
}

function listFiles(root: string, current = root): string[] {
  return readdirSync(current, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = join(current, entry.name)
      return entry.isDirectory() ? listFiles(root, entryPath) : [relative(root, entryPath)]
    })
    .sort((a, b) => a.localeCompare(b))
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("directory mirror", () => {
  it("removes stale output while preserving an exact recursive source copy", () => {
    const root = makeTemporaryDirectory()
    const source = join(root, "source")
    const destination = join(root, "output", "skills")
    const sibling = join(root, "output", "keep.txt")
    mkdirSync(join(source, "alpha"), { recursive: true })
    mkdirSync(join(source, "beta", "references"), { recursive: true })
    mkdirSync(join(destination, "stale", "nested"), { recursive: true })
    writeFileSync(join(source, "alpha", "SKILL.md"), "alpha")
    writeFileSync(join(source, "beta", "references", "guide.md"), "guide")
    writeFileSync(join(destination, "stale", "nested", "old.md"), "stale")
    writeFileSync(sibling, "keep")

    mirrorRequiredDirectorySync(source, destination)

    expect(listFiles(destination)).toEqual([
      join("alpha", "SKILL.md"),
      join("beta", "references", "guide.md")
    ])
    expect(readFileSync(join(destination, "alpha", "SKILL.md"), "utf8")).toBe("alpha")
    expect(readFileSync(sibling, "utf8")).toBe("keep")
  })

  it("fails without deleting the previous output when the required source is absent", () => {
    const root = makeTemporaryDirectory()
    const source = join(root, "missing")
    const destination = join(root, "output", "skills")
    mkdirSync(destination, { recursive: true })
    writeFileSync(join(destination, "stale.md"), "stale")

    expect(() => mirrorRequiredDirectorySync(source, destination)).toThrow(
      "Required build resource directory is unavailable"
    )

    expect(readFileSync(join(destination, "stale.md"), "utf8")).toBe("stale")
  })

  it("rejects linked directories instead of packaging files outside the source", () => {
    const root = makeTemporaryDirectory()
    const source = join(root, "source")
    const external = join(root, "external")
    const destination = join(root, "output", "skills")
    mkdirSync(source, { recursive: true })
    mkdirSync(external, { recursive: true })
    writeFileSync(join(external, "outside.md"), "outside")
    symlinkSync(external, join(source, "linked"), process.platform === "win32" ? "junction" : "dir")

    expect(() => mirrorRequiredDirectorySync(source, destination)).toThrow(
      "Refusing to mirror a symbolic link"
    )
  })
})
