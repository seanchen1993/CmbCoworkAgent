import { isDeepStrictEqual } from "node:util"
import type { ModObject } from "../../shared/mods/types"
import { validatePromptContext } from "../../shared/mods/v2/prompt-context"
import type { FunctionPromptDispatch } from "./mods-prompt-composition"
import { promptContextOccurrence, type PromptContribution } from "./mods-prompt-sources"
import { bindHostPromptOccurrence } from "../mods/v2/prompt-cache"

/** Change only host-proven native context slots; never locate them by matching prompt strings. */
export async function applyModPromptContext(
  sources: readonly PromptContribution[],
  dispatch: FunctionPromptDispatch,
  signal: AbortSignal,
  assertLive: () => void
): Promise<readonly PromptContribution[]> {
  const marked = sources.filter(source => source.context)
  if (!marked.length) return sources
  const instructions = marked.find(source => source.context?.name === "claudeMd")
  const input: ModObject = {
    blocks: marked.filter(source => source.text !== null).map(source =>
      ({ name: source.context!.name, text: source.text! })),
    ...(instructions?.context?.instructionFiles === undefined ? {} : {
      instructionFiles: instructions.context.instructionFiles.map(file => ({ ...file }))
    })
  }
  const core = bindHostPromptOccurrence(async (value, active) => {
    assertLive()
    active.throwIfAborted()
    validatePromptContext(value)
    return value
  }, "prompt.context", marked[0].context ? promptContextOccurrence(marked[0].context) : marked[0])
  const result = await dispatch("prompt.context", input, signal, core)
  assertLive()
  signal.throwIfAborted()
  validatePromptContext(result)
  if (isDeepStrictEqual(result, input)) return sources
  const blocks = result.blocks as Array<{ name: string; text: string }>
  const originals = new Map(marked.map(source => [source.context!.name, source]))
  const returned = new Set(blocks.map(block => block.name))
  const context: PromptContribution[] = blocks.map(block => ({
    id: originals.get(block.name)?.id ?? `cmb:context:${block.name}`,
    scope: "session",
    text: block.text
  }))
  // Retain empty named slots for section hooks, after the returned context order.
  context.push(...marked.filter(source => !returned.has(source.context!.name)).map(source =>
    ({ id: source.id, scope: source.scope, text: null })))
  let inserted = false
  return sources.flatMap(source => {
    if (!source.context) return [source]
    if (inserted) return []
    inserted = true
    return context
  })
}
