import { spawnSync } from "child_process"
import { existsSync, readdirSync, readFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import type { LspConfig, LspJavaRuntime, LspJavaRuntimeName, LspProjectRequirement } from "../types"
import { LSP_JAVA_RUNTIME_NAMES } from "../types"

const RUNTIME_NAME_BY_MAJOR: Record<number, LspJavaRuntimeName> = {
  8: "JavaSE-1.8",
  11: "JavaSE-11",
  17: "JavaSE-17",
  21: "JavaSE-21"
}

const SOURCE_PRIORITY: Record<LspJavaRuntime["source"], number> = {
  configured: 0,
  env: 1,
  java_home: 2,
  scan: 3
}

const AUTO_RUNTIME_CACHE_TTL_MS = 30_000

type JavaHomeStatus = { path: string; version: string | null; valid: boolean; error?: string }
type ResolvedJavaHome = { runtime: LspJavaRuntime | null; status: JavaHomeStatus }
type AutoRuntimeCache = {
  envJavaHome: string | null
  checkedAt: number
  runtimes: LspJavaRuntime[]
}

let autoRuntimeCache: AutoRuntimeCache | null = null

function normalizeJavaHome(inputPath: string): string {
  const trimmed = inputPath.trim().replace(/[\\/]+$/, "")
  if (!trimmed) return trimmed
  const match = trimmed.match(/^(.*?)[\\/]+bin[\\/]+(?:java|javac)(?:\.exe)?$/i)
  if (match) return match[1]
  return trimmed
}

function isSameJavaHome(left: string, right: string): boolean {
  const normalizedLeft = normalizeJavaHome(left)
  const normalizedRight = normalizeJavaHome(right)
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

function javacName(): string {
  return process.platform === "win32" ? "javac.exe" : "javac"
}

function hasJavac(javaHome: string): boolean {
  return existsSync(join(javaHome, "bin", javacName()))
}

function addJavaHomeCandidate(homes: Set<string>, javaHome: string): void {
  const normalized = normalizeJavaHome(javaHome)
  if (normalized && hasJavac(normalized)) homes.add(normalized)
}

function scanJavaHomeRoot(homes: Set<string>, root: string): void {
  if (!existsSync(root)) return
  try {
    for (const entry of readdirSync(root)) {
      const candidate = join(root, entry)
      addJavaHomeCandidate(homes, candidate)
      addJavaHomeCandidate(homes, join(candidate, "Contents", "Home"))
    }
  } catch {
    // Ignore best-effort detection failures.
  }
}

function parseJavaMajor(version: string): number | null {
  const cleaned = version.replace(/^"|"$/g, "").trim()
  if (!cleaned) return null
  if (cleaned.startsWith("1.8")) return 8
  const match = cleaned.match(/^(\d+)/)
  if (!match) return null
  const major = Number(match[1])
  return Number.isFinite(major) ? major : null
}

function runtimeNameFromVersion(version: string): LspJavaRuntimeName | null {
  const major = parseJavaMajor(version)
  if (!major) return null
  return RUNTIME_NAME_BY_MAJOR[major] ?? null
}

function readJavaVersion(javaHome: string): string | null {
  const releaseFile = join(javaHome, "release")
  if (!existsSync(releaseFile)) return null
  try {
    const content = readFileSync(releaseFile, "utf-8")
    const match = content.match(/^JAVA_VERSION="([^"]+)"/m)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

function validateJavaHome(javaHome: string): { version: string | null; valid: boolean; error?: string } {
  const normalized = normalizeJavaHome(javaHome)
  if (!normalized) {
    return { version: null, valid: false, error: "路径为空" }
  }
  if (!existsSync(normalized)) {
    return { version: null, valid: false, error: "路径不存在" }
  }
  if (!hasJavac(normalized)) {
    return { version: null, valid: false, error: "未找到 javac，可执行路径不是 JDK Home" }
  }
  const version = readJavaVersion(normalized)
  if (!version) {
    return { version: null, valid: false, error: "无法读取 release 文件中的 Java 版本" }
  }
  return { version, valid: true }
}

function collectMacJavaHomes(): string[] {
  if (process.platform !== "darwin") return []
  const homes = new Set<string>()

  try {
    const result = spawnSync("/usr/libexec/java_home", ["-V"], { encoding: "utf-8" })
    const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    for (const line of combined.split("\n")) {
      const pathMatch = line.match(/(\/.*)$/)
      if (pathMatch) homes.add(normalizeJavaHome(pathMatch[1]))
    }
  } catch {
    // Ignore detection failures; callers will surface the final result.
  }

  const roots = [
    "/Library/Java/JavaVirtualMachines",
    join(homedir(), "Library", "Java", "JavaVirtualMachines")
  ]
  for (const root of roots) scanJavaHomeRoot(homes, root)

  return Array.from(homes)
}

function collectWindowsJavaHomes(): string[] {
  if (process.platform !== "win32") return []
  const homes = new Set<string>()

  try {
    const result = spawnSync("where", ["java"], { encoding: "utf-8" })
    const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    for (const line of combined.split("\n")) {
      const candidate = line.trim()
      if (candidate.toLowerCase().endsWith("java.exe")) {
        homes.add(normalizeJavaHome(candidate))
      }
    }
  } catch {
    // Ignore best-effort detection failures.
  }

  const vendorRoots = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.LOCALAPPDATA,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs") : undefined
  ].filter((value): value is string => Boolean(value))

  const vendors = [
    "Java",
    "Eclipse Adoptium",
    "AdoptOpenJDK",
    "Zulu",
    "BellSoft",
    "Microsoft",
    "Amazon Corretto",
    "Semeru"
  ]

  for (const root of vendorRoots) {
    for (const vendor of vendors) {
      scanJavaHomeRoot(homes, join(root, vendor))
    }
  }

  return Array.from(homes)
}

function collectLinuxJavaHomes(): string[] {
  if (process.platform !== "linux") return []
  const homes = new Set<string>()
  for (const root of ["/usr/lib/jvm", "/usr/java"]) {
    scanJavaHomeRoot(homes, root)
  }
  return Array.from(homes)
}

function resolveJavaHome(pathValue: string, source: LspJavaRuntime["source"]): ResolvedJavaHome {
  const normalized = normalizeJavaHome(pathValue)
  const validation = validateJavaHome(normalized)
  const runtimeName = validation.version ? runtimeNameFromVersion(validation.version) : null
  const status = {
    path: normalized,
    version: validation.version,
    valid: validation.valid && Boolean(runtimeName),
    error: runtimeName ? validation.error : (validation.error ?? "无法识别该 JDK 版本")
  }

  return {
    runtime: runtimeName ? {
      name: runtimeName,
      path: normalized,
      source,
      version: validation.version,
      valid: validation.valid,
      error: validation.error
    } : null,
    status
  }
}

function inferRuntimeFromPath(pathValue: string, source: LspJavaRuntime["source"]): LspJavaRuntime | null {
  return resolveJavaHome(pathValue, source).runtime
}

function setRuntime(
  runtimes: Map<LspJavaRuntimeName, LspJavaRuntime>,
  runtime: LspJavaRuntime
): void {
  const existing = runtimes.get(runtime.name)
  if (
    !existing
    || (runtime.valid && !existing.valid)
    || (runtime.valid === existing.valid && SOURCE_PRIORITY[runtime.source] < SOURCE_PRIORITY[existing.source])
  ) {
    runtimes.set(runtime.name, runtime)
  }
}

function resolvePomProperty(value: string, properties: Record<string, string>): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, key: string) => properties[key] ?? "")
}

