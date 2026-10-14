import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const exported = resolve(process.argv[2] || join(root, "output/autobiz-fullstack-0920-20261009"))
const receipt = JSON.parse(readFileSync(join(exported, "SOURCE.json"), "utf8"))
if (receipt.source?.branch !== "dev_autobiz_fullstack_0920") throw Error("不是指定分支的导出。")
const workspace = join(exported, "autobiz-source-project")
const reports = join(exported, "baselines")
if (existsSync(reports)) throw Error("基线记录已存在，不覆盖原失败。")
mkdirSync(reports)
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
function verifyOriginals() {
  for (const item of receipt.originalFiles)
    if (hash(readFileSync(join(workspace, item.path))) !== item.sha256)
      throw Error("源码副本的原文件已变化：" + item.path)
}
verifyOriginals()
const fixtureStyle = `import importlib, inspect, json, sys, tempfile, types
from pathlib import Path
package = types.ModuleType("tests")
package.__path__ = [str(Path.cwd() / "tests")]
sys.modules["tests"] = package
results = []
for name in ["test_code_task_context", "test_code_stage_iterative_editing"]:
    try:
        module = importlib.import_module("tests." + name)
        for key, function in sorted(vars(module).items()):
            if not key.startswith("test_") or not callable(function):
                continue
            try:
                params = list(inspect.signature(function).parameters)
                if not params:
                    function()
                elif params == ["tmp_path"]:
                    with tempfile.TemporaryDirectory(prefix="autobiz-original-function-") as temp:
                        function(Path(temp))
                else:
                    raise RuntimeError("Unsupported original fixture: " + repr(params))
                results.append({"test": name + "." + key, "passed": True})
            except Exception as error:
                results.append({"test": name + "." + key, "passed": False, "error": repr(error)})
    except Exception as error:
        results.append({"module": name, "passed": False, "error": repr(error)})
print(json.dumps({"scope": "original functions with their tmp_path fixture; assertions unchanged", "results": results}, ensure_ascii=False, indent=2))
sys.exit(0 if len(results) == 3 and all(item["passed"] for item in results) else 1)
`
const groups = [
  {
    id: "python-root-unittest",
    executable: "python",
    args: ["-B", "-X", "utf8", "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"]
  },
  {
    id: "python-integration-unittest",
    executable: "python",
    args: [
      "-B",
      "-X",
      "utf8",
      "-m",
      "unittest",
      "discover",
      "-s",
      "tests/integration",
      "-p",
      "test_*.py"
    ]
  },
  {
    id: "python-code-workflow-script",
    executable: "python",
    args: ["-B", "-X", "utf8", "tests/test_code_workflow_integration.py"]
  },
  {
    id: "python-fixture-style-functions",
    executable: "python",
    args: ["-B", "-X", "utf8", "-c", fixtureStyle]
  },
  {
    id: "node-workflow-command-results",
    executable: process.execPath,
    args: ["--test", "tests/test_workflow_command_results.mjs"]
  }
]
const results = []
for (const group of groups) {
  const started = new Date().toISOString()
  const result = spawnSync(group.executable, group.args, {
    cwd: workspace,
    windowsHide: true,
    encoding: "utf8",
    timeout: 900000,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      PATH:
        dirname(process.execPath) + (process.platform === "win32" ? ";" : ":") + process.env.PATH,
      PYTHONIOENCODING: "utf-8",
      PYTHONDONTWRITEBYTECODE: "1"
    }
  })
  const log = (result.stdout || "") + "\n--- stderr ---\n" + (result.stderr || "")
  writeFileSync(join(reports, group.id + ".log"), log, { flag: "wx" })
  const entry = {
    id: group.id,
    started,
    finished: new Date().toISOString(),
    executable: group.executable,
    args: group.args,
    actualExitCode: result.status,
    signal: result.signal,
    error: result.error
      ? { name: result.error.name, message: result.error.message, code: result.error.code }
      : null,
    log: group.id + ".log",
    logSha256: hash(Buffer.from(log)),
    passed: result.status === 0 && !result.error && !result.signal
  }
  results.push(entry)
  console.log(
    JSON.stringify({ id: entry.id, actualExitCode: entry.actualExitCode, passed: entry.passed })
  )
}
let originalFilesUnchanged = false
let sourceError
try {
  verifyOriginals()
  originalFilesUnchanged = true
} catch (error) {
  sourceError = error.message
}
const report = {
  schemaVersion: 1,
  source: receipt.source,
  workspace,
  originalFilesUnchanged,
  sourceError,
  results,
  passed: originalFilesUnchanged && results.every((item) => item.passed),
  scope:
    "Five separately recorded scopes; unittest discovery does not execute all script-style tests; no business or customer-model acceptance"
}
writeFileSync(join(reports, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" })
if (!report.passed) process.exitCode = 1
