import { execFileSync, spawn } from "child_process"
import { existsSync } from "fs"
import { join, normalize } from "path"
import { getConfiguredIdeExecutablePath, getIdeSettings, saveIdeSettings } from "../storage"
import type {
  ConfigurePreferredIdeRequest,
  ConfigurePreferredIdeResult,
  OpenIdeRequest,
  SupportedIde
} from "../types"

type IdeLauncher = {
  label: string
  command: string
  argsPrefix?: string[]
}

type OpenIdeMode = "workspace+file+line" | "workspace+file" | "workspace"

type OpenIdeResult = {
  editor: string
  mode: OpenIdeMode
}

const FOLLOW_UP_OPEN_DELAY_MS = 500

const IDE_LABELS: Record<SupportedIde, string> = {
  idea: "IntelliJ IDEA",
  vscode: "VS Code",
  webstorm: "WebStorm"
}

const MAC_APP_NAMES: Record<SupportedIde, string[]> = {
  idea: ["IntelliJ IDEA.app", "IntelliJ IDEA CE.app", "IntelliJ IDEA Community Edition.app"],
  vscode: ["Visual Studio Code.app", "Visual Studio Code - Insiders.app"],
  webstorm: ["WebStorm.app"]
}

const MAC_APP_BINARIES: Record<string, string> = {
  "IntelliJ IDEA.app": "idea",
  "IntelliJ IDEA CE.app": "idea",
  "IntelliJ IDEA Community Edition.app": "idea",
  "Visual Studio Code.app": "Electron",
  "Visual Studio Code - Insiders.app": "Electron",
  "WebStorm.app": "webstorm"
}

function isJetBrainsIde(ide: SupportedIde): boolean {
  return ide === "idea" || ide === "webstorm"
}

function getIdeCommandCandidates(ide: SupportedIde): string[] {
  if (process.platform === "win32") {
    return ide === "idea"
      ? ["idea64.exe", "idea.exe", "idea.cmd"]
      : ide === "vscode"
        ? ["code.cmd", "code.exe"]
        : ["webstorm64.exe", "webstorm.exe", "webstorm.cmd"]
  }

  if (process.platform === "darwin") {
    return ide === "idea" ? ["idea"] : ide === "vscode" ? ["code", "code-insiders"] : ["webstorm"]
  }

  return ide === "idea"
    ? ["idea", "idea-community", "intellij-idea-ultimate", "intellij-idea-community"]
    : ide === "vscode"
      ? ["code", "code-insiders"]
      : ["webstorm", "webstorm.sh"]
}

function getExplicitLauncherOverride(ide: SupportedIde): string | null {
  const specificEnv =
    ide === "idea"
      ? process.env.CMB_IDEA_BIN
      : ide === "vscode"
        ? process.env.CMB_VSCODE_BIN
        : process.env.CMB_WEBSTORM_BIN
  const genericEnv = process.env.CMB_LOCAL_IDE || process.env.OPENWORK_IDE
  const rawValue = specificEnv || genericEnv
  const trimmed = trimWrappingQuotes(rawValue || "")
  return trimmed || null
}

function trimWrappingQuotes(value: string): string {
  const trimmed = value.trim()
  return trimmed.replace(/^"(.*)"$/, "$1")
}

function looksLikePath(value: string): boolean {
  return (
    value.includes("/") || value.includes("\\") || /^[a-zA-Z]:/.test(value) || value.startsWith(".")
  )
}

function findExecutableOnPath(command: string): string | null {
  try {
    const output = execFileSync(process.platform === "win32" ? "where.exe" : "which", [command], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000
    })
    const candidates = output
      .split(/\r?\n/)
      .map((line) => trimWrappingQuotes(line))
      .filter((line) => line.length > 0)

    return candidates[0] ?? null
  } catch {
    return null
  }
}

function resolveExecutablePathFromPathEnv(ide: SupportedIde): string | null {
  for (const command of getIdeCommandCandidates(ide)) {
    const resolved = findExecutableOnPath(command)
    if (resolved) return resolved
  }
  return null
}

