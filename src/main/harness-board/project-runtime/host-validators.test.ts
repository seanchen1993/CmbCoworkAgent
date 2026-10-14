import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { HostProjectStore } from "./host-store"
import { hostProjectFixture } from "./host-fixtures.test-helper"
import {
  assertHostReceiptsCurrent,
  assertHostRuntimeSupported,
  fingerprintHostStageInput,
  validateHostStage
} from "./host-validators"

const cleanup: Array<() => void> = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "host-validator-"))
  const workspace = join(root, "workspace")
  mkdirSync(workspace)
  const store = new HostProjectStore(join(root, "state.sqlite"))
  cleanup.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const input = hostProjectFixture(workspace)
  input.manifest.artifacts[0].path = "review.json"
  input.manifest.checks[0] = {
    id: "document-exists",
    artifactId: "document",
    kind: "json-schema",
    sideEffect: "read",
    schema: {
      type: "object",
      properties: { approved: { type: "boolean", const: true } },
      required: ["approved"],
      additionalProperties: false
    }
  }
  const project = store.create(input)
  const operation = store.prepare({
    projectId: project.projectId,
    expectedVersion: 1,
    stageId: "draft",
    idempotencyKey: "validate",
    inputFingerprint: fingerprintHostStageInput(project, project.goal)
  })
  const ticket = store.start(operation.operationId, operation.inputFingerprint)
  return { workspace, project, store, operation, ticket }
}
afterEach(() => cleanup.splice(0).forEach((run) => run()))

describe("host file validators", () => {
  it("excludes only checked current outputs while retaining other preceding byte fingerprints", () => {
    const { workspace, project } = fixture()
    const review = { ...project, stageIndex: 1, version: 2 }
    review.manifest.artifacts.push({ id: "source", path: "source.md", required: true })
    review.manifest.stages[0].artifactIds.push("source")
    writeFileSync(join(workspace, "source.md"), "Fixed source")
    writeFileSync(join(workspace, "review.json"), '{"approved":true}')
    const initial = fingerprintHostStageInput(review, review.goal)
    writeFileSync(join(workspace, "review.json"), '{"approved":false}')
    expect(fingerprintHostStageInput(review, review.goal)).toBe(initial)
    writeFileSync(join(workspace, "source.md"), "Changed source")
    expect(fingerprintHostStageInput(review, review.goal)).not.toBe(initial)
    // Merely listing an artifact cannot remove its input protection without a current check.
    review.manifest.stages[1].checkIds = []
    const unchecked = fingerprintHostStageInput(review, review.goal)
    writeFileSync(join(workspace, "review.json"), '{"approved":true}')
    expect(fingerprintHostStageInput(review, review.goal)).not.toBe(unchecked)
  })
  it("blocks a later stage when a required preceding artifact was removed", () => {
    const { workspace, project } = fixture()
    const review = { ...project, stageIndex: 1, version: 2 }
    expect(() => fingerprintHostStageInput(review, review.goal)).toThrow("REQUIRED_INPUT_MISSING")
    writeFileSync(join(workspace, "review.json"), '{"approved":true}')
    expect(() => fingerprintHostStageInput(review, review.goal)).not.toThrow()
  })
  it("uses actual bounded JSON bytes and rechecks receipt fingerprints before transition", () => {
    const { workspace, project, store, ticket } = fixture()
    writeFileSync(join(workspace, "review.json"), '{"approved":true}')
    const receipts = validateHostStage(project, ticket)
    expect(receipts[0]).toMatchObject({
      result: "passed",
      artifactFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    const completed = store.recordResult(ticket, { outcome: "succeeded", receipts })
    expect(() => assertHostReceiptsCurrent(project, completed)).not.toThrow()
    writeFileSync(join(workspace, "review.json"), '{"approved":false}')
    expect(validateHostStage(project, ticket)[0].result).toBe("failed")
    expect(() => assertHostReceiptsCurrent(project, completed)).toThrow("EVIDENCE_STALE")
  })
  it("rejects external schemas, hardlinks and scope mismatch", () => {
    const { workspace, project, ticket } = fixture()
    const invalid = structuredClone(project.manifest)
    invalid.checks[0].schema = { $ref: "https://example.com/schema.json" }
    expect(() => assertHostRuntimeSupported(invalid)).toThrow()
    writeFileSync(join(workspace, "original.json"), '{"approved":true}')
    linkSync(join(workspace, "original.json"), join(workspace, "review.json"))
    expect(() => validateHostStage(project, ticket)).toThrow("FILE_UNSAFE")
    expect(() => validateHostStage(project, { ...ticket, projectId: "another" })).toThrow(
      "VERSION_CONFLICT"
    )
  })
  it("distinguishes missing and invalid JSON from passing schema checks", () => {
    const { workspace, project, ticket } = fixture()
    expect(validateHostStage(project, ticket)[0].result).toBe("failed")
    writeFileSync(join(workspace, "review.json"), Buffer.from([0xff]))
    expect(validateHostStage(project, ticket)[0].result).toBe("failed")
    writeFileSync(join(workspace, "review.json"), '{"approved":true,"unexpected":1}')
    expect(validateHostStage(project, ticket)[0].result).toBe("failed")
  })
})
