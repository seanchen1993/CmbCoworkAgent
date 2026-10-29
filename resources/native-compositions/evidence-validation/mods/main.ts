import type { Register } from "devclaw-mods"

type Row = { artifactId: string; path: string; bytes: number; sha256: string; maxBytes: number }
type Reference = { protocol: string; current: Row; sources: Row[] }
type Citation = { sourceId: string; quote: string }
type Summary = { summary: string; citations: Citation[] }
type Sources = { sources: { id: string; text: string }[] }

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

function referenceRows(value: unknown): Row[] {
  if (!record(value) || value.protocol !== "devclaw.artifact-input/v1" ||
    !record(value.current) || !Array.isArray(value.sources) || value.sources.length > 7)
    throw Error("EVIDENCE_REFERENCE_REQUIRED")
  const rows = [value.current, ...value.sources] as Row[]
  const ids = new Set<string>(), paths = new Set<string>()
  for (const row of rows) {
    if (!record(row) || typeof row.artifactId !== "string" ||
      !/^[a-zA-Z0-9][\w.-]{0,63}$/.test(row.artifactId) || ids.has(row.artifactId) ||
      typeof row.path !== "string" || row.path.length > 512 || paths.has(row.path.toLowerCase()) ||
      // eslint-disable-next-line no-control-regex -- Artifact paths must reject C0 controls.
      /[\\:\x00-\x1f]/.test(row.path) || row.path.split("/").some((part) =>
        !part || part === "." || part === ".." || /[. ]$/.test(part)) ||
      typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256) ||
      !Number.isInteger(row.bytes) || row.bytes < 1 || row.bytes > 64 * 1024 ||
      !Number.isInteger(row.maxBytes) || row.maxBytes < row.bytes || row.maxBytes > 512 * 1024)
      throw Error("EVIDENCE_REFERENCE_INVALID")
    ids.add(row.artifactId)
    paths.add(row.path.toLowerCase())
  }
  return rows
}

function sources(value: unknown): Sources {
  if (!record(value) || !Array.isArray(value.sources) || !value.sources.length ||
    value.sources.length > 100) throw Error("EVIDENCE_SOURCES_INVALID")
  const ids = new Set<string>()
  for (const source of value.sources) {
    if (!record(source) || typeof source.id !== "string" || !source.id.trim() ||
      source.id.length > 100 || ids.has(source.id) || typeof source.text !== "string" ||
      !source.text.trim() || source.text.length > 16000) throw Error("EVIDENCE_SOURCES_INVALID")
    ids.add(source.id)
  }
  return value as Sources
}

function summary(value: unknown): Summary {
  if (!record(value) || typeof value.summary !== "string" || !value.summary.trim() ||
    value.summary.length > 16000 || !Array.isArray(value.citations) ||
    !value.citations.length || value.citations.length > 100)
    throw Error("EVIDENCE_SUMMARY_INVALID")
  for (const citation of value.citations) {
    if (!record(citation) || typeof citation.sourceId !== "string" ||
      typeof citation.quote !== "string" || !citation.quote.trim() || citation.quote.length > 8000)
      throw Error("EVIDENCE_CITATION_INVALID")
  }
  return value as Summary
}

/** Deterministic quotations only. This does not establish truth, entailment or causality. */
function citationErrors(document: Summary, original: Sources): string[] {
  const errors: string[] = []
  for (const [index, citation] of document.citations.entries()) {
    const source = original.sources.find((item) => item.id === citation.sourceId)
    if (!source) errors.push("CITATION_SOURCE_MISSING:" + index)
    else if (!source.text.includes(citation.quote)) errors.push("CITATION_QUOTE_MISMATCH:" + index)
  }
  return errors
}

export const register: Register<"evidence-validation"> = (on) => {
  on.capability({
    apiVersion: "devclaw.capability/v1", id: "evidence-validation", version: "1.0.0",
    title: "来源与摘要衔接校验", scope: "conversation", stateSchema: { type: "object" },
    actions: [
      { id: "check-citations", title: "核对来源逐字引用",
        inputSchema: { type: "object" }, outputSchema: { type: "object" },
        requiredPermissions: ["fs.read"], cancellable: true, idempotency: "keyed" },
      { id: "check-report", title: "核对报告沿用上游摘要",
        inputSchema: { type: "object" }, outputSchema: { type: "object" },
        requiredPermissions: ["fs.read"], cancellable: true, idempotency: "keyed" }
    ]
  }, {
    act: async ($, event) => {
      const envelope = event.input
      if (envelope.version !== 1 || !record(envelope.config)) throw Error("EVIDENCE_ENVELOPE_INVALID")
      const config = envelope.config
      if (typeof config.sourceArtifactId !== "string" ||
        (event.action !== "check-citations" && event.action !== "check-report"))
        throw Error("EVIDENCE_CONFIGURATION_INVALID")
      const rows = referenceRows(envelope.input)
      const ref = envelope.input as unknown as Reference
      const sourceRow = ref.sources.find((row) => row.artifactId === config.sourceArtifactId)
      const summaryRow = event.action === "check-report"
        ? ref.sources.find((row) => row.artifactId === config.summaryArtifactId) : undefined
      if (!sourceRow || (event.action === "check-report" && !summaryRow))
        throw Error("EVIDENCE_DECLARED_INPUT_MISSING")
      const wanted = new Set([ref.current.artifactId, sourceRow.artifactId, summaryRow?.artifactId])
      const loaded: Record<string, unknown> = {}
      for (const row of rows) {
        if (!wanted.has(row.artifactId)) continue
        // These paths come from the original Host check input, not the generated document.
        // Host captures and rechecks all descriptors before accepting its own receipt.
        const text = await $.fs.read(row.path)
        if (typeof text !== "string" || text.length > 64 * 1024) throw Error("EVIDENCE_FILE_INVALID")
        loaded[row.artifactId] = JSON.parse(text)
      }
      const current = summary(loaded[ref.current.artifactId])
      const original = sources(loaded[sourceRow.artifactId])
      const errors = citationErrors(current, original)
      if (summaryRow) {
        const prior = summary(loaded[summaryRow.artifactId])
        errors.push(...citationErrors(prior, original))
        if (current.summary !== prior.summary) errors.push("REPORT_SUMMARY_CHANGED")
        if (JSON.stringify(current.citations.map((item) => [item.sourceId, item.quote])) !==
          JSON.stringify(prior.citations.map((item) => [item.sourceId, item.quote])))
          errors.push("REPORT_CITATIONS_CHANGED")
      }
      return {
        status: errors.length ? "failed" : "succeeded",
        text: errors.length ? "来源或上游衔接校验未通过" : "逐字引用与约定字段衔接已通过",
        output: { passed: errors.length === 0, errors: errors.map((code) => ({ code })), warnings: [],
          scope: "exact-quotes-and-field-equality-only" }
      }
    }
  })
}
