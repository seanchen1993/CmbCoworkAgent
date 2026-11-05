import { describe, expect, it } from "vitest"
import {
  resolveContextUsageRatio,
  resolveManagedRunDecision,
  resolveProviderRetryPlan
} from "./managed-run-policy"
import type {
  ManagedFeatureStatusSnapshot,
  ManagedRunSnapshot
} from "../../shared/harness-board-types"

const baseRun: ManagedRunSnapshot = {
  version: 2.5,
  runId: "mr_test",
  projectId: "project-1",
  featureId: "feature-1",
  status: "running",
  providerRetryCount: 0,
  startedAt: "2026-08-24 10:00:00",
  updatedAt: "2026-08-24 10:00:00"
}

const currentFeatureStateHash = `v1:sha256:${"a".repeat(64)}`
const currentNextActionHash = `v1:sha256:${"b".repeat(64)}`
const previousFeatureStateHash = `v1:sha256:${"c".repeat(64)}`
const previousNextActionHash = `v1:sha256:${"d".repeat(64)}`

const feature: ManagedFeatureStatusSnapshot = {
  featureStatus: "in_progress",
  currentNodeId: "dev.plan",
  currentNodeStatus: "in_progress",
  isFinalNode: false,
  nextAction: { slashSkill: "dev-plan", userMessage: "继续计划" },
  featureStateHash: currentFeatureStateHash,
  nextActionHash: currentNextActionHash
}

function runWithBaseline(overrides: Partial<ManagedRunSnapshot> = {}): ManagedRunSnapshot {
  return {
    ...baseRun,
    currentSession: {
      threadId: "thread-1"
    },
    decisionBaseline: {
      nodeId: feature.currentNodeId,
      featureStateHash: previousFeatureStateHash,
      featureStatus: "in_progress",
      nodeStatus: "in_progress",
      nextActionHash: previousNextActionHash
    },
    ...overrides
  }
}

const successTerminal = {
  outcome: "success" as const,
  endReason: { code: "normal" as const }
}

