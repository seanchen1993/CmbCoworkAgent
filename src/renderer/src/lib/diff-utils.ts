export type DiffRowType = "file" | "hunk" | "add" | "del" | "context"

export interface DiffRow {
  type: DiffRowType
  text: string
}

/** Drop git metadata lines that add noise without informing the reviewer. */
const DIFF_METADATA_LINE =
  /^(index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename (from|to)|copy (from|to)|GIT binary patch|Binary files)/

/**
 * Parse a unified diff into display rows. File-header lines collapse into a single
 * filename row, metadata is dropped, and +/- markers are stripped (the gutter shows them),
 * so the body can wrap freely instead of forcing a wide horizontal scroll.
 */
export function parseUnifiedDiffRows(diff: string): DiffRow[] {
  const rows: DiffRow[] = []
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git")) {
      const match = raw.match(/ b\/(.+)$/)
      rows.push({ type: "file", text: match ? match[1] : raw.replace(/^diff --git\s+/, "") })
      continue
    }
    if (DIFF_METADATA_LINE.test(raw)) continue
    if (raw.startsWith("@@")) {
      rows.push({ type: "hunk", text: raw })
      continue
    }
    if (raw.startsWith("+")) {
      rows.push({ type: "add", text: raw.slice(1) })
      continue
    }
    if (raw.startsWith("-")) {
      rows.push({ type: "del", text: raw.slice(1) })
      continue
    }
    rows.push({ type: "context", text: raw.startsWith(" ") ? raw.slice(1) : raw })
  }
  return rows
}
