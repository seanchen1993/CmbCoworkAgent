import { createRequire } from "module"
import type { SavedCodeExecTool } from "../../../code-exec/saved-tool-store"
import type { McpCapabilityTool } from "../../../mcp/capability-types"

const require = createRequire(import.meta.url)
const Segment = require("segment") as new () => {
  useDefault(): void
  doSegment(text: string, options?: { simple?: boolean; stripPunctuation?: boolean }): string[]
}

const segmenter = new Segment()
segmenter.useDefault()

type ToolSearchSource = "mcp" | "saved_tool"
export type ToolSearchCaller = "invoke_deferred_tool" | "code_exec"
type ToolSearchFieldBucket = "toolId" | "toolName" | "providerDisplayName" | "providerAlias" | "dependency"

interface SearchFieldTerms {
  exactPhrases: string[]
  prefixTerms: string[]
  keywordTerms: string[]
}

export interface ToolSearchDoc {
  toolId: string
  source: ToolSearchSource
  allowCallers: ToolSearchCaller[]
  description?: string
  visibility?: "eager" | "lazy"
  exactPhrases: Record<Exclude<ToolSearchFieldBucket, "dependency">, string[]>
  prefixTerms: Record<ToolSearchFieldBucket, string[]>
  keywordTerms: Record<Exclude<ToolSearchFieldBucket, "providerAlias">, string[]>
  descriptionTerms: string[]
}

