import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { runInNewContext } from "node:vm"
import { build } from "esbuild"
import { afterEach, describe, expect, it } from "vitest"

const root = resolve("resources/native-compositions/autobiz-lean")
const scratch: string[] = []
afterEach(() => {
  for (const path of scratch.splice(0)) {
    if (dirname(path) !== tmpdir() || !path.split(/[\\/]/).at(-1)?.startsWith("lean-delivery-"))
      throw Error("UNEXPECTED_TEST_CLEANUP_PATH")
    rmSync(path, { recursive: true, force: true })
  }
})

type ProcessInit = { stdin?: string; timeoutMs?: number; env?: Record<string, string> }
type ProcessResult = { exitCode: number; stdout: string; stderr: string }
type Execution = {
  argv: string[]
  init: ProcessInit
  parse(result: ProcessResult): {
    passed: boolean
    counts: Record<string, number>
    subjectFingerprint: string
  }
}
type Handler = {
  act: (
    $: { process: { run(argv: string[], init: ProcessInit): Promise<ProcessResult> } },
    event: { action: string; input: unknown }
  ) => Promise<{
    status: string
    output: {
      productionFiles: string[]
      compilation: { files: string[]; results: Array<{ path: string; exitCode: number }> }
    }
  }>
}
type Exports = {
  rules: Record<string, string>
  executionPolicy: string
  contractFor(adapter: string): { runner: string; executionAdapter: string }
  prepareAdapterTest(adapter: string, input: object): Execution
  executeAdapterTests(adapter: string, argv: string[]): Execution
  prepareTest(input: Record<string, unknown>): Execution
  executeTests(argv: string[]): Execution
  assertNodeProductionPaths(paths: string[]): void
  register(on: { capability(manifest: { id: string }, handler: Handler): void }): void
}

async function exported(file: string) {
  const result = await build({
    entryPoints: [join(root, "providers/delivery/mods", file)],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node"
  })
  const module = { exports: {} as Exports }
  runInNewContext(result.outputFiles[0].text, { module, exports: module.exports })
  return module.exports
}

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "lean-delivery-"))
  scratch.push(cwd)
  mkdirSync(join(cwd, "src"))
  mkdirSync(join(cwd, "test"))
  writeFileSync(join(cwd, "src/add.cjs"), "module.exports = (a, b) => a + b\n")
  const run = (argv: string[], init: ProcessInit = {}) => {
    const value = spawnSync(argv[0], argv.slice(1), {
      cwd,
      input: init.stdin,
      timeout: init.timeoutMs ?? 30000,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, ...init.env }
    })
    if (value.error) throw value.error
    return { exitCode: value.status ?? -1, stdout: value.stdout, stderr: value.stderr }
  }
  return { cwd, run }
}

