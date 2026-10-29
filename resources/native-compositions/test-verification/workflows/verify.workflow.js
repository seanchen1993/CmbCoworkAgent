export const meta = {
  name: "test-verification",
  description: "按上下文中的项目配置执行 Node 测试，Host 独立核对实际配置期望",
  phases: [{ title: "执行测试", detail: "读取真实产物并执行配置的测试文件" }]
}

if (
  !args ||
  args.provider?.plugin !== "test-verification" ||
  args.provider.actionId !== "execute-e2e"
)
  throw Error("TEST_PROVIDER_REQUIRED")
const legacy = args.legacyInput === true && args.configuration === undefined
let files, subjects, timeoutMs
if (legacy) {
  files = args.files
  subjects = args.subjects
  timeoutMs = args.timeoutMs ?? 60000
} else {
  const configuration = args.configuration
  if (
    !configuration ||
    typeof configuration !== "object" ||
    Array.isArray(configuration) ||
    Object.keys(configuration).sort().join("|") !== "e2eSubjects|e2eTestFiles|e2eTimeoutMs" ||
    typeof configuration.e2eTestFiles !== "string" ||
    typeof configuration.e2eSubjects !== "string" ||
    configuration.e2eTestFiles.length > 4096 ||
    configuration.e2eSubjects.length > 4096
  )
    throw Error("TEST_EXPECTED_CONFIGURATION_REQUIRED")
  try {
    files = JSON.parse(configuration.e2eTestFiles)
    subjects = JSON.parse(configuration.e2eSubjects)
  } catch {
    throw Error("TEST_EXPECTED_CONFIGURATION_INVALID")
  }
  timeoutMs = configuration.e2eTimeoutMs
}
if (
  !Array.isArray(files) ||
  !files.length ||
  files.length > 4 ||
  files.some((file) => typeof file !== "string")
)
  throw Error("TEST_FILES_INVALID")
if (
  !Array.isArray(subjects) ||
  !subjects.length ||
  subjects.length > 8 ||
  subjects.some((file) => typeof file !== "string")
)
  throw Error("TEST_SUBJECTS_REQUIRED")
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000)
  throw Error("TEST_EXPECTED_CONFIGURATION_INVALID")
const result = await action({
  stepId: "verify-e2e",
  provider: args.provider,
  input: {
    files,
    sources: args.sources,
    subjects,
    timeoutMs
  }
})
if (result.status !== "succeeded" || result.output?.passed !== true)
  throw Error("TEST_EXECUTION_FAILED")
return {
  protocol: "devclaw.test-report-selection/v1",
  runId: result.parentRunId,
  executionId: result.executionId
}
