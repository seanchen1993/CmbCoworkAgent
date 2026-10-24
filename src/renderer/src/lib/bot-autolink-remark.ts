import type { Point } from "unist"
import type { Root, RootContent } from "mdast"
import type { VFile } from "vfile"

const PROSE_BOUNDARY = /[，。！？；：（）【】「」『』《》〈〉、…“”‘’]/u
// Grok 0.75.3 HG: generic URL trails, with only unmatched closing parens removed.
const URL_TRAIL = "!\"'*,.:;<?]_~"
const shifted = (start: Point, text: string): Point => {
  const lines = text.split("\n")
  return {
    offset: start.offset! + text.length,
    line: start.line + lines.length - 1,
    column: lines.length > 1 ? lines.at(-1)!.length + 1 : start.column + text.length
  }
}

/** Trim source-proven bare URL prose without changing the existing GFM parser. */
export function remarkBotAutolinks() {
  return (tree: Root, file: VFile) => {
    const source = file.toString()
    const visit = (parent: Root | RootContent): void => {
      if (!("children" in parent) || parent.type === "link" || parent.type === "linkReference")
        return
      for (let index = 0; index < parent.children.length; index++) {
        const child = parent.children[index]
        const label =
          child.type === "text"
            ? child.value
            : child.type === "link" &&
                child.children.length === 1 &&
                child.children[0].type === "text"
              ? child.children[0].value
              : undefined
        // Explicit []() / <> links, normalized escapes/entities and fallback
        // links without exact source positions remain unchanged.
        if (
          child.type === "link" &&
          label &&
          /^(?:https?:\/\/|www\.)/i.test(label) &&
          child.position?.start.offset !== undefined &&
          child.position.end.offset !== undefined &&
          source.slice(child.position.start.offset, child.position.end.offset) === label
        ) {
          let boundary = label.search(PROSE_BOUNDARY)
          if (boundary > 0) {
            const rawPrefix = label.slice(0, boundary)
            // Preserve existing Unicode paths/query/hash and Unicode hosts.
            // Even ASCII-prefix CJK prose remains a heuristic: a path may
            // legitimately start with the punctuation at this boundary.
            if (/[^\x21-\x7e]/u.test(rawPrefix)) continue
            let extraClosers = rawPrefix.split(")").length - rawPrefix.split("(").length
            while (boundary > 0) {
              const last = label.charAt(boundary - 1)
              if (last === ")" && extraClosers > 0) extraClosers--
              else if (!URL_TRAIL.includes(last)) break
              boundary--
            }
            const prefix = label.slice(0, boundary)
            const protocol = /^(https?:\/\/)/i.exec(child.url)?.[0]
            if (/^www\./i.test(prefix) && !protocol) continue
            const destination = /^www\./i.test(prefix) ? protocol + prefix : prefix
            try {
              const parsed = new URL(destination)
              if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname) continue
            } catch {
              continue
            }
            const suffix = label.slice(boundary)
            const end = shifted(child.position.start, prefix)
            const originalEnd = child.position.end
            child.url = destination
            child.children = [
              {
                type: "text",
                value: prefix,
                position: { start: child.position.start, end }
              }
            ]
            child.position.end = end
            parent.children.splice(++index, 0, {
              type: "text",
              value: suffix,
              position: { start: end, end: originalEnd }
            })
          }
        } else visit(child)
      }
    }
    visit(tree)
  }
}
