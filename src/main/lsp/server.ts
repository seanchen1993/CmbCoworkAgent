import { spawn, ChildProcess } from "child_process"
import { basename, join } from "path"
import {
  existsSync,
  readdirSync,
  mkdirSync,
  chmodSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync
} from "fs"
import { createHash } from "crypto"
import { homedir } from "os"
import AdmZip from "adm-zip"

export interface JdtlsServerOptions {
  projectRoot: string
  maxHeapMb: number
}

type VsixSource = "user"
type ResolvedVsix = { path: string; source: VsixSource; signature: string }
type ExtractionMarker = { vsixPath: string; vsixSignature: string; extractedAt: string }

let resolvedVsixCache: ResolvedVsix | null = null
const vsixValidationCache = new Map<string, boolean>()
const KNOWN_VSIX_FILENAMES = [
  "java-darwin-arm64.vsix",
  "java-darwin-x64.vsix",
  "java-win32-arm64.vsix",
  "java-win32-x64.vsix",
  "java-linux-arm64.vsix",
  "java-linux-x64.vsix"
]

/** Where user-provided VSIX files live */
function getUserVsixDir(): string {
  const dir = join(homedir(), ".cmbcoworkagent", "lsp-vsix")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** Where we extract the VSIX contents (user data dir, persistent) */
function getRuntimeDir(): string {
  const dir = join(homedir(), ".cmbcoworkagent", "lsp-runtime")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** Get platform-specific VSIX filenames, ordered by preference. */
function getVsixFilenames(): string[] {
  if (process.platform === "darwin") {
    if (process.arch === "arm64") return ["java-darwin-arm64.vsix"]
    if (process.arch === "x64") return ["java-darwin-x64.vsix"]
  }
  if (process.platform === "win32") {
    if (process.arch === "arm64") return ["java-win32-arm64.vsix"]
    if (process.arch === "x64") return ["java-win32-x64.vsix"]
  }
  if (process.platform === "linux") {
    if (process.arch === "arm64") return ["java-linux-arm64.vsix"]
    if (process.arch === "x64") return ["java-linux-x64.vsix"]
  }
  throw new Error(`Unsupported platform/architecture: ${process.platform}/${process.arch}.`)
}

function getVsixFilename(): string {
  return getVsixFilenames()[0]
}

export function getVsixDownloadTarget(): { name: string; filenames: string[] } {
  const filenames = getVsixFilenames()
  const platformName = process.platform === "darwin"
    ? "darwin"
    : process.platform === "win32"
      ? "win32"
      : "linux"
  return {
    name: `lsp_${platformName}_${process.arch}`,
    filenames
  }
}

function getFileSignature(filePath: string): string | null {
  try {
    const stat = statSync(filePath)
    return `${stat.size}:${stat.mtimeMs}`
  } catch {
    return null
  }
}

function assertVsixFilenameCompatible(sourceName: string): void {
  if (!KNOWN_VSIX_FILENAMES.includes(sourceName)) return
  if (getVsixFilenames().includes(sourceName)) return
  throw new Error(`VSIX 文件与当前平台不匹配：${sourceName}，当前平台为 ${process.platform}/${process.arch}`)
}

function assertVsixPackageCompatible(zip: AdmZip): void {
  const packageEntry = zip.getEntry("extension/package.json")
  if (!packageEntry) return

  let pkg: { os?: unknown; cpu?: unknown }
  try {
    pkg = JSON.parse(packageEntry.getData().toString("utf-8")) as { os?: unknown; cpu?: unknown }
  } catch {
    return
  }

  const osValues = typeof pkg.os === "string"
    ? [pkg.os]
    : Array.isArray(pkg.os) ? pkg.os.filter((value): value is string => typeof value === "string") : []
  const cpuValues = typeof pkg.cpu === "string"
    ? [pkg.cpu]
    : Array.isArray(pkg.cpu) ? pkg.cpu.filter((value): value is string => typeof value === "string") : []

  if (osValues.length > 0 && !osValues.includes(process.platform)) {
    throw new Error(`VSIX 文件与当前系统不匹配：需要 ${osValues.join(", ")}，当前为 ${process.platform}`)
  }
  if (cpuValues.length > 0 && !cpuValues.includes(process.arch)) {
    throw new Error(`VSIX 文件与当前 CPU 架构不匹配：需要 ${cpuValues.join(", ")}，当前为 ${process.arch}`)
  }
}

function assertJdtlsVsixArchive(source: string | Buffer): void {
  let zip: AdmZip
  try {
    zip = new AdmZip(source)
  } catch {
    throw new Error("VSIX 文件无效：下载内容不是有效的 .vsix 压缩包")
  }

  const entries = zip.getEntries()
  const hasExtensionPackage = entries.some((entry) => entry.entryName === "extension/package.json")
  const hasJdtlsLauncher = entries.some((entry) => (
    !entry.isDirectory &&
    entry.entryName.startsWith("extension/server/plugins/org.eclipse.equinox.launcher_") &&
    entry.entryName.endsWith(".jar")
  ))

  if (!hasExtensionPackage || !hasJdtlsLauncher) {
    throw new Error("VSIX 文件无效：未找到 Java LSP 运行时所需文件")
  }
  assertVsixPackageCompatible(zip)
}

function isJdtlsVsixArchive(source: string, signature = getFileSignature(source)): boolean {
  const cacheKey = signature ? `${source}:${signature}` : source
  const cached = vsixValidationCache.get(cacheKey)
  if (cached !== undefined) return cached

  try {
    assertJdtlsVsixArchive(source)
    vsixValidationCache.set(cacheKey, true)
    return true
  } catch (error) {
    console.warn("[LSP] Ignoring invalid VSIX:", source, error instanceof Error ? error.message : String(error))
    vsixValidationCache.set(cacheKey, false)
    return false
  }
}

function resolveVsix(): ResolvedVsix | null {
  if (resolvedVsixCache) {
    const signature = getFileSignature(resolvedVsixCache.path)
    if (signature && signature === resolvedVsixCache.signature) {
      return resolvedVsixCache
    }
    resolvedVsixCache = null
  }

  for (const filename of getVsixFilenames()) {
    const userPath = join(getUserVsixDir(), filename)
    const userSignature = getFileSignature(userPath)
    if (userSignature && isJdtlsVsixArchive(userPath, userSignature)) {
      resolvedVsixCache = { path: userPath, source: "user", signature: userSignature }
      return resolvedVsixCache
    }
  }

  return null
}

export function invalidateVsixCaches(): void {
  resolvedVsixCache = null
  vsixValidationCache.clear()
}

function readExtractionMarker(markerFile: string): ExtractionMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(markerFile, "utf-8")) as Partial<ExtractionMarker>
    if (
      typeof parsed.vsixPath === "string" &&
      typeof parsed.vsixSignature === "string" &&
      typeof parsed.extractedAt === "string"
    ) {
      return {
        vsixPath: parsed.vsixPath,
        vsixSignature: parsed.vsixSignature,
        extractedAt: parsed.extractedAt
      }
    }
  } catch {
    return null
  }
  return null
}

