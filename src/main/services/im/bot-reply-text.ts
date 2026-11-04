import { homedir, tmpdir } from "node:os"
import { getCmbCoworkAgentDataRoot } from "../../app-data-root"
import type { BotDeliveredFile } from "../../../shared/bots/file-delivery"

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Presentation boundary only. Never rewrite tool arguments, local history or attachment paths. */
export function botImReplyText(
  text: string,
  files: readonly BotDeliveredFile[] = [],
  roots: readonly string[] = []
): string {
  const customRoots = [getCmbCoworkAgentDataRoot(), homedir(), tmpdir(), ...roots]
    .filter((root) => root && root !== "/")
    .map((root) => escape(root.replace(/\\/g, "/").replace(/\/+$/, "")) + "(?=[/\\\\]|$)")
  // Do not treat arbitrary /api/routes or workspace-relative code examples as local paths.
  // Recognize Windows paths on macOS too (and vice versa), including retained old replies.
  const prefix = `(?:[A-Za-z]:[/\\\\]+|\\\\\\\\[^\\\\\\s]+\\\\|/(?:Users|home|tmp|private|var/folders)/${customRoots.length ? "|" + customRoots.join("|") : ""})`
  const pathStart = `(?:file:\\/{2,3}|${prefix})`
  const start = new RegExp(`^${pathStart}`, "i")
  const decoded = (value: string) => {
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  const local = (value: string) => start.test(decoded(value))
  const names = new Map<string, string>()
  const normalized = (value: string) => {
    const path = decoded(value)
      .replace(/^file:\/\//i, "")
      .replace(/^\/(?=[A-Za-z]:)/, "")
      .replace(/\\+/g, "/")
    return /^[A-Za-z]:\//.test(path) ? path.toLowerCase() : path
  }
  for (const file of files)
    for (const path of [file.filePath, file.attachmentPath])
      if (path) names.set(normalized(path), file.name)
  const display = (value: string) => {
    const path = normalized(value)
    const known = names.get(path)
    if (known) return known
    const name =
      decoded(value)
        .replace(/[\\/]+$/, "")
        .split(/[\\/]/)
        .at(-1) ?? ""
    return /^[^.].*\.[\p{L}\p{N}]{1,12}$/u.test(name) ? name : "本机目录"
  }
  // Local Markdown destinations are not usable in IM; retain the label without a dead link.
  text = text.replace(/(!?)\[([^\]\n]*)\]\(<?([^\n]*?)>?\)/g, (whole, _image, label, target) =>
    local(target) ? label || display(target) : whole
  )
  // Preserve full filenames with spaces in quotes/code spans. Public web links stay intact.
  text = text.replace(/([`"'])([^\n]*?)\1/g, (whole, quote, value) =>
    local(value) ? `${quote}${display(value)}${quote}` : whole
  )
  // Exact delivered paths also cover unquoted filenames with spaces and sent-byte copies.
  const references: [string, string][] = []
  for (const file of files) {
    for (const path of [file.filePath, file.attachmentPath]) {
      if (!path) continue
      const slash = path.replace(/\\/g, "/")
      for (const value of [path, slash, path.replace(/\\/g, "\\\\")])
        references.push([value, file.name])
    }
  }
  for (const [path, name] of references.sort((a, b) => b[0].length - a[0].length)) {
    const match = new RegExp(
      `https?:\\/\\/[^\\s<>\x60]+|(?<![\\w/\\\\])${escape(path)}(?![\\p{L}\\p{N}_.\\\\/])`,
      /^[A-Za-z]:/.test(path) ? "giu" : "gu"
    )
    text = text.replace(match, (value) => (/^https?:\/\//i.test(value) ? value : name))
  }
  const paths = new RegExp(
    `https?:\\/\\/[^\\s<>\x60]+|(?<![\\w/\\\\])${pathStart}[^\\s\x60"'<>\\[\\](),;，。；！？]*`,
    "giu"
  )
  return text.replace(paths, (value) => {
    if (/^https?:\/\//i.test(value)) return value
    const punctuation = value.match(/[.!?]+$/)?.[0] ?? ""
    return display(punctuation ? value.slice(0, -punctuation.length) : value) + punctuation
  })
}
