// Adapted from Grok Bot 0.18 shell review enrichment. See PROVENANCE.json.
import { isAbsolute, resolve } from "node:path"

export type SandShellEnrichmentCandidate =
  | { readonly kind: "executable"; readonly path: string }
  | {
      readonly kind: "package_script"
      readonly packageJsonPath: string
      readonly scriptName: string
    }
  | {
      readonly kind: "package_script_unresolved"
      readonly packageJsonPath?: string
      readonly invocation: string
    }

export function unquote(token: string): string {
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    return token.slice(1, -1)
  }
  return token
}

export function parseSandShellEnrichmentCandidate(
  command: string,
  workingDirectory?: string
): SandShellEnrichmentCandidate | undefined {
  let candidateCommand = command.trim()
  let candidateWorkingDirectory = workingDirectory
  for (let prefixCount = 0; prefixCount < 4; prefixCount += 1) {
    const environmentPrefix = candidateCommand.match(
      /^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s+)+/
    )
    if (environmentPrefix != null) {
      candidateCommand = candidateCommand.slice(environmentPrefix[0].length)
      continue
    }
    const changeDirectoryPrefix = candidateCommand.match(
      /^cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*&&\s*(.+)$/
    )
    if (changeDirectoryPrefix == null) break
    const directoryToken = changeDirectoryPrefix[1]
    const remaining = changeDirectoryPrefix[2]
    if (directoryToken == null || remaining == null) break
    candidateWorkingDirectory =
      candidateWorkingDirectory == null
        ? undefined
        : resolve(candidateWorkingDirectory, unquote(directoryToken))
    candidateCommand = remaining
  }

  const commandSegments = candidateCommand
    .split(/[;&|\n]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
  if (commandSegments.length > 1) {
    const hasPackageManagerSegment = commandSegments.some((segment) => {
      const nested = parseSandShellEnrichmentCandidate(segment, candidateWorkingDirectory)
      return nested?.kind === "package_script" || nested?.kind === "package_script_unresolved"
    })
    if (hasPackageManagerSegment) {
      return {
        kind: "package_script_unresolved",
        ...(candidateWorkingDirectory == null
          ? {}
          : { packageJsonPath: resolve(candidateWorkingDirectory, "package.json") }),
        invocation: candidateCommand
      }
    }
  }

  const packageMatch = candidateCommand.match(
    /^(?:npm(?:\s+run)?|pnpm(?:\s+run)?|yarn(?:\s+run)?)\s+([A-Za-z0-9_:][A-Za-z0-9:_-]*)(?:\s|$)/
  )
  if (packageMatch != null) {
    const scriptName = packageMatch[1]
    if (scriptName == null) return undefined
    if (candidateWorkingDirectory == null) {
      return { kind: "package_script_unresolved", invocation: packageMatch[0].trim() }
    }
    return {
      kind: "package_script",
      packageJsonPath: resolve(candidateWorkingDirectory, "package.json"),
      scriptName
    }
  }
  const unresolvedPackageMatch = candidateCommand.match(/^(?:npm|pnpm|yarn)\s+[^;&|]+/)
  if (unresolvedPackageMatch != null) {
    return {
      kind: "package_script_unresolved",
      ...(candidateWorkingDirectory == null
        ? {}
        : { packageJsonPath: resolve(candidateWorkingDirectory, "package.json") }),
      invocation: unresolvedPackageMatch[0]
    }
  }
  if (/\b(?:npm|pnpm|yarn)\b/.test(candidateCommand)) {
    return {
      kind: "package_script_unresolved",
      ...(candidateWorkingDirectory == null
        ? {}
        : { packageJsonPath: resolve(candidateWorkingDirectory, "package.json") }),
      invocation: candidateCommand
    }
  }

  const interpreterMatch = candidateCommand.match(
    /^(?:python(?:3(?:\.\d+)?)?|node|bash|sh|zsh)\s+("[^"]+"|'[^']+'|[^\s;&|]+)(?:\s|$)/
  )
  const directMatch = candidateCommand.match(
    /^((?:\/|\.{1,2}\/)("[^"]+"|'[^']+'|[^\s;&|]+)|(?:\/|\.{1,2}\/)[^\s;&|]+)(?:\s|$)/
  )
  const token = interpreterMatch?.[1] ?? directMatch?.[1]
  if (token == null) return undefined
  const executablePath = unquote(token)
  if (isAbsolute(executablePath)) return { kind: "executable", path: executablePath }
  return candidateWorkingDirectory == null
    ? undefined
    : { kind: "executable", path: resolve(candidateWorkingDirectory, executablePath) }
}