function isExtractionCurrent(markerFile: string, extensionDir: string, resolvedVsix: ResolvedVsix): boolean {
  if (!existsSync(markerFile) || !existsSync(extensionDir)) return false
  const marker = readExtractionMarker(markerFile)
  return marker?.vsixPath === resolvedVsix.path && marker.vsixSignature === resolvedVsix.signature
}

function writeExtractionMarker(markerFile: string, resolvedVsix: ResolvedVsix): void {
  const marker: ExtractionMarker = {
    vsixPath: resolvedVsix.path,
    vsixSignature: resolvedVsix.signature,
    extractedAt: new Date().toISOString()
  }
  writeFileSync(markerFile, JSON.stringify(marker, null, 2))
}

/** Ensure VSIX is extracted; returns the extension root (e.g. ~/.cmbcoworkagent/lsp-runtime/extension/) */
function ensureExtracted(): string {
  const runtimeDir = getRuntimeDir()
  const extensionDir = join(runtimeDir, "extension")
  const markerFile = join(runtimeDir, ".extracted")

  const resolvedVsix = resolveVsix()
  if (!resolvedVsix) {
    throw new Error(
      "Java LSP 运行时未找到。请在 Java LSP 面板下载当前平台的 .vsix 文件。"
    )
  }
  const vsixPath = resolvedVsix.path

  if (isExtractionCurrent(markerFile, extensionDir, resolvedVsix)) {
    repairJrePermissionsForCurrentPlatform(extensionDir)
    return extensionDir
  }

  console.log(`[LSP] Extracting VSIX: ${vsixPath} → ${runtimeDir}`)
  rmSync(extensionDir, { recursive: true, force: true })
  const zip = new AdmZip(vsixPath)
  zip.extractAllTo(runtimeDir, true)

  // Mark as extracted
  writeExtractionMarker(markerFile, resolvedVsix)

  // Restore executable bits lost during unzip for Java binaries/helpers.
  repairJrePermissionsForCurrentPlatform(extensionDir)

  console.log("[LSP] VSIX extracted successfully")
  return extensionDir
}

