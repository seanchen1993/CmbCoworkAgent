import { afterEach, beforeEach, expect, test } from "vitest"
import fs from "node:fs"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { runInNewContext } from "node:vm"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cmb-service-identity-")))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function fixture(later = false) {
  await mkdir(join(root, "out/main"), { recursive: true })
  const bytes = Buffer.from("service artifact contents")
  await writeFile(join(root, "out/main/bot-host.js"), bytes)
  const manifest = {
    schemaVersion: 1,
    buildId: "a".repeat(24),
    nativeDistribution: null,
    files: [
      {
        path: "out/main/bot-host.js",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex")
      }
    ]
  }
  if (later) {
    await writeFile(join(root, "later.data"), bytes)
    manifest.files.push({
      path: "later.data",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    })
  }
  await writeFile(join(root, "build-manifest.json"), JSON.stringify(manifest))
  return manifest
}

async function reader(changing?: string, updated = changing) {
  const script = join(process.cwd(), "scripts/bot-service-launcher.cjs")
  const require = createRequire(script)
  const descriptors = new Set<number>()
  let selected: number | undefined
  let changed = false
  // Use real temporary files and descriptors. Only the exact read boundary is
  // observed, to deterministically cover a file update while verification runs.
  const observed = {
    ...fs,
    openSync: ((...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args)
      descriptors.add(fd)
      if (args[0] === changing) selected = fd
      return fd
    }) as typeof fs.openSync,
    readSync: ((...args: Parameters<typeof fs.readSync>) => {
      const count = fs.readSync(...args)
      if (count > 0 && args[0] === selected && !changed && updated) {
        changed = true
        const previous = fs.readFileSync(updated)
        fs.renameSync(updated, updated + ".previous")
        fs.writeFileSync(updated, previous)
      }
      return count
    }) as typeof fs.readSync,
    closeSync(fd: number) {
      fs.closeSync(fd)
      descriptors.delete(fd)
    }
  }
  const module = { exports: {} as { verifyService(root: string): unknown } }
  // Preserve the production reader; isolate its version guard for portable
  // workers. The separate service runner uses actual Node22.
  runInNewContext(
    await readFile(script, "utf8"),
    {
      require: (id: string) => (id === "node:fs" ? observed : require(id)),
      module,
      exports: module.exports,
      Buffer,
      process: { versions: { node: "22.16.0" } }
    },
    { filename: script }
  )
  return { verify: module.exports.verifyService, descriptors, changed: () => changed }
}

test("unchanged service artifacts pass and release every descriptor", async () => {
  const manifest = await fixture()
  const { verify, descriptors } = await reader()
  expect(verify(root)).toMatchObject(manifest)
  expect(descriptors.size).toBe(0)
})

test.each(["out/main/bot-host.js", "build-manifest.json"])(
  "rejects a same-content %s path replacement during its real read",
  async (relative) => {
    await fixture()
    const { verify, descriptors, changed } = await reader(join(root, relative))
    expect(() => verify(root)).toThrow(/changed|identity/)
    expect(changed()).toBe(true)
    expect(descriptors.size).toBe(0)
  }
)

test.each(["out/main/bot-host.js", "build-manifest.json"])(
  "rejects an already-read %s update while a later artifact is read",
  async (relative) => {
    await fixture(true)
    const { verify, descriptors, changed } = await reader(
      join(root, "later.data"),
      join(root, relative)
    )
    expect(() => verify(root)).toThrow("artifact set changed")
    expect(changed()).toBe(true)
    expect(descriptors.size).toBe(0)
  }
)
