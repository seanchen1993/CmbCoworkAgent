import type { DevelopmentApi } from "../shared/mods/development"
import { createNativeProjectSourceBridge } from "./native-project-source"

export function createDevelopmentBridge(
  invoke: (channel: string, input: unknown) => Promise<unknown>,
  subscribe: (channel: string, callback: (payload: unknown) => void) => () => void
): DevelopmentApi {
  return {
    businessTrial: {
      source: createNativeProjectSourceBridge(invoke, "mods:development:business-trial"),
      request: (input) =>
        invoke("mods:development:business-trial:request", input) as ReturnType<
          NonNullable<DevelopmentApi["businessTrial"]>["request"]
        >,
      prepare: (input) =>
        invoke("mods:development:business-trial:prepare", input) as ReturnType<
          NonNullable<DevelopmentApi["businessTrial"]>["prepare"]
        >,
      refresh: (input) =>
        invoke("mods:development:business-trial:refresh", input) as ReturnType<
          NonNullable<DevelopmentApi["businessTrial"]>["refresh"]
        >,
      context: (input) =>
        invoke("mods:development:business-trial:context", input) as ReturnType<
          NonNullable<DevelopmentApi["businessTrial"]>["context"]
        >,
      selectContext: (input) =>
        invoke("mods:development:business-trial:select-context", input) as ReturnType<
          NonNullable<DevelopmentApi["businessTrial"]>["selectContext"]
        >,
      start: (input) =>
        invoke("mods:development:business-trial:start", input) as ReturnType<
          NonNullable<DevelopmentApi["businessTrial"]>["start"]
        >,
      stop: (input) =>
        invoke("mods:development:business-trial:stop", input) as ReturnType<
          NonNullable<DevelopmentApi["businessTrial"]>["stop"]
        >,
      gates: (input) =>
        invoke("mods:development:business-trial:gates", input) as ReturnType<
          NonNullable<DevelopmentApi["businessTrial"]>["gates"]
        >,
      decideGate: (input) =>
        invoke("mods:development:business-trial:decide-gate", input) as ReturnType<
          NonNullable<DevelopmentApi["businessTrial"]>["decideGate"]
        >,
      feedback: (input) =>
        invoke("mods:development:business-trial:feedback", input) as ReturnType<
          NonNullable<DevelopmentApi["businessTrial"]>["feedback"]
        >
    },
    planningCatalog: (input) =>
      invoke("mods:development:planning-catalog", input) as ReturnType<
        NonNullable<DevelopmentApi["planningCatalog"]>
      >,
    selectPlanning: (input) =>
      invoke("mods:development:select-planning", input) as ReturnType<
        NonNullable<DevelopmentApi["selectPlanning"]>
      >,
    status: (input) =>
      invoke("mods:development:status", input) as ReturnType<DevelopmentApi["status"]>,
    setEnabled: (input) =>
      invoke("mods:development:set-enabled", input) as ReturnType<DevelopmentApi["setEnabled"]>,
    setMode: (input) =>
      invoke("mods:development:set-mode", input) as ReturnType<DevelopmentApi["setMode"]>,
    approve: (input) =>
      invoke("mods:development:approve", input) as ReturnType<DevelopmentApi["approve"]>,
    stop: (input) => invoke("mods:development:stop", input) as ReturnType<DevelopmentApi["stop"]>,
    promote: (input) =>
      invoke("mods:development:promote", input) as ReturnType<DevelopmentApi["promote"]>,
    requestReuse: (input) =>
      invoke("mods:development:request-reuse", input) as ReturnType<DevelopmentApi["requestReuse"]>,
    approveReuse: (input) =>
      invoke("mods:development:approve-reuse", input) as ReturnType<DevelopmentApi["approveReuse"]>,
    approveBusiness: (input) =>
      invoke("mods:development:approve-business", input) as ReturnType<
        DevelopmentApi["approveBusiness"]
      >,
    exportBusiness: (input) =>
      invoke("mods:development:export-business", input) as ReturnType<
        DevelopmentApi["exportBusiness"]
      >,
    reconcileBusiness: (input) =>
      invoke("mods:development:reconcile-business", input) as ReturnType<
        DevelopmentApi["reconcileBusiness"]
      >,
    undoComposition: (input) =>
      invoke("mods:development:undo-composition", input) as ReturnType<
        DevelopmentApi["undoComposition"]
      >,
    cancelComposition: (input) =>
      invoke("mods:development:cancel-composition", input) as ReturnType<
        DevelopmentApi["cancelComposition"]
      >,
    undoTrial: (input) =>
      invoke("mods:development:undo-trial", input) as ReturnType<DevelopmentApi["undoTrial"]>,
    onChanged: (callback) =>
      subscribe("mods:development-changed", (value) => {
        if (
          value &&
          typeof value === "object" &&
          "threadId" in value &&
          typeof value.threadId === "string"
        )
          callback({ threadId: value.threadId })
      })
  }
}
