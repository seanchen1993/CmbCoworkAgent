import { expect, expectTypeOf, it } from "vitest"
import {
  FUNCTION_MANAGER_CATALOG_DISPOSE_METHODS,
  FUNCTION_MANAGER_CATALOG_METHODS,
  FUNCTION_MANAGER_ENTRY_POLICIES,
  FUNCTION_MANAGER_OPERATION_METHODS,
  type FunctionManagerMethod
} from "./function-manager-entry-policy"

it("requires an explicit policy for every public callable at type-check time", () => {
  expectTypeOf<
    keyof typeof FUNCTION_MANAGER_ENTRY_POLICIES
  >().toEqualTypeOf<FunctionManagerMethod>()
})

it("preserves quiet discovery, immediate revoke and cleanup contracts", () => {
  expect(FUNCTION_MANAGER_ENTRY_POLICIES.status).toEqual({ operation: "direct", catalog: "guard" })
  for (const name of [
    "revoke",
    "close",
    "closeThread",
    "invalidate",
    "setDisplayProjectionEnabled"
  ] as const)
    expect(FUNCTION_MANAGER_ENTRY_POLICIES[name]).toEqual({
      operation: "direct",
      catalog: "direct"
    })
  expect(FUNCTION_MANAGER_ENTRY_POLICIES.effectiveStatus).toEqual({
    operation: "retain",
    catalog: "guard"
  })
  expect(FUNCTION_MANAGER_ENTRY_POLICIES.siteRead).toEqual({
    operation: "retain",
    catalog: "guard"
  })
  expect(FUNCTION_MANAGER_ENTRY_POLICIES.turnStep).toEqual({
    operation: "apply-before",
    catalog: "guard"
  })
  expect(FUNCTION_MANAGER_ENTRY_POLICIES.turnComplete).toEqual({
    operation: "terminal",
    catalog: "guard"
  })
})

it("retains exactly the original operation/catalog/flow-disposal admission sets", () => {
  expect([...FUNCTION_MANAGER_OPERATION_METHODS].sort()).toEqual(
    [
      "commands",
      "interceptTool",
      "offerAgent",
      "receivePeer",
      "presentationEvent",
      "classicEvent",
      "turnStart",
      "turnStep",
      "prepareFlowScope",
      "registeredTools",
      "prepareAction",
      "runAction",
      "runCommand",
      "configList",
      "configSet",
      "userConfig",
      "saveUserConfig",
      "saveSensitiveUserConfig",
      "migrateUserConfig",
      "runtimeReady",
      "effectiveStatus",
      "inspectCheckpointRecovery",
      "advanceAutobizCheckpoint",
      "completionGate",
      "measure",
      "turnComplete",
      "turnNotices",
      "interceptToolCheck",
      "hasEventHandler",
      "logs",
      "feedback",
      "feedbackPresentation",
      "panes",
      "placedRows",
      "placedRead",
      "placedAct",
      "placedDismiss",
      "placedRelease",
      "focusAck",
      "scrollAck",
      "act",
      "siteMount",
      "siteMountOutcome",
      "siteRead",
      "siteRender",
      "siteUnmount",
      "siteAct",
      "clientAct",
      "actionCatalog",
      "markdownLink",
      "appendConversation"
    ].sort()
  )
  expect([...FUNCTION_MANAGER_CATALOG_METHODS].sort()).toEqual(
    [
      "configList",
      "configSet",
      "userConfig",
      "saveUserConfig",
      "saveSensitiveUserConfig",
      "migrateUserConfig",
      "pickUserConfigPath",
      "applyUserConfig",
      "reloadUserConfig",
      "releaseRuntimeSession",
      "resumeRuntimeSession",
      "runtimeReady",
      "effectiveStatus",
      "status",
      "checkCompatibility",
      "approve",
      "appendConversation",
      "independentModelPrompt",
      "commands",
      "inspectCheckpointRecovery",
      "advanceAutobizCheckpoint",
      "interceptTool",
      "offerAgent",
      "receivePeer",
      "presentationEvent",
      "classicEvent",
      "turnStart",
      "turnStep",
      "prepareFlowScope",
      "completionGate",
      "measure",
      "turnComplete",
      "turnNotices",
      "registeredTools",
      "interceptToolCheck",
      "hasEventHandler",
      "logs",
      "feedback",
      "feedbackPresentation",
      "panes",
      "clearPlacedRows",
      "markdownLink",
      "focusAck",
      "scrollAck",
      "act",
      "siteMount",
      "siteMountOutcome",
      "siteRead",
      "siteRender",
      "siteUnmount",
      "siteAct",
      "clientAct",
      "actionCatalog",
      "prepareAction",
      "runAction",
      "runCommand"
    ].sort()
  )
  expect(FUNCTION_MANAGER_CATALOG_DISPOSE_METHODS).toEqual(["prepareFlowScope"])
  expect(
    FUNCTION_MANAGER_OPERATION_METHODS.filter(
      (name) => FUNCTION_MANAGER_ENTRY_POLICIES[name].operation === "apply-before"
    ).sort()
  ).toEqual([
    "classicEvent",
    "commands",
    "interceptTool",
    "offerAgent",
    "prepareAction",
    "prepareFlowScope",
    "presentationEvent",
    "receivePeer",
    "registeredTools",
    "runAction",
    "runCommand",
    "turnStart",
    "turnStep"
  ])
})

it("does not expose mutable policy or classification arrays to other native modules", () => {
  expect(Object.isFrozen(FUNCTION_MANAGER_ENTRY_POLICIES)).toBe(true)
  expect(Object.values(FUNCTION_MANAGER_ENTRY_POLICIES).every(Object.isFrozen)).toBe(true)
  expect(Object.isFrozen(FUNCTION_MANAGER_OPERATION_METHODS)).toBe(true)
  expect(Object.isFrozen(FUNCTION_MANAGER_CATALOG_METHODS)).toBe(true)
  expect(Object.isFrozen(FUNCTION_MANAGER_CATALOG_DISPOSE_METHODS)).toBe(true)
})
