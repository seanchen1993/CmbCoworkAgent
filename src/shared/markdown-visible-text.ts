import { decodeNamedCharacterReference } from "decode-named-character-reference"
import { decodeNumericCharacterReference } from "micromark-util-decode-numeric-character-reference"
import { parse, postprocess, preprocess } from "micromark"
import { gfm } from "micromark-extension-gfm"
import remarkGfm from "remark-gfm"
import remarkParse from "remark-parse"
import remarkRehype from "remark-rehype"
import { unified } from "unified"

export const CHAT_MARKDOWN_REMARK_PLUGINS = [remarkGfm]
const markdownProcessor = unified()
  .use(remarkParse)
  .use(CHAT_MARKDOWN_REMARK_PLUGINS)
  .use(remarkRehype, { allowDangerousHtml: true })
  .freeze()

const MAX_MARKDOWN_CHARACTERS = 256 * 1024
const MAX_MARKDOWN_SYNTAX = 2048
const MAX_MARKDOWN_PIPES = 2048
const MAX_MARKDOWN_LINES = 1024
const deepContainers = /(?:^|[\r\n])(?:[ \t]*(?:>|[-+*][ \t]|[0-9]{1,9}[.)][ \t])){65}/
type MarkdownSearchAdmission = "literal" | "parse" | "truncated"

export interface MarkdownSearchSpan {
  start: number
  end: number
  sourceStart: number
  sourceEnd?: number
}

export interface MarkdownSearchProjection {
  text: string
  truncated: boolean
  sourceSpans?: MarkdownSearchSpan[]
}

function isSearchNavigation(properties: Record<string, unknown>): boolean {
  return Object.hasOwn(properties, "dataFootnoteRef") || Object.hasOwn(properties, "dataFootnoteBackref") ||
    (Array.isArray(properties.className) && properties.className.includes("sr-only"))
}

/** Keep generated footnote navigation out of both the DOM and saved body search. */
export function markChatMarkdownSearchNavigation() {
  return (tree: ReturnType<typeof markdownProcessor.runSync>) => {
    const nodes = [...tree.children]
    while (nodes.length) {
      const node = nodes.pop()!
      if (node.type !== "element") continue
      if (isSearchNavigation(node.properties)) node.properties.dataChatSearchIgnore = ""
      for (const child of node.children) nodes.push(child)
    }
  }
}

