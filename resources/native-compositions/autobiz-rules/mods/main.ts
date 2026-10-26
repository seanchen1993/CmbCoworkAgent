import { rules } from "./rules-bundle"
import { checkCodeResult } from "./code-result"
import { readFailedTestReceipt } from "./repair-evidence"
import { isArtifactReference, readReferencedCodeSelection, runReferencedCheck } from "./artifact-reference"

const stages = ["convert", "prd", "specs", "design", "plan"]
const preceding = [
  "NORMALIZED_REQUIREMENTS.json",
  "PRD.bundle.json",
  "SPECS.bundle.json",
  "DESIGN.bundle.json"
]
const bootstrap = `import sys,json,tempfile
from pathlib import Path
payload=json.loads(sys.stdin.read())
with tempfile.TemporaryDirectory(prefix="autobiz-pinned-rules-") as directory:
    root=Path(directory)
    for name,source in payload["rules"].items():
        path=root/name
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text(source,encoding="utf-8")
    sys.path.insert(0,str(root))
    from check import run
    try:
        result=run(payload["request"])
    except Exception as error:
        result={"passed":False,"errors":[{"code":type(error).__name__,"detail":str(error)}],"warnings":[]}
    print(json.dumps(result,ensure_ascii=False))
    sys.exit(0 if result["passed"] else 1)
`

