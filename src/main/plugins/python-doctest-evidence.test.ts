import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { runInNewContext } from "node:vm"
import { build } from "esbuild"
import { afterEach, expect, it } from "vitest"
import { analyzeAuthoringPreview } from "../mods/devtools/authoring-preflight"

type Init = { stdin?: string; timeoutMs?: number; env?: Record<string, string> }
type Result = { stdout: string; stderr: string; exitCode: number }
type Execution = { argv: string[]; init: Init; parse(value: Result): Record<string, unknown> }
type Adapter = {
  preparePythonTest(input: object): Execution
  executePythonTests(argv: string[]): Execution
}
type Compiler = {
  pythonSources(tracked: string[], declared: string[]): string[]
  compilePythonSources(
    sdk: object,
    argv: string[],
    files: string[]
  ): Promise<Result & { compilation: { sourceFingerprint: string; files: string[] } }>
}
const scratch: string[] = []
afterEach(() => {
  for (const path of scratch.splice(0)) {
    if (dirname(path) !== tmpdir() || !path.split(/[\\/]/).at(-1)?.startsWith("doctest-evidence-"))
      throw Error("UNEXPECTED_TEST_CLEANUP_PATH")
    rmSync(path, { recursive: true, force: true })
  }
})
async function load<T>(name: string): Promise<T> {
  const built = await build({
    entryPoints: [resolve("resources/native-compositions/python-doctest-evidence/mods", name)],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs"
  })
  const module = { exports: {} as T }
  runInNewContext(built.outputFiles[0].text, { module, exports: module.exports })
  return module.exports
}
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "doctest-evidence-"))
  scratch.push(cwd)
  mkdirSync(join(cwd, "src"))
  mkdirSync(join(cwd, "tests"))
  writeFileSync(
    join(cwd, "src/orders.py"),
    "def lookup(key):\n    return {'id': key} if key == '42' else None\n"
  )
  writeFileSync(
    join(cwd, "tests/orders.doctest"),
    ">>> from orders import lookup\n>>> lookup('42')\n{'id': '42'}\n>>> lookup('missing') is None\nTrue\n"
  )
  const run = (argv: string[], init: Init = {}) => {
    const result = spawnSync(argv[0], argv.slice(1), {
      cwd,
      input: init.stdin,
      timeout: init.timeoutMs ?? 30000,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, ...init.env }
    })
    if (result.error) throw result.error
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? -1 }
  }
  return {
    cwd,
    run,
    sdk: { process: { run: async (argv: string[], init?: Init) => run(argv, init) } }
  }
}
const input = { files: ["tests/orders.doctest"], subjects: ["src/orders.py"], timeoutMs: 10000 }

it("passes the actual Function authoring type and SDK check as an independent provider", async () => {
  const checked = await analyzeAuthoringPreview(
    resolve("resources/native-compositions/python-doctest-evidence")
  )
  expect(checked.typecheck.diagnostics).toEqual([])
  expect(checked.typecheck.valid).toBe(true)
  expect(checked.sdk.diagnostics).toEqual([])
  expect(checked.sdk.strictCompatible).toBe(true)
  // Static SDK compatibility is distinct from the real workflow integration below.
  expect(checked.sdk.runtimeVerified).toBe(false)
})

it("runs real doctest counts and binds real production compilation to identical source bytes", async () => {
  const { run, sdk } = fixture()
  const adapter = await load<Adapter>("doctest-adapter.ts")
  const compiler = await load<Compiler>("python-compile.ts")
  const compiled = await compiler.compilePythonSources(
    sdk,
    ["python", "-m", "py_compile", "src/orders.py"],
    input.subjects
  )
  expect(compiled.exitCode).toBe(0)
  const invocation = adapter.executePythonTests(adapter.preparePythonTest(input).argv)
  const result = invocation.parse(run(invocation.argv, invocation.init))
  expect(result.passed).toBe(true)
  expect(result.counts).toEqual({ total: 3, passed: 3, failed: 0, skipped: 0 })
  expect(result.subjectFingerprint).toBe(compiled.compilation.sourceFingerprint)
  expect(result.testsFingerprint).toMatch(/^[a-f0-9]{64}$/)
})

it.each([
  ["wrong result", ">>> from orders import lookup\n>>> lookup('42')\n{'id': 'wrong'}\n"],
  ["empty file", "This file has no executable examples.\n"],
  ["skip", ">>> 1 + 1 # doctest: +SKIP\n3\n"],
  ["spoofed stdout", ">>> print('{\"passed\":true}')\nwrong\n"]
])("rejects %s through the actual runner", async (_name, text) => {
  const { cwd, run } = fixture()
  writeFileSync(join(cwd, input.files[0]), text)
  const adapter = await load<Adapter>("doctest-adapter.ts")
  const invocation = adapter.executePythonTests(adapter.preparePythonTest(input).argv)
  expect(invocation.parse(run(invocation.argv, invocation.init)).passed).toBe(false)
})

