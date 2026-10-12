// Extracted from Grok sidebar-agent-preview-content.tsx; see PROVENANCE.json.
const markdownPreviewReplacements: readonly [RegExp, string][] = [
  [/`+/g, ""],
  [/!\[([^\]]*)\]\([^)]*\)/g, "$1"],
  [/\[([^\]]+)\]\([^)]*\)/g, "$1"],
  [/\$\$((?:[^$\\]|\\[\s\S])+?)\$\$/g, "$1"],
  [/\\\(([\s\S]+?)\\\)/g, "$1"],
  [/\\\[([\s\S]+?)\\\]/g, "$1"],
  [/\\\$/g, "$"],
  [/^\s{0,3}#{1,6}\s+/gm, ""],
  [/^\s{0,3}>\s?/gm, ""],
  [/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, ""],
  [/\*\*([^*]+)\*\*/g, "$1"],
  [/__([^_]+)__/g, "$1"],
  [/~~([^~]+)~~/g, "$1"],
  [/\*([^*\n]+)\*/g, "$1"],
  [new RegExp("(?<!\\w)_([^_\\n]+)_(?!\\w)", "g"), "$1"],
  [/\|/g, " "]
]

export function grokTextPreview(value: string): string {
  return markdownPreviewReplacements
    .reduce(
      (text, [pattern, replacement]) => text.replace(pattern, replacement),
      value.slice(0, 2000)
    )
    .replace(/\s+/g, " ")
    .trim()
}