describe("resolveManagedRunDecision", () => {
  it("returns a terminal decision when the local provider retry budget is exhausted", () => {
    expect(
      resolveManagedRunDecision({
        run: runWithBaseline({ providerRetryCount: 3, totalRetryCount: 3 }),
        feature: {
          ...feature,
          isFinalNode: true,
          featureStatus: "done",
          currentNodeStatus: "done"
        },
        terminal: { outcome: "error", endReason: { code: "provider_error", retryable: true } }
      }).policyResult
    ).toMatchObject({
      proposedAction: "fail_managed_run",
      reasonCode: "provider_retry_limit_exceeded"
    })
  })

  it.each([0, 5])(
    "does not complete a final feature after a transient model error, retries=%s",
    (totalRetryCount) => {
      const decision = resolveManagedRunDecision({
        run: runWithBaseline({ totalRetryCount }),
        feature: {
          ...feature,
          isFinalNode: true,
          featureStatus: "done",
          currentNodeStatus: "done"
        },
        terminal: { outcome: "error", endReason: { code: "provider_error", retryable: true } }
      })
      expect(decision.policyResult.proposedAction).toBe(
        totalRetryCount === 5 ? "fail_managed_run" : "schedule_provider_retry"
      )
    }
  )

  it("does not hide a non-provider execution failure behind the feature terminal state", () => {
    expect(
      resolveManagedRunDecision({
        run: runWithBaseline(),
        feature: {
          ...feature,
          isFinalNode: true,
          featureStatus: "done",
          currentNodeStatus: "done"
        },
        terminal: {
          outcome: "error",
          endReason: { code: "unknown", message: "Agent turn ended without a terminal outcome" }
        }
      }).policyResult.reasonCode
    ).toBe("agent_error")
  })

  it("retains bounded retry behavior for older terminal events without retryable metadata", () => {
    const terminal = { outcome: "error" as const, endReason: { code: "provider_error" as const } }
    expect(
      resolveManagedRunDecision({ run: runWithBaseline(), feature, terminal }).policyResult.type
    ).toBe("provider_retry")
    expect(
      resolveManagedRunDecision({ run: runWithBaseline({ totalRetryCount: 5 }), feature, terminal })
        .policyResult.reasonCode
    ).toBe("total_retry_limit_exceeded")
  })

  it.each(["done", "archived", "skipped"] as const)(
    "never advances a completed stage after a provider error: %s",
    (currentNodeStatus) => {
      for (const retryable of [true, false]) {
        const decision = resolveManagedRunDecision({
          run: runWithBaseline(),
          feature: { ...feature, currentNodeStatus },
          terminal: {
            outcome: "error",
            endReason: { code: "provider_error", retryable, message: "当前时段不允许调用该接口" }
          }
        })
        expect(decision.policyResult.proposedAction).toBe(
          retryable ? "schedule_provider_retry" : "fail_managed_run"
        )
      }
    }
  )

  it("handles a non-retryable model error before even a changed or final stage", () => {
    const decision = resolveManagedRunDecision({
      run: runWithBaseline(),
      feature: {
        ...feature,
        currentNodeId: "final",
        isFinalNode: true,
        featureStatus: "done",
        currentNodeStatus: "done"
      },
      terminal: { outcome: "error", endReason: { code: "provider_error", retryable: false } }
    })
    expect(decision.policyResult.reasonCode).toBe("provider_error_not_retryable")
  })

  it("retries a transient model failure in the same thread even when the stage changed", () => {
    expect(
      resolveManagedRunDecision({
        run: runWithBaseline(),
        feature: { ...feature, currentNodeId: "dev.code" },
        terminal: { outcome: "error", endReason: { code: "provider_error", retryable: true } }
      }).policyResult.type
    ).toBe("provider_retry")
  })

  it("does not count changes between completed states as normal progress", () => {
    const run = runWithBaseline()
    run.decisionBaseline!.nodeStatus = "done"
    expect(
      resolveManagedRunDecision({
        run,
        feature: { ...feature, currentNodeStatus: "archived" },
        terminal: successTerminal
      }).policyResult.type
    ).toBe("biz_retry")
  })

  it.each(["provider", "business"])("bounds cumulative %s retries at five", (kind) => {
    const terminal =
      kind === "provider"
        ? {
            outcome: "error" as const,
            endReason: { code: "provider_error" as const, retryable: true }
          }
        : successTerminal
    const allowed = resolveManagedRunDecision({
      run: runWithBaseline({ totalRetryCount: 4 }),
      feature,
      terminal
    })
    expect(allowed.policyResult.proposedAction).not.toBe("fail_managed_run")
    const blocked = resolveManagedRunDecision({
      run: runWithBaseline({ totalRetryCount: 5 }),
      feature,
      terminal
    })
    expect(blocked.policyResult).toMatchObject({
      proposedAction: "fail_managed_run",
      reasonCode: "total_retry_limit_exceeded"
    })
  })

  it("allows genuine progress and completion after the retry budget has been used", () => {
    const run = runWithBaseline({ totalRetryCount: 5 })
    expect(
      resolveManagedRunDecision({
        run,
        feature: { ...feature, currentNodeId: "dev.code" },
        terminal: successTerminal
      }).policyResult.type
    ).toBe("biz_progress")
    expect(
      resolveManagedRunDecision({
        run,
        feature: {
          ...feature,
          isFinalNode: true,
          featureStatus: "done",
          currentNodeStatus: "done"
        },
        terminal: successTerminal
      }).policyResult.proposedAction
    ).toBe("complete_managed_run")
  })

  it("uses bounded provider retry backoff", () => {
    expect(resolveProviderRetryPlan(0)).toEqual({ retryNumber: 1, delayMs: 5_000 })
    expect(resolveProviderRetryPlan(1)).toEqual({ retryNumber: 2, delayMs: 30_000 })
    expect(resolveProviderRetryPlan(2)).toEqual({ retryNumber: 3, delayMs: 120_000 })
    expect(resolveProviderRetryPlan(3)).toBeNull()
    expect(
      resolveManagedRunDecision({
        run: runWithBaseline({ providerRetryCount: 2 }),
        feature,
        terminal: { outcome: "error", endReason: { code: "provider_error", retryable: true } }
      }).providerRetryPlan
    ).toEqual({ retryNumber: 3, delayMs: 120_000 })
  })

  it("calculates reusable context only from valid token limits", () => {
    expect(resolveContextUsageRatio({ inputTokens: 90, maxTokens: 100 })).toBe(0.9)
    expect(resolveContextUsageRatio({ inputTokens: 91, maxTokens: 100 })).toBe(0.91)
    expect(resolveContextUsageRatio({ inputTokens: 1, maxTokens: 0 })).toBeUndefined()
    expect(resolveContextUsageRatio(undefined)).toBeUndefined()
  })

  it("requires nextAction only when creating a new Thread", () => {
    expect(
      resolveManagedRunDecision({
        run: baseRun,
        feature: { ...feature, nextAction: undefined }
      })
    ).toMatchObject({
      policyResult: {
        type: "run_termination",
        proposedAction: "fail_managed_run",
        reasonCode: "next_action_missing_slash_skill"
      }
    })

    expect(
      resolveManagedRunDecision({
        run: runWithBaseline(),
        feature: { ...feature, nextAction: undefined },
        terminal: successTerminal
      })
    ).toMatchObject({
      policyResult: {
        type: "biz_retry",
        proposedAction: "continue_current_thread",
        reasonCode: "biz_retry_progress_detected"
      }
    })
  })

  it("advances for a new node or when the node enters a completed-like status", () => {
    expect(
      resolveManagedRunDecision({
        run: runWithBaseline(),
        feature: { ...feature, currentNodeId: "dev.code" },
        terminal: successTerminal
      })
    ).toMatchObject({
      policyResult: {
        type: "biz_progress",
        proposedAction: "start_new_thread",
        reasonCode: "current_node_changed"
      }
    })

    for (const currentNodeStatus of ["done", "archived", "skipped"] as const) {
      expect(
        resolveManagedRunDecision({
          run: runWithBaseline(),
          feature: { ...feature, currentNodeStatus },
          terminal: successTerminal
        })
      ).toMatchObject({
        policyResult: {
          type: "biz_progress",
          proposedAction: "start_new_thread",
          reasonCode: "current_node_completed"
        }
      })
    }
  })

  it("uses Biz Retry when a successful session leaves the completed node state unchanged", () => {
    const completedFeature = { ...feature, currentNodeStatus: "done" as const }
    const baseline = runWithBaseline().decisionBaseline!

    expect(
      resolveManagedRunDecision({
        run: runWithBaseline({
          decisionBaseline: {
            ...baseline,
            nodeStatus: completedFeature.currentNodeStatus,
            featureStateHash: completedFeature.featureStateHash,
            nextActionHash: completedFeature.nextActionHash
          }
        }),
        feature: completedFeature,
        terminal: successTerminal
      })
    ).toMatchObject({
      policyResult: {
        type: "biz_retry",
        proposedAction: "start_new_thread",
        reasonCode: "biz_retry_no_progress"
      }
    })
  })

  it("forces a new Thread when context usage exceeds 90 percent", () => {
    expect(
      resolveManagedRunDecision({
        run: runWithBaseline(),
        feature,
        terminal: {
          ...successTerminal,
          contextUsage: { inputTokens: 901, maxTokens: 1000 }
        }
      })
    ).toMatchObject({
      policyResult: {
        type: "biz_retry",
        proposedAction: "start_new_thread",
        reasonCode: "biz_retry_context_limit"
      }
    })
  })

  it("uses a new Thread for no progress and reuses the Thread when progress is detected", () => {
    expect(
      resolveManagedRunDecision({
        run: runWithBaseline({
          decisionBaseline: {
            ...runWithBaseline().decisionBaseline!,
            featureStateHash: feature.featureStateHash
          }
        }),
        feature,
        terminal: {
          ...successTerminal,
          contextUsage: { inputTokens: 900, maxTokens: 1000 }
        }
      })
    ).toMatchObject({
      policyResult: {
        type: "biz_retry",
        proposedAction: "start_new_thread",
        reasonCode: "biz_retry_no_progress"
      }
    })

    expect(
      resolveManagedRunDecision({
        run: runWithBaseline(),
        feature,
        terminal: successTerminal
      })
    ).toMatchObject({
      policyResult: {
        type: "biz_retry",
        proposedAction: "continue_current_thread",
        reasonCode: "biz_retry_progress_detected"
      }
    })
  })

  it("keeps Provider Retry on the current Thread regardless of context usage", () => {
    expect(
      resolveManagedRunDecision({
        run: runWithBaseline(),
        feature,
        terminal: {
          outcome: "error",
          endReason: { code: "provider_error" },
          contextUsage: { inputTokens: 999, maxTokens: 1000 }
        }
      })
    ).toMatchObject({
      policyResult: {
        type: "provider_retry",
        proposedAction: "schedule_provider_retry",
        reasonCode: "provider_error"
      }
    })
  })
})