function resolveLaunchTargetFromExplicitOverride(ide: SupportedIde): string | null {
  const override = getExplicitLauncherOverride(ide)
  if (!override) return null

  if (process.platform === "darwin" && override.endsWith(".app") && existsSync(override)) {
    return override
  }

  if (looksLikePath(override)) {
    return existsSync(override) ? override : null
  }

  return findExecutableOnPath(override)
}

function getMacAppExecutablePath(appPath: string): string {
  const executableName = MAC_APP_BINARIES[appPath.split("/").pop() || ""]
  return join(appPath, "Contents", "MacOS", executableName)
}

function getMacAppBundlePath(pathValue: string): string | null {
  if (process.platform !== "darwin") return null

  const trimmed = trimWrappingQuotes(pathValue)
  if (!trimmed) return null
  if (trimmed.endsWith(".app")) return trimmed

  const marker = "/Contents/MacOS/"
  const markerIndex = trimmed.lastIndexOf(marker)
  if (markerIndex <= 0) return null

  const appPath = trimmed.slice(0, markerIndex)
  return appPath.endsWith(".app") ? appPath : null
}

function findMacInstalledApps(appName: string): string[] {
  try {
    const output = execFileSync(
      "mdfind",
      [`kMDItemFSName == "${appName}" && kMDItemContentTypeTree == "com.apple.application-bundle"`],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000
      }
    )

    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.endsWith(".app"))
  } catch {
    return []
  }
}

function resolveExecutablePathFromInstalledApp(ide: SupportedIde): string | null {
  if (process.platform !== "darwin") return null

  const seen = new Set<string>()

  for (const appName of MAC_APP_NAMES[ide]) {
    const candidates = [
      ...findMacInstalledApps(appName),
      join("/Applications", appName),
      join(process.env.HOME || "", "Applications", appName)
    ]

    for (const appPath of candidates) {
      if (!appPath || seen.has(appPath)) continue
      seen.add(appPath)

      const executablePath = getMacAppExecutablePath(appPath)
      if (existsSync(appPath) && existsSync(executablePath)) {
        return appPath
      }
    }
  }

  return null
}

function validateProvidedExecutablePath(ide: SupportedIde, executablePath?: string): string | null {
  const trimmed = trimWrappingQuotes(executablePath || "")
  if (!trimmed) return null

  if (process.platform === "darwin" && trimmed.endsWith(".app")) {
    const appExecutable = getMacAppExecutablePath(trimmed)
    if (!existsSync(trimmed) || !existsSync(appExecutable)) {
      throw new Error(`找不到 ${IDE_LABELS[ide]} 应用：${trimmed}`)
    }
    return trimmed
  }

  if (!looksLikePath(trimmed)) {
    throw new Error(`请输入 ${IDE_LABELS[ide]} 可执行文件的完整路径，不要只填命令名。`)
  }

  if (looksLikePath(trimmed) && !existsSync(trimmed)) {
    throw new Error(`找不到 ${IDE_LABELS[ide]} 可执行文件：${trimmed}`)
  }

  return trimmed
}

export function configurePreferredIde(
  request: ConfigurePreferredIdeRequest
): ConfigurePreferredIdeResult {
  const preferredIde = request.preferredIde

  try {
    const providedPath = validateProvidedExecutablePath(preferredIde, request.executablePath)

    if (providedPath) {
      const settings = saveIdeSettings({
        preferredIde,
        executablePaths: { [preferredIde]: providedPath }
      })
      return { status: "configured", settings }
    }
  } catch (error) {
    return {
      status: "needs_executable_path",
      settings: getIdeSettings(),
      message: error instanceof Error ? error.message : "IDE 路径无效"
    }
  }

  const resolvedPath =
    resolveLaunchTargetFromExplicitOverride(preferredIde) ||
    resolveExecutablePathFromPathEnv(preferredIde) ||
    resolveExecutablePathFromInstalledApp(preferredIde)
  if (!resolvedPath) {
    const settings = saveIdeSettings({ preferredIde })
    return {
      status: "needs_executable_path",
      settings,
      message:
        process.platform === "darwin"
          ? `未找到已安装的 ${IDE_LABELS[preferredIde]}，请输入可执行文件完整路径。`
          : `未在 PATH 中找到 ${IDE_LABELS[preferredIde]}，请输入可执行文件完整路径。`
    }
  }

  const settings = saveIdeSettings({
    preferredIde,
    executablePaths: { [preferredIde]: resolvedPath }
  })
  return { status: "configured", settings }
}

