import { requestUserInputSchema } from "../../user-input-schema"
import { MOD_COMMAND_HISTORY_LIMIT, type ModObject } from "../types"
import { encodeModJson } from "../validation"
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
  "AssistantMessage",
  "CommandOutput",
  "ToolUse",
  "ToolResult",
  "ToolGroup",
  "AskUserQuestion"
] as const
export type FunctionUiSite = (typeof FUNCTION_UI_SITES)[number]
export const FUNCTION_DURATION_SITE_LIMIT = 32
// Each retained job can show a result and an error block; other transcript sites stay at 32.
export const FUNCTION_COMMAND_OUTPUT_SITE_LIMIT = MOD_COMMAND_HISTORY_LIMIT * 2

export function functionUiSite(value: unknown): FunctionUiSite {
  if (!FUNCTION_UI_SITES.some((site) => site === value))
    throw new ModFunctionError("MODS_UI_SITE_UNSUPPORTED")
  return value as FunctionUiSite
}

/** Display wording may change; native answer IDs and option ordering keep their original meaning. */
export function functionQuestionPresentation(original: unknown, value: unknown) {
  const before = requestUserInputSchema.safeParse({ questions: original })
  const after = requestUserInputSchema.safeParse({ questions: value })
  if (!before.success || !after.success) throw new ModFunctionError("MODS_UI_SITE_PROPS")
  const identity = (questions: typeof before.data.questions) =>
    questions.map((q) => [q.id, q.options.map((option) => option.label)])
  if (
    JSON.stringify(identity(before.data.questions)) !==
    JSON.stringify(identity(after.data.questions))
  )
    throw new ModFunctionError("MODS_PINNED_INPUT")
  return after.data.questions
}

/** Desktop presentation facts. They carry no execution or thread authority. */
export function functionSiteProps(site: FunctionUiSite, value: unknown): ModObject {
  const fail = (): never => {
    throw new ModFunctionError("MODS_UI_SITE_PROPS")
  }
  if (!isModObject(value)) return fail()
  const text = (v: unknown): v is string => typeof v === "string" && v.length <= 10000
  if (site === "AskUserQuestion") {
    const parsed = requestUserInputSchema.safeParse({ questions: value.questions })
    if (
      !text(value.tool) ||
      !value.tool ||
      !parsed.success ||
      (value.metadataSource !== undefined && !text(value.metadataSource)) ||
      Object.keys(value).some((key) => !["tool", "questions", "metadataSource"].includes(key)) ||
      encodeModJson(value).length > 16000
    )
      return fail()
    return {
      tool: value.tool,
      questions: parsed.data.questions,
      ...(value.metadataSource === undefined ? {} : { metadataSource: value.metadataSource })
    }
  }
  if (site === "ToolGroup") {
    if (
      !Array.isArray(value.calls) ||
      value.calls.length < 1 ||
      value.calls.length > 32 ||
      typeof value.isActive !== "boolean" ||
      typeof value.isExpanded !== "boolean" ||
      Object.keys(value).some((key) => !["calls", "isActive", "isExpanded"].includes(key)) ||
      encodeModJson(value).length > 10000
    )
      return fail()
    const ids = new Set<string>()
    for (const call of value.calls) {
      const checked = functionSiteProps("ToolUse", call)
      if (ids.has(checked.tool_use_id as string)) return fail()
      ids.add(checked.tool_use_id as string)
    }
    return { ...value }
  }
  if (site === "ToolUse" || site === "ToolResult") {
    const fields =
      site === "ToolUse"
        ? ["tool_use_id", "tool", "input", "output", "isRunning", "isErrored", "isInterrupted"]
        : ["tool_use_id", "tool", "output", "isErrored"]
    if (
      !text(value.tool_use_id) ||
      !value.tool_use_id ||
      !text(value.tool) ||
      !value.tool ||
      typeof value.isErrored !== "boolean" ||
      (site === "ToolUse" &&
        (typeof value.isRunning !== "boolean" ||
          typeof value.isInterrupted !== "boolean" ||
          !Object.hasOwn(value, "input"))) ||
      (site === "ToolResult" && !Object.hasOwn(value, "output")) ||
      Object.keys(value).some((key) => !fields.includes(key)) ||
      encodeModJson(value).length > 10000
    )
      return fail()
    return { ...value }
  }
  if (site === "CommandOutput") {
    if (
      !text(value.command) ||
      !value.command ||
      !text(value.args) ||
      !text(value.text) ||
      typeof value.isErrored !== "boolean" ||
      Object.keys(value).some((key) => !["command", "args", "text", "isErrored"].includes(key))
    )
      return fail()
    return {
      command: value.command,
      args: value.args,
      text: value.text,
      isErrored: value.isErrored
    }
  }
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
  if (site === "AskUserQuestion") return { type: "Box", props: {}, children: [] }
  if (site === "ToolGroup")
    return {
      type: "Text",
      props: { dimColor: true },
      children: [`${(props.calls as unknown[]).length} tools`]
    }
  if (site === "ToolUse" || site === "ToolResult")
    return {
      type: "Text",
      props: {},
      children: [
        site === "ToolUse"
          ? `${props.tool} ${JSON.stringify(props.input)}`
          : typeof props.output === "string"
            ? props.output
            : JSON.stringify(props.output)
      ]
    }
  if (site === "UserMessage" || site === "AssistantMessage" || site === "CommandOutput")
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
