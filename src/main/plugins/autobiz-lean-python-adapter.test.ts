import { spawnSync } from "node:child_process"
import { linkSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { runInNewContext } from "node:vm"
import { build } from "esbuild"
import { afterEach, expect, it } from "vitest"
import { resolveFixtureExecutable } from "./native-fixture-executable.test-helper"

const scratch: string[] = []
afterEach(() => {
  for (const path of scratch.splice(0)) {
    if (dirname(path) !== tmpdir() || !path.split(/[\\/]/).at(-1)?.startsWith("lean-python-"))
      throw Error("UNEXPECTED_TEST_CLEANUP_PATH")
    rmSync(path, { recursive: true, force: true })
  }
})
type Init = { stdin?: string; timeoutMs?: number; env?: Record<string, string> }
type ProcessResult = { exitCode: number; stdout: string; stderr: string }
type Execution = {
  argv: string[]
  init: Init
  parse(result: ProcessResult): {
    passed: boolean
    counts?: { total: number; passed: number; failed: number; skipped: number }
    testsFingerprint?: string
    subjectFingerprint?: string
  }
}

async function adapter() {
  const built = await build({
    entryPoints: [
      resolve(
        "resources/native-compositions/autobiz-lean/providers/delivery/mods/python-unittest-adapter.ts"
      )
    ],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node"
  })
  const module = {
    exports: {} as {
      preparePythonTest(input: object): Execution
      executePythonTests(argv: string[]): Execution
    }
  }
  runInNewContext(built.outputFiles[0].text, { module, exports: module.exports })
  return module.exports
}

async function compiler() {
  const built = await build({
    entryPoints: [
      resolve("resources/native-compositions/autobiz-lean/providers/delivery/mods/java-compile.ts")
    ],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node"
  })
  const module = {
    exports: {} as {
      javaSources(tracked: string[], declared: string[]): string[]
      compileJavaSources(
        sdk: { process: { run(argv: string[], init?: Init): Promise<ProcessResult> } },
        argv: string[],
        files: string[]
      ): Promise<
        ProcessResult & {
          compilation: { sourceFingerprint: string }
        }
      >
    }
  }
  runInNewContext(built.outputFiles[0].text, { module, exports: module.exports })
  return module.exports
}

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "lean-python-"))
  scratch.push(cwd)
  mkdirSync(join(cwd, "src/main/java"), { recursive: true })
  const run = (argv: string[], init: Init = {}) => {
    const child = spawnSync(argv[0], argv.slice(1), {
      cwd,
      input: init.stdin,
      timeout: init.timeoutMs ?? 30000,
      encoding: "utf8",
      windowsHide: true,
      windowsVerbatimArguments: argv[0] === "cmd.exe",
      env: { ...process.env, ...init.env }
    })
    if (child.error) throw child.error
    return { exitCode: child.status ?? -1, stdout: child.stdout, stderr: child.stderr }
  }
  writeFileSync(
    join(cwd, "src/main/java/Orders.java"),
    'public class Orders { public static void main(String[] args) { if(args.length != 1 || !args[0].equals("42")) { System.err.println("ORDER_NOT_FOUND"); System.exit(2); } System.out.println("42"); } }'
  )
  return { cwd, run }
}