function inferPomJavaRequirement(projectRoot: string): LspProjectRequirement | null {
  const pomPath = join(projectRoot, "pom.xml")
  if (!existsSync(pomPath)) return null

  try {
    const xml = readFileSync(pomPath, "utf-8")
    const properties: Record<string, string> = {}
    const propertiesBlock = xml.match(/<properties>([\s\S]*?)<\/properties>/)
    if (propertiesBlock) {
      const propertyRegex = /<([a-zA-Z0-9_.-]+)>([\s\S]*?)<\/\1>/g
      let match: RegExpExecArray | null
      while ((match = propertyRegex.exec(propertiesBlock[1])) !== null) {
        properties[match[1]] = match[2].trim()
      }
    }

    const candidates = [
      xml.match(/<maven\.compiler\.release>([^<]+)<\/maven\.compiler\.release>/)?.[1],
      xml.match(/<maven\.compiler\.source>([^<]+)<\/maven\.compiler\.source>/)?.[1],
      xml.match(/<maven\.compiler\.target>([^<]+)<\/maven\.compiler\.target>/)?.[1],
      xml.match(/<java\.version>([^<]+)<\/java\.version>/)?.[1]
    ].filter((value): value is string => Boolean(value))

    for (const candidate of candidates) {
      const resolved = resolvePomProperty(candidate.trim(), properties)
      const runtimeName = runtimeNameFromVersion(resolved)
      if (runtimeName) {
        return { javaVersion: resolved, runtimeName, source: "pom.xml" }
      }
    }
  } catch {
    return null
  }

  return null
}

