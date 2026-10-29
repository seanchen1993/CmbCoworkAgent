import { ModFunctionError, type FunctionGuest } from "../../../shared/mods/v2/contracts"

/** A locked provider can serve public actions without joining any ambient event chain. */
export function actionOnlyFunctionGuest(guest: FunctionGuest): FunctionGuest {
  const registrations = guest.registrations.filter(item => item.platformCapability).map(item => {
    const descriptor = structuredClone(item.platformCapability!)
    // Presentation can install native surfaces/behaviors; public actions need neither.
    delete descriptor.presentation
    return { ...item, pattern: "native.locked-action", platformCapability: descriptor }
  })
  const ids = new Set(registrations.map(item => item.id))
  return new Proxy(guest, {
    get(target, property) {
      if (property === "registrations") return registrations
      if (property === "matches") return () => false
      if (property === "invoke") return (...args: Parameters<FunctionGuest["invoke"]>) => {
        if (!args[3].resourceCallback && (!ids.has(args[0]) || args[3].event !== "platform.action"))
          return Promise.reject(new ModFunctionError("PROJECT_ACTION_SOURCE_EVENT_DENIED"))
        return target.invoke(...args)
      }
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    }
  })
}
