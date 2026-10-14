import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { ModControlStore } from "../control-store"
import { parseFunctionUserConfig } from "../../../shared/mods/v2/user-config"
import { FunctionUserConfigValues } from "./user-config-values"

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})
const field = {
  type: "string",
  title: "Tone",
  description: "Help",
  options: ["warm", "formal"],
  default: "warm"
}
const schema = parseFunctionUserConfig({
  tone: field,
  secret: { type: "string", title: "Token", description: "Help", sensitive: true }
})!
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mods-config-values-")),
    path = join(root, "control.sqlite")
  let store = new ModControlStore(path)
  cleanup.push(() => {
    store.close()
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("mods-config-values-")
    )
      throw Error("Unexpected cleanup path")
    rmSync(root, { recursive: true, force: true })
  })
  return {
    values: new FunctionUserConfigValues(store),
    reopen: () => {
      store.close()
      store = new ModControlStore(path)
      return new FunctionUserConfigValues(store)
    }
  }
}

it("persists save revisions separately for actual plugin/workspace identities and across restart", () => {
  const f = fixture()
  expect(f.values.save("w", "p", schema, "tone", "formal", 0, () => {})).toEqual({
    revision: 1,
    values: { tone: "formal" },
    changed: true
  })
  const reopened = f.reopen()
  expect(reopened.read("w", "p")).toEqual({ revision: 1, values: { tone: "formal" } })
  expect(reopened.read("other", "p")).toEqual({ revision: 0, values: {} })
})

it("rejects stale, cancelled and dialog-only writes and avoids a save revision for the same value", () => {
  const f = fixture(),
    guard = vi.fn()
  f.values.save("w", "p", schema, "tone", "formal", 0, guard)
  expect(f.values.save("w", "p", schema, "tone", "formal", 1, guard).changed).toBe(false)
  expect(() => f.values.save("w", "p", schema, "tone", "warm", 0, guard)).toThrow(
    "MODS_CONFIG_VALUE_CHANGED"
  )
  expect(() => f.values.save("w", "p", schema, "secret", "must-never-store", 1, guard)).toThrow(
    "MODS_USER_CONFIG_DIALOG_REQUIRED"
  )
  expect(() =>
    f.values.save("w", "p", schema, "tone", "warm", 1, () => {
      throw Error("cancelled")
    })
  ).toThrow("cancelled")
  expect(f.values.read("w", "p")).toEqual({ revision: 1, values: { tone: "formal" } })
})

it("does not turn corrupt storage or a lost commit into a successful saved value", () => {
  const write = vi.fn()
  const lost = new FunctionUserConfigValues({
    getSetting: (_key, fallback) => fallback!,
    setSetting: write
  })
  expect(() => lost.save("w", "p", schema, "tone", "formal", 0, () => {})).toThrow(
    "MODS_CONFIG_COMMIT_UNCONFIRMED"
  )
  const corrupt = new FunctionUserConfigValues({
    getSetting: () => '{"revision":-1,"values":{}}',
    setSetting: write
  })
  expect(() => corrupt.read("w", "p")).toThrow("MODS_USER_CONFIG_STORE")
})

it("persists lists as actual arrays and paths as text without conflating list boundaries", () => {
  const f = fixture()
  const special = parseFunctionUserConfig({
    list: { type: "string", title: "List", description: "List", multiple: true, required: true },
    path: { type: "file", title: "File", description: "File" },
    directory: { type: "directory", title: "Directory", description: "Directory" }
  })!
  const values = ["a,b", "a\nb", "", "a,b"]
  f.values.save("w", "p", special, "list", values, 0, () => {})
  values.push("later")
  const reopened = f.reopen()
  expect(reopened.read("w", "p").values.list).toEqual(["a,b", "a\nb", "", "a,b"])
  expect(() => reopened.save("w", "p", special, "list", "a,b", 1, () => {})).toThrow(
    "MODS_CONFIG_VALUE_KIND"
  )
  expect(() => reopened.save("w", "p", special, "list", Array(257).fill("a"), 1, () => {})).toThrow(
    "list"
  )
  expect(() => reopened.save("w", "p", special, "path", ["file"], 1, () => {})).toThrow(
    "MODS_CONFIG_VALUE_KIND"
  )
  reopened.save("w", "p", special, "list", [], 1, () => {})
  reopened.save("w", "p", special, "path", "file,with\ncharacters", 2, () => {})
  expect(reopened.read("w", "p").values).toEqual({ list: [], path: "file,with\ncharacters" })
})

it.each([
  ["a", 7],
  ["文", 2]
] as const)(
  "checks the complete UTF-8 record before a %s value could make its own store unreadable",
  (letter, permitted) => {
    const f = fixture(),
      value = letter.repeat(32768)
    const large = parseFunctionUserConfig(
      Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [
          "field" + i,
          { type: "string", title: "Value", description: "Help" }
        ])
      )
    )!
    for (let index = 0; index < permitted; index++)
      f.values.save("w", "p", large, "field" + index, value, index, () => {})
    const previous = f.values.read("w", "p")
    expect(() =>
      f.values.save("w", "p", large, "field" + permitted, value, permitted, () => {})
    ).toThrow("MODS_USER_CONFIG_STORE_LIMIT")
    expect(f.values.read("w", "p")).toEqual(previous)
    expect(f.reopen().read("w", "p")).toEqual(previous)
  }
)
