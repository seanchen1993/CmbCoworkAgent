import { win32 } from "node:path"
import {
  parseSandShellEnrichmentCandidate,
  unquote,
  type SandShellEnrichmentCandidate
} from "./upstream/grok-shell-review-candidate"

/** Adapt only candidate discovery; the original command remains the approval
 * identity and is passed unchanged to the native executor. */
export function parseBotShellReviewCandidate(
  command: string,
  workingDirectory?: string
): SandShellEnrichmentCandidate | undefined {
  const leading = command
    .trim()
    .replace(/^&\s+/, "")
    .match(/^("[^"]+"|'[^']+'|[^\s;&|]+)(.*)$/s)
  if (!leading) return parseSandShellEnrichmentCandidate(command, workingDirectory)
  const token = unquote(leading[1])
  const name = win32
    .basename(token)
    .replace(/\.(?:exe|cmd|bat|com)$/i, "")
    .toLowerCase()
  if (
    !["npm", "pnpm", "yarn", "node", "bash", "sh", "zsh"].includes(name) &&
    !/^python(?:3(?:\.\d+)?)?$/.test(name)
  ) {
    const windowsPath = /^(?:[a-z]:[\\/]|\.{1,2}\\|\\\\)/i.test(token)
    if (windowsPath) {
      // Resolve Windows syntax independently of the development host. A Linux
      // worker must not interpret a Windows-looking path as a local filename.
      if (
        !workingDirectory ||
        !/^(?:[a-z]:[\\/]|\\\\)/i.test(workingDirectory) ||
        /[$%`]|[;&|\r\n]/.test(token + leading[2])
      )
        return { kind: "package_script_unresolved", invocation: command }
      return { kind: "executable", path: win32.resolve(workingDirectory, token) }
    }
    // A bare script name is resolved through shell/PATH rules. Do not pretend
    // reading a same-named file in the project establishes the executed script.
    if (/\.(?:cmd|bat|ps1)$/i.test(token) && !/[\\/]/.test(token))
      return { kind: "package_script_unresolved", invocation: command }
    return parseSandShellEnrichmentCandidate(command, workingDirectory)
  }
  // A path-qualified launcher can itself be a project-controlled script. Its
  // basename does not establish package-manager semantics; retain manual review.
  if (/[\\/]/.test(token)) return { kind: "package_script_unresolved", invocation: command }
  return parseSandShellEnrichmentCandidate(`${name}${leading[2]}`, workingDirectory)
}