function inferGradleJavaRequirement(projectRoot: string): LspProjectRequirement | null {
  const candidates: Array<{ path: string; source: LspProjectRequirement["source"] }> = [
    { path: join(projectRoot, "build.gradle.kts"), source: "build.gradle.kts" },
    { path: join(projectRoot, "build.gradle"), source: "build.gradle" }
  ]

  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue
    try {
      const content = readFileSync(candidate.path, "utf-8")
      const checks = [
        content.match(/JavaLanguageVersion\.of\((\d+)\)/)?.[1],
        content.match(/sourceCompatibility\s*=\s*JavaVersion\.VERSION_(1_8|\d+)/)?.[1]?.replace("_", "."),
        content.match(/targetCompatibility\s*=\s*JavaVersion\.VERSION_(1_8|\d+)/)?.[1]?.replace("_", "."),
        content.match(/sourceCompatibility\s*=\s*["']([^"']+)["']/)?.[1],
        content.match(/targetCompatibility\s*=\s*["']([^"']+)["']/)?.[1],
        content.match(/sourceCompatibility\s*=\s*(\d+)/)?.[1],
        content.match(/targetCompatibility\s*=\s*(\d+)/)?.[1]
      ].filter((value): value is string => Boolean(value))

      for (const check of checks) {
        const runtimeName = runtimeNameFromVersion(check)
        if (runtimeName) {
          return { javaVersion: check, runtimeName, source: candidate.source }
        }
      }
    } catch {
      return null
    }
  }

  return null
}

function inferClasspathJavaRequirement(projectRoot: string): LspProjectRequirement | null {
  const classpathPath = join(projectRoot, ".classpath")
  if (!existsSync(classpathPath)) return null
  try {
    const content = readFileSync(classpathPath, "utf-8")
    const runtimeName = LSP_JAVA_RUNTIME_NAMES.find((name) => content.includes(`/${name}`))
    if (!runtimeName) return null
    return {
      javaVersion: runtimeName === "JavaSE-1.8" ? "1.8" : runtimeName.replace("JavaSE-", ""),
      runtimeName,
      source: ".classpath"
    }
  } catch {
    return null
  }
}

export function inferProjectJavaRequirement(projectRoot: string): LspProjectRequirement | null {
  return (
    inferPomJavaRequirement(projectRoot)
    ?? inferGradleJavaRequirement(projectRoot)
    ?? inferClasspathJavaRequirement(projectRoot)
  )
}

function collectAutoDetectedJavaHomes(): string[] {
  const homes = new Set<string>()
  const envHome = process.env.JAVA_HOME
  if (envHome) homes.add(normalizeJavaHome(envHome))
  for (const home of collectMacJavaHomes()) homes.add(home)
  for (const home of collectWindowsJavaHomes()) homes.add(home)
  for (const home of collectLinuxJavaHomes()) homes.add(home)
  return Array.from(homes)
}

export function invalidateJavaRuntimeCache(): void {
  autoRuntimeCache = null
}

function resolveManualJavaHome(manualJavaHome: string | null): {
  runtime: LspJavaRuntime | null
  status: JavaHomeStatus | null
} {
  if (!manualJavaHome?.trim()) {
    return { runtime: null, status: null }
  }

  return resolveJavaHome(manualJavaHome, "configured")
}

