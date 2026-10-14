import { createHash } from "node:crypto"
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import AdmZip from "adm-zip"

const RESTORED_FROM_COMMIT = "c660e8f93200f291400c419e86e754d1638900d3"
const EXTENSION_ID = "lnfdbegfbhhlfimnojpalnkmhkgfahin"
const SOURCE_FILES = [
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
]

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  throw error
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function isDescendant(parent, child) {
  const path = relative(parent, child)
  return path !== "" && path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path)
}

function optionalStat(path) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error.code === "ENOENT") return undefined
    throw error
  }
}

function requireDirectory(path) {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail("CHROME_EXTENSION_UNSAFE_PATH", "打包路径必须是普通目录，不能使用链接。")
  }
}

function readSourceFile(source, path) {
  const fullPath = resolve(source, path)
  if (!isDescendant(source, fullPath)) {
    fail("CHROME_EXTENSION_UNSAFE_PATH", "扩展来源文件越出源码目录。")
  }
  requireDirectory(source)
  if (path.startsWith("icons/")) requireDirectory(join(source, "icons"))
  const info = lstatSync(fullPath)
  if (info.isSymbolicLink() || !info.isFile() || !isDescendant(source, realpathSync(fullPath))) {
    fail("CHROME_EXTENSION_UNSAFE_PATH", "扩展来源必须是目录内的普通文件，不能使用链接。")
  }
  return readFileSync(fullPath)
}

function prepareOutput(root, destination) {
  const allowedOutput = join(root, "output")
  if (!isDescendant(allowedOutput, destination)) {
    fail("CHROME_EXTENSION_OUTPUT_OUTSIDE_ROOT", "输出目录必须位于仓库 output 的新子目录内。")
  }
  if (optionalStat(destination)) {
    fail("CHROME_EXTENSION_OUTPUT_EXISTS", "输出目录已经存在，不覆盖已有交付文件。")
  }
  requireDirectory(root)
  let ancestor = root
  for (const segment of relative(root, dirname(destination)).split(sep)) {
    ancestor = join(ancestor, segment)
    const info = optionalStat(ancestor)
    if (info) requireDirectory(ancestor)
  }
}

function createArchive(files) {
  const archive = new AdmZip()
  for (const file of files) archive.addFile(file.path, file.content)
  return archive.toBuffer()
}

// The archive builder is injectable for deterministic source-change regression checks.
export function packageChromeExtension({ root, outputDirectory }, archiveBuilder = createArchive) {
  if (typeof outputDirectory !== "string" || !outputDirectory.trim()) {
    fail("CHROME_EXTENSION_OUTPUT_REQUIRED", "请指定仓库 output 下一个尚不存在的新输出目录。")
  }
  const repository = realpathSync(resolve(root))
  const destination = resolve(outputDirectory)
  prepareOutput(repository, destination)
  const source = join(repository, "chrome-extension")
  const files = SOURCE_FILES.map(([path, restoredBlobSha1]) => {
    const content = readSourceFile(source, path)
    const currentBlobSha1 = createHash("sha1")
      .update(`blob ${content.length}\0`)
      .update(content)
      .digest("hex")
    return {
      path,
      content,
      bytes: content.length,
      sha256: sha256(content),
      restoredBlobSha1,
      changedSinceRestoration: currentBlobSha1 !== restoredBlobSha1
    }
  })
  const manifest = JSON.parse(files.find((file) => file.path === "manifest.json").content)
  const extensionId = createHash("sha256")
    .update(Buffer.from(manifest.key || "", "base64"))
    .digest("hex")
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)))
  if (extensionId !== EXTENSION_ID) {
    fail("CHROME_EXTENSION_ID_MISMATCH", "扩展公钥派生的 ID 与本项目约定不一致。")
  }
  const archive = archiveBuilder(files)
  for (const file of files) {
    if (sha256(readSourceFile(source, file.path)) !== file.sha256) {
      fail("CHROME_EXTENSION_SOURCE_CHANGED", "打包期间扩展源码变化，请在源码稳定后重新打包。")
    }
  }
  // Recheck immediately before the exclusive mkdir; mkdir and wx writes reject races.
  prepareOutput(repository, destination)
  mkdirSync(dirname(destination), { recursive: true })
  mkdirSync(destination)
  const filename = "chrome-extension.zip"
  const evidence = {
    schemaVersion: 1,
    source: { directory: "chrome-extension", restoredFromCommit: RESTORED_FROM_COMMIT },
    extensionId,
    extensionVersion: manifest.version,
    file: filename,
    sha256: sha256(archive),
    files: files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
      restoredBlobSha1: file.restoredBlobSha1,
      changedSinceRestoration: file.changedSinceRestoration
    }))
  }
  writeFileSync(join(destination, filename), archive, { flag: "wx" })
  writeFileSync(
    join(destination, "chrome-extension-package.json"),
    JSON.stringify(evidence, null, 2) + "\n",
    { flag: "wx" }
  )
  writeFileSync(join(destination, "SHA256SUMS.txt"), `${evidence.sha256}  ${filename}\n`, {
    flag: "wx"
  })
  return evidence
}

const scriptPath = fileURLToPath(import.meta.url)
const normalizeEntryPath = (path) => process.platform === "win32" ? path.toLowerCase() : path
const entryPath = process.argv[1] ? normalizeEntryPath(resolve(process.argv[1])) : undefined
if (entryPath === normalizeEntryPath(scriptPath)) {
  try {
    if (process.argv.length !== 3) {
      fail(
        "CHROME_EXTENSION_OUTPUT_REQUIRED",
        "用法：node scripts/package-chrome-extension.mjs <新输出目录>"
      )
    }
    const evidence = packageChromeExtension({
      root: resolve(dirname(scriptPath), ".."),
      outputDirectory: process.argv[2]
    })
    console.log(JSON.stringify(evidence, null, 2))
  } catch (error) {
    console.error(`${error.code || "CHROME_EXTENSION_PACKAGE_FAILED"}: ${error.message}`)
    process.exitCode = 1
  }
}
