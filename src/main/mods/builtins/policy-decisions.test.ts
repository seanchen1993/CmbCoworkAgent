import { afterEach, expect, it } from "vitest"
import {
  observeBuiltinPolicyDecision,
  readBuiltinPolicyDecisions,
  registerBuiltinPolicyScopeResolver
} from "./policy-decisions"
import type { ModAuditEntry } from "../../../shared/mods/types"
const scope = { threadId: "thread", workspace: "C:/Workspace", incarnationKey: "original" }
let close = () => {}
afterEach(() => close())
it("captures actual host decisions with fixed explanations and rejects stale scope", () => {
  let current = scope
  close = registerBuiltinPolicyScopeResolver(() => current)
  observeBuiltinPolicyDecision({
    ...scope,
    source: "hook",
    event: "PreSkillUse",
    decision: "deny",
    code: "HOOK_BLOCKED"
  })
  const result = readBuiltinPolicyDecisions(scope)
  expect(result.records[0]).toMatchObject({
    source: "hook",
    ruleId: "HOOK_BLOCKED",
    decision: "deny"
  })
  expect(result.records[0].nextStep).toContain("原会话")
  current = { ...scope, incarnationKey: "replacement" }
  expect(readBuiltinPolicyDecisions(scope).state).toBe("unavailable")
  expect(readBuiltinPolicyDecisions(current).records).toEqual([])
})
it("bounds retained decisions, replaces pending approval, and does not infer denial from failed audit", () => {
  close = registerBuiltinPolicyScopeResolver(() => scope)
  for (let i = 0; i < 110; i++)
    observeBuiltinPolicyDecision({
      ...scope,
      id: String(i),
      source: "hook",
      event: "PostToolUse",
      decision: "allow",
      code: "HOOK_ALLOWED"
    })
  expect(readBuiltinPolicyDecisions(scope).limited).toBe(true)
  expect(readBuiltinPolicyDecisions(scope).records).toHaveLength(100)
  observeBuiltinPolicyDecision({
    ...scope,
    id: "approval",
    source: "tool-approval",
    event: "approval",
    decision: "ask",
    code: "HUMAN_APPROVAL_PENDING"
  })
  observeBuiltinPolicyDecision({
    ...scope,
    id: "approval",
    source: "tool-approval",
    event: "approval",
    decision: "deny",
    code: "HUMAN_APPROVAL_DENIED"
  })
  expect(
    readBuiltinPolicyDecisions(scope).records.filter((row) => row.id === "tool-approval:approval")
  ).toHaveLength(1)
  const audit: ModAuditEntry = {
    cursor: 1,
    toolId: "fixture-tool",
    originalArgsHash: "b".repeat(64),
    finalArgsHash: "b".repeat(64),
    reconciliation: null,
    callId: "old",
    identity: {
      callId: "old",
      threadId: scope.threadId,
      workspace: scope.workspace,
      turnId: "turn",
      agentId: "agent",
      origin: "model",
      grantEpoch: 1
    },
    status: "failed",
    startedAt: 1,
    finishedAt: 2,
    ruleIds: [],
    publication: "published",
    policyDigest: null
  }
  expect(
    readBuiltinPolicyDecisions(scope, [audit]).records.some((row) => row.id.includes("old"))
  ).toBe(false)
})
it("only joins publication evidence to a current-incarnation observed call", () => {
  close = registerBuiltinPolicyScopeResolver(() => scope)
  observeBuiltinPolicyDecision({
    ...scope,
    id: "call",
    source: "managed-policy",
    event: "tool",
    decision: "allow",
    code: "MODS_POLICY_ALLOWED"
  })
  const audit: ModAuditEntry = {
    cursor: 1,
    toolId: "fixture-tool",
    originalArgsHash: "b".repeat(64),
    finalArgsHash: "b".repeat(64),
    reconciliation: null,
    callId: "call",
    identity: {
      callId: "call",
      threadId: scope.threadId,
      workspace: scope.workspace,
      turnId: "turn",
      agentId: "agent",
      origin: "model",
      grantEpoch: 1
    },
    status: "succeeded",
    ruleIds: ["baseline-v1"],
    publication: "blocked",
    policyDigest: "a".repeat(64),
    startedAt: 1,
    finishedAt: 2
  }
  expect(readBuiltinPolicyDecisions(scope, [audit]).records).toContainEqual(
    expect.objectContaining({ source: "publication", decision: "deny", ruleId: "baseline-v1" })
  )
})
