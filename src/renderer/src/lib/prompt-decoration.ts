import type {
  FunctionPromptDecoration,
  FunctionPromptEditInput
} from "../../../shared/mods/v2/prompt-edit"

export function clampPromptDecorationGraphemes(
  text: string,
  decorations: FunctionPromptDecoration[]
): FunctionPromptDecoration[] {
  if (!decorations.length) return []
  const edges = [
    0,
    ...Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
      (segment) => segment.index + segment.segment.length
    )
  ]
  const floor = (offset: number) => {
    let low = 0,
      high = edges.length
    while (low + 1 < high) {
      const middle = (low + high) >>> 1
      if (edges[middle] <= offset) low = middle
      else high = middle
    }
    return edges[low]
  }
  return decorations
    .filter((span) => span.end > span.start)
    .map((span) => ({
      ...span,
      start: floor(Math.max(0, Math.min(text.length, span.start))),
      end: floor(Math.max(0, Math.min(text.length, span.end)))
    }))
    .filter((span) => span.end > span.start)
}

/** Existing paint follows surviving characters; newly typed text receives no old paint. */
export function movePromptDecorations(
  before: string,
  after: string,
  decorations: FunctionPromptDecoration[],
  native?: FunctionPromptEditInput
): FunctionPromptDecoration[] {
  let start = 0,
    suffix = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  while (
    suffix < before.length - start &&
    suffix < after.length - start &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix++
  const edit =
    native?.text === before
      ? native
      : { start, end: before.length - suffix, inputText: after.slice(start, after.length - suffix) }
  const delta = edit.inputText.length - (edit.end - edit.start)
  const result: FunctionPromptDecoration[] = []
  for (const span of decorations) {
    const start = Math.max(0, Math.min(before.length, span.start))
    const end = Math.max(start, Math.min(before.length, span.end))
    if (start < Math.min(end, edit.start))
      result.push({ ...span, start, end: Math.min(end, edit.start) })
    if (Math.max(start, edit.end) < end)
      result.push({ ...span, start: Math.max(start, edit.end) + delta, end: end + delta })
  }
  return result
}
