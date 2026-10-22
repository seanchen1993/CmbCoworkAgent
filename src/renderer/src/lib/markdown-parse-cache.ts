import type { Root } from "mdast"
import type { Parser, Plugin } from "unified"

interface MarkdownParseCacheLimits {
  maxEntries: number
  maxBytes: number
  maxEntryBytes: number
  maxSourceCharacters: number
}

const DEFAULT_LIMITS: MarkdownParseCacheLimits = {
  maxEntries: 256,
  maxBytes: 16 * 1024 * 1024,
  maxEntryBytes: 1024 * 1024,
  maxSourceCharacters: 64 * 1024
}

/** One memory-only cache belongs to one fixed parser/grammar configuration. */
export class MarkdownParseCache {
  private readonly entries = new Map<string, { serialized: string; bytes: number }>()
  private readonly limits: MarkdownParseCacheLimits
  private bytes = 0
  private parses = 0
  private hits = 0
  private evictions = 0
  private parsedCharacters = 0
  private reusedCharacters = 0

  constructor(limits: Partial<MarkdownParseCacheLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS }
    for (const key of Object.keys(DEFAULT_LIMITS) as Array<keyof MarkdownParseCacheLimits>) {
      const value = limits[key]
      if (value !== undefined && Number.isFinite(value))
        this.limits[key] = Math.max(0, Math.min(DEFAULT_LIMITS[key], Math.floor(value)))
    }
  }

  parse(source: string, parse: () => Root): Root {
    const cacheable = source.length <= this.limits.maxSourceCharacters && this.limits.maxEntries > 0
    // A fragment can be a slice of a much larger message. Store a serialized key rather
    // than retaining its backing string; JSON encoding also preserves exact source identity.
    const key = cacheable ? JSON.stringify(source) : ""
    const cached = cacheable ? this.entries.get(key) : undefined
    if (cached) {
      this.entries.delete(key)
      this.entries.set(key, cached)
      this.hits++
      this.reusedCharacters += source.length
      // runSync and downstream plugins can mutate their input. Never share a live AST.
      return JSON.parse(cached.serialized) as Root
    }

    this.parses++
    this.parsedCharacters += source.length
    const tree = parse()
    if (!cacheable) return tree
    const serialized = JSON.stringify(tree)
    // Conservative UTF-16 string accounting, including a per-entry bookkeeping allowance.
    const bytes = (key.length + serialized.length) * 2 + 256
    if (bytes > this.limits.maxEntryBytes || bytes > this.limits.maxBytes) return tree
    while (
      this.entries.size >= this.limits.maxEntries ||
      this.bytes + bytes > this.limits.maxBytes
    ) {
      const oldest = this.entries.entries().next().value
      if (!oldest) break
      this.entries.delete(oldest[0])
      this.bytes -= oldest[1].bytes
      this.evictions++
    }
    // Serialize before returning the original tree: later transformations cannot poison it.
    this.entries.set(key, { serialized, bytes })
    this.bytes += bytes
    return tree
  }

  stats() {
    return {
      entries: this.entries.size,
      bytes: this.bytes,
      parses: this.parses,
      hits: this.hits,
      evictions: this.evictions,
      parsedCharacters: this.parsedCharacters,
      reusedCharacters: this.reusedCharacters
    }
  }

  clear(): void {
    this.entries.clear()
    this.bytes = this.parses = this.hits = this.evictions = 0
    this.parsedCharacters = this.reusedCharacters = 0
  }
}

/** Wrap only the public unified parser; transformations and rendering still run normally. */
export function createRemarkParseCache(cache: MarkdownParseCache): Plugin<[], Root> {
  return function () {
    const parse = this.parser as Parser<Root> | undefined
    if (!parse) return
    this.parser = (source, file) => cache.parse(source, () => parse(source, file))
  }
}

// remark-parse 11 + remark-gfm 4 with default options, recreated with each renderer build.
// Never use this instance with custom grammar plugins, settings, or streaming fragments.
export const completedMarkdownParseCache = new MarkdownParseCache()
export const remarkCompletedMarkdownParseCache = createRemarkParseCache(completedMarkdownParseCache)

// Same grammar, but live suffixes are counted without retaining every token's AST.
export const streamingMarkdownParseMetrics = new MarkdownParseCache({ maxEntries: 0 })
export const remarkStreamingMarkdownParse = createRemarkParseCache(streamingMarkdownParseMetrics)
// The caller proves that these fenced-code prefixes cannot change when text appends.
export const stableMarkdownPrefixCache = new MarkdownParseCache({
  maxEntries: 64,
  maxBytes: 4 * 1024 * 1024
})
export const remarkStableMarkdownPrefixCache = createRemarkParseCache(stableMarkdownPrefixCache)
