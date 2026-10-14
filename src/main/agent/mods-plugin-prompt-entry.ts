import type { FunctionPluginPromptOrigin } from "../../shared/mods/v2/plugin-prompt"

const receipts = new WeakSet<object>()

export interface NativePluginPromptRun {
  readonly workspace: string
  readonly threadId: string
  readonly text: string
  readonly context: readonly string[]
  readonly origin: FunctionPluginPromptOrigin
  readonly framed: boolean
  assertLive(): void
  started(): void
}

/** Main-process-only receipt. A source string or serialized SDK input cannot mint this entry. */
export function createNativePluginPromptRun(input: NativePluginPromptRun): NativePluginPromptRun {
  const receipt = Object.freeze({
    ...input,
    context: Object.freeze([...input.context]),
    origin: Object.freeze({ ...input.origin })
  })
  receipts.add(receipt)
  return receipt
}

export function nativePluginPromptRun(
  receipt: NativePluginPromptRun | undefined,
  threadId: string,
  text: string
): NativePluginPromptRun | undefined {
  if (receipt === undefined) return undefined
  if (!receipts.has(receipt) || receipt.threadId !== threadId || receipt.text !== text)
    throw Error("MODS_PLUGIN_PROMPT_RECEIPT_INVALID")
  receipt.assertLive()
  return receipt
}
