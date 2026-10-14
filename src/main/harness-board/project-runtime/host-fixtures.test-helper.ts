import type {
  HostActionPrepareInput,
  HostExecutionTicket,
  HostProjectCreateInput,
  HostValidationReceipt
} from "../../../shared/project-runtime/host-types"

export const TEST_NOW = 1_000_000
export const TEST_FINGERPRINT = "b".repeat(64)

export function hostProjectFixture(workspace: string): HostProjectCreateInput {
  return {
    projectId: "local-docs",
    name: "Local documents",
    goal: "Write and review a project document.",
    workspace,
    installedPluginId: "a064bd34-7007-4b25-a7ea-6a9e463b5839",
    packageId: "docs",
    packageVersion: "1.0.0",
    pluginDigest: "a".repeat(64),
    manifest: {
      apiVersion: "devclaw.project-runtime/v1",
      plugin: { id: "docs", version: "1.0.0" },
      mode: "host",
      stateOwner: "host",
      stages: ["draft", "review"].map((id) => ({
        id,
        title: id,
        skill: `skills/${id}/SKILL.md`,
        actionIds: [],
        artifactIds: ["document"],
        checkIds: ["document-exists"],
        approval: id === "review" ? "human" : "none"
      })),
      actions: [],
      artifacts: [{ id: "document", path: "document.md", required: true }],
      checks: [
        { id: "document-exists", artifactId: "document", kind: "file-exists", sideEffect: "read" }
      ],
      environment: [],
      capabilities: {
        execution: true,
        conditionalTransition: true,
        idempotency: true,
        reconciliation: true,
        cancellation: true
      }
    }
  }
}

export function prepareFixture(
  overrides: Partial<HostActionPrepareInput> = {}
): HostActionPrepareInput {
  return {
    projectId: "local-docs",
    stageId: "draft",
    expectedVersion: 1,
    idempotencyKey: "first",
    inputFingerprint: TEST_FINGERPRINT,
    ...overrides
  }
}

export function receiptFixture(ticket: HostExecutionTicket): HostValidationReceipt {
  return {
    schemaVersion: 1,
    operationId: ticket.operationId,
    projectId: ticket.projectId,
    stageId: ticket.stageId,
    pluginDigest: ticket.pluginDigest,
    inputFingerprint: ticket.inputFingerprint,
    checkId: "document-exists",
    artifactFingerprint: "d".repeat(64),
    result: "passed",
    validatorVersion: "host-file-exists/v1",
    checkedAt: TEST_NOW
  }
}