it("compiles all production modules and rejects syntax errors outside the nominated module", async () => {
  const { cwd, sdk } = fixture()
  writeFileSync(join(cwd, "src/second.py"), "def broken(:\n")
  const compiler = await load<Compiler>("python-compile.ts")
  const files = compiler.pythonSources(
    ["src/orders.py", "src/second.py", "tests/orders.doctest"],
    []
  )
  const result = await compiler.compilePythonSources(
    sdk,
    ["python", "-m", "py_compile", "src/orders.py"],
    files
  )
  expect(result.exitCode).not.toBe(0)
  expect(result.compilation.files).toEqual(["src/orders.py", "src/second.py"])
  expect(() => compiler.pythonSources(["src/orders.py", "src/hidden.js"], [])).toThrow(
    "UNSUPPORTED_PRODUCTION_SOURCE"
  )
})

it("rejects production changes made by the test process", async () => {
  const { cwd, run } = fixture()
  writeFileSync(
    join(cwd, input.files[0]),
    ">>> from pathlib import Path\n>>> _ = Path('src/orders.py').write_text('changed')\n"
  )
  const adapter = await load<Adapter>("doctest-adapter.ts")
  const invocation = adapter.executePythonTests(adapter.preparePythonTest(input).argv)
  const result = invocation.parse(run(invocation.argv, invocation.init))
  expect(result.passed).toBe(false)
  expect(result.errors).toEqual([{ code: "TEST_FILE_CHANGED" }])
})

it("retains production/test ownership and configured artifact path protection in the real policy", async () => {
  const { run } = fixture()
  const { bootstrap } = await load<{ bootstrap: string }>("main.ts")
  const { rules } = await load<{ rules: Record<string, string> }>("rules-bundle.ts")
  const { executionPolicy } = await load<{ executionPolicy: string }>("execution-policy.ts")
  const adapter = await load<Adapter>("doctest-adapter.ts")
  const check = (phase: string, changedPaths: string[], argv: string[]) =>
    JSON.parse(
      run(["python", "-I", "-B", "-X", "utf8", "-c", bootstrap], {
        stdin: JSON.stringify({
          rules,
          executionPolicy,
          request: {
            stage: "command-policy",
            current: {
              executionAdapter: "python-doctest/v1",
              phase,
              argv,
              changedPaths,
              trackedPaths: ["src/orders.py", "tests/orders.doctest"],
              protectedArtifactPaths: ["contract/accepted.json"]
            }
          }
        })
      }).stdout
    )
  const compile = ["python", "-m", "py_compile", "src/orders.py"]
  expect(check("compile", ["src/orders.py"], compile).passed).toBe(true)
  expect(check("compile", ["tests/orders.doctest"], compile).errors).toContainEqual({
    code: "CODE_PRODUCTION_TEST_WRITE_BOUNDARY"
  })
  expect(check("compile", ["contract/accepted.json"], compile).errors).toContainEqual({
    code: "CODE_HOST_ARTIFACT_WRITE_DENIED"
  })
  expect(check("test", ["src/orders.py"], adapter.preparePythonTest(input).argv).passed).toBe(false)
})

it("rejects test evidence from different production bytes or a different source list", async () => {
  type Evidence = {
    output: Record<string, unknown>
    provider: { actionId: string }
    status: string
  }
  const { assertPythonTestCompilation } = await load<{
    assertPythonTestCompilation(actions: Evidence[], record: Evidence): void
  }>("python-evidence.ts")
  const compiled: Evidence = {
    status: "succeeded",
    provider: { actionId: "execute-command" },
    output: {
      phase: "compile",
      executionAdapter: "python-doctest/v1",
      workspaceRef: "orders",
      taskIds: ["T001"],
      compilation: {
        passed: true,
        mode: "python-pycompile",
        files: input.subjects,
        sourceFingerprint: "a".repeat(64)
      }
    }
  }
  const tested: Evidence = {
    status: "succeeded",
    provider: { actionId: "execute-command" },
    output: {
      phase: "test",
      workspaceRef: "orders",
      taskIds: ["T001"],
      test: { subjects: input.subjects, subjectFingerprint: "a".repeat(64) }
    }
  }
  expect(() => assertPythonTestCompilation([compiled, tested], tested)).not.toThrow()
  tested.output.test = { subjects: input.subjects, subjectFingerprint: "b".repeat(64) }
  expect(() => assertPythonTestCompilation([compiled, tested], tested)).toThrow("SOURCE_CHANGED")
  tested.output.test = { subjects: ["src/other.py"], subjectFingerprint: "a".repeat(64) }
  expect(() => assertPythonTestCompilation([compiled, tested], tested)).toThrow("SOURCE_CHANGED")
})
