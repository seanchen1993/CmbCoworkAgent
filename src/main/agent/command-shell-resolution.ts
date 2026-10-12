import fs from "node:fs/promises"
import path from "node:path"

/** Shared with the native executor. Discovery reads paths; it never starts a shell. */
export interface CommandShellEnvironment {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
}

const currentEnvironment = (): CommandShellEnvironment => ({
  platform: process.platform,
  env: process.env
})

function value(context: CommandShellEnvironment, key: string): string | undefined {
  if (context.env[key] !== undefined) return context.env[key]
  if (context.platform !== "win32") return undefined
  const actual = Object.keys(context.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return actual ? context.env[actual] : undefined
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

const paths = (context: CommandShellEnvironment) =>
  context.platform === "win32" ? path.win32 : path.posix

async function which(name: string, context: CommandShellEnvironment): Promise<string | null> {
  const windows = context.platform === "win32"
  const extensions = windows
    ? (value(context, "PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";")
    : [""]
  for (const directory of (value(context, "PATH") || "").split(windows ? ";" : ":")) {
    if (!directory) continue
    for (const extension of extensions) {
      const full = paths(context).join(directory, name + extension)
      if (await exists(full)) return full
    }
  }
  return null
}

function explicitShell(context: CommandShellEnvironment): string | undefined {
  const shell = value(context, "SHELL")
  return shell && !["fish", "nu"].includes(paths(context).basename(shell)) ? shell : undefined
}

/** Synchronous compatibility fallback while the desktop warms its resolver. */
export function fallbackCommandShell(context = currentEnvironment()): string {
  return (
    explicitShell(context) ||
    (context.platform === "win32"
      ? value(context, "GIT_BASH_PATH") || value(context, "COMSPEC") || "cmd.exe"
      : context.platform === "darwin"
        ? "/bin/zsh"
        : "/bin/sh")
  )
}

export async function resolveCommandShell(context = currentEnvironment()): Promise<string> {
  const explicit = explicitShell(context)
  if (explicit) return explicit
  if (context.platform !== "win32") return fallbackCommandShell(context)
  const configured = value(context, "GIT_BASH_PATH")
  if (configured) return configured
  const git = await which("git", context)
  if (git) {
    const bash = paths(context).join(git, "..", "..", "bin", "bash.exe")
    if (await exists(bash)) return bash
  }
  for (const base of [
    value(context, "ProgramFiles"),
    value(context, "ProgramFiles(x86)"),
    "C:\\Program Files"
  ]) {
    if (!base) continue
    const bash = paths(context).join(base, "Git", "bin", "bash.exe")
    if (await exists(bash)) return bash
  }
  return value(context, "COMSPEC") || "cmd.exe"
}

/** Restricted Windows tokens cannot run MSYS2; preserve the executor's PS/cmd order. */
export async function resolveWindowsCommandShell(context = currentEnvironment()): Promise<{
  shell: string
  flags: string[]
}> {
  for (const name of ["pwsh", "powershell"]) {
    const shell = await which(name, context)
    if (shell) return { shell, flags: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"] }
  }
  return { shell: value(context, "COMSPEC") || "cmd.exe", flags: ["/c"] }
}

export async function resolveCommandShellContext(
  windowsSandbox: "none" | "unelevated" | "readonly" | "elevated",
  context = currentEnvironment()
): Promise<{ name: string; guidance: string }> {
  const shell =
    context.platform === "win32" && windowsSandbox !== "none"
      ? (await resolveWindowsCommandShell(context)).shell
      : await resolveCommandShell(context)
  const name = paths(context)
    .basename(shell)
    .replace(/\.exe$/i, "")
    .toLowerCase()
  const guidance = ["pwsh", "powershell"].includes(name)
    ? "Use PowerShell syntax: $env:VAR for environment variables and ; between commands; do not use bash syntax."
    : name === "cmd"
      ? "Use cmd.exe syntax: %VAR% for environment variables, dir/type for listing/reading, and ^ for line continuation."
      : ["bash", "sh", "zsh"].includes(name)
        ? "Use Unix shell syntax; commands run in the configured project directory."
        : "Use syntax supported by this configured shell."
  return { name, guidance }
}
