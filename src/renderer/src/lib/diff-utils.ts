import { diffLines } from "diff"

export type DiffRowType = "file" | "hunk" | "add" | "del" | "context"

const VIRTUAL_LINE_DIFF_TIMEOUT_MS = 250

export interface DiffRow {
  type: DiffRowType
  text: string
}

function splitDiffChangeLines(value: string): string[] {
  if (!value) return []
  return value.replace(/\n$/, "").split("\n")
}

/**
 * Build virtual-list rows from the two reconstructed sides of a diff.
 *
 * This deliberately uses the same line comparison algorithm as
 * react-diff-viewer-continued. Replaying raw unified-diff rows is not equivalent:
 * a coarse hunk can encode a few scattered edits as one large delete block followed
 * by one large add block, even though most lines on both sides are unchanged.
 */
export function buildLineDiffRows(
  oldContent: string,
  newContent: string,
  filePath?: string
): DiffRow[] {
  const rows: DiffRow[] = filePath ? [{ type: "file", text: filePath }] : []
  const changes = diffLines(oldContent, newContent, {
    newlineIsToken: false,
    timeout: VIRTUAL_LINE_DIFF_TIMEOUT_MS
  })

  // Protect the renderer from pathological inputs. Sparse edits finish well below
  // the limit; a timeout falls back to a valid full replacement representation.
  if (!changes) {
    for (const line of splitDiffChangeLines(oldContent)) rows.push({ type: "del", text: line })
    for (const line of splitDiffChangeLines(newContent)) rows.push({ type: "add", text: line })
    return rows
  }

  for (const change of changes) {
    const type: DiffRowType = change.added ? "add" : change.removed ? "del" : "context"
    for (const line of splitDiffChangeLines(change.value)) {
      rows.push({ type, text: line })
    }
  }

  return rows
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
