import { createHash } from "node:crypto"
import { isReviewedAutobizBusinessAssembly } from "./autobiz-business-assembly-protocol"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])])
    )
  return value
}

/** The complete reviewed Python protocol, including validators and imported helpers. */
export function isReviewedAutobizProtocol(snapshot: {
  files: readonly { path: string; bytes: Buffer }[]
}): boolean {
  // Python can prefer native/sourceless modules over a same-named reviewed .py file.
  if (snapshot.files.some((file) => /\.(?:pyd|so|dll|pyc|pyo|pyw)$/i.test(file.path))) return false
  if (isReviewedAutobizBusinessAssembly(snapshot)) return true
  const board = snapshot.files.find((file) => file.path === "board_core/board_config.json")
  if (!board || board.bytes.length > 1024 * 1024) return false
  try {
    const commands = JSON.parse(board.bytes.toString("utf8")).inspectCommands
    if (
      !commands ||
      hash(JSON.stringify(canonical(commands))) !==
        "1ddff049c143909c2aceec11a7827b86da7f5186188eadfa9572cd74ff091839"
    )
      return false
  } catch {
    return false
  }
  const rows = snapshot.files
    .filter((file) => file.path.toLowerCase().endsWith(".py"))
    .map((file) => [file.path, hash(file.bytes.toString("utf8").replace(/\r\n/g, "\n"))])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return (
    rows.length === 49 &&
    hash(JSON.stringify(rows)) ===
      "a8da9cac588c8e921f1fb289908ccd4a39350838680b03ac95b1103b4b98245e"
  )
}
