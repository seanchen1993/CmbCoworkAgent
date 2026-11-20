import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { MEMORY_CATALOG_MAX_RESPONSE_BYTES, type MemoryCatalogSource } from "./protocol"
import {
  MemoryCatalogCancelledError,
  clearMemoryCatalogSnapshotsForTests,
  readMemoryCatalog
} from "./reader"

const tempDirs: string[] = []

function makeSource(): MemoryCatalogSource {
  const memoryRootDir = mkdtempSync(join(tmpdir(), "memory-catalog-"))
  tempDirs.push(memoryRootDir)
  const globalMemoryDir = join(memoryRootDir, "global")
  const projectsMemoryDir = join(memoryRootDir, "projects")
  const memorySettingsPath = join(memoryRootDir, "memory-settings.json")
  mkdirSync(globalMemoryDir, { recursive: true })
  mkdirSync(projectsMemoryDir, { recursive: true })
  return { memoryRootDir, globalMemoryDir, projectsMemoryDir, memorySettingsPath }
}

afterEach(() => {
  clearMemoryCatalogSnapshotsForTests()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("memory catalog reader", () => {
  it("bounds a 2 MiB detail response and refuses files above the hard size budget", () => {
    const source = makeSource()
    const exactLimit = join(source.globalMemoryDir, "large.md")
    writeFileSync(exactLimit, "\\".repeat(2 * 1024 * 1024))
    const bounded = readMemoryCatalog(source, {
      kind: "file",
      memoryDir: source.globalMemoryDir,
      name: "large.md"
    })
    if (!("content" in bounded)) throw new Error("expected file content")
    expect(bounded.truncated).toBe(true)
    expect(bounded.truncatedReason).toBe("response-bytes")
    expect(Buffer.byteLength(JSON.stringify(bounded), "utf-8")).toBeLessThanOrEqual(
      MEMORY_CATALOG_MAX_RESPONSE_BYTES
    )

    writeFileSync(join(source.globalMemoryDir, "too-large.md"), "x".repeat(2 * 1024 * 1024 + 1))
    const refused = readMemoryCatalog(source, {
      kind: "file",
      memoryDir: source.globalMemoryDir,
      name: "too-large.md"
    })
    if (!("content" in refused)) throw new Error("expected file content")
    expect(refused).toMatchObject({
      content: "",
      bytesRead: 0,
      truncated: true,
      truncatedReason: "file-size"
    })
  })

  it("observes a shared cancellation flag before scanning", () => {
    const source = makeSource()
    const flag = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
    Atomics.store(flag, 0, 1)
    expect(() =>
      readMemoryCatalog(
        source,
        {
          kind: "projects",
          limit: 128
        },
        flag
      )
    ).toThrow(MemoryCatalogCancelledError)
  })

  it("projects recall badges from a bounded read-only index without initializing MemoryStore", () => {
    const source = makeSource()
    const memoryPath = join(source.globalMemoryDir, "remembered.md")
    writeFileSync(memoryPath, "---\nname: Remembered\ntype: user\n---\n")
    const database = new DatabaseSync(join(source.globalMemoryDir, "index.sqlite"))
    database.exec("CREATE TABLE chunks (path TEXT NOT NULL, recall_count INTEGER DEFAULT 0)")
    const insert = database.prepare("INSERT INTO chunks(path, recall_count) VALUES (?, ?)")
    insert.run(memoryPath, 3)
    insert.run(memoryPath, 4)
    database.close()

    const page = readMemoryCatalog(source, {
      kind: "files",
      scope: "global",
      memoryDir: source.globalMemoryDir
    })
    if (!("items" in page) || !("stats" in page)) throw new Error("expected files page")
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.recallCount).toBe(7)
  })
})
