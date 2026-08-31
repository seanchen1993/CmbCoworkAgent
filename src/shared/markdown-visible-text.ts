const MARKDOWN_PROBE = /[\\`*_~#![<&]/

function decodeMarkdownEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39|#x[0-9a-f]+|#\d+);/gi, (entity) => {
    const key = entity.toLowerCase()
    if (key === "&amp;") return "&"
    if (key === "&lt;") return "<"
    if (key === "&gt;") return ">"
    if (key === "&quot;") return '"'
    if (key === "&#39;") return "'"
    const hex = key.startsWith("&#x")
    const value = Number.parseInt(key.slice(hex ? 3 : 2, -1), hex ? 16 : 10)
    return Number.isFinite(value) && value >= 0 && value <= 0x10ffff
      ? String.fromCodePoint(value)
      : entity
  })
}

/** Conservative linear Markdown projection shared by main and renderer search. */
export function projectMarkdownVisibleText(markdown: string): string {
  if (!MARKDOWN_PROBE.test(markdown)) return markdown
  const visibleLines: string[] = []
  let lineFence: "```" | "~~~" | null = null
  let previousWasDefinition = false
  const rawLines = markdown.split("\n")
  for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex += 1) {
    const rawLine = rawLines[lineIndex]
    const fenceMatch = rawLine.match(/^ {0,3}(```|~~~)/)
    if (lineFence) {
      visibleLines.push(fenceMatch?.[1] === lineFence ? fenceMatch[1] : rawLine)
      if (fenceMatch?.[1] === lineFence) lineFence = null
      continue
    }
    if (fenceMatch) {
      lineFence = fenceMatch[1] as "```" | "~~~"
      visibleLines.push(rawLine.slice(rawLine.indexOf(lineFence)))
      continue
    }
    const isDefinition = /^ {0,3}\[[^\]]+\]:\s*\S+/.test(rawLine)
    const previousBlank = lineIndex === 0 || rawLines[lineIndex - 1].trim() === ""
    if (isDefinition && (previousBlank || previousWasDefinition)) {
      previousWasDefinition = true
      continue
    }
    previousWasDefinition = false
    let line = rawLine.replace(/^ {0,3}#{1,6}\s+/, "")
    line = line.replace(/^\s*(?:[-+*]|\d+[.)])\s+/, "")
    line = line.replace(/^\s*\[[ xX]\]\s+/, "")
    visibleLines.push(line)
  }
  const source = visibleLines.join("\n")
  let output = ""
  let index = 0
  const activePairs = new Set<string>()
  let activeFence: "```" | "~~~" | null = null
  while (index < source.length) {
    if (activeFence) {
      if ((index === 0 || source[index - 1] === "\n") && source.startsWith(activeFence, index)) {
        const lineEnd = source.indexOf("\n", index + activeFence.length)
        activeFence = null
        index = lineEnd < 0 ? source.length : lineEnd + 1
        continue
      }
      output += source[index]
      index += 1
      continue
    }
    const fence = source.startsWith("```", index)
      ? "```"
      : source.startsWith("~~~", index)
        ? "~~~"
        : null
    if (fence && (index === 0 || source[index - 1] === "\n")) {
      const lineEnd = source.indexOf("\n", index + fence.length)
      if (lineEnd < 0) break
      activeFence = fence
      index = lineEnd + 1
      continue
    }
    if (source[index] === "`") {
      let ticks = 1
      while (source[index + ticks] === "`") ticks += 1
      const delimiter = "`".repeat(ticks)
      const close = source.indexOf(delimiter, index + ticks)
      if (close >= 0) {
        output += source.slice(index + ticks, close)
        index = close + ticks
        continue
      }
    }
    const image = source[index] === "!" && source[index + 1] === "["
    if (source[index] === "[" || image) {
      const labelStart = index + (image ? 2 : 1)
      const labelEnd = source.indexOf("]", labelStart)
      if (labelEnd >= 0) {
        const destinationStart = labelEnd + 1
        const reference = source[destinationStart] === "["
        if (source[destinationStart] === "(" || reference) {
          let close = -1
          if (reference) {
            close = source.indexOf("]", destinationStart + 1)
          } else {
            let depth = 1
            for (let cursor = destinationStart + 1; cursor < source.length; cursor += 1) {
              if (source[cursor] === "\\") cursor += 1
              else if (source[cursor] === "(") depth += 1
              else if (source[cursor] === ")" && --depth === 0) {
                close = cursor
                break
              }
            }
          }
          if (close >= 0) {
            if (!image) output += projectMarkdownVisibleText(source.slice(labelStart, labelEnd))
            index = close + 1
            continue
          }
        }
      }
    }
    if (source[index] === "\\" && index + 1 < source.length) {
      output += source[index + 1]
      index += 2
      continue
    }
    const pair = source.slice(index, index + 2)
    if (pair === "**" || pair === "__" || pair === "~~") {
      if (activePairs.has(pair)) {
        if (pair === "__" && !/[\p{L}\p{N}]/u.test(source[index - 1] ?? "")) {
          output += pair
          index += 2
          continue
        }
        activePairs.delete(pair)
        index += 2
        continue
      }
      const underscoreCanOpen =
        pair !== "__" ||
        !/[\p{L}\p{N}]/u.test(source[index - 1] ?? "") &&
          /[\p{L}\p{N}]/u.test(source[index + 2] ?? "")
      if (underscoreCanOpen && source.indexOf(pair, index + 2) >= 0) {
        activePairs.add(pair)
        index += 2
        continue
      }
    }
    output += source[index]
    index += 1
  }
  return decodeMarkdownEntities(output)
}