function resolveAutoDetectedJavaRuntimes(): LspJavaRuntime[] {
  const envJavaHome = process.env.JAVA_HOME ?? null
  const now = Date.now()
  if (
    autoRuntimeCache &&
    autoRuntimeCache.envJavaHome === envJavaHome &&
    now - autoRuntimeCache.checkedAt < AUTO_RUNTIME_CACHE_TTL_MS
  ) {
    return autoRuntimeCache.runtimes
  }

  const runtimes = new Map<LspJavaRuntimeName, LspJavaRuntime>()

  for (const home of collectAutoDetectedJavaHomes()) {
    const source: LspJavaRuntime["source"] =
      process.env.JAVA_HOME && isSameJavaHome(process.env.JAVA_HOME, home)
        ? "env"
        : process.platform === "darwin"
          ? "java_home"
          : "scan"
    const runtime = inferRuntimeFromPath(home, source)
    if (runtime) setRuntime(runtimes, runtime)
  }

  const resolved = LSP_JAVA_RUNTIME_NAMES
    .map((name) => runtimes.get(name))
    .filter((runtime): runtime is LspJavaRuntime => Boolean(runtime))

  autoRuntimeCache = { envJavaHome, checkedAt: now, runtimes: resolved }
  return resolved
}

function resolveJavaRuntimesWithManualResolution(manualResolution: ReturnType<typeof resolveManualJavaHome>): LspJavaRuntime[] {
  const runtimes = new Map<LspJavaRuntimeName, LspJavaRuntime>()

  if (manualResolution.runtime) setRuntime(runtimes, manualResolution.runtime)

  for (const runtime of resolveAutoDetectedJavaRuntimes()) {
    if (runtime) setRuntime(runtimes, runtime)
  }

  return LSP_JAVA_RUNTIME_NAMES
    .map((name) => runtimes.get(name))
    .filter((runtime): runtime is LspJavaRuntime => Boolean(runtime))
}

export function resolveJavaRuntimes(config: LspConfig): LspJavaRuntime[] {
  return resolveJavaRuntimesWithManualResolution(resolveManualJavaHome(config.manualJavaHome))
}

function buildRuntimeContext(config: LspConfig, projectRequirement: LspProjectRequirement | null): {
  projectRequirement: LspProjectRequirement | null
  runtimes: LspJavaRuntime[]
  selectedRuntime: LspJavaRuntime | null
  manualJavaHomeStatus: { path: string; version: string | null; valid: boolean; error?: string } | null
  missingRuntime: LspJavaRuntimeName | null
  settingsRuntimes: Array<{ name: LspJavaRuntimeName; path: string; default?: boolean }>
} {
  const manualResolution = resolveManualJavaHome(config.manualJavaHome)
  const runtimes = resolveJavaRuntimesWithManualResolution(manualResolution)
  const manualJavaHomeStatus = manualResolution.status
  const validRuntimes = runtimes.filter((runtime) => runtime.valid)

  let defaultRuntimeName: LspJavaRuntimeName | null = null
  if (projectRequirement && validRuntimes.some((runtime) => runtime.name === projectRequirement.runtimeName)) {
    defaultRuntimeName = projectRequirement.runtimeName
  } else if (validRuntimes.length > 0) {
    defaultRuntimeName = validRuntimes[validRuntimes.length - 1].name
  }

  const settingsRuntimes = validRuntimes.map((runtime) => ({
    name: runtime.name,
    path: runtime.path,
    default: runtime.name === defaultRuntimeName
  }))

  const selectedRuntime = defaultRuntimeName
    ? validRuntimes.find((runtime) => runtime.name === defaultRuntimeName) ?? null
    : (validRuntimes[validRuntimes.length - 1] ?? null)

  const missingRuntime = projectRequirement && !validRuntimes.some((runtime) => runtime.name === projectRequirement.runtimeName)
    ? projectRequirement.runtimeName
    : null

  return {
    projectRequirement,
    runtimes,
    selectedRuntime,
    manualJavaHomeStatus,
    missingRuntime,
    settingsRuntimes
  }
}

export function buildGlobalRuntimeContext(config: LspConfig): ReturnType<typeof buildRuntimeContext> {
  return buildRuntimeContext(config, null)
}

export function buildProjectRuntimeContext(projectRoot: string, config: LspConfig): ReturnType<typeof buildRuntimeContext> {
  return buildRuntimeContext(config, inferProjectJavaRequirement(projectRoot))
}
