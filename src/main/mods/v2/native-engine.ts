import type { ModJson, ModObject } from "../../../shared/mods/types"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"
import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"
import { functionEngineRefs, type FunctionNativeContent } from "../../../shared/mods/v2/engine"
import { normalizeFunctionInput } from "../../../shared/mods/v2/pinned-input"
import {
  functionQuestionPresentation,
  functionSiteProps,
  type FunctionUiSite
} from "../../../shared/mods/v2/sites"
import type { FunctionUiElement } from "../../../shared/mods/v2/ui"

const clone = (value: ModObject): ModObject => parseModJson(encodeModJson(value)) as ModObject
const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

/** Trusted publication can redact display bodies, while identity stays host-owned. */
export function functionNativePresentation(
  component: FunctionUiSite | "Pane",
  received: unknown,
  original: ModObject
): ModObject {
  if (!isModObject(received)) throw new ModFunctionError("MODS_UI_NATIVE_PUBLICATION")
  const fields: readonly string[] =
    component === "UserMessage"
      ? ["origin", "isExpanded"]
      : component === "AssistantMessage"
        ? ["isFirstOfReply"]
        : component === "CommandOutput"
          ? ["command", "args", "isErrored"]
          : component === "ToolUse"
            ? ["tool_use_id", "tool", "isRunning", "isErrored", "isInterrupted"]
            : component === "ToolResult"
              ? ["tool_use_id", "tool", "isErrored"]
              : component === "ToolGroup"
                ? ["isActive"]
                : component === "AskUserQuestion"
                  ? ["tool", "metadataSource"]
                  : component === "PromptHint"
                    ? ["isWorking", "isDraft"]
                    : component === "AbovePrompt" || component === "Pane"
                      ? Object.keys(original).filter(
                          (key) => component !== "Pane" || key !== "title"
                        )
                      : []
  for (const field of fields)
    if (!same(received[field], original[field]))
      throw new ModFunctionError("MODS_UI_NATIVE_PUBLICATION")
  if (Object.keys(received).some((key) => !Object.hasOwn(original, key)))
    throw new ModFunctionError("MODS_UI_NATIVE_PUBLICATION")
  if (component === "ToolGroup") {
    if (
      !Array.isArray(original.calls) ||
      !Array.isArray(received.calls) ||
      original.calls.length !== received.calls.length
    )
      throw new ModFunctionError("MODS_UI_NATIVE_PUBLICATION")
    for (let index = 0; index < original.calls.length; index++) {
      const before = original.calls[index]
      if (!isModObject(before)) throw new ModFunctionError("MODS_UI_NATIVE_PUBLICATION")
      functionNativePresentation("ToolUse", received.calls[index], before)
    }
  }
  if (component === "AskUserQuestion")
    functionQuestionPresentation(original.questions, received.questions)
  // AbovePrompt already holds normalized, pinned geometry rather than renderer input fields.
  if (component === "Pane" || component === "AbovePrompt") {
    if (component === "AbovePrompt" && !same(received, original))
      throw new ModFunctionError("MODS_UI_NATIVE_PUBLICATION")
    if (component === "Pane" && typeof received.title !== "string")
      throw new ModFunctionError("MODS_UI_NATIVE_PUBLICATION")
    return clone(received)
  }
  return functionSiteProps(component, received)
}

/** Numeric refs name display input in this one drawing; they never grant execution authority. */
export class FunctionNativeDrawing {
  private readonly input: ModObject
  private readonly inputs: ModObject[]
  private readonly protectedInputs = new Map<number, ModObject>()

  constructor(
    input: ModObject,
    private readonly assertCurrent: () => void,
    private readonly requestId?: string
  ) {
    assertCurrent()
    this.input = clone(input)
    if (!isModObject(this.input.props)) throw new ModFunctionError("MODS_UI_NATIVE_PUBLICATION")
    this.inputs = [clone(this.input.props)]
  }

  keep(received: ModObject): ModJson {
    this.assertCurrent()
    if (this.inputs.length >= 65) throw new ModFunctionError("MODS_UI_NATIVE_REF_LIMIT")
    const checked = normalizeFunctionInput("ui.render", received, this.input)
    if (!isModObject(checked.props)) throw new ModFunctionError("MODS_UI_NATIVE_PUBLICATION")
    const props = functionNativePresentation(
      this.input.component as FunctionUiSite | "Pane",
      checked.props,
      this.inputs[0]
    )
    // Both the number of refs and their total real payload stay bounded.
    encodeModJson([...this.inputs, props])
    const ref = this.inputs.length
    this.inputs.push(props)
    return { type: "engine", ref }
  }

  /** Cache only the two publication passes of this snapshot, never a later policy decision. */
  beginPublication(): void {
    this.assertCurrent()
    this.protectedInputs.clear()
  }

  async protect(
    tree: FunctionUiElement,
    publish: (value: ModJson) => Promise<ModJson>
  ): Promise<FunctionNativeContent> {
    this.assertCurrent()
    const refs = [
      ...new Set([
        0,
        ...functionEngineRefs(tree).map((ref) => (ref < this.inputs.length ? ref : 0))
      ])
    ]
    const pending = refs.filter((ref) => !this.protectedInputs.has(ref))
    if (pending.length) {
      const values = pending.map((ref) => ({ ref, props: clone(this.inputs[ref]) }))
      const published = await publish(values as unknown as ModJson)
      this.assertCurrent()
      if (!Array.isArray(published) || published.length !== values.length)
        throw new ModFunctionError("MODS_UI_NATIVE_PUBLICATION")
      const verified: Array<{ ref: number; props: ModObject }> = []
      for (let index = 0; index < values.length; index++) {
        const value = published[index]
        if (
          !isModObject(value) ||
          value.ref !== values[index].ref ||
          Object.keys(value).some((key) => !["ref", "props"].includes(key))
        )
          throw new ModFunctionError("MODS_UI_NATIVE_PUBLICATION")
        verified.push({
          ref: values[index].ref,
          props: functionNativePresentation(
            this.input.component as FunctionUiSite | "Pane",
            value.props,
            values[index].props
          )
        })
      }
      // Never partially accept a batch whose later identity check fails.
      for (const { ref, props } of verified) this.protectedInputs.set(ref, props)
    }
    this.assertCurrent()
    const entries = refs.map((ref) => ({ ref, props: clone(this.protectedInputs.get(ref)!) }))
    const result: FunctionNativeContent = {
      component: this.input.component as FunctionUiSite | "Pane",
      entries,
      ...(this.requestId === undefined ? {} : { requestId: this.requestId }),
      nativeUnchanged: entries.every((entry) => same(entry.props, this.inputs[0]))
    }
    encodeModJson(result)
    return result
  }
}
