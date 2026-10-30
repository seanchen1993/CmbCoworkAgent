import type { SDK } from "devclaw-mods"
import { productionModules, compileNodeModules, assertNodeProductionPaths } from "./node-compile"
import { executionPolicy } from "./execution-policy"
import { rules } from "./rules-bundle"
import { registerEvidence } from "./evidence"
import { executionAdapter, prepareAdapterTest, executeAdapterTests, contractFor } from "./test-adapter"
import { javaSources, compileJavaSources } from "./java-compile"
import { readInputs } from "./inputs"
import { readFailedTestReceipt } from "./repair-evidence"


export const bootstrap = `import sys,json,tempfile
from pathlib import Path
payload=json.loads(sys.stdin.read())
sources={**payload["rules"],"lean_execution.py":payload["executionPolicy"]}
with tempfile.TemporaryDirectory(prefix="autobiz-pinned-rules-") as directory:
    root=Path(directory)
    for name,source in sources.items():
        path=root/name
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text(source,encoding="utf-8")
    sys.path.insert(0,str(root))
    from lean_execution import run
    try:
        result=run(payload["request"])
    except Exception as error:
        result={"passed":False,"errors":[{"code":type(error).__name__,"detail":str(error)}],"warnings":[]}
    print(json.dumps(result,ensure_ascii=False))
    sys.exit(0 if result["passed"] else 1)
`

export function parseCheckedReport(result: any) {
  let report
  try {
    report = JSON.parse(result.stdout)
  } catch {
    throw Error("AUTOBIZ_CHECK_PROCESS_RESULT_INVALID")
  }
  if (
    !report ||
    Array.isArray(report) ||
    typeof report.passed !== "boolean" ||
    !Array.isArray(report.errors) ||
    !Array.isArray(report.warnings) ||
    !Number.isInteger(result.exitCode) ||
    result.exitCode < 0 ||
    (result.exitCode === 0) !== report.passed
  )
    throw Error("AUTOBIZ_CHECK_PROCESS_RESULT_INVALID")
  return report
}

