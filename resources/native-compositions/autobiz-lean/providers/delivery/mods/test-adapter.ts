import { preparePythonTest, executePythonTests } from "./python-unittest-adapter"
import { adapterInvocation, parseAdapterResult } from "./runner"

// Public adapter contract: workflows consume this schema and prepare-test argv, never framework rules.
export const testContract = {
  passed: true,
  protocol: "devclaw.execution-evidence/v1",
  actions: ["prepare-test", "execute-command", "inspect-workspace", "repair-evidence"],
  resultProtocol: "autobiz.test-execution/v1",
  compileInputSchema: {
    type: "object", additionalProperties: false, required: ["compileArgv"],
    properties: { compileArgv: { type: "array", minItems: 1, maxItems: 64,
      items: { type: "string", minLength: 1, maxLength: 1024 } } }
  },
  runner: "node-test/v1",
  description: "Node内置test runner。生产编译返回[node,--check,一个生产模块路径]，执行器从真实Git跟踪清单枚举并逐个编译全部生产JS模块（最多8个）。创建真正的test()/it()行为测试，不能只打印结果。subjects必须包含本仓本批全部生产修改文件；最终E2E包含全部批次生产文件。测试禁止修改工作区。",
  inputSchema: {
    type: "object", additionalProperties: false, required: ["files", "subjects", "timeoutMs"],
    properties: {
      files: { type: "array", minItems: 1, maxItems: 4, items: { type: "string" } },
      subjects: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } },
      timeoutMs: { type: "integer", minimum: 1000, maximum: 295000 }
    }
  }
}

export function validCounts(counts: any) {
  return counts && ["total", "passed", "failed", "skipped"].every(
    (key: any) => Number.isSafeInteger(counts[key]) && counts[key] >= 0
  ) && counts.total > 0 && counts.passed === counts.total && counts.failed === 0 && counts.skipped === 0
}

export function prepareTest(input: any) {
  const paths = (value: any, max: any, tests: any) => Array.isArray(value) && value.length > 0 &&
    value.length <= max && new Set(value).size === value.length && value.every((path: any) =>
      typeof path === "string" && path.length <= 160 &&
      /^(?!\.)(?!.*(?:^|\/)\.\.?\/)[a-zA-Z0-9_.\/-]+$/.test(path) &&
      !path.split("/").some((part: any) => !part || [".", "..", ".git", ".devclaw", ".cmbcoworkagent"].includes(part)) &&
      (!tests || /\.(?:test|spec)\.(?:cjs|mjs|js)$/.test(path)))
  if (!input || Object.keys(input).sort().join("|") !== "files|subjects|timeoutMs" ||
      !paths(input.files, 4, true) || !paths(input.subjects, 8, false) ||
      input.subjects.some((path: any) => input.files.includes(path)) ||
      !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 295000)
    throw Error("LEAN_TEST_INPUT_INVALID")
  const invocation = adapterInvocation({ mode: "execute", files: input.files,
    subjects: input.subjects, sources: [], timeoutMs: input.timeoutMs })
  if (invocation.argv.some((arg: any) => arg.length > 1024)) throw Error("LEAN_TEST_COMMAND_LIMIT")
  return invocation
}

export function executeTests(argv: any) {
  if (!Array.isArray(argv) || argv.length !== 3 || argv[0] !== "node" || argv[1] !== "-")
    throw Error("LEAN_TEST_ADAPTER_COMMAND_REQUIRED")
  const request = JSON.parse(argv[2])
  const invocation = prepareTest({ files: request.files, subjects: request.subjects,
    timeoutMs: request.timeoutMs })
  if (JSON.stringify(invocation.argv) !== JSON.stringify(argv)) throw Error("LEAN_TEST_COMMAND_CHANGED")
  return { ...invocation, parse(result: any) {
    const { value } = parseAdapterResult<any>(result)
    if (value.passed && (!validCounts(value.counts) ||
        ![value.testsFingerprint, value.subjectFingerprint].every((hash: any) => /^[a-f0-9]{64}$/.test(hash))))
      throw Error("LEAN_TEST_STATISTICS_REQUIRED")
    return { ...value, protocol: "autobiz.test-execution/v1", files: request.files,
      subjects: request.subjects, timeoutMs: request.timeoutMs }
  } }
}

export function executionAdapter(value: any) {
  if (!["node-test/v1", "python-unittest/v1"].includes(value)) throw Error("LEAN_EXECUTION_ADAPTER_REQUIRED")
  return value
}
export function contractFor(adapter: any) {
  executionAdapter(adapter)
  return { ...testContract, runner: adapter, executionAdapter: adapter,
    ...(adapter === "python-unittest/v1" ? {
      description: "Java/Maven：返回真实Maven compile生产命令；独立编写test_*.py中的unittest.TestCase，调用target/classes中已编译Java行为。每批测试、修复重跑和最终E2E的subjects均必须等于编译回执的全部Java/POM源清单，按路径字典序排序；不得只打印结果、跳过、改源码或替换报告。每次最多4个测试文件、64个源码及pom文件。",
      inputSchema: { ...testContract.inputSchema, properties: {
        ...testContract.inputSchema.properties,
        subjects: { type: "array", minItems: 1, maxItems: 64, items: { type: "string" } }
      } }
    } : {}) }
}
export function prepareAdapterTest(adapter: any, input: any) {
  return executionAdapter(adapter) === "python-unittest/v1" ? preparePythonTest(input) : prepareTest(input)
}
export function executeAdapterTests(adapter: any, argv: any) {
  return executionAdapter(adapter) === "python-unittest/v1" ? executePythonTests(argv) : executeTests(argv)
}
