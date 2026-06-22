import type { WindowsShellKind } from "./windows-safe-commands"

interface ReadOnlyExecuteBlockMessageOptions {
  hookRewrite?: boolean
  detailedExamples?: boolean
}

export function readOnlyExecuteBlockMessage(
  windowsShell: WindowsShellKind = "unknown",
  options: ReadOnlyExecuteBlockMessageOptions = {}
): string {
  const hookNote = options.hookRewrite
    ? " A hook may have rewritten the command into a non-read-only one."
    : ""
  const examples =
    options.detailedExamples !== false
      ? ' Use direct read-only commands such as rg "pattern" file, grep "pattern" file, find ..., ls, git log, git diff, cat file, or use the read_file/grep/glob tools.'
      : " Use direct read-only commands or the read_file/grep/glob tools."

  if (windowsShell === "powershell") {
    return (
      "execute blocked: this is a read-only agent - on Windows PowerShell, only commands that can be proven read-only are allowed. " +
      "Pipelines or command chains are allowed only when every segment can be validated as read-only; unsafe or unverified shell composition, file redirects (<, >, >>), heredocs, writes, mutating commands, builds, or installs are blocked." +
      hookNote +
      examples
    )
  }

  return (
    "execute blocked: this is a read-only agent - only provably read-only single commands are allowed. " +
    "Shell composition is blocked in read-only mode, including pipes (|), redirects (<, >, >>), command chaining (&&, ||, ;), heredocs, writes, mutating commands, builds, or installs." +
    hookNote +
    examples
  )
}
