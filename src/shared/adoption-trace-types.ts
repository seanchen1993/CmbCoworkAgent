export type LocalGeneratedLineStatus =
  | "adopted"
  | "not_adopted"
  | "superseded_by_agent"
  | "deleted"
  | "unknown"

export interface LocalGeneratedLineDetail {
  lineNumber: number
  text: string
  status: LocalGeneratedLineStatus
}

export interface LocalAdoptionLine {
  lineNumber: number
  text: string
  adopted: boolean
}

export interface LocalGenAdoptionLines {
  genEventId: string
  available: boolean
  source?: "stored_gen" | "commit_match"
  reason?: string
  relPath?: string
  generatedLineCount?: number
  effectiveLineCount?: number
  matchedLineCount?: number
  notAdoptedLineCount?: number
  supersededLineCount?: number
  truncated?: boolean
  generatedLines?: LocalGeneratedLineDetail[]
  lines?: LocalAdoptionLine[]
}
