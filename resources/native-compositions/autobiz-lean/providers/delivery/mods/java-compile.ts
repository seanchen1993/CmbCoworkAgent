import type { SDK } from "devclaw-mods"
import { fingerprintJavaSources } from "./python-unittest-adapter"

/** The selected adapter is Java/Maven, not arbitrary Python production projects. */
export function javaSources(tracked: string[], declared: string[]) {
  const test = (path: string) =>
    /(?:^|\/)(?:tests?|__tests__)\//.test(path) || /(?:^|\/)test_[^/]+\.py$/.test(path)
  const resource =
    /\.(?:json|jsonc|md|txt|ya?ml|toml|ini|cfg|conf|properties|xml|sql|csv|tsv|lock|png|jpe?g|gif|svg|ico|webp|pdf|woff2?|ttf|otf)$/i
  for (const path of [...tracked, ...declared]) {
    if (test(path) || /\.java$/.test(path) || resource.test(path)) continue
    const name = path.split("/").at(-1)!
    if (
      /^\.(?:gitignore|gitattributes|editorconfig)$/.test(name) ||
      /^(?:LICENSE|NOTICE|CHANGELOG|README)(?:\..*)?$/i.test(name) ||
      /^(?:mvnw|mvnw.cmd)$/.test(name) ||
      path.startsWith(".mvn/")
    )
      continue
    throw Error("LEAN_JAVA_UNSUPPORTED_PRODUCTION_SOURCE:replace-execution-adapter")
  }
  const files = tracked
    .filter((path) => !test(path) && (/\.java$/.test(path) || /(?:^|\/)pom\.xml$/.test(path)))
    .sort()
  if (
    !files.includes("pom.xml") ||
    !files.some((path) => /\.java$/.test(path)) ||
    files.length > 64
  )
    throw Error("LEAN_JAVA_COMPILE_INPUT_INVALID")
  return files
}

export async function compileJavaSources($: Pick<SDK, "process">, argv: string[], files: string[]) {
  const executable = argv[0]
    ?.replace(/\\/g, "/")
    .split("/")
    .at(-1)
    ?.toLowerCase()
    .replace(/\.(?:cmd|bat)$/, "")
  const options = argv.slice(1, -1)
  if (
    !["mvn", "mvnw"].includes(executable!) ||
    argv.at(-1) !== "compile" ||
    options.some(
      (arg) =>
        ![
          "-q",
          "--quiet",
          "-o",
          "--offline",
          "-B",
          "--batch-mode",
          "-ntp",
          "--no-transfer-progress"
        ].includes(arg)
    ) ||
    new Set(options).size !== options.length
  )
    throw Error("LEAN_MAVEN_COMPILE_COMMAND_REQUIRED")
  const sourceFingerprint = await fingerprintJavaSources($, files)
  const result = await $.process.run(argv, { timeoutMs: 300000 })
  if ((await fingerprintJavaSources($, files)) !== sourceFingerprint)
    throw Error("LEAN_JAVA_COMPILE_INPUT_CHANGED")
  return {
    ...result,
    compilation: {
      protocol: "autobiz.production-compile/v1",
      mode: "maven-java",
      passed: result.exitCode === 0,
      files,
      sourceFingerprint
    }
  }
}
