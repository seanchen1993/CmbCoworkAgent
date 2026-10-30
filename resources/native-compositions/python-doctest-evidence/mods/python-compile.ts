import type { SDK } from "devclaw-mods"
import { fingerprintPythonSources } from "./doctest-adapter"

/** Supports Python modules under src/ and static project resources. */
export function pythonSources(tracked: string[], declared: string[]) {
  const production = (path: string) => /^src\/[a-zA-Z0-9_./-]+\.py$/.test(path)
  for (const path of [...tracked, ...declared]) {
    if (
      /^tests\//.test(path) ||
      production(path) ||
      /\.(?:json|jsonc|md|txt|ya?ml|toml|ini|cfg|conf|csv|sql|lock)$/i.test(path) ||
      /(?:^|\/)(?:\.gitignore|\.gitattributes|\.editorconfig|LICENSE|NOTICE)$/.test(path)
    )
      continue
    throw Error("DOCTEST_UNSUPPORTED_PRODUCTION_SOURCE:replace-execution-provider")
  }
  const files = tracked.filter(production).sort()
  if (
    !files.length ||
    files.length > 64 ||
    new Set(files.map((name) => name.toLowerCase())).size !== files.length
  )
    throw Error("DOCTEST_COMPILE_INPUT_INVALID")
  return files
}
const compile = String.raw`
import sys,json,tempfile,py_compile
from pathlib import Path
files=json.loads(sys.argv[1])
with tempfile.TemporaryDirectory(prefix='doctest-compile-') as directory:
 for index,name in enumerate(files):
  py_compile.compile(name,cfile=str(Path(directory)/(str(index)+'.pyc')),doraise=True)
`
export async function compilePythonSources(
  $: Pick<SDK, "process">,
  argv: string[],
  files: string[]
) {
  if (
    !Array.isArray(argv) ||
    argv.length !== 4 ||
    argv[0] !== "python" ||
    argv[1] !== "-m" ||
    argv[2] !== "py_compile" ||
    !files.includes(argv[3]!)
  )
    throw Error("DOCTEST_COMPILE_COMMAND_REQUIRED")
  const sourceFingerprint = await fingerprintPythonSources($, files)
  const result = await $.process.run(["python", "-I", "-B", "-c", compile, JSON.stringify(files)], {
    integrity: "native",
    timeoutMs: 300000
  })
  if ((await fingerprintPythonSources($, files)) !== sourceFingerprint)
    throw Error("DOCTEST_COMPILE_INPUT_CHANGED")
  return {
    ...result,
    compilation: {
      protocol: "autobiz.production-compile/v1",
      mode: "python-pycompile",
      passed: result.exitCode === 0,
      files,
      sourceFingerprint
    }
  }
}
