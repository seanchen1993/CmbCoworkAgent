import type { ModObject } from "../../../shared/mods/types"
import { isFunctionDockedSite, type FunctionUiSite } from "../../../shared/mods/v2/sites"

/** Only a previously protected presentation may bridge these non-authority progress updates. */
export function retainsFunctionSitePresentation(
  component: FunctionUiSite,
  previousKey: string,
  next: ModObject
): boolean {
  const previous = JSON.parse(previousKey) as ModObject
  const same = (left: unknown, right: unknown): boolean =>
    JSON.stringify(left) === JSON.stringify(right)
  if (previousKey === JSON.stringify(next)) return false
  // Resize and scrolling change presentation geometry only. Keep the protected DOM inert
  // until the latest read completes; clearing it can reset scroll and amplify resize work.
  if (isFunctionDockedSite(component) &&
    Object.keys(previous).length === 4 && Object.keys(next).length === 4 &&
    ["isWorking", "bodyColumns", "maxRows", "offset"].every(key => Object.hasOwn(next, key)) &&
    typeof previous.isWorking === "boolean" && typeof next.isWorking === "boolean" &&
    [previous.bodyColumns, next.bodyColumns].every(value => typeof value === "number" &&
      Number.isSafeInteger(value) && value >= 1 && value <= 1000) &&
    [previous.maxRows, next.maxRows].every(value => typeof value === "number" &&
      Number.isSafeInteger(value) && value >= 1 && value <= 12) &&
    [previous.offset, next.offset].every(value => typeof value === "number" &&
      Number.isSafeInteger(value) && value >= 0 && value <= 100000)) return true
  if (component === "Spinner")
    return (
      Object.keys(previous).length === 4 &&
      Object.keys(next).length === 4 &&
      ["word", "message", "suffix", "mode"].every((key) => Object.hasOwn(next, key)) &&
      typeof previous.word === "string" &&
      typeof next.word === "string" &&
      typeof previous.mode === "string" &&
      typeof next.mode === "string" &&
      [previous.mode, next.mode].every((mode) =>
        ["requesting", "responding", "thinking", "tool-input", "tool-use"].includes(mode)
      ) &&
      same(previous.message, next.message) &&
      same(previous.suffix, next.suffix)
    )
  if (component === "ToolGroup") {
    if (
      Object.keys(previous).length !== 3 ||
      Object.keys(next).length !== 3 ||
      !["calls", "isActive", "isExpanded"].every((key) => Object.hasOwn(next, key)) ||
      typeof previous.isActive !== "boolean" ||
      typeof next.isActive !== "boolean" ||
      (!previous.isActive && next.isActive) ||
      previous.isExpanded !== next.isExpanded ||
      !Array.isArray(previous.calls) ||
      !Array.isArray(next.calls) ||
      !previous.calls.length ||
      previous.calls.length > next.calls.length
    )
      return false
    // Append-only groups retain just their previously protected rows. Every new ID
    // must be unique, and malformed/error/interrupted additions cannot bridge a read.
    const ids = new Set<string>()
    for (const value of next.calls) {
      const call = value as ModObject
      if (!call || typeof call !== "object" || Array.isArray(call) ||
        typeof call.tool_use_id !== "string" || !call.tool_use_id ||
        ids.has(call.tool_use_id) || typeof call.tool !== "string" || !call.tool ||
        typeof call.isRunning !== "boolean" || call.isErrored !== false ||
        call.isInterrupted !== false || !Object.hasOwn(call, "input") ||
        Object.keys(call).some(key => !["tool_use_id", "tool", "input", "isRunning",
          "isErrored", "isInterrupted", "output"].includes(key))) return false
      ids.add(call.tool_use_id)
    }
    return previous.calls.every((value, index) => {
      const old = value as ModObject,
        current = (next.calls as ModObject[])[index]
      if (
        !old ||
        !current ||
        Array.isArray(old) ||
        Array.isArray(current) ||
        typeof old !== "object" ||
        typeof current !== "object" ||
        typeof old.isRunning !== "boolean" ||
        typeof current.isRunning !== "boolean" ||
        (!old.isRunning && current.isRunning) ||
        typeof old.tool_use_id !== "string" ||
        !old.tool_use_id ||
        typeof old.tool !== "string" ||
        !old.tool ||
        [old, current].some((call) =>
          Object.keys(call).some(
            (key) =>
              ![
                "tool_use_id",
                "tool",
                "input",
                "isRunning",
                "isErrored",
                "isInterrupted",
                "output"
              ].includes(key)
          )
        ) ||
        old.isErrored !== false ||
        current.isErrored !== false ||
        old.isInterrupted !== false ||
        current.isInterrupted !== false
      )
        return false
      // The first result may arrive; replacing or withdrawing an existing result is not progress.
      if (Object.hasOwn(old, "output") && !same(old.output, current.output)) return false
      const stableKeys = Object.keys(old).filter((key) => key !== "isRunning" && key !== "output")
      return (
        stableKeys.length ===
          Object.keys(current).filter((key) => key !== "isRunning" && key !== "output").length &&
        stableKeys.every((key) => Object.hasOwn(current, key) && same(old[key], current[key]))
      )
    })
  }
  const field =
    isFunctionDockedSite(component)
      ? "isWorking"
      : component === "AssistantMessage"
        ? "text"
        : undefined
  if (
    !field ||
    Object.keys(previous).length !== Object.keys(next).length ||
    Object.keys(previous).some(
      (key) =>
        !Object.hasOwn(next, key) ||
        (key !== field && JSON.stringify(previous[key]) !== JSON.stringify(next[key]))
    )
  )
    return false
  if (field === "isWorking")
    return (
      typeof previous.isWorking === "boolean" &&
      typeof next.isWorking === "boolean" &&
      previous.isWorking !== next.isWorking
    )
  // A protected empty frame is also a valid prefix. Keep its captured renderer only;
  // new text still needs a protected read and old-input actions remain disabled.
  return (
    typeof previous.text === "string" &&
    typeof next.text === "string" &&
    next.text.length > previous.text.length &&
    next.text.startsWith(previous.text)
  )
}
