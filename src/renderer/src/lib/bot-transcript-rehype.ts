import type { Element, ElementContent, Root, RootContent } from "hast"

// Grok 0.75 clt/hG: missing values do not make a numeric column textual; the
// first column remains a label. Preserve the source text instead of padding it.
const MISSING = /^(?:n\.m\.|NM|n\/m|N\/A|n\/a|NA|—|–|--?)$/u
const NUMBER =
  /^[~≈]?(\()?([-+−])?[$€£¥₹]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?( ?(?:%|x|bps|pp|[KMBT]))?(\))?( ?(?:%|x|bps|pp|[KMBT]))?([*†‡]*)$/u

function numericText(node: ElementContent): string | null {
  if (node.type === "text") return node.value
  if (node.type !== "element" || !["th", "td", "strong"].includes(node.tagName)) return null
  const parts = node.children.map(numericText)
  return parts.includes(null) ? null : parts.join("")
}

function numericValue(value: string): boolean {
  const match = NUMBER.exec(value)
  return Boolean(
    match &&
    (match[1] === undefined) === (match[4] === undefined) &&
    !(match[1] && match[2]) &&
    !(match[3] && match[5])
  )
}

function markNumericColumns(table: Element): void {
  const sections = table.children.filter((node): node is Element => node.type === "element")
  const rows = (section: Element) =>
    section.children.filter(
      (node): node is Element => node.type === "element" && node.tagName === "tr"
    )
  const cells = (row: Element) =>
    row.children.filter(
      (node): node is Element => node.type === "element" && ["td", "th"].includes(node.tagName)
    )
  const body = sections
    .filter((section) => section.tagName === "tbody")
    .flatMap(rows)
    .map(cells)
  const allRows = sections.flatMap(rows).map(cells)
  for (let column = 1; column < (allRows[0]?.length ?? 0); column++) {
    const values = body.map((row) =>
      row[column] ? (numericText(row[column])?.trim() ?? null) : ""
    )
    const present = values.filter(
      (value) => value !== "" && (value === null || !MISSING.test(value))
    )
    if (!present.length || !present.every((value) => value !== null && numericValue(value)))
      continue
    for (const row of allRows) {
      const cell = row[column]
      if (!cell) continue
      cell.properties["data-bot-numeric"] = "true"
      // Only numeric cells override GFM alignment, as in Grok's enhanced table.
      delete cell.properties.style
    }
  }
}

/** Presentation within one existing Markdown parse/message, never new messages. */
export function rehypeBotTranscript() {
  return (tree: Root): void => {
    const children: RootContent[] = []
    let prose: ElementContent[] = []
    const flush = () => {
      if (prose.some((node) => node.type !== "text" || node.value.trim())) {
        children.push({
          type: "element",
          tagName: "div",
          properties: { "data-bot-prose": "true" },
          children: prose
        })
      }
      prose = []
    }
    for (const node of tree.children) {
      if (node.type === "element" && node.tagName === "table") {
        flush()
        markNumericColumns(node)
        children.push(node)
      } else if (node.type !== "doctype") {
        prose.push(node)
      }
    }
    flush()
    // Keep the first prose wrapper from the initial streamed paragraph onward.
    // A later table appends siblings instead of remounting that paragraph.
    tree.children = children
  }
}
