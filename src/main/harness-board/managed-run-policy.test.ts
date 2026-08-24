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
  version: 2,
  runId: "mr_test",
  projectId: "project-1",
  featureId: "feature-1",
  status: "running",
  providerRetryCount: 0,
  bizRetryCount: 0,
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
  it("uses bounded provider retry backoff", () => {
    expect(resolveProviderRetryPlan(0)).toEqual({ retryNumber: 1, delayMs: 5_000 })
    expect(resolveProviderRetryPlan(1)).toEqual({ retryNumber: 2, delayMs: 30_000 })
    expect(resolveProviderRetryPlan(2)).toEqual({ retryNumber: 3, delayMs: 120_000 })
    expect(resolveProviderRetryPlan(3)).toBeNull()
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
    ).toMatchObject({ decision: "fail", reasonCode: "next_action_missing_slash_skill" })

    expect(
      resolveManagedRunDecision({
        run: runWithBaseline(),
        feature: { ...feature, nextAction: undefined },
        terminal: successTerminal
      })
    ).toMatchObject({
      decision: "biz_retry_reuse_thread",
      reasonCode: "biz_retry_progress_detected"
    })
  })

  it("advances for a new node or a completed-like node status", () => {
    expect(
      resolveManagedRunDecision({
        run: runWithBaseline(),
        feature: { ...feature, currentNodeId: "dev.code" },
        terminal: successTerminal
      })
    ).toMatchObject({ decision: "advance", reasonCode: "current_node_changed" })

    for (const currentNodeStatus of ["done", "archived", "skipped"] as const) {
      expect(
        resolveManagedRunDecision({
          run: runWithBaseline(),
          feature: { ...feature, currentNodeStatus },
          terminal: successTerminal
        })
      ).toMatchObject({ decision: "advance", reasonCode: "current_node_completed" })
    }
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
      decision: "biz_retry_new_thread",
      reasonCode: "biz_retry_context_limit"
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
      decision: "biz_retry_new_thread",
      reasonCode: "biz_retry_no_progress"
    })

    expect(
      resolveManagedRunDecision({
        run: runWithBaseline(),
        feature,
        terminal: successTerminal
      })
    ).toMatchObject({
      decision: "biz_retry_reuse_thread",
      reasonCode: "biz_retry_progress_detected"
    })
  })

  it("fails before a fourth Biz Retry", () => {
    expect(
      resolveManagedRunDecision({
        run: runWithBaseline({ bizRetryCount: 3 }),
        feature,
        terminal: successTerminal
      })
    ).toMatchObject({
      decision: "fail",
      reasonCode: "biz_retry_limit_exceeded",
      summary: "当前任务重试超过限制次数"
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
    ).toMatchObject({ decision: "provider_retry", reasonCode: "provider_error" })
  })
})
