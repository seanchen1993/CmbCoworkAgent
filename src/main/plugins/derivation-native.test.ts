import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import type { ClawActionDescriptor } from "../../shared/mods/claw-actions"
import { PluginDerivationService } from "./derivation-service"
import {
  compileNativeComposition,
  nativeCompositionSchema,
  readNativeCompositionFiles
} from "./native-composition"
import { assertNativeCompositionCurrent } from "./native-composition-derivation"
import { snapshotDerivationSource } from "./derivation-source"
import { PROJECT_ACTION_LOCK_PATH } from "../../shared/project-runtime/action-bindings"
import { setDerivationFamilies } from "./derivation-scope"

const roots: string[] = []
afterEach(async () => {
  setDerivationFamilies([])
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(withProvider = false) {
  const root = await mkdtemp(join(tmpdir(), "native-derivation-"))
  roots.push(root)
  const original = join(root, "original")
  const vendor = resolve("tests/fixtures/native-compositions/vendor")
  const source = nativeCompositionSchema.parse(
    JSON.parse(await readFile(join(vendor, "composition/source.json"), "utf8"))
  )
  // A pinned catalog fixture exercises identity changes; it grants no production authority.
  const provider: ClawActionDescriptor = {
    pluginId: randomUUID(),
    plugin: "vendor-checks",
    digest: "a".repeat(64),
    actionId: "check",
    name: "Vendor check",
    platform: { id: "vendor.checks", version: "1.0.0", action: "check" },
    inputSchema: { type: "object", properties: {} }
  }
  let actions: ClawActionDescriptor[] = withProvider ? [provider] : []
  if (withProvider)
    source.modules[0].checks = [
      {
        id: "normalize.schema",
        kind: "action",
        artifactId: "normalize",
        provider: { plugin: provider.plugin, actionId: provider.actionId },
        format: "json"
      }
    ]
  const compiled = compileNativeComposition(source, {
    files: readNativeCompositionFiles(vendor, source),
    actionCatalog: actions
  })
  for (const file of [
    ...compiled.files,
    { path: "README.md", bytes: Buffer.from("Preserved author notes\n") }
  ]) {
    await mkdir(dirname(join(original, file.path)), { recursive: true })
    await writeFile(join(original, file.path), file.bytes)
  }
  const install = vi.fn<(...args: unknown[]) => Promise<{ success: boolean }>>(async () => ({
    success: true
  }))
  const service = new PluginDerivationService(join(root, "copies"), {
    plugins: () => [],
    install,
    invalidate: () => {}
  })
  const inspect = await service.inspect(original, "workspace", () => {})
  const catalog = vi.fn(async () => actions)
  const create = (name = "vendor-copy", guard = () => {}, read = catalog) =>
    service.create("workspace", inspect.inspectionId, name, randomUUID(), guard, read)
  return {
    root,
    original,
    source,
    compiled,
    provider,
    service,
    inspect,
    catalog,
    create,
    install,
    setActions: (value: ClawActionDescriptor[]) => {
      actions = value
    }
  }
}

it("creates and checks an actual compiled supplier copy with coherent source, runtime and locks", async () => {
  const f = await fixture()
  expect(f.inspect.suggestedName).toBe("vendor-native-fixture-copy")
  const original = await snapshotDerivationSource(f.original)
  const copy = await f.create()
  const checked = await f.service.check("workspace", copy.copyId, () => {}, f.catalog)
  expect(checked.status).toBe("checked")
  const snapshot = await snapshotDerivationSource(f.service.sourcePath(copy.copyId, "workspace"))
  expect(() => assertNativeCompositionCurrent(snapshot, [])).not.toThrow()
  expect(
    JSON.parse(
      snapshot.files.find((file) => file.path === "composition/source.json")!.bytes.toString()
    ).plugin.id
  ).toBe("vendor-copy")
  const lock = JSON.parse(
    snapshot.files.find((file) => file.path === "composition/lock.json")!.bytes.toString()
  )
  expect(lock.sourceDigest).not.toBe(f.compiled.lock.sourceDigest)
  expect(lock.runtimeDigest).not.toBe(f.compiled.lock.runtimeDigest)
  expect(snapshot.files.find((file) => file.path === PROJECT_ACTION_LOCK_PATH)!.bytes).toEqual(
    original.files.find((file) => file.path === PROJECT_ACTION_LOCK_PATH)!.bytes
  )
  expect(snapshot.files.find((file) => file.path === "README.md")!.bytes.toString()).toBe(
    "Preserved author notes\n"
  )
  expect((await snapshotDerivationSource(f.original)).digest).toBe(original.digest)
  expect(f.install).not.toHaveBeenCalled()
})

it("preserves the pinned provider lock when renaming a native copy", async () => {
  const f = await fixture(true)
  const copy = await f.create()
  const snapshot = await snapshotDerivationSource(f.service.sourcePath(copy.copyId, "workspace"))
  expect(
    JSON.parse(
      snapshot.files.find((file) => file.path === PROJECT_ACTION_LOCK_PATH)!.bytes.toString()
    )
  ).toEqual(f.compiled.actionLock)
  expect(() => assertNativeCompositionCurrent(snapshot, [f.provider])).not.toThrow()
})

it.each(["missing", "uuid", "digest"])(
  "does not rebind a %s provider while creating a copy",
  async (kind) => {
    const f = await fixture(true)
    f.setActions(
      kind === "missing"
        ? []
        : [
            {
              ...f.provider,
              ...(kind === "uuid" ? { pluginId: randomUUID() } : { digest: "b".repeat(64) })
            }
          ]
    )
    await expect(f.create()).rejects.toThrow("PROJECT_DERIVATION_SOURCE_INVALID")
    expect(f.service.list("workspace")).toEqual([])
    expect(f.install).not.toHaveBeenCalled()
  }
)

it("rechecks provider identity before checked publication and installation", async () => {
  const f = await fixture(true)
  const copy = await f.create()
  f.setActions([])
  await expect(f.service.check("workspace", copy.copyId, () => {}, f.catalog)).rejects.toThrow(
    "SOURCE_INVALID"
  )
  expect(f.service.get(copy.copyId, "workspace").status).toBe("created")
  f.setActions([f.provider])
  const checked = await f.service.check("workspace", copy.copyId, () => {}, f.catalog)
  f.setActions([{ ...f.provider, digest: "c".repeat(64) }])
  await expect(
    f.service.install("workspace", copy.copyId, checked.digest, () => {}, f.catalog)
  ).rejects.toThrow("SOURCE_INVALID")
  expect(f.install).not.toHaveBeenCalled()
})

it("rejects stale generated bytes instead of repairing them during rename or check", async () => {
  const f = await fixture()
  const copy = await f.create()
  await writeFile(
    join(f.service.sourcePath(copy.copyId, "workspace"), "skills/native-normalize/SKILL.md"),
    "forged\n"
  )
  await expect(f.service.check("workspace", copy.copyId, () => {}, f.catalog)).rejects.toThrow(
    "SOURCE_INVALID"
  )
  expect(f.service.get(copy.copyId, "workspace").status).toBe("created")
})

it("rejects invalid native names and a changed caller after asynchronous catalog lookup", async () => {
  const f = await fixture()
  await expect(f.create("供应商副本")).rejects.toThrow("原生组合名称")
  let current = true
  const guard = () => {
    if (!current) throw Error("STALE_CALLER")
  }
  const lookup = vi.fn(async () => {
    current = false
    return []
  })
  await expect(f.create("vendor-copy", guard, lookup)).rejects.toThrow("STALE_CALLER")
  expect(f.service.list("workspace")).toEqual([])
})

it("refuses publication when providers change during copy materialization", async () => {
  const f = await fixture(true)
  let reads = 0
  const catalog = vi.fn(async () => (++reads === 1 ? [f.provider] : []))
  await expect(f.create("vendor-copy", () => {}, catalog)).rejects.toThrow("SOURCE_INVALID")
  expect(f.service.list("workspace")).toEqual([])
})

it("does not publish checked when native source bytes change during catalog lookup", async () => {
  const f = await fixture()
  const copy = await f.create()
  const source = f.service.sourcePath(copy.copyId, "workspace")
  await expect(
    f.service.check(
      "workspace",
      copy.copyId,
      () => {},
      async () => {
        await writeFile(join(source, "README.md"), "Changed during lookup\n")
        return []
      }
    )
  ).rejects.toThrow("源码已变化")
  expect(f.service.get(copy.copyId, "workspace").status).toBe("created")
})

it.each(["registration", "directory", "excluded"])(
  "does not publish checked when a new %s entry appears during catalog lookup",
  async (kind) => {
    const f = await fixture()
    const copy = await f.create()
    const source = f.service.sourcePath(copy.copyId, "workspace")
    await expect(
      f.service.check(
        "workspace",
        copy.copyId,
        () => {},
        async () => {
          if (kind === "registration") {
            await mkdir(join(source, "hooks"))
            await writeFile(join(source, "hooks/hooks.json"), "{}\n")
          } else if (kind === "directory") {
            await mkdir(join(source, "new-empty-directory"))
          } else {
            await writeFile(join(source, ".env"), "TEST_FIXTURE_ONLY=1\n")
          }
          return []
        }
      )
    ).rejects.toThrow("源码已变化")
    expect(f.service.get(copy.copyId, "workspace").status).toBe("created")
  }
)

it.each(["original", "copy"])(
  "refuses native publication when %s bytes change during its last catalog lookup",
  async (target) => {
    const f = await fixture()
    let calls = 0
    const catalog = vi.fn(async () => {
      if (++calls === 2) {
        const staging = (await readdir(join(f.root, "copies"))).find((name) =>
          name.startsWith(".creating-")
        )!
        const directory =
          target === "original" ? f.original : join(f.root, "copies", staging, "source")
        await writeFile(join(directory, "README.md"), "Changed during final lookup\n")
      }
      return []
    })
    await expect(f.create("vendor-copy", () => {}, catalog)).rejects.toThrow("源码已变化")
    expect(f.service.list("workspace")).toEqual([])
  }
)

it.each(["source", "installed"])(
  "refuses installation when %s bytes change during its last catalog lookup",
  async (target) => {
    const f = await fixture()
    const copy = await f.create()
    const checked = await f.service.check("workspace", copy.copyId, () => {}, f.catalog)
    f.install.mockImplementation(async (...args: unknown[]) => {
      await (args[4] as (directory: string) => Promise<void>)(args[0] as string)
      return { success: true }
    })
    let calls = 0
    await expect(
      f.service.install(
        "workspace",
        copy.copyId,
        checked.digest,
        () => {},
        async () => {
          if (++calls === 2) {
            const staging = (await readdir(join(f.root, "copies"))).find((name) =>
              name.startsWith(".installing-")
            )!
            const directory =
              target === "source"
                ? f.service.sourcePath(copy.copyId, "workspace")
                : join(f.root, "copies", staging)
            await writeFile(join(directory, "README.md"), "Changed during install lookup\n")
          }
          return []
        }
      )
    ).rejects.toThrow("源码已变化")
    expect(f.service.get(copy.copyId, "workspace").status).toBe("checked")
  }
)
