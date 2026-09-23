import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"
import { requestUserInputSchema } from "../../agent/tools/user-input-schema"

/** The desktop host currently exposes the original single-selection native question tool. */
export function functionAskInput(args: unknown[]) {
  const fail = (): never => {
    throw new ModFunctionError("MODS_UI_ASK_ARGUMENTS")
  }
  if (args.length < 1 || args.length > 2 || typeof args[0] !== "string") return fail()
  const options =
    args[1] === undefined ? {} : Array.isArray(args[1]) ? { options: args[1] } : args[1]
  if (
    !isModObject(options) ||
    Object.keys(options).some((k) => !["options", "header", "multiSelect"].includes(k))
  )
    return fail()
  if (options.multiSelect !== undefined)
    throw new ModFunctionError("MODS_UI_ASK_MULTISELECT_UNSUPPORTED")
  if (options.options !== undefined && !Array.isArray(options.options)) return fail()
  const labels = [...((options.options as unknown[]) ?? [])]
  if (
    labels.length > 4 ||
    labels.some((v) => typeof v !== "string" || !v.trim()) ||
    new Set(labels).size !== labels.length
  )
    return fail()
  for (const label of ["Yes", "No"])
    if (labels.length < 2 && !labels.includes(label)) labels.push(label)
  const parsed = requestUserInputSchema.safeParse({
    questions: [
      {
        id: "mod_question",
        header: Object.hasOwn(options, "header") ? options.header : "Question",
        question: args[0],
        options: labels.map((label) => ({ label, description: label }))
      }
    ]
  })
  if (!parsed.success) return fail()
  return { tool: "request_user_input", ...parsed.data }
}

export function functionAskAnswer(value: unknown): string {
  if (isModObject(value) && typeof value.deny === "string")
    throw new ModFunctionError("MODS_OPERATION_DENIED", value.deny)
  const fail = (): never => {
    throw new ModFunctionError("MODS_UI_ASK_RESULT")
  }
  if (!isModObject(value) || value.isError || typeof value.result !== "string") return fail()
  let result: unknown
  try {
    result = JSON.parse(value.result)
  } catch {
    return fail()
  }
  if (!isModObject(result)) return fail()
  if (["ignored", "rejected", "cancelled", "auto_resolved"].includes(String(result.status)))
    throw new ModFunctionError("MODS_UI_ASK_DISMISSED")
  if (result.status !== "submitted" || !isModObject(result.answers)) return fail()
  const answer = result.answers.mod_question
  if (!isModObject(answer)) return fail()
  const text =
    answer.type === "option" ? answer.label : answer.type === "other" ? answer.text : undefined
  if (typeof text !== "string" || !text || text.length > 10000) return fail()
  return text
}
