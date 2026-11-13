import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import AdmZip from "adm-zip"
import { afterEach, describe, expect, it } from "vitest"

interface PackageSourceFile {
  path: string
  content: Buffer
}

interface PackageEvidence {
  schemaVersion: number
  source: { directory: string; restoredFromCommit: string }
  extensionId: string
  extensionVersion: string
  file: string
  sha256: string
  files: Array<{
    path: string
    bytes: number
    sha256: string
    restoredBlobSha1: string
    changedSinceRestoration: boolean
  }>
}

interface PackageModule {
  packageChromeExtension(
    options: { root: string; outputDirectory: string },
    archiveBuilder?: (files: PackageSourceFile[]) => Buffer
  ): PackageEvidence
}

const packageScript = resolve(process.cwd(), "scripts/package-chrome-extension.mjs")
const packageModule = import(pathToFileURL(packageScript).href) as Promise<PackageModule>
const paths = [
  "manifest.json",
  "service-worker.js",
  "popup.js",
  "popup.html",
  "popup.css",
  "README.md",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png"
]
// Independent Git blob identities at c660e8f93200f291400c419e86e754d1638900d3.
// The delivery audit compares bytes, including checkout line endings.
const restoredBlobSha1 = new Map([
  ["manifest.json", "a2821e4547ccfc83732ec57d89f12c261d11042d"],
  ["service-worker.js", "236740c7ee36a09a2d67d0c7b644b85f9ab7ce77"],
  ["popup.js", "994d035a09fc28c77a3980291713e45099138a09"],
  ["popup.html", "440595df0900640f089a25f2ee3602e697c95e4a"],
  ["popup.css", "3541f672949b497f21b1879d58c53777dd3d4a86"],
  ["README.md", "1d53dd0e6d68f0355629422b5ad9b8da33f6e525"],
  ["icons/icon-16.png", "f7bea3bdb62d0ffa19af79db97e2d61ab6cbe08d"],
  ["icons/icon-32.png", "775ac4ef2c0c1306d6c96a581d31a04dccb082fc"],
  ["icons/icon-48.png", "1d20a210435243c67a6bfffb478a6c2c8800906b"],
  ["icons/icon-128.png", "568815997ac6416b9b728b12bf12e45f8b8ae735"]
])
const temporaryRoots: string[] = []
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex")
const gitBlobSha1 = (bytes: Buffer): string => createHash("sha1")
  .update(`blob ${bytes.length}\0`).update(bytes).digest("hex")

function fixture(): { root: string; source: string; outputDirectory: string } {
  const root = mkdtempSync(join(tmpdir(), "cmb-chrome-extension-package-"))
  temporaryRoots.push(root)
  const source = join(root, "chrome-extension")
  for (const path of paths) {
    const destination = join(source, path)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, readFileSync(resolve(process.cwd(), "chrome-extension", path)))
  }
  return { root, source, outputDirectory: join(root, "output", "delivery") }
}

