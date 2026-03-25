import type { CodeIndexStore } from "./store"
import type { EmbeddingProvider } from "./embedder"
import type { CodeSearchResult } from "./types"
import { VECTOR_WEIGHT, FTS_WEIGHT, DEFAULT_SEARCH_LIMIT, MIN_SEARCH_SCORE } from "./constants"

/**
 * Cosine similarity between two Float32Arrays.
 * Assumes vectors are normalized by the embedding API (most are).
 * Falls back to full formula for safety.
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

/**
 * Hybrid search: vector similarity + FTS keyword matching.
 *
 * 1. Embed the query
 * 2. Brute-force cosine similarity against all stored embeddings
 * 3. FTS3 keyword search (BM25 + LIKE for CJK)
 * 4. Merge results with configurable weights
 * 5. Sort by combined score, return top-K
 */
export async function hybridSearch(
  store: CodeIndexStore,
  embedder: EmbeddingProvider | null,
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
  vectorWeight: number = VECTOR_WEIGHT,
  ftsWeight: number = FTS_WEIGHT,
): Promise<CodeSearchResult[]> {
  // Step 1: Embed query
  let queryEmbedding: Float32Array | null = null
  if (embedder) {
    try {
      queryEmbedding = await embedder.embedQuery(query)
    } catch (e) {
      console.warn("[CodeSearch] Embedding failed, FTS-only:", e)
    }
  }

  // Step 2: Vector search (brute force cosine)
  const vectorResults = new Map<string, { score: number; chunk: ReturnType<CodeIndexStore["getAllEmbeddings"]>[0] }>()
  if (queryEmbedding) {
    const allEmbeddings = store.getAllEmbeddings()
    for (const chunk of allEmbeddings) {
      const sim = cosineSimilarity(queryEmbedding, chunk.embedding)
      if (sim > MIN_SEARCH_SCORE) {
        const key = `${chunk.filePath}:${chunk.startLine}`
        const existing = vectorResults.get(key)
        if (!existing || sim > existing.score) {
          vectorResults.set(key, { score: sim, chunk })
        }
      }
    }
  }

  // Step 3: FTS search
  const ftsResults = store.searchFTS(query, limit * 3)

  // Normalize FTS scores to 0-1 range
  let maxFtsScore = 0
  for (const r of ftsResults) {
    if (r.ftsScore > maxFtsScore) maxFtsScore = r.ftsScore
  }
  const normalizedFts = ftsResults.map((r) => ({
    ...r,
    ftsScore: maxFtsScore > 0 ? r.ftsScore / maxFtsScore : 0,
  }))

  // Step 4: Merge
  const merged = new Map<string, CodeSearchResult>()

  for (const [key, { score, chunk }] of vectorResults) {
    merged.set(key, {
      filePath: chunk.filePath,
      relativePath: chunk.relativePath,
      identifier: chunk.identifier,
      type: chunk.type,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      content: chunk.content,
      score: vectorWeight * score,
      vectorScore: score,
      ftsScore: 0,
    })
  }

  for (const fts of normalizedFts) {
    const key = `${fts.filePath}:${fts.startLine}`
    const existing = merged.get(key)
    if (existing) {
      existing.ftsScore = fts.ftsScore
      existing.score = vectorWeight * existing.vectorScore + ftsWeight * fts.ftsScore
    } else {
      merged.set(key, {
        filePath: fts.filePath,
        relativePath: fts.relativePath,
        identifier: fts.identifier,
        type: fts.type,
        startLine: fts.startLine,
        endLine: fts.endLine,
        content: fts.content,
        score: ftsWeight * fts.ftsScore,
        vectorScore: 0,
        ftsScore: fts.ftsScore,
      })
    }
  }

  // Step 5: Sort and limit
  return Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}
