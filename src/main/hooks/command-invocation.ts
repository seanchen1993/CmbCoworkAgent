import type { HookConfig } from "./types"

/** Original Cmb Hook interpreter selection, shared with the leased Bot executor. */
export function hookCommandInvocation(hook: Pick<HookConfig, "command" | "shell">) {
  const command = hook.command ?? ""
  if (hook.shell === "bash") return { executable: "bash", args: ["-c", command], shell: false }
  if (hook.shell === "powershell")
    return {
      executable: "pwsh",
      args: ["-NoProfile", "-NonInteractive", "-Command", command],
      shell: false
    }
  if (hook.shell === "sh") return { executable: "sh", args: ["-c", command], shell: false }
  return process.platform === "win32"
    ? { executable: command, args: [] as string[], shell: true }
    : { executable: "/bin/sh", args: ["-c", command], shell: false }
}