afterEach(() => {
  // These are only the exact directories returned by this test's mkdtemp calls.
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("Chrome extension delivery package", () => {
  it("packages exactly ten root-relative assets and records the same bytes and hashes", async () => {
    const { packageChromeExtension } = await packageModule
    const test = fixture()
    const originals = new Map(paths.map((path) => [path, readFileSync(join(test.source, path))]))
    writeFileSync(join(test.source, ".env.fixture"), "synthetic-only=true\n")
    mkdirSync(join(test.source, "fake-profile"))
    writeFileSync(join(test.source, "fake-profile", "Cookies"), "synthetic-only")
    const evidence = packageChromeExtension(test)
    const archiveBytes = readFileSync(join(test.outputDirectory, "chrome-extension.zip"))
    const archive = new AdmZip(archiveBytes)
    const archivePaths = archive.getEntries().map((entry) => entry.entryName).sort()
    expect(archivePaths).toEqual([...paths].sort())
    expect(archive.getEntries().every((entry) => !entry.isDirectory)).toBe(true)
    expect(evidence.schemaVersion).toBe(1)
    expect(evidence.source).toEqual({
      directory: "chrome-extension",
      restoredFromCommit: "c660e8f93200f291400c419e86e754d1638900d3"
    })
    expect(evidence.extensionId).toBe("lnfdbegfbhhlfimnojpalnkmhkgfahin")
    expect(evidence.extensionVersion).toBe("0.1.3")
    expect(evidence.sha256).toBe(sha256(archiveBytes))
    expect(evidence.files).toHaveLength(10)
    for (const file of evidence.files) {
      const original = originals.get(file.path)!
      expect(archive.getEntry(file.path)!.getData()).toEqual(original)
      expect(readFileSync(join(test.source, file.path))).toEqual(original)
      expect(file.bytes).toBe(original.length)
      expect(file.sha256).toBe(sha256(original))
      expect(file.restoredBlobSha1).toMatch(/^[0-9a-f]{40}$/)
      expect(restoredBlobSha1.has(file.path)).toBe(true)
      expect(file.restoredBlobSha1).toBe(restoredBlobSha1.get(file.path))
      expect(file.changedSinceRestoration).toBe(
        gitBlobSha1(original) !== restoredBlobSha1.get(file.path)
      )
    }
    const savedEvidence = JSON.parse(
      readFileSync(join(test.outputDirectory, "chrome-extension-package.json"), "utf8")
    )
    expect(savedEvidence).toEqual(evidence)
    expect(readFileSync(join(test.outputDirectory, "SHA256SUMS.txt"), "utf8")).toBe(
      `${evidence.sha256}  chrome-extension.zip\n`
    )
    const originalManifest = JSON.parse(originals.get("manifest.json")!.toString())
    expect(JSON.stringify(evidence)).not.toContain(originalManifest.key)
  })

  it("audits LF and CRLF popup bytes without rewriting either delivery", async () => {
    const { packageChromeExtension } = await packageModule
    const original = readFileSync(resolve(process.cwd(), "chrome-extension", "popup.js"))
    const lf = Buffer.from(original.toString("utf8").replaceAll("\r\n", "\n"))
    const crlf = Buffer.from(lf.toString("utf8").replaceAll("\n", "\r\n"))
    expect(gitBlobSha1(lf)).toBe(restoredBlobSha1.get("popup.js"))
    expect(crlf.equals(lf)).toBe(false)
    for (const bytes of [lf, crlf]) {
      const test = fixture()
      const popup = join(test.source, "popup.js")
      writeFileSync(popup, bytes)
      const evidence = packageChromeExtension(test)
      const audit = evidence.files.find(file => file.path === "popup.js")!
      expect(audit.changedSinceRestoration).toBe(!bytes.equals(lf))
      expect(audit.sha256).toBe(sha256(bytes))
      expect(audit.bytes).toBe(bytes.length)
      expect(readFileSync(popup)).toEqual(bytes)
      const archive = new AdmZip(readFileSync(join(test.outputDirectory, "chrome-extension.zip")))
      expect(archive.getEntry("popup.js")!.getData()).toEqual(bytes)
    }
  })

  it("refuses to overwrite any existing output directory", async () => {
    const { packageChromeExtension } = await packageModule
    const test = fixture()
    mkdirSync(test.outputDirectory, { recursive: true })
    const sentinel = join(test.outputDirectory, "keep.txt")
    writeFileSync(sentinel, "keep existing bytes")
    expect(() => packageChromeExtension(test)).toThrow("输出目录已经存在")
    expect(readFileSync(sentinel, "utf8")).toBe("keep existing bytes")
    expect(existsSync(join(test.outputDirectory, "chrome-extension.zip"))).toBe(false)
  })

  it("rejects an absent output argument and output paths outside the allowed subtree", async () => {
    const { packageChromeExtension } = await packageModule
    const test = fixture()
    expect(() => packageChromeExtension({ ...test, outputDirectory: "" }))
      .toThrow("请指定仓库 output")
    for (const outputDirectory of [join(test.root, "other"), join(test.root, "output")]) {
      expect(() => packageChromeExtension({ ...test, outputDirectory }))
        .toThrow("输出目录必须位于仓库 output")
      expect(existsSync(outputDirectory)).toBe(false)
    }
    const result = spawnSync(process.execPath, [packageScript], {
      encoding: "utf8",
      timeout: 10000
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("CHROME_EXTENSION_OUTPUT_REQUIRED")
    if (process.platform === "win32") {
      // Node's module loader requires lowercase .mjs even on a case-insensitive filesystem.
      const differentlyCasedPath = packageScript.slice(0, -4).toUpperCase() + ".mjs"
      const differentlyCased = spawnSync(process.execPath, [differentlyCasedPath], {
        encoding: "utf8",
        timeout: 10000
      })
      expect(differentlyCased.status).toBe(1)
      expect(differentlyCased.stderr).toContain("CHROME_EXTENSION_OUTPUT_REQUIRED")
    }
  })

  it("rejects a linked output ancestor without writing to its target", async () => {
    const { packageChromeExtension } = await packageModule
    const test = fixture()
    const target = join(test.root, "target")
    mkdirSync(target)
    mkdirSync(join(test.root, "output"))
    symlinkSync(
      target,
      join(test.root, "output", "linked"),
      process.platform === "win32" ? "junction" : "dir"
    )
    expect(() => packageChromeExtension({
      root: test.root,
      outputDirectory: join(test.root, "output", "linked", "delivery")
    })).toThrow("打包路径必须是普通目录")
    expect(existsSync(join(target, "delivery"))).toBe(false)
  })

  it.each(["chrome-extension", "icons"])("rejects a linked %s source directory", async (linked) => {
    const { packageChromeExtension } = await packageModule
    const test = fixture()
    const linkedPath = linked === "icons" ? join(test.source, "icons") : test.source
    const target = join(test.root, "linked-source-target")
    mkdirSync(target)
    rmSync(linkedPath, { recursive: true })
    symlinkSync(target, linkedPath, process.platform === "win32" ? "junction" : "dir")
    expect(() => packageChromeExtension(test)).toThrow("打包路径必须是普通目录")
    expect(existsSync(test.outputDirectory)).toBe(false)
  })

  it.each(["missing", "directory"])("rejects a %s asset before creating output", async (kind) => {
    const { packageChromeExtension } = await packageModule
    const test = fixture()
    const asset = join(test.source, "popup.js")
    rmSync(asset)
    if (kind === "directory") mkdirSync(asset)
    expect(() => packageChromeExtension(test)).toThrow()
    expect(existsSync(test.outputDirectory)).toBe(false)
  })

  it("rejects source changes during archive creation before publishing evidence", async () => {
    const { packageChromeExtension } = await packageModule
    const test = fixture()
    expect(() => packageChromeExtension(test, (files) => {
      const archive = new AdmZip()
      for (const file of files) archive.addFile(file.path, file.content)
      writeFileSync(join(test.source, "popup.js"), "changed during packaging\n")
      return archive.toBuffer()
    })).toThrow("打包期间扩展源码变化")
    expect(existsSync(test.outputDirectory)).toBe(false)
  })

  it("rejects a changed extension key without publishing the key or output", async () => {
    const { packageChromeExtension } = await packageModule
    const test = fixture()
    const manifestPath = join(test.source, "manifest.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    manifest.key = Buffer.from("synthetic invalid public key").toString("base64")
    writeFileSync(manifestPath, JSON.stringify(manifest))
    expect(() => packageChromeExtension(test)).toThrow("扩展公钥派生的 ID")
    expect(existsSync(test.outputDirectory)).toBe(false)
  })
})
