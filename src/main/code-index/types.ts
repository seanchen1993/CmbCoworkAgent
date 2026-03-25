// ── Code Block (output of parser) ──

export interface CodeBlock {
  filePath: string
  relativePath: string
  identifier: string | null
  type: string
  startLine: number
  endLine: number
  content: string
  fileHash: string
  segmentHash: string
}

// ── Stored chunk (in database, with embedding) ──

export interface IndexedChunk {
  id: number
  filePath: string
  relativePath: string
  identifier: string | null
  type: string
  startLine: number
  endLine: number
  content: string
  embedding: Float32Array
}

// ── Search result ──

export interface CodeSearchResult {
  filePath: string
  relativePath: string
  identifier: string | null
  type: string
  startLine: number
  endLine: number
  content: string
  score: number
  vectorScore: number
  ftsScore: number
}

// ── FTS search result (intermediate) ──

export interface FtsSearchResult {
  filePath: string
  relativePath: string
  identifier: string | null
  type: string
  startLine: number
  endLine: number
  content: string
  ftsScore: number
}

// ── Embedding provider config ──

export interface CodeIndexSettings {
  enabled: boolean
  embeddingProvider: "openai-compatible"
  embeddingBaseUrl: string
  embeddingApiKey: string
  embeddingModel: string
  embeddingDimensions: number
  vectorWeight: number
  ftsWeight: number
}

// ── Indexing status ──

export type IndexingState = "idle" | "scanning" | "indexing" | "indexed" | "error"

export interface IndexingStatus {
  state: IndexingState
  message: string
  totalFiles: number
  processedFiles: number
  totalChunks: number
  embeddedChunks: number
  workspacePath: string | null
}