function repairJrePermissionsForCurrentPlatform(extensionDir: string): void {
  if (process.platform === "win32") return
  repairJrePermissions(extensionDir)
}

function repairJrePermissions(extensionDir: string): void {
  const candidateFiles = new Set<string>()
  const jreDir = join(extensionDir, "jre")
  if (!existsSync(jreDir)) return

  for (const entry of readdirSync(jreDir)) {
    const runtimeRoot = join(jreDir, entry)
    const binDir = join(runtimeRoot, "bin")
    if (existsSync(binDir)) {
      for (const name of readdirSync(binDir)) {
        candidateFiles.add(join(binDir, name))
      }
    }

    candidateFiles.add(join(runtimeRoot, "lib", "jspawnhelper"))
    candidateFiles.add(join(runtimeRoot, "lib", "jexec"))
  }

  for (const filePath of candidateFiles) {
    if (!existsSync(filePath)) continue
    try {
      chmodSync(filePath, 0o755)
    } catch {
      // Ignore best-effort permission repair failures.
    }
  }
}

function findJreBinDir(extensionDir: string): string | null {
  const jreDir = join(extensionDir, "jre")
  if (!existsSync(jreDir)) return null
  // Find the JRE version directory (e.g., 21.0.7-macosx-aarch64)
  const entries = readdirSync(jreDir)
  for (const entry of entries) {
    const binDir = join(jreDir, entry, "bin")
    if (existsSync(binDir)) return binDir
  }
  return null
}

function getJavaPath(extensionDir: string): string {
  const jreBinDir = findJreBinDir(extensionDir)
  if (!jreBinDir) {
    throw new Error("JRE not found in extracted VSIX")
  }
  const javaBin = process.platform === "win32"
    ? join(jreBinDir, "java.exe")
    : join(jreBinDir, "java")
  if (!existsSync(javaBin)) {
    throw new Error(`Java binary not found: ${javaBin}`)
  }
  return javaBin
}

function findLauncherJar(extensionDir: string): string {
  const pluginsDir = join(extensionDir, "server", "plugins")
  if (!existsSync(pluginsDir)) {
    throw new Error(`JDTLS plugins directory not found: ${pluginsDir}`)
  }
  const entries = readdirSync(pluginsDir)
  const launcher = entries.find((f) => f.startsWith("org.eclipse.equinox.launcher_") && f.endsWith(".jar"))
  if (!launcher) {
    throw new Error("JDTLS launcher JAR not found in plugins directory")
  }
  return join(pluginsDir, launcher)
}

function getConfigDir(extensionDir: string): string {
  const serverDir = join(extensionDir, "server")
  const isArm = process.arch === "arm64"

  const candidates = process.platform === "darwin"
    ? (isArm ? ["config_mac_arm", "config_mac"] : ["config_mac"])
    : process.platform === "linux"
    ? (isArm ? ["config_linux_arm", "config_linux"] : ["config_linux"])
    : ["config_win"]

  for (const name of candidates) {
    const dir = join(serverDir, name)
    if (existsSync(dir)) return dir
  }
  throw new Error(`JDTLS config directory not found in: ${candidates.join(", ")}`)
}

function getLombokJar(extensionDir: string): string | null {
  const lombokDir = join(extensionDir, "lombok")
  if (!existsSync(lombokDir)) return null
  const entries = readdirSync(lombokDir)
  const jar = entries.find((f) => f.startsWith("lombok") && f.endsWith(".jar"))
  return jar ? join(lombokDir, jar) : null
}

function getDataDir(projectRoot: string): string {
  const hash = createHash("sha256").update(projectRoot).digest("hex").slice(0, 12)
  const dataDir = join(homedir(), ".cmbcoworkagent", "lsp-data", hash)
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true })
  }
  return dataDir
}

