import type { CodeIndexSettings } from "./types"
import { EMBEDDING_MAX_RETRIES, EMBEDDING_RETRY_DELAY_MS } from "./constants"

export interface EmbeddingProvider {
  embedBatch(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>
  embedQuery(text: string): Promise<Float32Array>
  readonly dimensions: number
}

const EMBEDDING_TIMEOUT_MS = 30_000
// Most embedding models have ~8K token limit
// Estimate: ASCII ~4 chars/token, CJK ~1 char/token
const MAX_TOKENS = 8192
const CJK_REGEX = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = EMBEDDING_MAX_RETRIES,
  delayMs = EMBEDDING_RETRY_DELAY_MS,
  externalSignal?: AbortSignal,
): Promise<Response> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (externalSignal?.aborted) throw new Error("Aborted")
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS)
    const onExternalAbort = (): void => controller.abort()
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true })
    try {
      const response = await fetch(url, { ...init, signal: controller.signal })

      // Retry on 429 (rate limit) and 5xx (server errors)
      if ((response.status === 429 || response.status >= 500) && attempt < retries) {
        await response.text().catch(() => {}) // consume body to free connection
        const backoff = delayMs * Math.pow(2, attempt)
        const jitter = Math.random() * 0.3 * backoff
        await new Promise((r) => setTimeout(r, backoff + jitter))
        continue
      }
      return response
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      if (attempt < retries) {
        const backoff = delayMs * Math.pow(2, attempt)
        const jitter = Math.random() * 0.3 * backoff
        await new Promise((r) => setTimeout(r, backoff + jitter))
      }
    } finally {
      clearTimeout(timeout)
      externalSignal?.removeEventListener("abort", onExternalAbort)
    }
  }
  throw lastError ?? new Error("Embedding request failed after retries")
}

export class OpenAICompatibleEmbedder implements EmbeddingProvider {
  private baseUrl: string
  private apiKey: string
  private model: string
  readonly dimensions: number

  constructor(config: { baseUrl: string; apiKey?: string; model: string; dimensions: number }) {
    // Normalize: strip trailing slash and /embeddings suffix (we append it ourselves)
    this.baseUrl = config.baseUrl.replace(/\/embeddings\/?$/, "").replace(/\/$/, "")
    this.apiKey = config.apiKey ?? ""
    this.model = config.model
    this.dimensions = config.dimensions
  }

  async embedBatch(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`
    }

    // Truncate texts that exceed model's token limit
    // Estimate token count by CJK ratio: CJK chars ≈ 1 token each, ASCII ≈ 4 chars/token
    const truncated = texts.map((t) => {
      const cjkCount = (t.match(CJK_REGEX) || []).length
      const asciiCount = t.length - cjkCount
      const estimatedTokens = cjkCount + asciiCount / 4
      const limit = estimatedTokens <= MAX_TOKENS ? t.length : Math.floor(t.length * (MAX_TOKENS / estimatedTokens))
      return t.length > limit ? t.slice(0, limit) : t
    })

    const body: Record<string, unknown> = {
      model: this.model,
      input: truncated,
      encoding_format: "float",
    }
    // Only include dimensions for models that support it
    if (this.dimensions > 0) {
      body.dimensions = this.dimensions
    }

    const response = await fetchWithRetry(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }, undefined, undefined, signal)

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`Embedding API error ${response.status}: ${errText}`)
    }

    const json = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>
    }

    if (!json.data || json.data.length !== truncated.length) {
      throw new Error(`Embedding API returned ${json.data?.length ?? 0} results, expected ${truncated.length}`)
    }

    // Sort by index to match input order
    const sorted = json.data.sort((a, b) => a.index - b.index)
    return sorted.map((d) => new Float32Array(d.embedding))
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const results = await this.embedBatch([text])
    return results[0]
  }
}

export function createEmbedder(settings: CodeIndexSettings): EmbeddingProvider {
  return new OpenAICompatibleEmbedder({
    baseUrl: settings.embeddingBaseUrl,
    apiKey: settings.embeddingApiKey,
    model: settings.embeddingModel,
    dimensions: settings.embeddingDimensions,
  })
}
