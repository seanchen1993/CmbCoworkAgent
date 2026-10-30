import { preparePythonTest, executePythonTests } from "./doctest-adapter"

export function executionAdapter(value: unknown) {
  if (value !== "python-doctest/v1") throw Error("LEAN_EXECUTION_ADAPTER_REQUIRED")
  return value
}
export function validCounts(counts: any) {
  return (
    counts &&
    ["total", "passed", "failed", "skipped"].every(
      (key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0
    ) &&
    counts.total > 0 &&
    counts.passed === counts.total &&
    counts.failed === 0 &&
    counts.skipped === 0
  )
}
export function contractFor(adapter: unknown) {
  executionAdapter(adapter)
  return {
    passed: true,
    protocol: "devclaw.execution-evidence/v1",
    actions: ["prepare-test", "execute-command", "inspect-workspace", "repair-evidence"],
    resultProtocol: "autobiz.test-execution/v1",
    runner: adapter,
    executionAdapter: adapter,
    description:
      "Python标准库：生产模块置于src/，返回compileArgv=[python,-m,py_compile,一个生产模块路径]；提供器枚举并真正py_compile全部跟踪生产模块。独立测试置于tests/*.doctest，以>>>表达式和预期输出验证行为。禁止空测试或SKIP。subjects为全部生产模块字典序路径，必须与最近编译摘要一致。测试禁止修改工作区。",
    compileInputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["compileArgv"],
      properties: {
        compileArgv: {
          type: "array",
          minItems: 4,
          maxItems: 4,
          items: { type: "string", minLength: 1, maxLength: 1024 }
        }
      }
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["files", "subjects", "timeoutMs"],
      properties: {
        files: { type: "array", minItems: 1, maxItems: 4, items: { type: "string" } },
        subjects: { type: "array", minItems: 1, maxItems: 64, items: { type: "string" } },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 295000 }
      }
    }
  }
}
export function prepareAdapterTest(adapter: unknown, input: any) {
  executionAdapter(adapter)
  return preparePythonTest(input)
}
export function executeAdapterTests(adapter: unknown, argv: string[]) {
  executionAdapter(adapter)
  return executePythonTests(argv)
}
