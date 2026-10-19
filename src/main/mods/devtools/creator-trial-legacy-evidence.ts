import { join } from "node:path"
import type {
  StageCheckContract,
  StageCheckReceipt
} from "../../../shared/project-runtime/stage-check-receipt"
import { canonicalStageCheckJson } from "../../../shared/project-runtime/stage-check-receipt"
import {
  parseProjectRuntimeManifest,
  type ProjectRuntimeManifest
} from "../../../shared/project-runtime"
import type { BusinessDraftSettings } from "./creator-business-draft"
import type { RuntimePluginSourceBinding } from "../../plugins/runtime-source-scope"
import { assertCurrentRuntimePluginSourceContent } from "../../plugins/runtime-source-scope"
import {
  registerStageCheckReceiptObserver,
  type StageCheckInvocation
} from "../../hooks/stage-check-receipts"
import { CompositionStageCheckStore } from "../../harness-board/project-runtime/composition-stage-check-store"
import {
  registerScopedProjectCheckpointProvider,
  type ProjectCheckpointInput,
  type ProjectCheckpointResult
} from "../../harness-board/project-runtime/project-checkpoint"

export interface CreatorLegacyTrialEvidenceOwner {
  trialId: string
  featureId: string
  runId: string
  workspace: string
  packageDigest: string
  assertCurrent(): void
  assertHook(hook: StageCheckInvocation["hook"]): void
  transition(
    input: ProjectCheckpointInput & {
      validateReceipts(receipts: StageCheckReceipt[]): Promise<void>
    }
  ): Promise<ProjectCheckpointResult>
}

/** Native observation/checkpoint plumbing shared by reviewed plugin adapters. It owns no model,
 * workflow, business validator, approval or source token. Unknown commits are never replayed. */
export class CreatorLegacyTrialEvidence {
  private readonly store: CompositionStageCheckStore
  private readonly stopObserver: () => void
  private readonly stopCheckpoint: () => void
  private readonly diagnostics = new Map<string, string>()
  private readonly sources = new Map<string, string>()

  constructor(
    root: string,
    private readonly deps: {
      settings?: BusinessDraftSettings
      owner(
        binding: Readonly<RuntimePluginSourceBinding>
      ): CreatorLegacyTrialEvidenceOwner | undefined
      canDescribe?(binding: Readonly<RuntimePluginSourceBinding>): boolean
      changed(trialId: string): void
    }
  ) {
    this.store = new CompositionStageCheckStore(join(root, "stage-checks.sqlite"))
    this.stopObserver = registerStageCheckReceiptObserver({
      available: (binding) => !!this.owner(binding),
      observe: async (invocation) => {
        const owner = this.owner(invocation.binding)
        if (!owner) throw Error("CREATOR_TRIAL_EVIDENCE_SCOPE_CHANGED")
        owner.assertCurrent()
        owner.assertHook(invocation.hook)
        await this.append(
          owner,
          invocation.binding,
          invocation.hookId,
          invocation.receipts,
          invocation.signal
        )
        this.changed(owner.trialId)
      },
      failed: (error, binding) => {
        this.diagnostics.set(
          binding.projectId,
          error instanceof Error
            ? error.message.slice(0, 1000)
            : "CREATOR_TRIAL_EVIDENCE_UNAVAILABLE"
        )
        this.changed(binding.projectId)
      }
    })
    this.stopCheckpoint = registerScopedProjectCheckpointProvider({
      available: (binding) => !!this.owner(binding),
      canDescribe: (binding) =>
        !!binding.featureId &&
        !!this.store.contracts(binding.projectId, binding.featureId) &&
        !!this.deps.canDescribe?.(binding),
      execute: async (binding, input) => {
        const owner = this.owner(binding)
        if (!owner) throw Error("CREATOR_TRIAL_EVIDENCE_SCOPE_CHANGED")
        owner.assertCurrent()
        const intent = this.store.beginTransition(
          owner.trialId,
          owner.featureId,
          input.checkpoint,
          input.expectedStateDigest
        )
        if (intent.prior) return intent.prior
        let validated: string | undefined
        try {
          const result = await owner.transition({
            ...input,
            validateReceipts: async (receipts) => {
              input.signal?.throwIfAborted()
              owner.assertCurrent()
              assertCurrentRuntimePluginSourceContent()
              if (receipts.length)
                await this.store.validateReceipts(
                  owner.workspace,
                  owner.trialId,
                  owner.featureId,
                  receipts,
                  input.signal
                )
              owner.assertCurrent()
              assertCurrentRuntimePluginSourceContent()
              validated = canonicalStageCheckJson(receipts)
            }
          })
          input.signal?.throwIfAborted()
          owner.assertCurrent()
          assertCurrentRuntimePluginSourceContent()
          if (result.status === "committed") {
            if (
              !/^[a-f0-9]{64}$/.test(result.stateDigest ?? "") ||
              validated === undefined ||
              canonicalStageCheckJson(result.receipts) !== validated
            )
              throw Error("CREATOR_TRIAL_EVIDENCE_ACK_MISMATCH")
            if (result.receipts.length)
              await this.append(
                owner,
                binding,
                "host:project_checkpoint",
                result.receipts,
                input.signal
              )
          } else if (result.receipts.length) throw Error("CREATOR_TRIAL_EVIDENCE_UNCOMMITTED")
          this.store.settleTransition(intent.id, result)
          this.changed(owner.trialId)
          return result
        } catch (error) {
          this.store.settleTransition(intent.id, {
            status: "unknown",
            receipts: [],
            message: "原阶段推进结果待核对，不会自动重放。"
          })
          throw error
        }
      }
    })
  }

