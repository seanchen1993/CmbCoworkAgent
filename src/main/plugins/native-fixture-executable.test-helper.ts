import { accessSync, constants, statSync } from "node:fs"
import { posix, win32 } from "node:path"

/** Resolve an installed test dependency without shells, downloads, or machine-specific fallbacks. */
export function resolveFixtureExecutable(
  options: {
    name: string
    overrideEnv: string
    homeEnvs: string[]
    commands: string[]
  },
  runtime: {
    platform?: NodeJS.Platform
    env?: NodeJS.ProcessEnv
    isExecutableFile?: (path: string) => boolean
  } = {}
): string {
  const windows = (runtime.platform ?? process.platform) === "win32"
  const paths = windows ? win32 : posix
  const env = runtime.env ?? process.env
  const value = (key: string) => {
    const actual = windows
      ? Object.keys(env).find((item) => item.toLowerCase() === key.toLowerCase())
      : key
    return (actual ? env[actual] : undefined)?.trim()
  }
  const available =
    runtime.isExecutableFile ??
    ((path: string) => {
      try {
        if (!statSync(path).isFile()) return false
        accessSync(path, windows ? constants.F_OK : constants.X_OK)
        return true
      } catch {
        return false
      }
    })
  const fail = (source: string): never => {
    throw Error(
      `NATIVE_FIXTURE_EXECUTABLE_MISSING: ${options.name}; configure ${options.overrideEnv}, ${options.homeEnvs.join("/")} or PATH. Invalid source: ${source}. Tests require the real tool and do not skip or download it.`
    )
  }
  const override = value(options.overrideEnv)
  if (override) {
    if (!paths.isAbsolute(override) || !available(override)) fail(options.overrideEnv)
    return paths.normalize(override)
  }
  for (const key of options.homeEnvs) {
    const home = value(key)
    if (!home) continue
    if (!paths.isAbsolute(home)) fail(key)
    for (const command of options.commands) {
      const candidate = paths.join(home, "bin", command)
      if (available(candidate)) return candidate
    }
    fail(key)
  }
  for (const part of (value("PATH") ?? "").split(windows ? ";" : ":")) {
    const directory = part.trim().replace(/^"(.*)"$/, "$1")
    // Do not accidentally resolve a tool from the current checkout.
    if (!directory || !paths.isAbsolute(directory)) continue
    for (const command of options.commands) {
      const candidate = paths.join(directory, command)
      if (available(candidate)) return candidate
    }
  }
  return fail("PATH")
}
