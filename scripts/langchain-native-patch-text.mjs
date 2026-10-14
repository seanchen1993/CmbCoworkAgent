/** Ordinary fixed text hunks only. Preserve exact source EOF; never evaluate patch text. */
export function applyNativeTextPatch(patch, originals) {
  const lines = patch.split("\n")
  if (lines.at(-1) === "") lines.length--
  const outputs = new Map()
  let index = 0
  while (index < lines.length) {
    const oldHeader = lines[index++], newHeader = lines[index++]
    if (!oldHeader.startsWith("--- ") || !newHeader.startsWith("+++ b/"))
      throw Error("LANGCHAIN_PATCH_HEADER_INVALID")
    const path = newHeader.slice(6), original = originals.get(path)
    if (!originals.has(path) || outputs.has(path) ||
      (original === undefined ? oldHeader !== "--- /dev/null" : oldHeader !== `--- a/${path}`))
      throw Error("LANGCHAIN_PATCH_FILE_INVALID")
    const source = original === undefined ? "" : original.toString("utf8")
    const inputEndsLF = source.endsWith("\n")
    const input = source === "" ? [] : source.split("\n")
    if (inputEndsLF) input.length--
    const output = []
    let cursor = 0, outputEndsLF = inputEndsLF, markedOutput = -1
    const copyInput = () => {
      output[output.length] = input[cursor++]
      outputEndsLF = cursor === input.length ? inputEndsLF : true
    }
    while (index < lines.length && !lines[index].startsWith("--- ")) {
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[index++])
      if (!header) throw Error("LANGCHAIN_PATCH_HUNK_INVALID")
      const oldStart = Number(header[1]), oldCount = Number(header[2] ?? 1)
      const newStart = Number(header[3]), newCount = Number(header[4] ?? 1)
      const start = oldCount === 0 ? oldStart : oldStart - 1
      if (start < cursor || start > input.length) throw Error("LANGCHAIN_PATCH_RANGE_INVALID")
      while (cursor < start) copyInput()
      if (output.length !== (newCount === 0 ? newStart : newStart - 1))
        throw Error("LANGCHAIN_PATCH_OFFSET_INVALID")
      let consumed = 0, produced = 0
      while (consumed < oldCount || produced < newCount) {
        const line = lines[index++]
        if (!line) throw Error("LANGCHAIN_PATCH_LINE_INVALID")
        const kind = line[0], text = line.slice(1)
        if (kind !== " " && kind !== "-" && kind !== "+") throw Error("LANGCHAIN_PATCH_LINE_INVALID")
        const noLF = lines[index] === "\\ No newline at end of file"
        if (noLF) index++
        if (kind !== "+") {
          if (input[cursor++] !== text) throw Error("LANGCHAIN_PATCH_CONTEXT_CHANGED")
          consumed++
          if (noLF !== (cursor === input.length && !inputEndsLF))
            throw Error("LANGCHAIN_PATCH_OLD_EOF_INVALID")
        }
        if (kind !== "-") {
          output[output.length] = text
          outputEndsLF = !noLF
          if (noLF) markedOutput = output.length
          produced++
        }
      }
      if (consumed !== oldCount || produced !== newCount) throw Error("LANGCHAIN_PATCH_COUNT_INVALID")
    }
    while (cursor < input.length) copyInput()
    if (markedOutput !== -1 && markedOutput !== output.length) throw Error("LANGCHAIN_PATCH_NEW_EOF_INVALID")
    outputs.set(path, Buffer.from(output.join("\n") + (output.length && outputEndsLF ? "\n" : "")))
  }
  if (outputs.size !== originals.size) throw Error("LANGCHAIN_PATCH_FILE_SET_INVALID")
  return outputs
}
