/** Line-ending preservation adapted from OpenCode's edit tool (MIT License). */
export function createEditMatchView(content: string, oldString: string, newString: string) {
  const endingsOnly = oldString.replaceAll("\r", "") === newString.replaceAll("\r", "")
  const removed = [...content.matchAll(/\r\n/g)].map((match, index) => match.index - index)
  const fileEnding = lineEnding(content, "\n")
  const replacement = newString.replaceAll("\r\n", "\n")

  return {
    content: endingsOnly ? content : content.replaceAll("\r\n", "\n"),
    oldString: endingsOnly ? oldString : oldString.replaceAll("\r\n", "\n"),
    endingsOnly,
    sourceOffset(offset: number): number {
      if (endingsOnly) return offset
      let low = 0
      let high = removed.length
      while (low < high) {
        const middle = (low + high) >> 1
        if (removed[middle] < offset) low = middle + 1
        else high = middle
      }
      return offset + low
    },
    replacementFor(start: number, end: number): string {
      if (endingsOnly) return newString
      const region = content.slice(start, end)
      return withRegionEndings(region, replacement, lineEnding(region, fileEnding))
    }
  }
}

function lineEnding(text: string, fallback: string): string {
  const crlfCount = text.split("\r\n").length - 1
  const lfCount = text.split("\n").length - 1 - crlfCount
  if (crlfCount === lfCount) return fallback
  return crlfCount > lfCount ? "\r\n" : "\n"
}

function withRegionEndings(region: string, replacement: string, fallback: string): string {
  if (!replacement.includes("\n")) return replacement
  const endings = [...region.matchAll(/\r?\n/g)].map((match) => match[0])
  // Uniform regions need no line alignment, including regions without a newline.
  if (endings.every((ending) => ending === fallback)) {
    return fallback === "\n" ? replacement : replacement.replaceAll("\n", fallback)
  }
  const before = region.split(/\r?\n/)
  const after = replacement.split("\n")
  const key = (line: string): string => line.replace(/[\t ]+$/, "")
  const source = alignLines(before.map(key), after.map(key))
  return after
    .map((line, index) => {
      if (index === after.length - 1) return line
      const sourceIndex = source[index]
      return line + (sourceIndex === undefined ? fallback : (endings[sourceIndex] ?? fallback))
    })
    .join("")
}

// Bound synchronous alignment work and its Uint32 table to approximately 4 MB.
const MAX_ALIGNMENT_CELLS = 1_000_000

// Retained lines keep their endings; changed lines reuse the source lines they replace.
function alignLines(before: string[], after: string[]): (number | undefined)[] {
  const width = after.length + 1
  const cells = (before.length + 1) * width
  if (cells > MAX_ALIGNMENT_CELLS) {
    throw new Error(
      "Cannot safely preserve mixed line endings: the edit exceeds the line-alignment limit. Submit smaller edits with fewer surrounding lines."
    )
  }
  const table = new Uint32Array(cells)
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i * width + j] =
        before[i] === after[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }
  const result: (number | undefined)[] = []
  let beforeGap: number[] = []
  let afterGap: number[] = []
  const flush = (): void => {
    afterGap.forEach((j, k) => (result[j] = beforeGap[k]))
    beforeGap = []
    afterGap = []
  }
  let i = 0
  let j = 0
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      flush()
      result[j++] = i++
      continue
    }
    if (table[(i + 1) * width + j] >= table[i * width + j + 1]) beforeGap.push(i++)
    else afterGap.push(j++)
  }
  while (i < before.length) beforeGap.push(i++)
  while (j < after.length) afterGap.push(j++)
  flush()
  return result
}
