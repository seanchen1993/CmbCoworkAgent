import { expect, it } from "vitest"
import { boundHostCheckDiagnostic, boundHostCheckDiagnostics, parseHostCheckDiagnostics,
  previousHostCheckOperation } from "./host-check-diagnostics"
import type { HostProjectOperation } from "../../../shared/project-runtime/host-types"

export const diagnosticFixture = (inputFingerprint = "b".repeat(64)) => boundHostCheckDiagnostic({
  checkId: "document-exists", actionId: "validate", runId: "flow-original", executionId: "execution-original",
  provider: { pluginId: "checker-installation", plugin: "checker", digest: "c".repeat(64), actionId: "check" },
  inputFingerprint, resultDigest: "d".repeat(64)
}, "Original check failed", { errors: [{ code: "INVALID_SOURCE", detail: "version must be 1" }] })

it("bounds diagnostic UTF-8 text, hidden controls, count and total expansion without copying raw output", () => {
  const item = boundHostCheckDiagnostic(diagnosticFixture(), "中".repeat(2000), {
    errors: Array.from({ length: 30 }, () => ({ code: "E\0", detail: "文".repeat(1000) })),
    warnings: Array.from({ length: 30 }, () => "warning".repeat(200)), stdin: "private"
  })
  expect(item.errors).toHaveLength(8)
  expect(item.warnings).toHaveLength(8)
  expect(Buffer.byteLength(item.summary)).toBeLessThanOrEqual(1024)
  expect(Buffer.byteLength(item.errors[0].message)).toBeLessThanOrEqual(512)
  expect(item.errors[0].code).toBe("E")
  expect(item.truncated).toBe(true)
  expect(JSON.stringify(item)).not.toContain("private")
  const items = boundHostCheckDiagnostics(Array.from({ length: 64 }, () => ({ ...item })))
  expect(items.length).toBeGreaterThan(0)
  expect(items.length).toBeLessThanOrEqual(16)
  expect(Buffer.byteLength(JSON.stringify(items))).toBeLessThanOrEqual(32 * 1024)
  expect(() => parseHostCheckDiagnostics([{ ...item, approval: true }])).toThrow("INVALID")
  expect(() => parseHostCheckDiagnostics([{ ...item, errors: Array(9).fill(item.errors[0]) }])).toThrow("INVALID")
  expect(() => parseHostCheckDiagnostics([{ ...item, inputFingerprint: "forged" }])).toThrow("INVALID")
})

it("selects only the latest failed attempt with exact project, stage, version, package and input identity", () => {
  const current = { operationId: "new", projectId: "project", stageId: "prd", expectedVersion: 2,
    pluginDigest: "a".repeat(64), inputFingerprint: "b".repeat(64) } as HostProjectOperation
  const previous = { ...current, operationId: "old", status: "failed" as const }
  expect(previousHostCheckOperation(current, [previous])).toBe(previous)
  for (const delta of [{ projectId: "other" }, { stageId: "convert" }, { expectedVersion: 3 },
    { pluginDigest: "c".repeat(64) }, { inputFingerprint: "d".repeat(64) }, { status: "unknown" as const }]) {
    expect(previousHostCheckOperation(current, [{ ...previous, ...delta }])).toBeUndefined()
  }
  const latest = { ...previous, operationId: "latest-with-no-diagnostics" }
  expect(previousHostCheckOperation(current, [latest, previous])).toBe(latest)
})