it("executes Maven-built Java through real Python unittest and records nonzero cases", async () => {
  const f = fixture()
  const maven = resolveFixtureExecutable({
    name: "Maven",
    overrideEnv: "AUTOBIZ_TEST_MAVEN",
    homeEnvs: ["MAVEN_HOME", "M2_HOME"],
    commands: process.platform === "win32" ? ["mvn.cmd", "mvn.bat", "mvn.exe"] : ["mvn"]
  })
  writeFileSync(
    join(f.cwd, "pom.xml"),
    "<project><modelVersion>4.0.0</modelVersion><groupId>fixture</groupId><artifactId>orders</artifactId><version>1</version><properties><maven.compiler.source>17</maven.compiler.source><maven.compiler.target>17</maven.compiler.target></properties></project>"
  )
  const java = await compiler()
  const files = java.javaSources(["pom.xml", "src/main/java/Orders.java"], [])
  const compiled = await java.compileJavaSources(
    {
      process: {
        run: async (argv, init) =>
          argv[0] === maven && process.platform === "win32" && /\.(?:cmd|bat)$/i.test(maven)
            ? f.run(["cmd.exe", "/d", "/s", "/c", `""${maven}" -q -o compile"`])
            : f.run(argv, init)
      }
    },
    [maven, "-q", "-o", "compile"],
    files
  )
  expect(compiled.exitCode, compiled.stderr).toBe(0)
  expect(compiled.compilation.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/)
  expect(() =>
    java.javaSources(["pom.xml", "src/main/java/Orders.java", "src/hidden.ts"], [])
  ).toThrow("LEAN_JAVA_UNSUPPORTED_PRODUCTION_SOURCE")
  writeFileSync(
    join(f.cwd, "test_orders.py"),
    `import unittest,subprocess
class OrdersTests(unittest.TestCase):
 def test_found(self):
  result=subprocess.run(['java','-cp','target/classes','Orders','42'],capture_output=True,text=True)
  self.assertEqual(result.returncode,0)
  self.assertEqual(result.stdout.strip(),'42')
 def test_missing(self):
  result=subprocess.run(['java','-cp','target/classes','Orders','missing'],capture_output=True,text=True)
  self.assertEqual(result.returncode,2)
  self.assertIn('ORDER_NOT_FOUND',result.stderr)
`
  )
  const api = await adapter()
  const prepared = api.preparePythonTest({
    files: ["test_orders.py"],
    subjects: ["src/main/java/Orders.java"],
    timeoutMs: 10000
  })
  const execution = api.executePythonTests(prepared.argv)
  const result = execution.parse(f.run(execution.argv, execution.init))
  expect(result.passed).toBe(true)
  expect(result.counts).toEqual({ total: 2, passed: 2, failed: 0, skipped: 0 })
  expect(result.testsFingerprint).toMatch(/^[a-f0-9]{64}$/)
  expect(result.subjectFingerprint).toMatch(/^[a-f0-9]{64}$/)
  await expect(
    java.compileJavaSources(
      {
        process: {
          run: async (argv, init) => {
            const result =
              argv[0] === maven && process.platform === "win32" && /\.(?:cmd|bat)$/i.test(maven)
                ? f.run(["cmd.exe", "/d", "/s", "/c", `""${maven}" -q -o compile"`])
                : f.run(argv, init)
            if (argv[0] === maven)
              writeFileSync(join(f.cwd, "src/main/java/Orders.java"), "class Changed {}")
            return result
          }
        }
      },
      [maven, "-q", "-o", "compile"],
      files
    )
  ).rejects.toThrow("LEAN_JAVA_COMPILE_INPUT_CHANGED")
}, 30000)

it.each([
  [
    "failed",
    "import unittest\nclass Tests(unittest.TestCase):\n def test_fail(self): self.assertEqual(1,2)\n"
  ],
  ["empty", 'print(\'{"passed":true,"counts":{"total":100}}\')\n'],
  [
    "skip",
    "import unittest\nclass Tests(unittest.TestCase):\n @unittest.skip('not run')\n def test_skip(self): pass\n"
  ],
  ["exit", "import os\nos._exit(0)\n"],
  [
    "tamper",
    "import unittest\nclass Tests(unittest.TestCase):\n def test_tamper(self):\n  with open('src/main/java/Orders.java','w') as stream: stream.write('changed')\n"
  ],
  [
    "fake_stdout",
    'import os\nos.write(1,b\'{"passed":true,"completed":true,"counts":{"total":1,"passed":1,"failed":0,"skipped":0}}\')\nos._exit(0)\n'
  ]
])("rejects %s without trusting test output or exit zero", async (_name, body) => {
  const f = fixture(),
    api = await adapter()
  writeFileSync(join(f.cwd, "test_orders.py"), body)
  const prepared = api.preparePythonTest({
    files: ["test_orders.py"],
    subjects: ["src/main/java/Orders.java"],
    timeoutMs: 10000
  })
  const execution = api.executePythonTests(prepared.argv)
  expect(execution.parse(f.run(execution.argv, execution.init)).passed).toBe(false)
  expect(() => api.executePythonTests(["python", "-m", "unittest", "test_orders.py"])).toThrow(
    "LEAN_PYTHON_TEST_COMMAND_REQUIRED"
  )
})

it("rejects hardlinked subjects and a timed out unittest process", async () => {
  const f = fixture(),
    api = await adapter()
  writeFileSync(
    join(f.cwd, "test_orders.py"),
    "import unittest,time\nclass Tests(unittest.TestCase):\n def test_wait(self): time.sleep(3)\n"
  )
  const prepared = api.preparePythonTest({
    files: ["test_orders.py"],
    subjects: ["src/main/java/Orders.java"],
    timeoutMs: 1000
  })
  const execution = api.executePythonTests(prepared.argv)
  expect(execution.parse(f.run(execution.argv, execution.init)).passed).toBe(false)
  linkSync(join(f.cwd, "src/main/java/Orders.java"), join(f.cwd, "linked.java"))
  expect(execution.parse(f.run(execution.argv, execution.init)).passed).toBe(false)
})