describe("lean delivery executes original evidence", () => {
  it("declares compiler-generated workflow identity instead of a handwritten provider digest", () => {
    const source = JSON.parse(readFileSync(join(root, "project/composition/source.json"), "utf8"))
    for (const id of ["code.evidence", "delivery.evidence"]) {
      const check = source.modules.flatMap((module: { checks: Array<{ id: string }> }) => module.checks)
        .find((check: { id: string }) => check.id === id)
      expect(check.bindResourceDigests).toEqual({ workflowSha256: "workflows/lean-code.workflow.js" })
      expect(check.bindCheckProviderIdentities).toEqual({
        rulesProvider: { checkId: "solution.business", actionId: "solution.inspect" }
      })
    }
    expect(readFileSync(join(root, "providers/delivery/mods/code-result.ts"), "utf8"))
      .not.toContain("code-script-identity")
  })

  it("records the adapted policy and original rule provenance", () => {
    const provenance = JSON.parse(
      readFileSync(join(root, "providers/delivery/provenance.json"), "utf8")
    )
    const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")
    expect(provenance.executionPolicySha256).toBe(
      digest(join(root, "providers/delivery/mods/execution-policy.ts"))
    )
    expect(provenance.adaptedRulesSha256).toBe(
      digest(join(root, "providers/delivery/mods/rules-bundle.ts"))
    )
    expect(provenance.upstreamRulesSha256).toBe(
      digest(resolve("resources/native-compositions/autobiz-rules/mods/rules-bundle.ts"))
    )
  })

  it("selects the public adapter explicitly and rejects cross-adapter invocations", async () => {
    const api = await exported("test-adapter.ts")
    for (const adapter of ["node-test/v1", "python-unittest/v1"]) {
      expect(api.contractFor(adapter)).toMatchObject({ runner: adapter, executionAdapter: adapter })
      const files = adapter === "node-test/v1" ? ["test/add.test.cjs"] : ["test_orders.py"]
      const prepared = api.prepareAdapterTest(adapter, {
        files,
        subjects: ["src/main.java"],
        timeoutMs: 10000
      })
      expect(() => api.executeAdapterTests(adapter, prepared.argv)).not.toThrow()
      expect(() =>
        api.executeAdapterTests(
          adapter === "node-test/v1" ? "python-unittest/v1" : "node-test/v1",
          prepared.argv
        )
      ).toThrow()
    }
    expect(() => api.contractFor("guess-from-files")).toThrow("LEAN_EXECUTION_ADAPTER_REQUIRED")
  })

  it.each(["ts", "tsx", "jsx", "vue", "java", "py", "unknown"])(
    "rejects unsupported production %s instead of skipping its compilation",
    async (extension) => {
      const compiler = await exported("node-compile.ts")
      expect(() =>
        compiler.assertNodeProductionPaths(["src/main.cjs", "src/other." + extension])
      ).toThrow("LEAN_NODE_UNSUPPORTED_PRODUCTION_SOURCE")
      expect(() =>
        compiler.assertNodeProductionPaths(["src/main.cjs", "package.json", "README.md"])
      ).not.toThrow()
    }
  )

  it.each([
    ["pass", "test('adds',()=>assert.equal(add(2,3),5))", true],
    ["failure", "test('adds',()=>assert.equal(add(2,3),6))", false],
    ["empty", "console.log('passed 100 tests')", false],
    ["skip", "test.skip('adds',()=>{})", false],
    [
      "tamper",
      "test('changes subject',()=>require('node:fs').writeFileSync('src/add.cjs','module.exports=()=>5'))",
      false
    ]
  ])("counts real %s tests and fingerprints unchanged inputs", async (_name, body, passed) => {
    const adapter = await exported("test-adapter.ts")
    const f = fixture()
    writeFileSync(
      join(f.cwd, "test/add.test.cjs"),
      "const test=require('node:test');const assert=require('node:assert/strict');const add=require('../src/add.cjs');\n" +
        body
    )
    const prepared = adapter.prepareTest({
      files: ["test/add.test.cjs"],
      subjects: ["src/add.cjs"],
      timeoutMs: 10000
    })
    const invocation = adapter.executeTests(prepared.argv)
    const output = invocation.parse(f.run(invocation.argv, invocation.init))
    expect(output.passed).toBe(passed)
    if (passed) {
      expect(output.counts).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0 })
      expect(output.subjectFingerprint).toMatch(/^[a-f0-9]{64}$/)
    }
    expect(() => adapter.executeTests(["node", "-e", "process.exit(0)"])).toThrow()
    expect(() =>
      adapter.prepareTest({ files: ["test/add.test.cjs"], subjects: [], timeoutMs: 10000 })
    ).toThrow()
  })

  it("binds failed adapter invocations without relaxing retained repair semantics", async () => {
    const adapter = await exported("test-adapter.ts")
    const { rules } = await exported("rules-bundle.ts")
    const { executionPolicy } = await exported("execution-policy.ts")
    const f = fixture()
    writeFileSync(
      join(f.cwd, "test/add.test.cjs"),
      "const test=require('node:test');const assert=require('node:assert/strict');" +
        "test('actual failure',()=>assert.equal(require('../src/add.cjs')(2,3),6))"
    )
    const prepared = adapter.prepareTest({
      files: ["test/add.test.cjs"],
      subjects: ["src/add.cjs"],
      timeoutMs: 10000
    })
    const invocation = adapter.executeTests(prepared.argv)
    const actual = invocation.parse(f.run(invocation.argv, invocation.init))
    expect(actual.passed).toBe(false)
    const receiptOutput = { argv: prepared.argv, testFiles: ["test/add.test.cjs"], test: actual }
    const validate = (output: unknown) =>
      f.run(
        [
          "python",
          "-X",
          "utf8",
          "-c",
          `import sys,json,tempfile
from pathlib import Path
p=json.loads(sys.stdin.read())
with tempfile.TemporaryDirectory() as directory:
    for name,source in {**p["rules"],"lean_execution.py":p["policy"]}.items():
        path=Path(directory)/name
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text(source,encoding="utf8")
    sys.path.insert(0,directory)
    from lean_execution import repair_command_validator
    validate=repair_command_validator({"receipt":{"output":p["output"]}})
    original={"argv":p["output"]["argv"],"testFiles":p["output"]["testFiles"]}
    assert validate(original)
    assert not validate({**original,"argv":["node","-e","process.exit(1)"]})
    assert not validate({**original,"testFiles":["test/unrelated.test.cjs"]})
`
        ],
        { stdin: JSON.stringify({ rules, policy: executionPolicy, output }) }
      )
    const accepted = validate(receiptOutput)
    expect(accepted.exitCode, accepted.stderr + JSON.stringify(receiptOutput)).toBe(0)
    for (const patch of [
      { counts: { total: 0, passed: 0, failed: 0, skipped: 0 } },
      { counts: { total: 2, passed: 0, failed: 1, skipped: 0 } },
      { counts: { total: 2, passed: 0, failed: 1, skipped: 1 } },
      { subjectFingerprint: "unbound" },
      { files: ["test/other.test.cjs"] },
      { subjects: ["src/other.cjs"] },
      { runner: "claimed-test/v1" },
      { passed: true }
    ]) {
      const rejected = validate({ ...receiptOutput, test: { ...actual, ...patch } })
      expect(rejected.exitCode).not.toBe(0)
      expect(rejected.stderr).toContain("LEAN_REPAIR_ADAPTER_RECEIPT_INVALID")
    }
  }, 30000)

  it("executes actual Git-bound production compilation and rejects altered production/test ownership", async () => {
    const mod = await exported("main.ts")
    const handlers = new Map<string, Handler>()
    mod.register({
      capability: (manifest: { id: string }, handler: Handler) => handlers.set(manifest.id, handler)
    })
    const act = handlers.get("delivery-proof")!.act
    const f = fixture()
    writeFileSync(join(f.cwd, "src/second.cjs"), "module.exports = value => String(value)\n")
    const git = (...args: string[]) => {
      const result = f.run(["git", ...args])
      expect(result.exitCode, result.stderr).toBe(0)
      return result.stdout.trim()
    }
    git("init", "--initial-branch=main")
    git("config", "user.name", "Lean isolated test")
    git("config", "user.email", "lean@example.test")
    git("add", ".")
    git("commit", "-m", "baseline")
    const baselineCommit = git("rev-parse", "HEAD")
    writeFileSync(join(f.cwd, "src/add.cjs"), "module.exports = (a, b) => Number(a) + Number(b)\n")
    git("add", ".")
    git("commit", "-m", "production change")
    const expectedCommit = git("rev-parse", "HEAD")
    const input = {
      phase: "compile",
      workspaceRef: "default",
      taskIds: ["T001"],
      expectedCommit,
      baselineCommit,
      argv: ["node", "--check", "src/add.cjs"]
    }
    const output = await act(
      { process: { run: async (argv: string[], init: ProcessInit) => f.run(argv, init) } },
      { action: "execute-command", input: { version: 1, input } }
    )
    expect(output.status).toBe("succeeded")
    expect(output.output.productionFiles).toEqual(["src/add.cjs"])
    expect(output.output.compilation.files).toEqual(["src/add.cjs", "src/second.cjs"])
    expect(output.output.compilation.results).toEqual([
      { path: "src/add.cjs", exitCode: 0 },
      { path: "src/second.cjs", exitCode: 0 }
    ])
    await expect(
      act(
        { process: { run: async (argv: string[], init: ProcessInit) => f.run(argv, init) } },
        {
          action: "execute-command",
          input: { version: 1, input: { ...input, argv: ["node", "-e", "0"] } }
        }
      )
    ).rejects.toThrow("LEAN_NODE_COMPILE_COVERAGE_REQUIRED")
    writeFileSync(join(f.cwd, "src/second.cjs"), "module.exports = (\n")
    git("add", ".")
    git("commit", "-m", "invalid second module")
    const invalid = await act(
      { process: { run: async (argv: string[], init: ProcessInit) => f.run(argv, init) } },
      {
        action: "execute-command",
        input: {
          version: 1,
          input: {
            ...input,
            baselineCommit: expectedCommit,
            expectedCommit: git("rev-parse", "HEAD")
          }
        }
      }
    )
    expect(invalid.status).toBe("failed")
    expect(invalid.output.compilation.results).toContainEqual({
      path: "src/second.cjs",
      exitCode: 1
    })
    writeFileSync(join(f.cwd, "src/second.cjs"), "module.exports = value => String(value)\n")
    writeFileSync(join(f.cwd, "Definition.json"), "{}")
    git("add", ".")
    git("commit", "-m", "unauthorized artifact change")
    const protectedChange = await act(
      { process: { run: async (argv: string[], init: ProcessInit) => f.run(argv, init) } },
      {
        action: "execute-command",
        input: {
          version: 1,
          input: {
            ...input,
            baselineCommit: expectedCommit,
            expectedCommit: git("rev-parse", "HEAD")
          }
        }
      }
    )
    expect(protectedChange.status).toBe("failed")
    const call = (extra: Record<string, unknown>) =>
      act(
        {
          process: {
            run: async (argv: string[], init: ProcessInit) => f.run(argv, init)
          }
        },
        {
          action: "execute-command",
          input: {
            version: 1,
            input: { ...input, expectedCommit: git("rev-parse", "HEAD"), ...extra }
          }
        }
      )
    await expect(call({ declaredProductionPaths: ["src/planned.ts"] })).rejects.toThrow(
      "LEAN_NODE_UNSUPPORTED_PRODUCTION_SOURCE"
    )
    writeFileSync(join(f.cwd, "src/mixed.ts"), "export const mixed: number = 1\n")
    git("add", ".")
    git("commit", "-m", "mixed unsupported production source")
    await expect(call({})).rejects.toThrow("LEAN_NODE_UNSUPPORTED_PRODUCTION_SOURCE")
  }, 30000)
})
