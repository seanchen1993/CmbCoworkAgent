import type { ModObject } from "../types"
import { encodeModJson } from "../validation"
import { isModObject, ModFunctionError } from "./contracts"
import { isFunctionPluginPromptOrigin } from "./plugin-prompt"

/** A routing boundary, never a grant or an increase to guest FunctionSite limits. */
export function functionMessageTextMode(text: string): "ordinary" | "host-message" {
  return text.length > 10000 || !text.trim() ? "host-message" : "ordinary"
}

/**
 * Main-only message publication schema. The original bounded ModJson transport
 * still applies; this schema never makes an oversized text a guest UI input.
 */
export function functionHostMessageProps(component: string, value: unknown): ModObject {
  const fail = (): never => {
    throw new ModFunctionError("MODS_UI_SITE_PROPS")
  }
  if (component !== "UserMessage" && component !== "AssistantMessage") return fail()
  encodeModJson(value)
  if (!isModObject(value) || typeof value.text !== "string") return fail()
  if (component === "AssistantMessage") {
    if (
      typeof value.isFirstOfReply !== "boolean" ||
      Object.keys(value).some((key) => !["text", "isFirstOfReply"].includes(key))
    )
      return fail()
    return { text: value.text, isFirstOfReply: value.isFirstOfReply }
  }
  if (
    typeof value.isExpanded !== "boolean" ||
    !isModObject(value.origin) ||
    !(
      isFunctionPluginPromptOrigin(value.origin) ||
      (value.origin.kind === "unclassified" && Object.keys(value.origin).length === 1)
    ) ||
    Object.keys(value).some((key) => !["text", "origin", "isExpanded"].includes(key))
  )
    return fail()
  const origin = isFunctionPluginPromptOrigin(value.origin)
    ? {
        kind: "plugin",
        name: value.origin.name,
        ...(value.origin.asUser === true ? { asUser: true } : {})
      }
    : { kind: "unclassified" }
  return { text: value.text, origin, isExpanded: value.isExpanded }
}

/** Only the body may change under publication; every host identity field is pinned. */
export function functionHostMessagePublication(
  component: string,
  received: unknown,
  original: ModObject
): ModObject {
  const before = functionHostMessageProps(component, original)
  const after = functionHostMessageProps(component, received)
  const fields = component === "UserMessage" ? ["origin", "isExpanded"] : ["isFirstOfReply"]
  if (fields.some((field) => encodeModJson(before[field]) !== encodeModJson(after[field])))
    throw new ModFunctionError("MODS_UI_NATIVE_PUBLICATION")
  return after
}