// Intraword underscores, bare Windows separators and soft line feeds stay
// literal. Indentation and paragraph/inline boundaries reach the parser.
const markdownSyntax = new RegExp([
  // eslint-disable-next-line no-control-regex -- CommonMark renders NUL as a replacement character.
  /[\r\t`*~[<>&\u0000]/,
  /(?:^|[^A-Za-z0-9])_|_(?![A-Za-z0-9])/,
  /\\[!-/:-@[-`{-~\n]/,
  /(?:^|\n)(?:[ +#>=\n-]|\d{1,9}[.)](?: |\n|$))/,
  / (?:\n|$)/
].map((pattern) => pattern.source).join("|"), "g")

export function markdownSearchAdmission(markdown: string): MarkdownSearchAdmission {
  if (markdown.length > MAX_MARKDOWN_CHARACTERS) return "truncated"
  let pipes = 0
  let nextPipe = markdown.indexOf("|")
  while (nextPipe >= 0) {
    if (++pipes > MAX_MARKDOWN_PIPES) return "truncated"
    nextPipe = markdown.indexOf("|", nextPipe + 1)
  }
  markdownSyntax.lastIndex = 0
  const hasSyntax = markdownSyntax.test(markdown)
  if (!hasSyntax && !pipes) return "literal"
  let lines = 1
  const lineBreaks = /\r\n|[\r\n]/g
  while (lineBreaks.test(markdown)) {
    if (++lines > MAX_MARKDOWN_LINES) return "truncated"
  }
  if (deepContainers.test(markdown)) return "truncated"
  let count = 1
  while (markdownSyntax.test(markdown)) {
    if (++count > MAX_MARKDOWN_SYNTAX) return "truncated"
  }
  return "parse"
}

const referenceSource = /&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/
const references = new RegExp(referenceSource.source, "g")

function decodeReference(decimal?: string, hex?: string, name?: string): string | undefined {
  if (decimal) return decodeNumericCharacterReference(decimal, 10)
  if (hex) return decodeNumericCharacterReference(hex, 16)
  return name ? decodeNamedCharacterReference(name) || undefined : undefined
}

/** A character superset keeps references literal in code and allows their decoded prose form. */
export function markdownPossibleSourceText(source: string): string {
  const withoutNulls = source.includes("\0") ? source.replaceAll("\0", "\uFFFD") : source
  if (!withoutNulls.includes("&")) return withoutNulls
  return withoutNulls.replace(references, (entity, decimal, hex, name) =>
    entity + (decodeReference(decimal, hex, name) ?? ""))
}

interface MarkdownSourceToken {
  from: number
  to: number
  value: string
  mode: "text" | "inlineCode" | "blockCode"
}

function visibleSourceTokens(markdown: string): MarkdownSourceToken[] {
  const source = preprocess()(markdown, undefined, true)
  const events = postprocess(parse({ extensions: [gfm()] }).document().write(source))
  const tokens: MarkdownSourceToken[] = []
  let mode: MarkdownSourceToken["mode"] = "text"
  let skipFenceOpening = false
  for (const [kind, token] of events) {
    if (token.type === "codeText" || token.type === "codeFenced" || token.type === "codeIndented") {
      mode = kind === "exit" ? "text" : token.type === "codeText" ? "inlineCode" : "blockCode"
      skipFenceOpening = kind === "enter" && token.type === "codeFenced"
      continue
    }
    if (kind !== "enter") continue
    const { offset: from } = token.start
    let { offset: to } = token.end
    const raw = markdown.slice(from, to)
    let value = raw
    if (token.type === "lineEnding" || (mode === "blockCode" && token.type === "lineEndingBlank")) {
      if (skipFenceOpening) {
        skipFenceOpening = false
        continue
      }
      const ending = /^(?:\r\n|[\r\n])/.exec(raw)?.[0]
      if (!ending) continue
      to = from + ending.length
      value = mode === "inlineCode" ? " " : ending
    } else if (mode !== "text") {
      if (mode === "inlineCode" ? token.type !== "codeTextData" : token.type !== "codeFlowValue")
        continue
    } else if (token.type === "characterEscape") value = raw.slice(1)
    else if (token.type === "characterReference") {
      const match = referenceSource.exec(raw)
      if (match) value = decodeReference(match[1], match[2], match[3]) ?? raw
    } else if (token.type !== "data") continue
    if (value.includes("\0")) value = value.replaceAll("\0", "\uFFFD")
    tokens.push({ from, to, value, mode })
  }
  return tokens
}

function positionedTextSpans(
  tokens: readonly MarkdownSourceToken[],
  from: number,
  to: number,
  rendered: string,
  renderOffset: number,
  mode: MarkdownSourceToken["mode"]
): MarkdownSearchSpan[] {
  const spans: MarkdownSearchSpan[] = []
  let first = 0
  let upper = tokens.length
  while (first < upper) {
    const middle = (first + upper) >>> 1
    if (tokens[middle].from < from) first = middle + 1
    else upper = middle
  }
  let visible = 0
  for (let index = first; index < tokens.length && visible < rendered.length; index += 1) {
    const token = tokens[index]
    if (token.to > to) break
    if (token.mode !== mode) continue
    if (!rendered.startsWith(token.value, visible)) break
    spans.push({ start: renderOffset + visible, end: renderOffset + visible + token.value.length,
      sourceStart: token.from })
    visible += token.value.length
  }
  return spans
}

/** Match the same CommonMark/GFM text nodes ReactMarkdown mounts in a chat row. */
export function projectMarkdownVisibleText(
  markdown: string,
  trackSource = false
): MarkdownSearchProjection {
  const admission = markdownSearchAdmission(markdown)
  if (admission === "literal") {
    const text = markdown.endsWith("\n") ? markdown.slice(0, -1) : markdown
    return { text, truncated: false,
      ...(trackSource ? { sourceSpans: [{ start: 0, end: text.length, sourceStart: 0 }] } : {}) }
  }
  if (admission === "truncated") return { text: "", truncated: true }

  let tree: ReturnType<typeof markdownProcessor.runSync>
  try {
    tree = markdownProcessor.runSync(markdownProcessor.parse(markdown))
  } catch (error) {
    if (error instanceof RangeError) return { text: "", truncated: true }
    throw error
  }
  const pending = tree.children.map((node) => ({
    node, from: 0, to: markdown.length, mode: "text" as MarkdownSourceToken["mode"]
  })).reverse()
  const text: string[] = []
  const sourceSpans: MarkdownSearchSpan[] = []
  let tokens: MarkdownSourceToken[] | undefined
  let visibleLength = 0
  while (pending.length) {
    const entry = pending.pop()!
    const { node } = entry
    const from = node.position?.start.offset ?? entry.from
    const to = node.position?.end.offset ?? entry.to
    if (node.type === "text" || node.type === "raw") {
      // ReactMarkdown escapes raw HTML, so tag-shaped text remains visible.
      if (trackSource && node.value &&
          (node.position || entry.mode !== "text" || to - from <= node.value.length + 64)) {
        const original = markdown.slice(from, to)
        const offset = original.indexOf(node.value)
        if (offset >= 0 && original.indexOf(node.value, offset + 1) < 0) {
          sourceSpans.push({ start: visibleLength, end: visibleLength + node.value.length,
            sourceStart: from + offset })
        } else if (node.position || entry.mode !== "text") {
          tokens ??= visibleSourceTokens(markdown)
          sourceSpans.push(...positionedTextSpans(tokens, from, to, node.value, visibleLength, entry.mode))
        }
        // Some syntax extensions rewrite a whole node. Identical rendered
        // values in the very same original node still identify one occurrence.
        if (node.position || entry.mode !== "text") {
          sourceSpans.push({ start: visibleLength, end: visibleLength + node.value.length,
            sourceStart: from, sourceEnd: to })
        }
      }
      text.push(node.value)
      visibleLength += node.value.length
    } else if (node.type === "element") {
      if (node.tagName === "br") {
        text.push("\n")
        visibleLength += 1
      }
      if (isSearchNavigation(node.properties)) continue
      const mode = node.tagName === "pre" ? "blockCode" :
        node.tagName === "code" && entry.mode === "text" ? "inlineCode" : entry.mode
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        pending.push({ node: node.children[index], from, to, mode })
      }
    }
  }
  return { text: text.join(""), truncated: false, ...(trackSource ? { sourceSpans } : {}) }
}
