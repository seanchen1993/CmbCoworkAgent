// Extracted from Grok 0.18 recovered conversation/workspace/composer.tsx.
// Source and digest are recorded in PROVENANCE.json.
export function extractClipboardFiles(items: DataTransferItemList | null | undefined): File[] {
  if (items == null) return []
  const files: File[] = []
  for (const item of Array.from(items)) {
    if (item.kind !== "file") continue
    const file = item.getAsFile()
    if (file != null) files.push(file)
  }
  return files
}

export function hasFileDragData(types: Iterable<string> | null | undefined): boolean {
  if (types == null) return false
  for (const type of types) if (type === "Files") return true
  return false
}