/** Pure business validation. Host owns stage progression and the platform owns action receipts. */
export function register(on: any) {
  on.capability(
    {
      apiVersion: "devclaw.capability/v1",
      id: "delivery-proof",
      version: "1.0.0",
      title: "AutoBiz真实代码验证",
      scope: "conversation",
      stateSchema: { type: "object" },
      actions: [
  {
    "id": "execute-command",
    "title": "execute-command",
    "inputSchema": {
      "type": "object"
    },
    "outputSchema": {
      "type": "object"
    },
    "requiredPermissions": [
      "process.run"
    ],
    "cancellable": true,
    "idempotency": "keyed"
  },
  {
    "id": "inspect-workspace",
    "title": "inspect-workspace",
    "inputSchema": {
      "type": "object"
    },
    "outputSchema": {
      "type": "object"
    },
    "requiredPermissions": [
      "process.run"
    ],
    "cancellable": true,
    "idempotency": "keyed"
  },
  {
    "id": "repair-evidence",
    "title": "repair-evidence",
    "inputSchema": {
      "type": "object"
    },
    "outputSchema": {
      "type": "object"
    },
    "requiredPermissions": [
      "process.run",
      "fs.read",
      "platform.read",
      "platform.act"
    ],
    "cancellable": true,
    "idempotency": "keyed"
  },
  {
    "id": "test.contract",
    "title": "test.contract",
    "inputSchema": {
      "type": "object"
    },
    "outputSchema": {
      "type": "object"
    },
    "requiredPermissions": [
      "process.run"
    ],
    "cancellable": true,
    "idempotency": "keyed"
  },
  {
    "id": "prepare-test",
    "title": "prepare-test",
    "inputSchema": {
      "type": "object"
    },
    "outputSchema": {
      "type": "object"
    },
    "requiredPermissions": [
      "process.run"
    ],
    "cancellable": true,
    "idempotency": "keyed"
  }
]
    },
    {
      act: async ($: Pick<SDK, "process" | "platform">, event: any) => {
        const input = event.input.input
        if (event.action === "test.contract") return {
          status: "succeeded", text: "可替换测试适配器契约", output: contractFor(input.executionAdapter)
        }
        if (event.action === "prepare-test") return {
          status: "succeeded", text: "测试执行入口", output: { passed: true, executionAdapter: input.executionAdapter, argv: prepareAdapterTest(input.executionAdapter, input.testInput).argv }
        }
        if (event.action === "repair-evidence") {
          const receipt = await readFailedTestReceipt($, event.input)
          const { documents, inputDigests } = await readInputs($, undefined, undefined, undefined, input.artifactPaths)
          if (Object.entries(inputDigests).some(([path, digest]) => receipt.inputDigests[path] !== digest))
            throw Error("LEAN_REPAIR_INPUT_CHANGED")
          const solved = documents["Solution.json"]
          const plan = { feature: solved.feature, stage: "plan", files: {
            "plan.json": JSON.stringify(solved.plan),
            ...Object.fromEntries(Object.entries(solved.batches).map(([id, value]: any) =>
              ["plans/" + id + "/plan.json", JSON.stringify(value)]))
          } }
          const checked = await $.process.run(
            ["python", "-I", "-B", "-X", "utf8", "-c", bootstrap],
            {
              stdin: JSON.stringify({
                request: { stage: "repair-evidence", plan, receipt },
                rules, executionPolicy
              }),
              timeoutMs: 30000
            }
          )
          const output = parseCheckedReport(checked)
          return {
            status: output.passed ? "succeeded" : "failed",
            text: "原始失败UT回执与当前任务契约绑定",
            output
          }
        }
        if (event.action === "inspect-workspace") {
          if (!/^[a-f0-9]{40,64}$/.test(input.expectedCommit))
            throw Error("CODE_REVIEW_INPUT_INVALID")
          const head = await $.process.run(["git", "rev-parse", "HEAD"], { timeoutMs: 30000 })
          const dirty = await $.process.run(["git", "status", "--porcelain"], { timeoutMs: 30000 })
          const passed =
            head.exitCode === 0 &&
            dirty.exitCode === 0 &&
            !dirty.stdout.trim() &&
            head.stdout.trim() === input.expectedCommit
          return {
            status: passed ? "succeeded" : "failed",
            text: "实际只读评审Git边界",
            output: { passed, headCommit: head.stdout.trim(), dirty: Boolean(dirty.stdout.trim()) }
          }
        }
        if (
          !input ||
          !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(input.workspaceRef) ||
          !["compile", "test", "e2e"].includes(input.phase) ||
          !/^[a-f0-9]{40,64}$/.test(input.expectedCommit) ||
          !/^[a-f0-9]{40,64}$/.test(input.baselineCommit) ||
          !Array.isArray(input.taskIds) ||
          !input.taskIds.length ||
          input.taskIds.some((id: any) => !/^T\d{3}$/.test(id))
        )
          throw Error("CODE_VALIDATION_INPUT_INVALID")
        const selected = executionAdapter(input.executionAdapter ?? "node-test/v1")
        if (input.phase !== "compile") executeAdapterTests(selected, input.argv)
        const diff = await $.process.run(
          [
            "git",
            "diff",
            "--no-ext-diff",
            "--name-only",
            "-z",
            input.baselineCommit,
            input.expectedCommit
          ],
          { timeoutMs: 30000 }
        )
        if (diff.exitCode !== 0 || diff.stdout.length > 32000)
          throw Error("CODE_VALIDATION_DIFF_UNCONFIRMED")
        const tracked = await $.process.run(["git", "ls-files", "-z"], { timeoutMs: 30000 })
        if (tracked.exitCode !== 0 || tracked.stdout.length > 32000)
          throw Error("CODE_TEST_ASSETS_UNCONFIRMED")
        const nodeModules = input.phase === "compile" && selected === "node-test/v1"
          ? productionModules(tracked.stdout.split("\0").filter(Boolean)) : null
        const declared = input.declaredProductionPaths ?? []
        if (!Array.isArray(declared) || declared.some((path: any) => typeof path !== "string"))
          throw Error("LEAN_DECLARED_PRODUCTION_PATHS_INVALID")
        const javaFiles = input.phase === "compile" && selected === "python-unittest/v1"
          ? javaSources(tracked.stdout.split("\0").filter(Boolean), [...diff.stdout.split("\0").filter(Boolean), ...declared]) : null
        if (nodeModules) {
          assertNodeProductionPaths([...tracked.stdout.split("\0").filter(Boolean),
            ...diff.stdout.split("\0").filter(Boolean), ...declared])
        }
        if (nodeModules && (input.argv.length !== 3 || input.argv[1] !== "--check" ||
            !nodeModules.length || nodeModules.length > 8 || !nodeModules.includes(input.argv[2])))
          throw Error("LEAN_NODE_COMPILE_COVERAGE_REQUIRED")
        const policy = await $.process.run(["python", "-I", "-B", "-X", "utf8", "-c", bootstrap], {
          stdin: JSON.stringify({
            request: {
              stage: "command-policy",
              current: {
                ...input,
                executionAdapter: selected,
                trackedPaths: tracked.stdout.split("\0").filter(Boolean),
                changedPaths: diff.stdout.split("\0").filter(Boolean)
              }
            },
            rules, executionPolicy
          }),
          timeoutMs: 30000
        })
        const policyReport = parseCheckedReport(policy)
        if (!policyReport.passed)
          return {
            status: "failed",
            text: "命令不符合原编译/测试分工规则",
            output: { passed: false, phase: input.phase }
          }
        let performance = { passed: true, errors: [], warnings: [], files: [] }
        if (diff.stdout.split("\0").some((path: any) => /\.(?:js|jsx|ts|tsx|vue|mjs|cjs)$/.test(path))) {
          const scanned = await $.process.run(
            ["python", "-I", "-B", "-X", "utf8", "-c", bootstrap],
            {
              stdin: JSON.stringify({ request: { stage: "performance", current: input }, rules, executionPolicy }),
              timeoutMs: 30000
            }
          )
          performance = parseCheckedReport(scanned)
          if (!performance.passed)
            return {
              status: "failed",
              text: "实际候选提交未通过原性能规则",
              output: { passed: false, phase: input.phase, performance }
            }
        }
        const before = await $.process.run(["git", "rev-parse", "HEAD"], { timeoutMs: 30000 })
        if (before.exitCode !== 0 || before.stdout.trim() !== input.expectedCommit)
          throw Error("CODE_VALIDATION_COMMIT_CHANGED")
        // The actual command is an independent native process admission. Never hide it in Python.
        const invocation = input.phase === "compile" ? null : executeAdapterTests(selected, input.argv)
        const result = nodeModules ? await compileNodeModules($, nodeModules) :
          javaFiles ? await compileJavaSources($, input.argv, javaFiles) :
          await $.process.run(input.argv, invocation?.init ?? { timeoutMs: 300000 })
        const test = invocation ? invocation.parse(result) : null
        const after = await $.process.run(["git", "rev-parse", "HEAD"], { timeoutMs: 30000 })
        const dirty = await $.process.run(["git", "status", "--porcelain"], { timeoutMs: 30000 })
        if (
          after.exitCode !== 0 ||
          dirty.exitCode !== 0 ||
          after.stdout.trim() !== input.expectedCommit ||
          dirty.stdout.trim()
        )
          throw Error("CODE_VALIDATION_WORKSPACE_CHANGED")
        const output = {
          passed: result.exitCode === 0 && (!test || test.passed === true),
          ...(test ? { test } : {}),
          ...("compilation" in result ? { compilation: result.compilation } : {}),
          executionAdapter: selected,
          phase: input.phase,
          taskIds: input.taskIds,
          workspaceRef: input.workspaceRef,
          testFiles: test?.files ?? policyReport.testFiles,
          productionFiles: input.phase === "compile" ? diff.stdout.split("\0").filter(Boolean) : [],
          performance,
          argv: input.argv,
          baselineCommit: input.baselineCommit,
          headCommit: input.expectedCommit,
          exitCode: result.exitCode,
          stdout: result.stdout.slice(0, 2048),
          stderr: result.stderr.slice(0, 2048),
          logTruncated: result.stdout.length > 2048 || result.stderr.length > 2048
        }
        return { status: output.passed ? "succeeded" : "failed", text: "实际命令执行结果", output }
      }
    }
  )
  registerEvidence(on)
}
