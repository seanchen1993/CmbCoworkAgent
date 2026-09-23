import type { ModObject } from "../types"
import { isModObject, ModFunctionError } from "./contracts"
import { validateFunctionTree, type FunctionUiElement } from "./ui"

export const FUNCTION_UI_SITES = [
  "AbovePrompt",
  "PromptHint",
  "InfoNotice",
  "Spinner",
  "TurnDuration",
  "SessionMode",
  "UserMessage",
  "AssistantMessage"
] as const
export type FunctionUiSite = (typeof FUNCTION_UI_SITES)[number]
export const FUNCTION_DURATION_SITE_LIMIT = 32

export function functionUiSite(value: unknown): FunctionUiSite {
  if (!FUNCTION_UI_SITES.some((site) => site === value))
    throw new ModFunctionError("MODS_UI_SITE_UNSUPPORTED")
  return value as FunctionUiSite
}

/** Desktop presentation facts. They carry no execution or thread authority. */
export function functionSiteProps(site: FunctionUiSite, value: unknown): ModObject {
  const fail = (): never => {
    throw new ModFunctionError("MODS_UI_SITE_PROPS")
  }
  if (!isModObject(value)) return fail()
  const text = (v: unknown): v is string => typeof v === "string" && v.length <= 10000
  if (site === "UserMessage") {
    if (
      !text(value.text) ||
      typeof value.isExpanded !== "boolean" ||
      !isModObject(value.origin) ||
      value.origin.kind !== "unclassified" ||
      Object.keys(value.origin).some((key) => key !== "kind") ||
      Object.keys(value).some((key) => !["text", "origin", "isExpanded"].includes(key))
    )
      return fail()
    // CMB's durable transcript has no upstream PromptOrigin stamp. Never infer authorship.
    return { text: value.text, origin: { kind: "unclassified" }, isExpanded: value.isExpanded }
  }
  if (site === "AssistantMessage") {
    if (
      !text(value.text) ||
      typeof value.isFirstOfReply !== "boolean" ||
      Object.keys(value).some((key) => !["text", "isFirstOfReply"].includes(key))
    )
      return fail()
    return { text: value.text, isFirstOfReply: value.isFirstOfReply }
  }
  if (site === "Spinner") {
    if (
      !text(value.word) ||
      !(value.message === null || text(value.message)) ||
      !text(value.suffix) ||
      typeof value.mode !== "string" ||
      !["requesting", "responding", "thinking", "tool-input", "tool-use"].includes(
        String(value.mode)
      ) ||
      Object.keys(value).some((key) => !["word", "message", "suffix", "mode"].includes(key))
    )
      return fail()
    return { word: value.word, message: value.message, suffix: value.suffix, mode: value.mode }
  }
  if (site === "TurnDuration") {
    if (
      !text(value.word) ||
      typeof value.durationMs !== "number" ||
      !Number.isFinite(value.durationMs) ||
      value.durationMs < 0 ||
      value.durationMs > Number.MAX_SAFE_INTEGER ||
      Object.keys(value).some((key) => !["word", "durationMs"].includes(key))
    )
      return fail()
    // DOM virtualized message rows do not report terminal row geometry: onScreen is absent.
    return { word: value.word, durationMs: value.durationMs }
  }
  if (site === "SessionMode") {
    if (
      !Array.isArray(value.modes) ||
      value.modes.length > 32 ||
      !value.modes.every(text) ||
      Object.keys(value).some((key) => key !== "modes")
    )
      return fail()
    return { modes: [...value.modes] }
  }
  if (site === "InfoNotice") {
    if (
      !text(value.text) ||
      !(value.command === null || text(value.command)) ||
      Object.keys(value).some((key) => !["text", "command"].includes(key))
    )
      return fail()
    return { text: value.text, command: value.command }
  }
  if (typeof value.isWorking !== "boolean") return fail()
  if (site === "PromptHint") {
    if (
      typeof value.isDraft !== "boolean" ||
      !text(value.hint) ||
      Object.keys(value).some((key) => !["isWorking", "isDraft", "hint"].includes(key))
    )
      return fail()
    return { isWorking: value.isWorking, isDraft: value.isDraft, hint: value.hint }
  }
  if (
    ![value.bodyColumns, value.maxRows].every(
      (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= 1000
    ) ||
    (value.offset !== undefined &&
      (typeof value.offset !== "number" ||
        !Number.isSafeInteger(value.offset) ||
        value.offset < 0 ||
        value.offset > 100000)) ||
    Object.keys(value).some(
      (key) => !["isWorking", "bodyColumns", "maxRows", "offset"].includes(key)
    )
  )
    return fail()
  return {
    isWorking: value.isWorking,
    hasSurvey: false,
    bodyColumns: value.bodyColumns,
    maxRows: value.maxRows,
    scroll: { offset: value.offset ?? 0, bodyRows: value.maxRows },
    view: {}
  }
}

export function functionSiteDefault(site: FunctionUiSite, props: ModObject): FunctionUiElement {
  if (site === "UserMessage" || site === "AssistantMessage")
    return { type: "Text", props: {}, children: [String(props.text)] }
  if (site === "Spinner" || site === "TurnDuration" || site === "SessionMode") {
    const ms = Number(props.durationMs)
    const seconds = Math.round(ms / 1000)
    const duration =
      ms < 60000
        ? `${seconds}s`
        : `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000) ? ` ${Math.round((ms % 60000) / 1000)}s` : ""}`
    return {
      type: "Text",
      props: { dimColor: true },
      children: [
        site === "Spinner"
          ? `${props.message ?? props.word}${props.suffix}`
          : site === "TurnDuration"
            ? `${props.word} ${duration}`
            : (props.modes as string[]).join(" & ")
      ]
    }
  }
  return site === "AbovePrompt"
    ? { type: "Box", props: {}, children: [] }
    : {
        type: "Text",
        props: { dimColor: true },
        children: [
          site === "PromptHint"
            ? String(props.hint)
            : `${props.text}${props.command ? ` ${props.command}` : ""}`
        ]
      }
}

export function validateFunctionSiteTree(value: unknown): asserts value is FunctionUiElement {
  validateFunctionTree(value)
  const visit = (tree: FunctionUiElement): void => {
    if (tree.type === "Client") throw new ModFunctionError("MODS_UI_SITE_CLIENT_UNSUPPORTED")
    for (const child of tree.children ?? []) if (typeof child !== "string") visit(child)
  }
  visit(value)
}
