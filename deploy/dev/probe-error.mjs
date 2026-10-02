// Child output may contain a full OR truncated password/SQL. Do not try to redact
// by matching a complete password: rebuild a small allowlisted error instead.
export function probeFailure(error, phase, { cancelled = false, injected = false } = {}) {
  const phases = ["compile", "initialize", "socket-startup", "socket-readiness", "credential-bootstrap", "loopback-startup", "jdbc-readiness", "jdbc-probe"]
  const failures = ["cancelled", "timeout", "unavailable", "output_limit", "exit"]
  const safePhase = phases.includes(phase) ? phase : "unknown"
  const reason = cancelled ? "cancelled" : injected ? "injected" : failures.includes(error?.failureCode) ? error.failureCode : "compatibility_or_io"
  const result = new Error(`Real probe ${safePhase} failed: ${reason}`)
  result.code = "DEV_PROBE_FAILED"
  result.diagnostic = {
    phase: safePhase, reason,
    ...(Number.isInteger(error?.exitCode) ? { exitCode: error.exitCode } : {}),
    ...(error?.readiness ? { ownedPidMatch: error.readiness.ownedPidMatch === true, readyLog: error.readiness.readyLog === true } : {})
  }
  return result
}