function parseCheckedReport(result) {
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
export function register(on) {
  on.capability(
    {
      apiVersion: "devclaw.capability/v1",
      id: "code-execution",
      version: "1.0.0",
      title: "AutoBiz真实代码验证",
      scope: "conversation",
      stateSchema: { type: "object" },
      actions: ["validate-command", "inspect-workspace", "repair-evidence"].map((id) => ({
        id,
        title: "执行计划所属编译或测试",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        requiredPermissions: [
          "process.run",
          ...(id === "repair-evidence" ? ["fs.read", "platform.read", "platform.act"] : [])
        ],
        cancellable: true,
        idempotency: "keyed"
      }))
    },
    {
      act: async ($, event) => {
        const input = event.input.input
        if (event.action === "repair-evidence") {
          const receipt = await readFailedTestReceipt($, event.input)
          const plan = JSON.parse(await $.fs.read("PLAN.bundle.json"))
          const checked = await $.process.run(
            ["python", "-I", "-B", "-X", "utf8", "-c", bootstrap],
            {
              stdin: JSON.stringify({
                request: { stage: "repair-evidence", plan, receipt },
                rules
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
          input.taskIds.some((id) => !/^T\d{3}$/.test(id))
        )
          throw Error("CODE_VALIDATION_INPUT_INVALID")
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
        const policy = await $.process.run(["python", "-I", "-B", "-X", "utf8", "-c", bootstrap], {
          stdin: JSON.stringify({
            request: {
              stage: "command-policy",
              current: {
                ...input,
                trackedPaths: tracked.stdout.split("\0").filter(Boolean),
                changedPaths: diff.stdout.split("\0").filter(Boolean)
              }
            },
            rules
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
        if (diff.stdout.split("\0").some((path) => /\.(?:js|jsx|ts|tsx|vue|mjs|cjs)$/.test(path))) {
          const scanned = await $.process.run(
            ["python", "-I", "-B", "-X", "utf8", "-c", bootstrap],
            {
              stdin: JSON.stringify({ request: { stage: "performance", current: input }, rules }),
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
        const result = await $.process.run(input.argv, { timeoutMs: 300000 })
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
          passed: result.exitCode === 0,
          phase: input.phase,
          taskIds: input.taskIds,
          workspaceRef: input.workspaceRef,
          testFiles: policyReport.testFiles,
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
  on.capability(
    {
      apiVersion: "devclaw.capability/v1",
      id: "business-checks",
      version: "1.0.3",
      title: "AutoBiz业务检查",
      scope: "conversation",
      stateSchema: { type: "object" },
      actions: [...stages, "code", "cicd", "archive"].map((stage) => ({
        id: stage,
        title: "校验 " + stage,
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        requiredPermissions: [
          "fs.read",
          "process.run",
          ...(["code", "cicd", "archive"].includes(stage) ? ["platform.read", "platform.act"] : [])
        ],
        cancellable: true,
        idempotency: "keyed"
      }))
    },
    {
      act: async ($, event) => {
        if (isArtifactReference(event.input?.input)) {
          if (event.input.version !== 1) throw Error("ACTION_ENVELOPE_INVALID")
          const reference = event.input.input
          if (["code", "cicd", "archive"].includes(event.action)) {
            const selection = await readReferencedCodeSelection($, reference, event.action)
            const output = await checkCodeResult($, { ...event.input, input: selection }, async () =>
              parseCheckedReport(await runReferencedCheck($, reference, event.action, "plan-check"))
            )
            if (event.action === "code")
              return { status: "succeeded", text: "原始Code子运行、测试和合并证据已核对", output }
          }
          const report = parseCheckedReport(await runReferencedCheck($, reference, event.action))
          return {
            status: report.passed ? "succeeded" : "failed",
            text: report.passed ? "业务规则已校验；阶段提交由 Host 决定。" : "业务规则未通过。",
            output: report
          }
        }
        if (["code", "cicd", "archive"].includes(event.action)) {
          const codeEnvelope =
            event.action === "code"
              ? event.input
              : { ...event.input, input: JSON.parse(await $.fs.read("CODE_RESULT.json")) }
          const output = await checkCodeResult($, codeEnvelope, async (current) => {
            const request = { stage: "plan", current }
            for (let prior = 0; prior < preceding.length; prior++)
              request[["normalized", "prd", "specs", "design"][prior]] = JSON.parse(
                await $.fs.read(preceding[prior])
              )
            const checked = await $.process.run(
              ["python", "-I", "-B", "-X", "utf8", "-c", bootstrap],
              { stdin: JSON.stringify({ request, rules }), timeoutMs: 30000 }
            )
            return parseCheckedReport(checked)
          })
          if (event.action !== "code") {
            const sources = {}
            for (const name of [
              ...preceding,
              "PLAN.bundle.json",
              "CODE_RESULT.json",
              ...(event.action === "archive" ? ["CICD.bundle.json"] : [])
            ])
              sources[name] = await $.fs.read(name)
            const verified = await $.process.run(
              ["python", "-I", "-B", "-X", "utf8", "-c", bootstrap],
              {
                stdin: JSON.stringify({
                  request: { stage: event.action, current: event.input.input, sources },
                  rules
                }),
                timeoutMs: 30000
              }
            )
            const report = parseCheckedReport(verified)
            return {
              status: report.passed ? "succeeded" : "failed",
              text: "CI/CD准备与过程产物校验",
              output: report
            }
          }
          return { status: "succeeded", text: "原始Code子运行、测试和合并证据已核对", output }
        }
        const index = stages.indexOf(event.action)
        if (index < 0) throw Error("AUTOBIZ_STAGE_INVALID")
        const envelope = event.input
        if (envelope.version !== 1 || !envelope.input || typeof envelope.input !== "object")
          throw Error("ACTION_ENVELOPE_INVALID")
        const request = { stage: stages[index], current: envelope.input }
        for (let prior = 0; prior < index; prior++)
          request[["normalized", "prd", "specs", "design"][prior]] = JSON.parse(
            await $.fs.read(preceding[prior])
          )
        // Embedded modules participate in the compiled action identity, including every Python rule.
        const result = await $.process.run(["python", "-I", "-B", "-X", "utf8", "-c", bootstrap], {
          stdin: JSON.stringify({ request, rules }),
          timeoutMs: 30000,
          env: { PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" }
        })
        const report = parseCheckedReport(result)
        return {
          status: report.passed ? "succeeded" : "failed",
          text: report.passed ? "业务规则已校验；阶段提交由 Host 决定。" : "业务规则未通过。",
          output: report
        }
      }
    }
  )
}
