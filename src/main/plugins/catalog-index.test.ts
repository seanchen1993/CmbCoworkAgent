import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, linkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { PluginCatalogIndex } from "./catalog-index"

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "catalog-index-"))
  roots.push(root)
  const file = join(root, "plugins.json")
  return { root, file, index: new PluginCatalogIndex(file) }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const first = JSON.stringify([{ id: "one", name: "first", path: "C:/owned/first" }])
const second = JSON.stringify([{ id: "one", name: "first", path: "C:/owned/second" }])

describe("exact plugin catalog index", () => {
  it("creates and replaces whole indexes while preserving exact text", () => {
    const { root, file, index } = fixture()
    const absent = index.capture()
    expect(absent.raw).toBeNull()
    const current = index.replace(absent, first)
    expect(readFileSync(file, "utf8")).toBe(first)
    expect(index.replace(current, second).raw).toBe(second)
    expect(readdirSync(root)).toEqual(["plugins.json"])
  })
  it("rejects stale, copied and different-instance tokens without touching current bytes", () => {
    const { file, index } = fixture()
    const initial = index.capture()
    index.replace(initial, first)
    expect(() => index.replace(initial, second)).toThrow("PLUGIN_CATALOG_CHANGED")
    const current = index.capture()
    expect(() => index.replace({ ...current }, second)).toThrow("PLUGIN_CATALOG_CHANGED")
    expect(() => new PluginCatalogIndex(file).replace(current, second)).toThrow(
      "PLUGIN_CATALOG_CHANGED"
    )
    writeFileSync(file, first + "\n")
    expect(() => index.replace(current, second)).toThrow("PLUGIN_CATALOG_CHANGED")
    expect(readFileSync(file, "utf8")).toBe(first + "\n")
  })
  it("rejects malformed metadata, duplicate identities and oversized output", () => {
    const { file, index } = fixture()
    const current = index.replace(index.capture(), first)
    for (const invalid of [
      "{}",
      "[null]",
      '[{"id":"x"}]',
      JSON.stringify([...JSON.parse(first), ...JSON.parse(first)]),
      " ".repeat(4 * 1024 * 1024 + 1)
    ]) {
      expect(() => index.replace(current, invalid)).toThrow()
      expect(readFileSync(file, "utf8")).toBe(first)
    }
  })
  it("refuses invalid UTF8 and hardlinked indexes", () => {
    const { file, root, index } = fixture()
    writeFileSync(file, Buffer.from([0xff]))
    expect(() => index.capture()).toThrow("PLUGIN_CATALOG_INVALID")
    writeFileSync(file, first)
    linkSync(file, join(root, "alias"))
    expect(() => index.capture()).toThrow("PLUGIN_CATALOG_INVALID")
  })
})
