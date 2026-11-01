import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"

/** Capture before compilation, then compare both contents and inventory after it. */
export function captureModsSourceSnapshot(repository: string, roots: readonly string[]) {
  const files: Record<string, string> = {}
  const walk = (path: string) => {
    const tail = relative(repository, path)
    assert(
      tail &&
        !isAbsolute(tail) &&
        tail !== ".." &&
        !tail.startsWith("..\\") &&
        !tail.startsWith("../"),
      "SOURCE_INPUT_OUTSIDE_REPOSITORY"
    )
    const stat = lstatSync(path)
    assert(!stat.isSymbolicLink(), "SOURCE_INPUT_LINK_FORBIDDEN")
    if (stat.isDirectory()) {
      for (const name of readdirSync(path))
        if (![".vite", "node_modules", "out", "dist", "build"].includes(name))
          walk(join(path, name))
    } else
      files[tail.replaceAll("\\", "/")] = createHash("sha256")
        .update(readFileSync(path))
        .digest("hex")
  }
  for (const root of roots) {
    const path = resolve(repository, root)
    assert(existsSync(path), `SOURCE_INPUT_MISSING:${root}`)
    walk(path)
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))
}

export function verifyModsSourceSnapshot(
  repository: string,
  roots: readonly string[],
  expected: Readonly<Record<string, string>>
) {
  const current = captureModsSourceSnapshot(repository, roots)
  for (const file of new Set([...Object.keys(expected), ...Object.keys(current)]))
    assert.equal(current[file], expected[file], `SOURCE_CHECKOUT_CHANGED:${file}`)
}
