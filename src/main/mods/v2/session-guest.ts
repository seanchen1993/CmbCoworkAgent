import { aliasFunctionDisplayPreparation } from "./display-preparation"
import type { FunctionGuest, FunctionHostCall } from "../../../shared/mods/v2/contracts"
import type { FunctionSessionActivity } from "./session-activity"
import type { FunctionSessionInitializer } from "./session-initializer"
import { aliasFunctionUiResolveRuntime } from "./ui-resolve-runtime-binding"
import type { FunctionGuestExecutionFacts } from "./guest-execution-facts"

/** Covers late real host Promises even when the IPC proxy has already forgotten their calls. */
export function trackFunctionGuest(
  guest: FunctionGuest,
  activity: FunctionSessionActivity,
  initializer: FunctionSessionInitializer,
  fresh: <T>(run: () => Promise<T>) => Promise<T> = (run) => run(),
  facts?: FunctionGuestExecutionFacts
): FunctionGuest {
  const guarded = <T>(operation: () => Promise<T>): Promise<T> =>
    activity.run(operation).catch((error) => {
      initializer.record(error)
      throw error
    })
  const host =
    (call: FunctionHostCall): FunctionHostCall =>
    (...args) => {
      facts?.enterHostCall()
      return guarded(() => call(...args))
    }
  const tracked = new Proxy(guest, {
    get(target, property) {
      if (property === "matches")
        return (...args: Parameters<FunctionGuest["matches"]>) => {
          facts?.enterGuest()
          return guarded(() => Promise.resolve(target.matches(...args)))
        }
      if (property === "invoke")
        return (...args: Parameters<FunctionGuest["invoke"]>) => {
          facts?.enterGuest()
          return guarded(() => target.invoke(args[0], args[1], host(args[2]), args[3]))
        }
      if (property === "bindModuleHost") {
        if (!target.bindModuleHost) return undefined
        return (call: FunctionHostCall, onDispose?: () => void) =>
          target.bindModuleHost!((...args) => {
            facts?.enterHostCall()
            return args[0] === "prompt.submit.wait"
              ? fresh(() => activity.resource(() => call(...args)))
              : fresh(() => activity.fresh(() => host(call)(...args)))
          }, onDispose)
      }
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    }
  })
  aliasFunctionUiResolveRuntime(guest, tracked)
  aliasFunctionDisplayPreparation(guest, tracked)
  return tracked
}
