import { describe, expect, it } from "vitest"
import { join } from "node:path"
import { isCreatorVersionSource } from "./creator-path"

describe("creator version ownership paths", () => {
  it("protects only the exact owned immutable source directory", () => {
    const root = process.cwd(),
      id = "12345678-1234-4234-8234-123456789abc"
    expect(isCreatorVersionSource(root, join(root, ".creator-revisions", id, "source"))).toBe(true)
    for (const directory of [
      join(root, "source"),
      join(root, ".creator-revisions", id),
      join(root, "..", ".creator-revisions", id, "source"),
      join(root, ".creator-revisions", "not-a-version", "source")
    ])
      expect(isCreatorVersionSource(root, directory)).toBe(false)
  })
})
