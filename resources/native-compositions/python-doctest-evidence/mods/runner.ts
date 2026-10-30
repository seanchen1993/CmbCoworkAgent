export function parseAdapterResult<T>(result: { stdout: string; exitCode: number }) {
  let value: { passed?: boolean }
  try {
    value = JSON.parse(result.stdout)
  } catch {
    throw Error("TEST_ADAPTER_RESULT_INVALID")
  }
  if (
    ![0, 1].includes(result.exitCode) ||
    typeof value !== "object" ||
    !value ||
    (result.exitCode === 0 && value.passed === false) ||
    (result.exitCode !== 0 && value.passed !== false)
  )
    throw Error("TEST_ADAPTER_RESULT_INVALID")
  return { value: value as T, exitCode: result.exitCode }
}
