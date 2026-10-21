import { expect, it, vi } from "vitest"
import { createPluginStageRecoveryBridge } from "./plugin-stage-recovery"

it("forwards exact native recovery requests without granting consent, inventing scope or sending model messages", async () => {
  const invoke = vi.fn<(channel: string, input: unknown) => Promise<unknown>>(async () => undefined)
  const bridge = createPluginStageRecoveryBridge(invoke)
  const caller = { threadId: "creator", expectedWorkspace: "native-workspace" }
  const source = { ...caller, trialId: "creator-business-trial:id" }
  const prepare = {
    ...source,
    stageId: "draft",
    stateMode: "target_in_progress" as const,
    expectedPackageDigest: "a".repeat(64),
    expectedAdapterDigest: "b".repeat(64),
    expectedInputsDigest: "c".repeat(64),
    allowNetworkSideEffects: true as const
  }
  const operation = { ...caller, preparationId: "id", expectedDigest: "d".repeat(64) }
  await bridge.inspect(source)
  await bridge.latest(source)
  await bridge.prepare(prepare)
  await bridge.apply({ ...operation, allowNetworkSideEffects: true })
  await bridge.reconcile(operation)
  await bridge.reconcile({ ...operation, allowNetworkSideEffects: true })
  expect(invoke.mock.calls).toEqual([
    ["mods:development:plugin-stage-recovery:inspect", source],
    ["mods:development:plugin-stage-recovery:latest", source],
    ["mods:development:plugin-stage-recovery:prepare", prepare],
    [
      "mods:development:plugin-stage-recovery:apply",
      { ...operation, allowNetworkSideEffects: true }
    ],
    ["mods:development:plugin-stage-recovery:reconcile", operation],
    [
      "mods:development:plugin-stage-recovery:reconcile",
      { ...operation, allowNetworkSideEffects: true }
    ]
  ])
  expect(Object.keys(bridge).sort()).toEqual(["apply", "inspect", "latest", "prepare", "reconcile"])
  invoke.mockRejectedValueOnce(Error("FRESH_APPROVAL_REQUIRED"))
  await expect(bridge.prepare(prepare)).rejects.toThrow("FRESH_APPROVAL_REQUIRED")
  expect(invoke).toHaveBeenCalledTimes(7)
})