  private owner(binding: Readonly<RuntimePluginSourceBinding>) {
    const owner = this.deps.owner(binding)
    return owner && this.store.contracts(owner.trialId, owner.featureId) ? owner : undefined
  }

  private changed(trialId: string) {
    try {
      this.deps.changed(trialId)
    } catch {
      /* A closed observer cannot change an already committed business result. */
    }
  }

  private async append(
    owner: CreatorLegacyTrialEvidenceOwner,
    binding: Readonly<RuntimePluginSourceBinding>,
    hookId: string,
    receipts: StageCheckReceipt[],
    signal?: AbortSignal
  ) {
    await this.store.append(
      owner.workspace,
      {
        runId: owner.trialId,
        unitId: owner.featureId,
        engineRunId: owner.runId,
        packageDigest: owner.packageDigest,
        threadId: binding.threadId,
        incarnationKey: binding.incarnationKey,
        hookId
      },
      receipts,
      {
        signal,
        assertCurrent: () => {
          owner.assertCurrent()
          assertCurrentRuntimePluginSourceContent()
          const current = this.deps.owner(binding)
          if (!current || current.runId !== owner.runId)
            throw Error("CREATOR_TRIAL_EVIDENCE_RUN_CHANGED")
        }
      }
    )
  }

  freeze(trialId: string, featureId: string, contracts: StageCheckContract[]) {
    this.store.freezeContracts(trialId, featureId, contracts)
  }
  freezeSource(
    trialId: string,
    featureId: string,
    packageDigest: string,
    manifest: ProjectRuntimeManifest
  ) {
    const key = `mods-trial-observed-runtime-v1:${trialId}:${featureId}`
    const value = canonicalStageCheckJson({
      packageDigest,
      manifest: parseProjectRuntimeManifest(manifest)
    })
    if (Buffer.byteLength(value) > 256 * 1024) throw Error("CREATOR_TRIAL_SOURCE_LIMIT")
    const previous = this.deps.settings?.getSetting(key, "") || this.sources.get(key)
    if (previous && previous !== value) throw Error("CREATOR_TRIAL_SOURCE_CHANGED")
    if (
      !previous &&
      this.deps.settings &&
      !this.deps.settings.compareAndSetSetting(key, undefined, value)
    )
      throw Error("CREATOR_TRIAL_SOURCE_CHANGED")
    this.sources.set(key, value)
  }
  source(trialId: string, featureId: string, packageDigest: string) {
    const key = `mods-trial-observed-runtime-v1:${trialId}:${featureId}`
    const raw = this.deps.settings?.getSetting(key, "") || this.sources.get(key)
    if (!raw || Buffer.byteLength(raw) > 256 * 1024) return undefined
    const value = JSON.parse(raw)
    if (value?.packageDigest !== packageDigest) throw Error("CREATOR_TRIAL_SOURCE_CHANGED")
    return parseProjectRuntimeManifest(value.manifest)
  }
  read(trialId: string, featureId: string) {
    return {
      contracts: this.store.contracts(trialId, featureId),
      receipts: this.store.read(trialId, featureId),
      diagnostic: this.diagnostics.get(trialId)
    }
  }
  close() {
    this.stopCheckpoint()
    this.stopObserver()
    this.store.close()
  }
}
