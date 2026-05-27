import { execFileSync, spawn } from "child_process"
import { existsSync } from "fs"
import { join, normalize } from "path"
import type { OpenIdeRequest, SupportedIde } from "../types"

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

function uniqueLaunchers(launchers: IdeLauncher[]): IdeLauncher[] {
  const seen = new Set<string>()
  return launchers.filter((launcher) => {
    const key = `${launcher.label}\0${launcher.command}\0${(launcher.argsPrefix || []).join("\0")}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function canExecuteOnPath(command: string): boolean {
  try {
    if (process.platform === "win32") {
      execFileSync("where.exe", [command], { stdio: "ignore", timeout: 2000 })
      return true
    }

    execFileSync("which", [command], { stdio: "ignore", timeout: 2000 })
    return true
  } catch {
    return false
  }
}

function getCustomLaunchers(ide: SupportedIde): IdeLauncher[] {
  const specificEnv =
    ide === "idea"
      ? process.env.CMB_IDEA_BIN
      : ide === "vscode"
        ? process.env.CMB_VSCODE_BIN
        : process.env.CMB_WEBSTORM_BIN
  const genericEnv = process.env.CMB_LOCAL_IDE || process.env.OPENWORK_IDE
  const command = specificEnv || genericEnv
  if (!command) return []
  return [{ label: command, command }]
}

function getMacLaunchers(ide: SupportedIde): IdeLauncher[] {
  const appName =
    ide === "idea" ? "IntelliJ IDEA" : ide === "vscode" ? "Visual Studio Code" : "WebStorm"
  const cliNames =
    ide === "idea"
      ? ["idea"]
      : ide === "vscode"
        ? ["code"]
        : ["webstorm"]

  return uniqueLaunchers([
    { label: appName, command: "open", argsPrefix: ["-a", appName] },
    ...cliNames
      .filter((command) => canExecuteOnPath(command))
      .map((command) => ({ label: command, command }))
  ])
}

function getWindowsLaunchers(ide: SupportedIde): IdeLauncher[] {
  const roots = [
    process.env["ProgramFiles"],
    process.env["ProgramFiles(x86)"],
    process.env.LOCALAPPDATA
  ].filter((value): value is string => Boolean(value))

  const commandNames =
    ide === "idea"
      ? ["idea64.exe", "idea.exe", "idea.cmd"]
      : ide === "vscode"
        ? ["code.cmd", "code.exe"]
        : ["webstorm64.exe", "webstorm.exe", "webstorm.cmd"]

  const absolutePaths =
    ide === "idea"
      ? [
          ...roots.map((base) => join(base, "JetBrains", "IntelliJ IDEA", "bin", "idea64.exe")),
          ...roots.map((base) => join(base, "JetBrains", "IntelliJ IDEA Community Edition", "bin", "idea64.exe"))
        ]
      : ide === "vscode"
        ? [
            ...roots.map((base) => join(base, "Microsoft VS Code", "Code.exe")),
            ...roots.map((base) => join(base, "Microsoft VS Code Insiders", "Code - Insiders.exe"))
          ]
        : roots.map((base) => join(base, "JetBrains", "WebStorm", "bin", "webstorm64.exe"))

  return uniqueLaunchers([
    ...commandNames
      .filter((command) => canExecuteOnPath(command))
      .map((command) => ({ label: command, command })),
    ...absolutePaths
      .filter((command) => existsSync(command))
      .map((command) => ({ label: command, command }))
  ])
}

function getLinuxLaunchers(ide: SupportedIde): IdeLauncher[] {
  const commandNames =
    ide === "idea"
      ? ["idea", "idea-community", "intellij-idea-ultimate", "intellij-idea-community"]
      : ide === "vscode"
        ? ["code", "code-insiders"]
        : ["webstorm", "webstorm.sh"]

  const absolutePaths =
    ide === "idea"
      ? [
          "/snap/bin/intellij-idea-community",
          "/snap/bin/intellij-idea-ultimate",
          "/usr/local/bin/idea",
          "/opt/idea/bin/idea.sh"
        ]
      : ide === "vscode"
        ? [
            "/snap/bin/code",
            "/snap/bin/code-insiders",
            "/usr/bin/code",
            "/usr/local/bin/code"
          ]
        : [
            "/snap/bin/webstorm",
            "/usr/local/bin/webstorm",
            "/opt/webstorm/bin/webstorm.sh"
          ]

  return uniqueLaunchers([
    ...commandNames
      .filter((command) => canExecuteOnPath(command))
      .map((command) => ({ label: command, command })),
    ...absolutePaths
      .filter((command) => existsSync(command))
      .map((command) => ({ label: command, command }))
  ])
}

function getIdeLaunchers(ide: SupportedIde): IdeLauncher[] {
  const custom = getCustomLaunchers(ide)
  const platformLaunchers =
    process.platform === "darwin"
      ? getMacLaunchers(ide)
      : process.platform === "win32"
        ? getWindowsLaunchers(ide)
        : getLinuxLaunchers(ide)

  return uniqueLaunchers([...custom, ...platformLaunchers])
}

function spawnDetached(launcher: IdeLauncher, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(launcher.command, [...(launcher.argsPrefix || []), ...args], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    })

    let settled = false
    const settle = (callback: () => void): void => {
      if (settled) return
      settled = true
      callback()
    }

    const timer = setTimeout(() => {
      child.unref()
      settle(resolve)
    }, 700)

    child.once("error", (error) => {
      clearTimeout(timer)
      settle(() => reject(error))
    })

    child.once("exit", (code) => {
      clearTimeout(timer)
      if (code === 0 || code === null) {
        settle(resolve)
        return
      }
      settle(() => reject(new Error(`exited with code ${code}`)))
    })
  })
}

function buildWorkspaceArgs(ide: SupportedIde, workspacePath: string): string[] {
  return [workspacePath]
}

function buildFileArgs(ide: SupportedIde, filePath: string): string[] {
  return ide === "vscode" ? [filePath] : [filePath]
}

function buildFileAtLineArgs(ide: SupportedIde, filePath: string, line: number): string[] {
  if (ide === "vscode") return ["-g", `${filePath}:${line}`]
  return ["--line", String(line), filePath]
}

async function openWorkspace(launcher: IdeLauncher, ide: SupportedIde, workspacePath: string): Promise<void> {
  await spawnDetached(launcher, buildWorkspaceArgs(ide, workspacePath))
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

export async function openIde(request: OpenIdeRequest): Promise<OpenIdeResult> {
  const workspacePath = normalize(request.workspacePath)
  const filePath = request.filePath ? normalize(request.filePath) : undefined
  const line = typeof request.line === "number" && request.line > 0 ? request.line : undefined
  const launchers = getIdeLaunchers(request.ide)

  if (launchers.length === 0) {
    throw new Error(`未找到可用的 ${request.ide} 启动方式。请安装对应 IDE CLI，或设置环境变量覆盖。`)
  }

  const failures: string[] = []

  for (const launcher of launchers) {
    if (filePath && line) {
      try {
        await openFileAtLine(launcher, request.ide, filePath, line)
        return { editor: launcher.label, mode: "workspace+file+line" }
      } catch (error) {
        failures.push(
          `${launcher.label} (workspace+file+line): ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }

    if (filePath) {
      try {
        await openFile(launcher, request.ide, filePath)
        return { editor: launcher.label, mode: "workspace+file" }
      } catch (error) {
        failures.push(
          `${launcher.label} (workspace+file): ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }

    try {
      await openWorkspace(launcher, request.ide, workspacePath)
      return { editor: launcher.label, mode: "workspace" }
    } catch (error) {
      failures.push(
        `${launcher.label} (workspace): ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  throw new Error(
    `无法打开 IDE。已尝试 ${request.ide}，并按 workspace+file+line / workspace+file / workspace 顺序降级。${failures
      .slice(0, 4)
      .join("；")}`
  )
}
