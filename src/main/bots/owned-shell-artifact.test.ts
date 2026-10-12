import { createHash } from "node:crypto"
import io, { type FileHandle } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { finished } from "node:stream/promises"
import { createPackageWithOptions } from "@electron/asar"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { hashOwnedShellArtifact, verifyOwnedShellArtifact } from "./owned-shell-artifact"

let root: string
beforeEach(async () => {
  root = await io.realpath(await io.mkdtemp(join(tmpdir(), "cmb-owned-artifact-")))
})
afterEach(async () => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  await io.rm(root, { recursive: true, force: true })
})

const contents = Buffer.from("// immutable command owner\n")
const sha256 = createHash("sha256").update(contents).digest("hex")
async function fixture(layout: "physical" | "asar" | "unpacked") {
  const app = join(root, "app"),
    main = join(app, "out", "main"),
    archive = join(root, "app.asar")
  await io.mkdir(main, { recursive: true })
  await io.writeFile(join(main, "owner.js"), contents)
  if (layout !== "physical") {
    await finished(
      await createPackageWithOptions(
        app,
        archive,
        layout === "unpacked" ? { unpack: "**/owner.js" } : {}
      )
    )
    await io.rm(app, { recursive: true, force: true })
  }
  return {
    archive,
    entry: join(layout === "physical" ? app : archive, "out", "main", "owner.js")
  }
}

it.each(["physical", "asar", "unpacked"] as const)(
  "verifies actual %s bytes and rejects a different expected hash",
  async (layout) => {
    const { entry } = await fixture(layout)
    expect(await hashOwnedShellArtifact(entry)).toBe(sha256)
    await expect(verifyOwnedShellArtifact({ entry, sha256 })).resolves.toBeUndefined()
    await expect(verifyOwnedShellArtifact({ entry, sha256: "0".repeat(64) })).rejects.toThrow(
      "Owned shell artifact changed"
    )
  }
)

it.each(["symbolic", "hard"] as const)("rejects a physical %s link", async (kind) => {
  const { entry } = await fixture("physical"),
    alias = join(root, "alias.js")
  if (kind === "symbolic") await io.symlink(entry, alias)
  else await io.link(entry, alias)
  await expect(hashOwnedShellArtifact(alias)).rejects.toThrow("Owned shell artifact is unsafe")
})

it("rejects an archive member link rather than hashing the link's destination", async () => {
  const app = join(root, "app")
  await io.mkdir(app)
  await io.writeFile(join(app, "owner.js"), contents)
  await io.symlink("owner.js", join(app, "alias.js"))
  const archive = join(root, "app.asar")
  await finished(await createPackageWithOptions(app, archive, {}))
  await expect(hashOwnedShellArtifact(join(archive, "alias.js"))).rejects.toThrow()
})

/** Observe completed native reads; no fake file bytes or synthetic stat identities. */
function afterRead(path: string, observe: (position: number) => Promise<void>) {
  const open = io.open.bind(io)
  vi.spyOn(io, "open").mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (String(args[0]) !== path) return handle
    const read = handle.read.bind(handle) as (
      buffer: Buffer,
      offset: number,
      length: number,
      position: number
    ) => Promise<{ bytesRead: number; buffer: Buffer }>
    handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
      const result = await read(buffer, offset, length, position)
      await observe(position)
      return result
    }) as FileHandle["read"]
    return handle
  })
  syncBuiltinESMExports()
}

it("rejects a named file replaced after its original bytes were read", async () => {
  const { entry } = await fixture("physical")
  let changed = false
  afterRead(entry, async () => {
    if (changed) return
    changed = true
    const replacement = join(root, "replacement.js")
    await io.writeFile(replacement, contents)
    await io.rename(replacement, entry)
  })
  await expect(verifyOwnedShellArtifact({ entry, sha256 })).rejects.toThrow(/changed/)
  expect(changed).toBe(true)
})

it("rejects an archive changed after member bytes were read from the pinned handle", async () => {
  const { archive, entry } = await fixture("asar")
  let changed = false
  afterRead(archive, async (position) => {
    if (changed || position <= 8) return
    changed = true
    const file = await io.open(archive, "r+")
    try {
      await file.write(Buffer.from("!"), 0, 1, position)
    } finally {
      await file.close()
    }
  })
  await expect(verifyOwnedShellArtifact({ entry, sha256 })).rejects.toThrow(/changed/)
  expect(changed).toBe(true)
})