function getConfiguredLauncher(ide: SupportedIde): IdeLauncher {
  const executablePath = getConfiguredIdeExecutablePath(ide)
  if (!executablePath) {
    throw new Error(`尚未配置 ${IDE_LABELS[ide]} 的启动路径，请重新选择 IDE 并保存路径。`)
  }

  const macAppPath =
    process.platform === "darwin"
      ? executablePath.endsWith(".app")
        ? executablePath
        : getMacAppBundlePath(executablePath)
      : null

  if (macAppPath) {
    const appExecutable = getMacAppExecutablePath(macAppPath)
    if (!existsSync(macAppPath) || !existsSync(appExecutable)) {
      throw new Error(`已保存的 ${IDE_LABELS[ide]} 应用路径无效，请重新选择 IDE。`)
    }

    if (isJetBrainsIde(ide)) {
      return {
        label: macAppPath,
        command: appExecutable
      }
    }

    return {
      label: macAppPath,
      command: "/usr/bin/open",
      argsPrefix: ["-a", macAppPath, "--args"]
    }
  }

  return {
    label: executablePath,
    command: executablePath
  }
}

function shouldUseShell(command: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(command)
}

function shouldTreatNonZeroExitAsSuccess(command: string): boolean {
  if (process.platform !== "win32") return false

  // JetBrains / VS Code GUI launchers on Windows can return a non-zero exit code
  // even after they have already forwarded the open request to a running IDE.
  // Once the process is spawned successfully, trust the spawn/error signal rather
  // than the launcher exit code for these best-effort handoff executables.
  return /(?:^|[\\/])(?:idea64|idea|webstorm64|webstorm|code|code - insiders)\.exe$/i.test(
    command
  )
}

function logOpenInIde(
  stage: string,
  detail: Record<string, unknown>
): void {
  const message = Object.entries(detail)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      if (Array.isArray(value)) return `${key}=${value.join(" ")}`
      if (typeof value === "string") {
        return `${key}=${/\s/.test(value) ? JSON.stringify(value) : value}`
      }
      return `${key}=${String(value)}`
    })
    .join(" ")

  console.log(message.length > 0 ? `[OpenInIde] ${stage} ${message}` : `[OpenInIde] ${stage}`)
}

function spawnDetached(launcher: IdeLauncher, args: string[]): Promise<void> {
  return spawnDetachedWithPrefix(launcher, launcher.argsPrefix, args)
}

function spawnDetachedWithPrefix(
  launcher: IdeLauncher,
  argsPrefix: string[] | undefined,
  args: string[]
): Promise<void> {
  const shell = shouldUseShell(launcher.command)
  const launchPreview = [launcher.command, ...(argsPrefix ?? []), ...args]
    .map((value) => (/\s/.test(value) ? JSON.stringify(value) : value))
    .join(" ")

  logOpenInIde("spawn", {
    cmd: launchPreview,
    shell: shell ? true : undefined
  })

  return new Promise((resolve, reject) => {
    const child = spawn(launcher.command, [...(argsPrefix || []), ...args], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell
    })

    let settled = false
    const settle = (callback: () => void): void => {
      if (settled) return
      settled = true
      callback()
    }

    const timer = setTimeout(() => {
      child.unref()
      logOpenInIde("spawn-ok", {
        via: "timeout",
        cmd: launchPreview
      })
      settle(resolve)
    }, 700)

    child.once("error", (error) => {
      clearTimeout(timer)
      logOpenInIde("spawn-fail", {
        cmd: launchPreview,
        error: error.message
      })
      settle(() => reject(error))
    })

    child.once("exit", (code) => {
      clearTimeout(timer)
      const treatedAsSuccess =
        code === 0 || code === null || shouldTreatNonZeroExitAsSuccess(launcher.command)

      logOpenInIde(treatedAsSuccess ? "spawn-ok" : "spawn-fail", {
        cmd: launchPreview,
        code
      })

      if (treatedAsSuccess) {
        child.unref()
        settle(resolve)
        return
      }
      settle(() => reject(new Error(`exited with code ${code}`)))
    })
  })
}

