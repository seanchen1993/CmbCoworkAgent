import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { readModsSourceCandidate } from "../support/mods-source-candidate"
import {
  readHistoricalSourceWrapper,
  readModsHistoricalSourceReference
} from "../support/mods-historical-source-reference"

const roots: string[] = []
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mods-history-reference-"))
  roots.push(root)
  const candidate = join(root, "output/phase3-source-generic-mod-123456ab/candidate")
  const sources = { "src/example.ts": "original source" }
  const artifacts = {
    "out/main/index.js": "original main",
    "out/preload/index.js": "original preload"
  }
  const write = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  for (const [path, text] of Object.entries(sources)) write(join(root, path), text)
  for (const [path, text] of Object.entries(artifacts)) write(join(candidate, path), text)
  write(join(root, "package-lock.json"), "fixed dependencies")
  const manifest = {
    execution: "source-isolated",
    root: candidate,
    repository: root,
    head: "a".repeat(40),
    entry: join(candidate, "out/main/index.js"),
    rendererUrl: "http://127.0.0.1:1234",
    files: Object.fromEntries(Object.entries(artifacts).map(([path, text]) => [path, hash(text)])),
    sources: Object.fromEntries(Object.entries(sources).map(([path, text]) => [path, hash(text)])),
    sourceRoots: ["src"],
    dependencies: hash("fixed dependencies")
  }
  const path = join(candidate, "source-candidate.json")
  const save = () => {
    write(path, JSON.stringify(manifest))
    return hash(JSON.stringify(manifest))
  }
  const signature = save()
  const wrapperPath = join(dirname(candidate), "run.json")
  const wrapper = {
    head: manifest.head,
    candidate: path,
    manifestSha256: signature,
    realModel: true,
    driverIntegrityVerified: true,
    driverHashes: { "tests/entry.ts": "b".repeat(64) }
  }
  write(wrapperPath, JSON.stringify(wrapper))
  return { root, candidate, path, manifest, save, signature, wrapper, wrapperPath }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("immutable historical source evidence", () => {
  it("keeps evidence usable after source evolves while the current execution fence still rejects old builds", () => {
    const f = fixture()
    expect(readModsSourceCandidate(f.path).execution).toBe("source-isolated")
    writeFileSync(join(f.root, "src/example.ts"), "new source")
    const historical = readHistoricalSourceWrapper(f.path, f.root)
    expect(historical.execution).toBe("historical-source-reference")
    expect(historical).not.toHaveProperty("entry")
    expect(historical).not.toHaveProperty("rendererUrl")
    expect(() => readModsSourceCandidate(f.path)).toThrow("SOURCE_CHECKOUT_CHANGED")
  })
  it("rejects artifact or dependency changes instead of treating old signatures as executable authority", () => {
    const f = fixture()
    writeFileSync(join(f.candidate, "out/main/index.js"), "changed main")
    expect(() => readHistoricalSourceWrapper(f.path, f.root)).toThrow("ARTIFACT_CHANGED")
    writeFileSync(join(f.candidate, "out/main/index.js"), "original main")
    writeFileSync(join(f.root, "package-lock.json"), "changed dependencies")
    expect(() => readHistoricalSourceWrapper(f.path, f.root)).toThrow("DEPENDENCIES_CHANGED")
  })
  it("pins raw manifest bytes and rejects an unrelated repository", () => {
    const f = fixture()
    writeFileSync(f.path, JSON.stringify(f.manifest) + "\n")
    expect(() =>
      readModsHistoricalSourceReference(f.path, { repository: f.root, manifestSha256: f.signature })
    ).toThrow("MANIFEST_CHANGED")
    f.save()
    expect(() =>
      readModsHistoricalSourceReference(f.path, {
        repository: dirname(f.root),
        manifestSha256: f.signature
      })
    ).toThrow("OWNED_CANDIDATE")
  })
  it("rejects unknown wrapper provenance and source file escapes", () => {
    const f = fixture()
    f.wrapper.driverIntegrityVerified = false
    writeFileSync(f.wrapperPath, JSON.stringify(f.wrapper))
    expect(() => readHistoricalSourceWrapper(f.path, f.root)).toThrow("WRAPPER_INTEGRITY")
    f.manifest.files["../outside.js"] = "a".repeat(64)
    const signature = f.save()
    expect(() =>
      readModsHistoricalSourceReference(f.path, { repository: f.root, manifestSha256: signature })
    ).toThrow("FILE_INVALID")
  })
})
