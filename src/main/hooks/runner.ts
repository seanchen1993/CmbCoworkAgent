import { getHookLoggingConfig, getUserInfo } from "../storage"
import { getAvailableModelConfigOrDefault, getModelConfigByRef } from "../models/registry"
import { persistHookResultRecord } from "./log-record"
import { trackEvent } from "../services/event-reporter"
import { runHooksCore } from "./runner-core"
import { withHookRunnerServices } from "./runner-services"

export * from "./runner-core"

/** Desktop adapter. Event matching, parsing and decision aggregation are shared
 * with headless execution; desktop settings/telemetry remain owned here. */
export function runHooks(
  ...args: Parameters<typeof runHooksCore>
): ReturnType<typeof runHooksCore> {
  return withHookRunnerServices(
    {
      getHookLoggingConfig,
      getUserInfo,
      getAvailableModelConfigOrDefault,
      getModelConfigByRef,
      persistHookResultRecord,
      trackEvent
    },
    () => runHooksCore(...args)
  )
}
