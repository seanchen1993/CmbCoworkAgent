export interface FunctionCheckOptions {
  command: "check" | "inspect"
  directory: string
  strictCompatibility: boolean
  typecheck?: boolean
}

export function parseFunctionCheckOptions(args: string[]): FunctionCheckOptions | undefined {
  const [command, ...rest] = args
  if (command !== "check" && command !== "inspect") return undefined
  const positional = rest.filter(
    (value) => value !== "--strict-compatibility" && value !== "--types"
  )
  if (
    positional.length !== 1 ||
    !positional[0] ||
    positional[0].startsWith("--") ||
    rest.filter((value) => value === "--strict-compatibility").length > 1 ||
    rest.filter((value) => value === "--types").length > 1
  )
    return undefined
  return {
    command,
    directory: positional[0],
    strictCompatibility: rest.includes("--strict-compatibility"),
    ...(rest.includes("--types") ? { typecheck: true } : {})
  }
}

export function functionCheckExitCode(
  report: {
    valid: boolean
    compatibility: { strictCompatible: boolean }
    sdkCompatibility?: { strictCompatible: boolean }
  },
  strictCompatibility: boolean
): 0 | 1 {
  return report.valid &&
    (!strictCompatibility ||
      (report.compatibility.strictCompatible && report.sdkCompatibility?.strictCompatible === true))
    ? 0
    : 1
}
