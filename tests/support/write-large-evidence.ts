import { closeSync, openSync, renameSync, writeSync } from "node:fs"

/** Large frame traces must not be flattened into one V8 string. Keep every array item. */
export function writeLargeEvidence(path: string, evidence: Record<string, unknown>): void {
  const temporary = `${path}.writing`
  const descriptor = openSync(temporary, "w")
  const write = (text: string): void => {
    const bytes = Buffer.from(text)
    let offset = 0
    while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset)
  }
  try {
    write("{\n")
    let first = true
    for (const [key, value] of Object.entries(evidence)) {
      if (value === undefined) continue
      write(`${first ? "" : ",\n"}${JSON.stringify(key)}:`)
      first = false
      if (Array.isArray(value)) {
        write("[\n")
        for (let index = 0; index < value.length; index++) {
          write(`${index ? ",\n" : ""}${JSON.stringify(value[index], null, 2) ?? "null"}`)
        }
        write("\n]")
      } else {
        write(JSON.stringify(value, null, 2))
      }
    }
    write("\n}\n")
  } finally {
    closeSync(descriptor)
  }
  renameSync(temporary, path)
}
