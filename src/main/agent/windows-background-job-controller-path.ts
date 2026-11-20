import { existsSync } from "node:fs"
import path from "node:path"

export interface WindowsBackgroundJobControllerPathOptions {
  cwd?: string
  isPackaged?: boolean
  moduleDirectory?: string
  pathExists?: (candidate: string) => boolean
  resourcesPath?: string
}

const relativeParts = ["bin", "win32", "background-job-controller.exe"]

function isPackagedElectronRuntime(electronProcess: NodeJS.Process): boolean {
  return Boolean(electronProcess.versions.electron) && electronProcess.defaultApp !== true
}

export function resolveWindowsBackgroundJobControllerPath(
  options: WindowsBackgroundJobControllerPathOptions = {}
): string {
  const electronProcess = process
  const isPackaged = options.isPackaged ?? isPackagedElectronRuntime(electronProcess)
  const resourceRoot = options.resourcesPath ?? electronProcess.resourcesPath

  if (isPackaged) {
    if (!resourceRoot || !path.isAbsolute(resourceRoot)) {
      throw new Error("Packaged Windows background Job controller resource path is unavailable")
    }
    // Packaged builds must fail closed at the immutable extraResources path.
    // Do not probe the current working directory for an attacker-controlled
    // executable when packaging is incomplete or damaged.
    return path.join(resourceRoot, ...relativeParts)
  }

  const cwd = options.cwd ?? process.cwd()
  const moduleDirectory = options.moduleDirectory ?? __dirname
  const pathExists = options.pathExists ?? existsSync
  const candidates = [
    path.join(cwd, "resources", ...relativeParts),
    path.resolve(moduleDirectory, "../../resources", ...relativeParts),
    path.resolve(moduleDirectory, "../../../resources", ...relativeParts)
  ]
  return candidates.find((candidate) => pathExists(candidate)) ?? candidates[0]
}
