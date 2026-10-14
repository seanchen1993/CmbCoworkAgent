/** Finish each cleanup step without replacing an earlier test failure. */
export async function attemptModsE2eCleanup(
  failures: unknown[],
  operation: () => unknown
): Promise<boolean> {
  try {
    await operation()
    return true
  } catch (reason) {
    failures.push(reason)
    return false
  }
}

/** Early focus returns still report every failure collected by the real runner. */
export async function runModsE2eWithFailures(
  run: (failures: unknown[]) => void | Promise<void>
): Promise<void> {
  const failures: unknown[] = []
  try {
    await run(failures)
  } catch (reason) {
    failures.push(reason)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1)
    throw new AggregateError(failures, "Mods E2E failed", { cause: failures[0] })
}