function buildWorkspaceArgs(_ide: SupportedIde, workspacePath: string): string[] {
  return [workspacePath]
}

function buildWorkspaceAndFileArgs(
  _ide: SupportedIde,
  workspacePath: string,
  filePath: string
): string[] {
  return [workspacePath, filePath]
}

function buildFileArgs(_ide: SupportedIde, filePath: string): string[] {
  return [filePath]
}

function buildFileAtLineArgs(
  ide: SupportedIde,
  filePath: string,
  line: number,
): string[] {
  if (ide === "vscode") return ["-g", `${filePath}:${line}`]
  return ["--line", String(line), filePath]
}

async function openWorkspace(
  launcher: IdeLauncher,
  ide: SupportedIde,
  workspacePath: string
): Promise<void> {
  await spawnDetached(launcher, buildWorkspaceArgs(ide, workspacePath))
}

async function openWorkspaceAndFile(
  launcher: IdeLauncher,
  ide: SupportedIde,
  workspacePath: string,
  filePath: string
): Promise<void> {
  await spawnDetached(launcher, buildWorkspaceAndFileArgs(ide, workspacePath, filePath))
}

async function openFile(launcher: IdeLauncher, ide: SupportedIde, filePath: string): Promise<void> {
  await spawnDetached(launcher, buildFileArgs(ide, filePath))
}

async function openFileAtLine(
  launcher: IdeLauncher,
  ide: SupportedIde,
  filePath: string,
  line: number
): Promise<void> {
  await spawnDetached(launcher, buildFileAtLineArgs(ide, filePath, line))
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export async function openIde(request: OpenIdeRequest): Promise<OpenIdeResult> {
  const workspacePath = normalize(request.workspacePath)
  const filePath = request.filePath ? normalize(request.filePath) : undefined
  const line = typeof request.line === "number" && request.line > 0 ? request.line : undefined
  const launcher = getConfiguredLauncher(request.ide)
  const failures: string[] = []
  let workspaceOpened = false
  let fileOpened = false

  logOpenInIde("request", {
    ide: request.ide,
    launcher: launcher.label,
    command: launcher.command,
    workspace: workspacePath,
    file: filePath,
    line
  })

  if (filePath && isJetBrainsIde(request.ide)) {
    try {
      logOpenInIde("action", {
        mode: line ? "workspace+file-then-line" : "workspace+file",
        workspace: workspacePath,
        file: filePath,
        line
      })
      await openWorkspaceAndFile(launcher, request.ide, workspacePath, filePath)
      workspaceOpened = true
      fileOpened = true
    } catch (error) {
      failures.push(
        `${launcher.label} (workspace+file): ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  if (!workspaceOpened) {
    try {
      logOpenInIde("action", {
        mode: "workspace",
        workspace: workspacePath,
        file: filePath,
        line
      })
      await openWorkspace(launcher, request.ide, workspacePath)
      workspaceOpened = true
    } catch (error) {
      failures.push(
        `${launcher.label} (workspace): ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  if (!workspaceOpened) {
    throw new Error(
      `无法打开 IDE。已尝试 ${launcher.label}，并按 workspace+file / workspace 顺序降级。${failures.join("；")}`
    )
  }

  if (!filePath) {
    return { editor: launcher.label, mode: "workspace" }
  }

  if (line) {
    try {
      logOpenInIde("action", {
        mode: "file-at-line-after-workspace",
        file: filePath,
        line
      })
      await delay(FOLLOW_UP_OPEN_DELAY_MS)
      await openFileAtLine(launcher, request.ide, filePath, line)
      return { editor: launcher.label, mode: "workspace+file+line" }
    } catch (error) {
      failures.push(
        `${launcher.label} (file+line after workspace): ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  if (fileOpened) {
    return { editor: launcher.label, mode: "workspace+file" }
  }

  try {
    logOpenInIde("action", {
      mode: "file-after-workspace",
      file: filePath
    })
    await openFile(launcher, request.ide, filePath)
    return { editor: launcher.label, mode: "workspace+file" }
  } catch (error) {
    failures.push(
      `${launcher.label} (file after workspace): ${error instanceof Error ? error.message : String(error)}`
    )
  }

  return { editor: launcher.label, mode: "workspace" }
}
