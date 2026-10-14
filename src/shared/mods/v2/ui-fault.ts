import type { ModObject } from "../types"
import { ModFunctionError } from "./contracts"
import { FUNCTION_UI_SITES } from "./sites"

export type FunctionUiFaultPhase = "load" | "render" | "run"

export function functionUiFaultReason(value: unknown): string {
  const reason = (typeof value === "string" ? value : "")
    // eslint-disable-next-line no-control-regex -- Remove controls from untrusted module text.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return reason
    ? reason.length > 200
      ? reason.slice(0, 199) + "…"
      : reason
    : "the module failed without a message"
}

export function validateFunctionUiFault(value: ModObject): void {
  const keys = ["surface", "component", "requestId", "element", "module", "phase", "reason"]
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    value.surface !== "desktop" ||
    (value.component !== "Pane" && !FUNCTION_UI_SITES.some((site) => site === value.component)) ||
    !["load", "render", "run"].includes(String(value.phase)) ||
    ["requestId", "element", "module"].some(
      (key) => typeof value[key] !== "string" || !value[key] || (value[key] as string).length > 1024
    ) ||
    typeof value.reason !== "string" ||
    !value.reason ||
    value.reason.length > 200 ||
    // eslint-disable-next-line no-control-regex -- Fault reasons are single-line untrusted text.
    /[\u0000-\u001f\u007f-\u009f]/.test(value.reason)
  )
    throw new ModFunctionError("MODS_UI_FAULT_INPUT")
}
