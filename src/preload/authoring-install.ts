import type { AuthoringInstallApi } from "../shared/mods/authoring-install"

export function createAuthoringInstallBridge(
  invoke: (channel: string, input: unknown) => Promise<unknown>
): AuthoringInstallApi {
  return {
    inspectRetention: (input) =>
      invoke("mods:authoring-install:inspect-retention", input) as ReturnType<
        AuthoringInstallApi["inspectRetention"]
      >,
    retireVersions: (input) =>
      invoke("mods:authoring-install:retire-versions", input) as ReturnType<
        AuthoringInstallApi["retireVersions"]
      >,
    resolveInstalled: (input) =>
      invoke("mods:authoring-install:resolve-installed", input) as ReturnType<
        AuthoringInstallApi["resolveInstalled"]
      >,
    inspectPreparation: (input) =>
      invoke("mods:authoring-install:inspect-preparation", input) as ReturnType<
        AuthoringInstallApi["inspectPreparation"]
      >,
    recoverPreparation: (input) =>
      invoke("mods:authoring-install:recover-preparation", input) as ReturnType<
        AuthoringInstallApi["recoverPreparation"]
      >,
    inspectUncertain: (input) =>
      invoke("mods:authoring-install:inspect-uncertain", input) as ReturnType<
        AuthoringInstallApi["inspectUncertain"]
      >,
    reconcile: (input) =>
      invoke("mods:authoring-install:reconcile", input) as ReturnType<
        AuthoringInstallApi["reconcile"]
      >,
    list: (input) =>
      invoke("mods:authoring-install:list", input) as ReturnType<AuthoringInstallApi["list"]>,
    prepare: (input) =>
      invoke("mods:authoring-install:prepare", input) as ReturnType<AuthoringInstallApi["prepare"]>,
    rollbackPrepare: (input) =>
      invoke("mods:authoring-install:rollback-prepare", input) as ReturnType<
        AuthoringInstallApi["rollbackPrepare"]
      >,
    apply: (input) =>
      invoke("mods:authoring-install:apply", input) as ReturnType<AuthoringInstallApi["apply"]>,
    cancel: (input) =>
      invoke("mods:authoring-install:cancel", input) as ReturnType<AuthoringInstallApi["cancel"]>
  }
}