export interface ExactSearchCandidate {
  toolId: string
  toolName?: string
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function deriveEnglishTokenVariant(token: string): string | null {
  if (token.length <= 3) return null
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`
  if (token.endsWith("es") && token.length > 4) return token.slice(0, -2)
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) return token.slice(0, -1)
  return null
}

function tokenizeBase(value: string): string[] {
  const tokens: string[] = []
  const chineseRegex = /[\u4e00-\u9fff]/
  const segmentPattern = /([\u4e00-\u9fff]+)|([^\u4e00-\u9fff]+)/g

  let match: RegExpExecArray | null
  while ((match = segmentPattern.exec(value)) !== null) {
    const segment = match[0]
    if (!segment.trim()) continue

    if (chineseRegex.test(segment)) {
      const chineseTokens = segmenter.doSegment(segment, { simple: true, stripPunctuation: true })
      for (const token of chineseTokens) {
        const normalized = normalizeLiteral(token)
        if (normalized) tokens.push(normalized)
      }
      continue
    }

    const englishTokens = normalizePhrase(segment)
      .split(/\s+/)
      .filter((token) => token.length > 1)
    tokens.push(...englishTokens)
  }

  return unique(tokens)
}

function normalizeLiteral(value: string): string {
  return value.trim().toLowerCase()
}

function normalizePhrase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

function tokenize(value: string): string[] {
  const expanded: string[] = []
  for (const token of tokenizeBase(value)) {
    expanded.push(token)
    const variant = deriveEnglishTokenVariant(token)
    if (variant) expanded.push(variant)
  }
  return unique(expanded)
}

const GENERIC_ACTION_TOKENS = new Set([
  "add",
  "browse",
  "close",
  "create",
  "delete",
  "edit",
  "get",
  "list",
  "open",
  "read",
  "remove",
  "search",
  "set",
  "show",
  "update",
  "write"
])

function weightedScore(baseScore: number, token: string): number {
  if (!GENERIC_ACTION_TOKENS.has(token)) return baseScore
  return Math.max(Math.round(baseScore * 0.35), 1)
}

interface QueryTokenGroup {
  primary: string
  variants: string[]
}

interface RequiredSearchTerm {
  literal: string
  phrase: string
  tokenGroups: QueryTokenGroup[]
}

function buildQueryTokenGroups(query: string): QueryTokenGroup[] {
  return tokenizeBase(query).map((token) => {
    const variant = deriveEnglishTokenVariant(token)
    return {
      primary: token,
      variants: unique([token, ...(variant ? [variant] : [])])
    }
  })
}

function splitRawQueryTerms(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean)
}

function buildRequiredSearchTerms(query: string): RequiredSearchTerm[] {
  return splitRawQueryTerms(query)
    .filter((term) => term.startsWith("+") && term.length > 1)
    .map((term) => term.slice(1).trim())
    .filter(Boolean)
    .map((term) => ({
      literal: normalizeLiteral(term),
      phrase: normalizePhrase(term),
      tokenGroups: buildQueryTokenGroups(term)
    }))
}

function buildSearchFieldTerms(value: string, options?: { includeKeywordTerms?: boolean }): SearchFieldTerms {
  if (!value.trim()) {
    return {
      exactPhrases: [],
      prefixTerms: [],
      keywordTerms: []
    }
  }

  const literal = normalizeLiteral(value)
  const phrase = normalizePhrase(value)
  const tokens = tokenize(value)

  return {
    exactPhrases: unique([literal, phrase]),
    prefixTerms: unique([literal, phrase, ...tokens]),
    keywordTerms: options?.includeKeywordTerms === false ? [] : tokens
  }
}

export function matchesExactSearchValue(value: string, query: string): boolean {
  if (!value.trim() || !query.trim()) return false
  return normalizeLiteral(value) === normalizeLiteral(query) || normalizePhrase(value) === normalizePhrase(query)
}

export function findExactToolIdOrNameMatches<T extends ExactSearchCandidate>(items: T[], query: string): T[] {
  const toolIdMatches = items.filter((item) => matchesExactSearchValue(item.toolId, query))
  if (toolIdMatches.length > 0) return toolIdMatches

  return items.filter((item) => {
    return typeof item.toolName === "string" && matchesExactSearchValue(item.toolName, query)
  })
}

function extractDependencyTerms(dependencies: string[]): SearchFieldTerms {
  const fields = dependencies.map((dependency) => buildSearchFieldTerms(dependency))
  return {
    exactPhrases: unique(fields.flatMap((field) => field.exactPhrases)),
    prefixTerms: unique(fields.flatMap((field) => field.prefixTerms)),
    keywordTerms: unique(fields.flatMap((field) => field.keywordTerms))
  }
}

export function buildMcpToolSearchDoc(
  tool: McpCapabilityTool,
  options?: { allowCallers?: ToolSearchCaller[] }
): ToolSearchDoc {
  const toolIdTerms = buildSearchFieldTerms(tool.toolId)
  const toolNameTerms = buildSearchFieldTerms(tool.toolName)
  const providerDisplayNameTerms = buildSearchFieldTerms(tool.providerDisplayName)
  const providerAliasTerms = buildSearchFieldTerms(tool.providerAlias, { includeKeywordTerms: false })

  return {
    toolId: tool.toolId,
    source: "mcp",
    allowCallers: options?.allowCallers ?? ["invoke_deferred_tool", "code_exec"],
    description: tool.description,
    visibility: tool.visibility,
    exactPhrases: {
      toolId: toolIdTerms.exactPhrases,
      toolName: toolNameTerms.exactPhrases,
      providerDisplayName: providerDisplayNameTerms.exactPhrases,
      providerAlias: providerAliasTerms.exactPhrases
    },
    prefixTerms: {
      toolId: toolIdTerms.prefixTerms,
      toolName: toolNameTerms.prefixTerms,
      providerDisplayName: providerDisplayNameTerms.prefixTerms,
      providerAlias: providerAliasTerms.prefixTerms,
      dependency: []
    },
    keywordTerms: {
      toolId: toolIdTerms.keywordTerms,
      toolName: toolNameTerms.keywordTerms,
      providerDisplayName: providerDisplayNameTerms.keywordTerms,
      dependency: []
    },
    descriptionTerms: tokenize(tool.description ?? "")
  }
}

export function buildSavedToolSearchDoc(tool: SavedCodeExecTool): ToolSearchDoc {
  const toolIdTerms = buildSearchFieldTerms(tool.toolId)
  const dependencyTerms = extractDependencyTerms(tool.dependencies)

  return {
    toolId: tool.toolId,
    source: "saved_tool",
    allowCallers: ["invoke_deferred_tool"],
    description: tool.description,
    exactPhrases: {
      toolId: toolIdTerms.exactPhrases,
      toolName: [],
      providerDisplayName: [],
      providerAlias: []
    },
    prefixTerms: {
      toolId: toolIdTerms.prefixTerms,
      toolName: [],
      providerDisplayName: [],
      providerAlias: [],
      dependency: dependencyTerms.prefixTerms
    },
    keywordTerms: {
      toolId: toolIdTerms.keywordTerms,
      toolName: [],
      providerDisplayName: [],
      dependency: dependencyTerms.keywordTerms
    },
    descriptionTerms: tokenize(tool.description)
  }
}

function hasExactPhraseMatch(doc: ToolSearchDoc, queryLiteral: string, queryPhrase: string): boolean {
  const exactBuckets = [
    doc.exactPhrases.toolId,
    doc.exactPhrases.toolName,
    doc.exactPhrases.providerDisplayName,
    doc.exactPhrases.providerAlias
  ]

  return exactBuckets.some((phrases) => phrases.includes(queryLiteral) || phrases.includes(queryPhrase))
}

function hasPrefixMatch(terms: string[], queryLiteral: string, queryPhrase: string): boolean {
  if (!queryLiteral && !queryPhrase) return false
  return terms.some((term) => {
    return (queryLiteral.length > 0 && term.startsWith(queryLiteral))
      || (queryPhrase.length > 0 && term.startsWith(queryPhrase))
  })
}

function matchesAnyVariantInDoc(doc: ToolSearchDoc, variants: string[]): boolean {
  return variants.some((token) => {
    return doc.keywordTerms.toolId.includes(token)
      || doc.keywordTerms.toolName.includes(token)
      || doc.keywordTerms.providerDisplayName.includes(token)
      || doc.keywordTerms.dependency.includes(token)
      || doc.prefixTerms.providerAlias.some((term) => term === token || term.startsWith(token))
      || doc.descriptionTerms.includes(token)
  })
}

function matchesRequiredTerm(doc: ToolSearchDoc, requiredTerm: RequiredSearchTerm): boolean {
  const fieldPrefixMatch = hasPrefixMatch(doc.prefixTerms.toolId, requiredTerm.literal, requiredTerm.phrase)
    || hasPrefixMatch(doc.prefixTerms.toolName, requiredTerm.literal, requiredTerm.phrase)
    || hasPrefixMatch(doc.prefixTerms.providerAlias, requiredTerm.literal, requiredTerm.phrase)
    || hasPrefixMatch(doc.prefixTerms.providerDisplayName, requiredTerm.literal, requiredTerm.phrase)
    || hasPrefixMatch(doc.prefixTerms.dependency, requiredTerm.literal, requiredTerm.phrase)

  if (fieldPrefixMatch) return true
  if (requiredTerm.tokenGroups.length === 0) return false

  return requiredTerm.tokenGroups.every((group) => matchesAnyVariantInDoc(doc, group.variants))
}

function scoreExactAndPrefixMatches(doc: ToolSearchDoc, queryLiteral: string, queryPhrase: string): number {
  let score = 0

  if (doc.exactPhrases.toolId.includes(queryLiteral) || doc.exactPhrases.toolId.includes(queryPhrase)) score += 1600
  if (doc.exactPhrases.toolName.includes(queryLiteral) || doc.exactPhrases.toolName.includes(queryPhrase)) score += 1400
  if (
    doc.exactPhrases.providerAlias.includes(queryLiteral)
    || doc.exactPhrases.providerAlias.includes(queryPhrase)
  ) {
    score += 1100
  }
  if (
    doc.exactPhrases.providerDisplayName.includes(queryLiteral)
    || doc.exactPhrases.providerDisplayName.includes(queryPhrase)
  ) {
    score += 900
  }

  if (hasPrefixMatch(doc.prefixTerms.toolId, queryLiteral, queryPhrase)) score += 720
  if (hasPrefixMatch(doc.prefixTerms.toolName, queryLiteral, queryPhrase)) score += 620
  if (hasPrefixMatch(doc.prefixTerms.providerAlias, queryLiteral, queryPhrase)) score += 360
  if (hasPrefixMatch(doc.prefixTerms.providerDisplayName, queryLiteral, queryPhrase)) score += 300
  if (hasPrefixMatch(doc.prefixTerms.dependency, queryLiteral, queryPhrase)) score += 180

  return score
}

function scoreTokenMatches(doc: ToolSearchDoc, queryTokenGroups: QueryTokenGroup[]): { score: number; matchedTokens: number } {
  let score = 0
  const matched = new Set<string>()

  const markMatched = (token: string): void => {
    matched.add(token)
  }

  for (const group of queryTokenGroups) {
    const { primary, variants } = group

    if (variants.some((token) => doc.keywordTerms.toolId.includes(token))) {
      score += weightedScore(120, primary)
      markMatched(primary)
      continue
    }
    if (variants.some((token) => doc.prefixTerms.toolId.some((term) => term.startsWith(token)))) {
      score += weightedScore(90, primary)
      markMatched(primary)
    }

    if (variants.some((token) => doc.keywordTerms.toolName.includes(token))) {
      score += weightedScore(100, primary)
      markMatched(primary)
      continue
    }
    if (variants.some((token) => doc.prefixTerms.toolName.some((term) => term.startsWith(token)))) {
      score += weightedScore(75, primary)
      markMatched(primary)
    }

    if (variants.some((token) => doc.prefixTerms.providerAlias.some((term) => term === token || term.startsWith(token)))) {
      score += weightedScore(45, primary)
      markMatched(primary)
      continue
    }

    if (variants.some((token) => doc.keywordTerms.providerDisplayName.includes(token))) {
      score += weightedScore(55, primary)
      markMatched(primary)
      continue
    }
    if (variants.some((token) => doc.prefixTerms.providerDisplayName.some((term) => term.startsWith(token)))) {
      score += weightedScore(35, primary)
      markMatched(primary)
    }

    if (variants.some((token) => doc.keywordTerms.dependency.includes(token))) {
      score += weightedScore(45, primary)
      markMatched(primary)
      continue
    }
    if (variants.some((token) => doc.prefixTerms.dependency.some((term) => term.startsWith(token)))) {
      score += weightedScore(30, primary)
      markMatched(primary)
    }

    if (variants.some((token) => doc.descriptionTerms.includes(token))) {
      score += weightedScore(18, primary)
      markMatched(primary)
    }
  }

  return {
    score,
    matchedTokens: matched.size
  }
}

function scoreQueryCoverage(queryTokens: string[], matchedTokens: number): number {
  if (queryTokens.length === 0 || matchedTokens === 0) return 0
  if (queryTokens.length === matchedTokens && queryTokens.length > 1) return 120
  return matchedTokens * 20
}

function getMinimumMatchedTokens(queryTokens: string[]): number {
  if (queryTokens.length >= 4) return 2
  return 1
}

export function searchToolDocs(
  docs: ToolSearchDoc[],
  query: string,
  maxResults: number
): ToolSearchDoc[] {
  const queryLiteral = normalizeLiteral(query)
  const queryPhrase = normalizePhrase(query)
  const queryTokens = tokenizeBase(query)
  const queryTokenGroups = buildQueryTokenGroups(query)
  const requiredTerms = buildRequiredSearchTerms(query)

  if (!queryLiteral && queryTokens.length === 0) return []

  const ranked = docs
    .map((doc) => {
      const exactOrPrefixScore = scoreExactAndPrefixMatches(doc, queryLiteral, queryPhrase)
      const tokenScore = scoreTokenMatches(doc, queryTokenGroups)
      const coverageScore = scoreQueryCoverage(queryTokens, tokenScore.matchedTokens)
      const score = exactOrPrefixScore + tokenScore.score + coverageScore
      const minimumMatchedTokens = getMinimumMatchedTokens(queryTokens)

      if (score <= 0 && !hasExactPhraseMatch(doc, queryLiteral, queryPhrase)) {
        return null
      }

      if (requiredTerms.length > 0 && !requiredTerms.every((term) => matchesRequiredTerm(doc, term))) {
        return null
      }

      if (exactOrPrefixScore === 0 && tokenScore.matchedTokens < minimumMatchedTokens) {
        return null
      }

      return { doc, score }
    })
    .filter((item): item is { doc: ToolSearchDoc; score: number } => item != null)

  return ranked
    .sort((left, right) => right.score - left.score || left.doc.toolId.localeCompare(right.doc.toolId))
    .slice(0, maxResults)
    .map((item) => item.doc)
}
