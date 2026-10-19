import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import {
  CreatorLegacyTrialEvidence,
  type CreatorLegacyTrialEvidenceOwner
} from "./creator-trial-legacy-evidence"
import {
  executeProjectCheckpoint,
  projectCheckpointAvailable
} from "../../harness-board/project-runtime/project-checkpoint"
import {
  issueRuntimePluginSourceToken,
  withRuntimePluginSource
} from "../../plugins/runtime-source-scope"
import { runtimeDigest } from "../../harness-board/project-runtime/safe-files"
import type { PluginMetadata } from "../../types"
import type { StageCheckReceipt } from "../../../shared/project-runtime/stage-check-receipt"
import { createProjectTemplate } from "./project-template"

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})
function fixture(mode: "valid" | "changed" | "unconfirmed" = "valid") {
  const root = mkdtempSync(join(tmpdir(), "creator-legacy-evidence-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, "report.md"), "checked")
  const receipt: StageCheckReceipt = {
    apiVersion: "devclaw.stage-check/v1",
    nodeId: "review",
    checkId: "postcheck",
    contractDigest: "a".repeat(64),
    outcome: "passed",
    artifacts: [{ id: "report", path: "report.md", digest: runtimeDigest("checked") }]
  }
  let admitted = true
  const transition = vi.fn<CreatorLegacyTrialEvidenceOwner["transition"]>(async (input) => {
    if (mode === "changed") writeFileSync(join(root, "report.md"), "changed after check")
    await input.validateReceipts([receipt])
    if (mode === "unconfirmed") throw Error("state commit uncertain")
    return { status: "committed", stateDigest: "c".repeat(64), receipts: [receipt] }
  })
  const owner: CreatorLegacyTrialEvidenceOwner = {
    trialId: "creator-business-trial:owner",
    featureId: "feature",
    runId: "native-run",
    workspace: root,
    packageDigest: "b".repeat(64),
    assertCurrent: () => {
      if (!admitted) throw Error("owner revoked")
    },
    assertHook: () => {},
    transition
  }
  const changed = vi.fn()
  const values = new Map<string, string>()
  const settings = {
    getSetting: (key: string, fallback = "") => values.get(key) ?? fallback,
    compareAndSetSetting: (key: string, before: string | undefined, value: string) => {
      if (values.get(key) !== before) return false
      values.set(key, value)
      return true
    }
  }
  const evidence = new CreatorLegacyTrialEvidence(root, {
    settings,
    owner: (binding) =>
      admitted &&
      binding.projectId === owner.trialId &&
      binding.packageDigest === owner.packageDigest
        ? owner
        : undefined,
    changed
  })
  cleanup.push(() => evidence.close())
  evidence.freeze(owner.trialId, owner.featureId, [
    {
      nodeId: "review",
      checkId: "postcheck",
      contractDigest: receipt.contractDigest,
      artifacts: [{ id: "report", path: "report.md" }]
    }
  ])
  const binding = {
    mode: "legacy" as const,
    threadId: "stage-thread",
    incarnationKey: "incarnation",
    projectId: owner.trialId,
    featureId: owner.featureId,
    operationId: owner.trialId,
    workspace: root,
    packageDigest: owner.packageDigest,
    stageId: "review",
    plugin: { id: owner.trialId, path: root } as PluginMetadata
  }
  return {
    root,
    evidence,
    owner,
    binding,
    transition,
    changed,
    settings,
    revoke: () => {
      admitted = false
    }
  }
}

it("records genuine native checkpoint evidence, retains original run/thread identity and never repeats its commit", async () => {
  const f = fixture()
  await withRuntimePluginSource(issueRuntimePluginSourceToken(f.binding), async () => {
    expect(projectCheckpointAvailable()).toBe(true)
    const input = { checkpoint: "review_done", expectedStateDigest: "d".repeat(64) }
    expect((await executeProjectCheckpoint(input)).status).toBe("committed")
    expect((await executeProjectCheckpoint(input)).status).toBe("committed")
    expect(f.transition).toHaveBeenCalledTimes(1)
  })
  expect(f.evidence.read(f.owner.trialId, "feature").receipts).toMatchObject([
    {
      runId: f.owner.trialId,
      engineRunId: "native-run",
      threadId: "stage-thread",
      incarnationKey: "incarnation",
      packageDigest: f.owner.packageDigest,
      hookId: "host:project_checkpoint",
      receipt: { outcome: "passed" }
    }
  ])
})

it.each(["changed", "unconfirmed"] as const)(
  "keeps %s checkpoint results unknown without storing PASS or replaying effects",
  async (mode) => {
    const f = fixture(mode)
    await withRuntimePluginSource(issueRuntimePluginSourceToken(f.binding), async () => {
      const input = { checkpoint: "review_done", expectedStateDigest: "d".repeat(64) }
      await expect(executeProjectCheckpoint(input)).rejects.toThrow()
      expect((await executeProjectCheckpoint(input)).status).toBe("unknown")
      expect(f.transition).toHaveBeenCalledTimes(1)
    })
    expect(f.evidence.read(f.owner.trialId, "feature").receipts).toEqual([])
  }
)

it("requires the registered exact owner, rather than the creator project prefix, to admit checkpoints", async () => {
  const f = fixture()
  await withRuntimePluginSource(
    issueRuntimePluginSourceToken({ ...f.binding, projectId: "creator-business-trial:another" }),
    async () => {
      expect(projectCheckpointAvailable()).toBe(false)
      await expect(
        executeProjectCheckpoint({ checkpoint: "review_done", expectedStateDigest: "d".repeat(64) })
      ).rejects.toThrow("UNAVAILABLE")
    }
  )
  f.revoke()
  await withRuntimePluginSource(issueRuntimePluginSourceToken(f.binding), async () => {
    expect(projectCheckpointAvailable()).toBe(false)
  })
  expect(f.transition).not.toHaveBeenCalled()
})

it("persists the admitted source declaration for readback without trusting a later package file or restoring execution", () => {
  const f = fixture()
  const source = createProjectTemplate({ packageId: "observed-source", name: "Source" })
  const manifest = JSON.parse(
    source.files.find((file) => file.path === "devclaw.project-runtime.json")!.text
  )
  f.evidence.freezeSource(f.owner.trialId, "feature", f.owner.packageDigest, manifest)
  const readback = new CreatorLegacyTrialEvidence(f.root, {
    settings: f.settings,
    owner: () => undefined,
    changed: () => {}
  })
  cleanup.push(() => readback.close())
  expect(readback.source(f.owner.trialId, "feature", f.owner.packageDigest)).toEqual(manifest)
  expect(() => readback.source(f.owner.trialId, "feature", "c".repeat(64))).toThrow(
    "SOURCE_CHANGED"
  )
  expect(() =>
    readback.freezeSource(f.owner.trialId, "feature", f.owner.packageDigest, {
      ...manifest,
      plugin: { ...manifest.plugin, version: "2.0.0" }
    })
  ).toThrow("SOURCE_CHANGED")
})
