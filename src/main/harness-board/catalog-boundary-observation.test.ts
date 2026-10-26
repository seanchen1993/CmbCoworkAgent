import * as fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { createProjectTemplate } from "../mods/devtools/project-template"
import { readHarnessCatalogPage, resetHarnessCatalogReaderCacheForTests } from "./catalog-reader"
import { HOST_PACKAGE_LIMITS } from "./project-runtime/package-snapshots"

vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>())
}))

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  resetHarnessCatalogReaderCacheForTests()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "catalog-page-observation-"))
  roots.push(root)
  const plugin = join(root, "plugin")
  fs.mkdirSync(join(plugin, "board_core"), { recursive: true })
  fs.writeFileSync(join(plugin, "board_core/board_config.json"), JSON.stringify({ apiVersion: 1 }))
  const projects = join(root, "projects.json")
  const plugins = join(root, "plugins.json")
  fs.writeFileSync(projects, JSON.stringify({ projects: [] }))
  fs.writeFileSync(
    plugins,
    JSON.stringify(
      [0, 1].map((id) => ({
        id: `legacy-${id}`,
        name: `Legacy ${id}`,
        version: "0.1.0",
        path: plugin,
        enabled: true
      }))
    )
  )
  const source = createProjectTemplate({ packageId: "host-only", name: "Host" })
  const host = source.files.find((file) => file.path === "devclaw.project-runtime.json")!.text
  return { plugin, projects, plugins, host }
}

it("reobserves protocols on every page even when the board config bytes remain cached", () => {
  const f = fixture()
  const read = (registryCursor?: number) =>
    readHarnessCatalogPage(f.projects, f.plugins, {
      includeProjects: false,
      registryLimit: 1,
      registryCursor
    })
  const first = read()
  expect(first.registry[0].boardCompatibility.compatible).toBe(true)
  expect(first.registryNextCursor).toBe(1)
  fs.writeFileSync(join(f.plugin, "devclaw.project-runtime.json"), f.host)
  expect(read(first.registryNextCursor!).registry).toMatchObject([
    { runtimeMode: "host", boardCompatibility: { compatible: false } }
  ])
  fs.rmSync(join(f.plugin, "devclaw.project-runtime.json"))
  expect(read(first.registryNextCursor!).registry[0].boardCompatibility.compatible).toBe(true)
})

it("safely probes the selected board before reusing cached config after a hardlink replacement", () => {
  const f = fixture()
  const first = readHarnessCatalogPage(f.projects, f.plugins, {
    includeProjects: false,
    registryLimit: 1
  })
  expect(first.registry[0].boardCompatibility.compatible).toBe(true)
  const board = join(f.plugin, "board_core/board_config.json")
  const original = join(f.plugin, "..", "original-board.json")
  fs.renameSync(board, original)
  fs.linkSync(original, board)
  expect(fs.lstatSync(board).nlink).toBe(2)
  const next = readHarnessCatalogPage(f.projects, f.plugins, {
    includeProjects: false,
    registryLimit: 1,
    registryCursor: first.registryNextCursor!
  })
  expect(next.registry[0].boardCompatibility).toMatchObject({
    compatible: false,
    message: expect.stringContaining("FILE_UNSAFE")
  })
})

it("rejects a runtime added during the shared root absence observation", () => {
  const f = fixture()
  const original = fs.opendirSync
  let changed = false
  vi.spyOn(fs, "opendirSync").mockImplementation(((...args: Parameters<typeof fs.opendirSync>) => {
    const opened = Reflect.apply(original, fs, args) as ReturnType<typeof fs.opendirSync>
    if (args[0] === f.plugin) {
      const read = opened.readSync.bind(opened)
      vi.spyOn(opened, "readSync").mockImplementation(() => {
        const entry = read()
        if (!changed && entry) {
          changed = true
          fs.writeFileSync(join(f.plugin, "devclaw.project-runtime.json"), f.host)
        }
        return entry
      })
    }
    return opened
  }) as typeof fs.opendirSync)
  const result = readHarnessCatalogPage(f.projects, f.plugins, {
    includeProjects: false,
    registryLimit: 1
  })
  expect(changed).toBe(true)
  expect(result.registry[0].boardCompatibility).toMatchObject({
    compatible: false,
    message: expect.stringContaining("HARNESS_CATALOG_SOURCE_CHANGED")
  })
})

it.each(["host", "unknown"])(
  "does not mistake uppercase %s runtime names for missing declarations",
  (kind) => {
    const f = fixture()
    const bytes =
      kind === "host" ? f.host : JSON.stringify({ apiVersion: "devclaw.project-runtime/v999" })
    fs.writeFileSync(
      join(
        f.plugin,
        process.platform === "win32"
          ? "DEVCLAW.PROJECT-RUNTIME.JSON"
          : "devclaw.project-runtime.json"
      ),
      bytes
    )
    const original = fs.opendirSync
    vi.spyOn(fs, "opendirSync").mockImplementation(((
      ...args: Parameters<typeof fs.opendirSync>
    ) => {
      const opened = Reflect.apply(original, fs, args) as ReturnType<typeof fs.opendirSync>
      if (args[0] === f.plugin) {
        const read = opened.readSync.bind(opened)
        vi.spyOn(opened, "readSync").mockImplementation(() => {
          const entry = read()
          return entry
            ? new Proxy(entry, {
                get(target, key, receiver) {
                  return key === "name"
                    ? target.name.toUpperCase()
                    : Reflect.get(target, key, receiver)
                }
              })
            : null
        })
      }
      return opened
    }) as typeof fs.opendirSync)
    const result = readHarnessCatalogPage(f.projects, f.plugins, { includeProjects: false })
    // A canonical Host uses its own runtime; a platform-level case/identity rejection remains a
    // diagnostic row. Neither may fall back to a compatible runtime-less board package.
    expect(result.registry.every((row) => !row.boardCompatibility.compatible)).toBe(true)
  }
)

it("bounds root enumeration and falls back to exact safe reads instead of inferring absence", () => {
  const f = fixture()
  fs.writeFileSync(join(f.plugin, "devclaw.project-runtime.json"), f.host)
  const original = fs.opendirSync
  let reads = 0
  vi.spyOn(fs, "opendirSync").mockImplementation(((...args: Parameters<typeof fs.opendirSync>) => {
    const opened = Reflect.apply(original, fs, args) as ReturnType<typeof fs.opendirSync>
    if (args[0] === f.plugin) {
      const first = opened.readSync()!
      vi.spyOn(opened, "readSync").mockImplementation(() => {
        reads++
        return new Proxy(first, {
          get(target, key, receiver) {
            return key === "name" ? `unrelated-${reads}` : Reflect.get(target, key, receiver)
          }
        })
      })
    }
    return opened
  }) as typeof fs.opendirSync)
  expect(
    readHarnessCatalogPage(f.projects, f.plugins, { includeProjects: false }).registry
  ).toMatchObject([
    { runtimeMode: "host", boardCompatibility: { compatible: false } },
    { runtimeMode: "host", boardCompatibility: { compatible: false } }
  ])
  expect(reads).toBe(HOST_PACKAGE_LIMITS.files + HOST_PACKAGE_LIMITS.directories + 1)
})