export function spawnJdtls(options: JdtlsServerOptions): ChildProcess {
  const { projectRoot, maxHeapMb } = options

  const extensionDir = ensureExtracted()
  const javaBin = getJavaPath(extensionDir)
  const launcherJar = findLauncherJar(extensionDir)
  const configDir = getConfigDir(extensionDir)
  const dataDir = getDataDir(projectRoot)
  const lombokJar = getLombokJar(extensionDir)

  // Shared index location: reuse Java class indexes across projects
  const sharedIndexDir = join(homedir(), ".cmbcoworkagent", "lsp-shared-index")
  if (!existsSync(sharedIndexDir)) mkdirSync(sharedIndexDir, { recursive: true })

  const args = [
    `-Xmx${maxHeapMb}m`,
    `-Xms100m`,
    // GC tuning: reduce memory footprint and pause times
    "-XX:+UseParallelGC",
    "-XX:GCTimeRatio=4",
    "-XX:AdaptiveSizePolicyWeight=90",
    "-Dsun.zip.disableMemoryMapping=true",
    "-Xlog:disable",
    // Shared index for cross-project reuse
    `-Djdt.core.sharedIndexLocation=${sharedIndexDir}`,
    "--add-modules=ALL-SYSTEM",
    "--add-opens", "java.base/java.util=ALL-UNNAMED",
    "--add-opens", "java.base/java.lang=ALL-UNNAMED",
    "--add-opens", "java.base/sun.nio.fs=ALL-UNNAMED",
  ]

  // Add Lombok support if available
  if (lombokJar) {
    args.push(`-javaagent:${lombokJar}`)
  }

  args.push(
    "-jar", launcherJar,
    "-configuration", configDir,
    "-data", dataDir
  )

  console.log(`[LSP] Spawning JDTLS: ${javaBin}`)
  console.log(`[LSP] Project root: ${projectRoot}`)
  console.log(`[LSP] Data dir: ${dataDir}`)

  const child = spawn(javaBin, args, {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32", // Create process group for tree kill
    env: {
      ...process.env,
      CLIENT_HOST: projectRoot,
      syntaxserver: "false"
    }
  })

  child.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString().trim()
    if (msg) console.warn(`[LSP/stderr] ${msg}`)
  })

  // Early failure detection
  if (child.exitCode !== null) {
    throw new Error(`JDTLS process terminated immediately with exit code ${child.exitCode}`)
  }

  return child
}

export function getBundledJavaHome(): string | undefined {
  try {
    const runtimeDir = getRuntimeDir()
    const extensionDir = join(runtimeDir, "extension")
    const jreBinDir = findJreBinDir(extensionDir)
    return jreBinDir ? join(jreBinDir, "..") : undefined
  } catch {
    return undefined
  }
}

export function checkJdtlsAvailable(): { available: boolean; error?: string } {
  try {
    const resolvedVsix = resolveVsix()
    if (!resolvedVsix) {
      return {
        available: false,
        error: "Java LSP 运行时缺失。请在 Java LSP 面板下载当前平台的 .vsix 文件。"
      }
    }
    // If already extracted, verify key files
    const runtimeDir = getRuntimeDir()
    const extensionDir = join(runtimeDir, "extension")
    const markerFile = join(runtimeDir, ".extracted")
    if (isExtractionCurrent(markerFile, extensionDir, resolvedVsix)) {
      getJavaPath(extensionDir)
      findLauncherJar(extensionDir)
      getConfigDir(extensionDir)
    }
    return { available: true }
  } catch (e) {
    return { available: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function getVsixStatus(): { available: boolean; source: VsixSource | null; path: string | null } {
  try {
    const resolved = resolveVsix()
    if (!resolved) {
      return { available: false, source: null, path: null }
    }
    return { available: true, source: resolved.source, path: resolved.path }
  } catch {
    return { available: false, source: null, path: null }
  }
}

export function importUserVsix(sourcePath: string, sourceName = basename(sourcePath)): { path: string } {
  assertJdtlsVsixArchive(sourcePath)
  assertVsixFilenameCompatible(sourceName)
  const filename = getVsixFilenames().includes(sourceName) ? sourceName : getVsixFilename()
  const destinationDir = getUserVsixDir()
  const destinationPath = join(destinationDir, filename)
  copyFileSync(sourcePath, destinationPath)
  invalidateVsixCaches()
  return { path: destinationPath }
}

export function importUserVsixBuffer(buffer: ArrayBuffer, sourceName?: string): { path: string } {
  const content = Buffer.from(buffer)
  assertJdtlsVsixArchive(content)
  if (sourceName) assertVsixFilenameCompatible(sourceName)
  const filename = sourceName && getVsixFilenames().includes(sourceName) ? sourceName : getVsixFilename()
  const destinationDir = getUserVsixDir()
  const destinationPath = join(destinationDir, filename)
  writeFileSync(destinationPath, content)
  invalidateVsixCaches()
  return { path: destinationPath }
}
