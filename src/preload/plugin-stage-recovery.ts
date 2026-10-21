import type { PluginStageRecoveryApi } from "../shared/mods/plugin-stage-recovery"

export function createPluginStageRecoveryBridge(
  invoke: (channel: string, input: unknown) => Promise<unknown>
): PluginStageRecoveryApi {
  const prefix = "mods:development:plugin-stage-recovery"
  return {
    inspect: (input) =>
      invoke(`${prefix}:inspect`, input) as ReturnType<PluginStageRecoveryApi["inspect"]>,
    latest: (input) =>
      invoke(`${prefix}:latest`, input) as ReturnType<PluginStageRecoveryApi["latest"]>,
    prepare: (input) =>
      invoke(`${prefix}:prepare`, input) as ReturnType<PluginStageRecoveryApi["prepare"]>,
    apply: (input) =>
      invoke(`${prefix}:apply`, input) as ReturnType<PluginStageRecoveryApi["apply"]>,
    reconcile: (input) =>
      invoke(`${prefix}:reconcile`, input) as ReturnType<PluginStageRecoveryApi["reconcile"]>
  }
}
