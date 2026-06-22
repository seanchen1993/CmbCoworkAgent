/**
 * Unit tests for dashboard raw ES query guardrails.
 *
 * Run:
 *   npx tsx tests/dashboard-es-query.spec.ts
 */

import {
  prepareDashboardEsQuery,
  type DashboardEsQueryInput
} from "../src/main/services/dashboard-es-query.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function parseBody(prepared: ReturnType<typeof prepareDashboardEsQuery>): Record<string, unknown> {
  assert(typeof prepared.bodyText === "string", "expected request body")
  return JSON.parse(prepared.bodyText ?? "{}") as Record<string, unknown>
}

const baseOptions = {
  indexByAlias: {
    event: "devclaw_event",
    trace: "devclaw_trace"
  },
  injectedFilters: [{ term: { upperOrgLv1: "开发一室" } }],
  access: { sapId: "1001", ystId: "yst-1001", unrestricted: false }
} as const

function testSearchIsReadOnlyAndRewritten(): void {
  const prepared = prepareDashboardEsQuery(
    {
      indexAlias: "event",
      operation: "search",
      body: {
        size: 50000,
        query: { term: { eventName: "code_gen" } },
        _source: ["eventName", "userMessage", "properties.filePath"],
        aggs: {
          by_user: {
            terms: { field: "sapId", size: 99999 }
          }
        }
      }
    },
    baseOptions
  )

  assert(prepared.method === "POST", "search should use POST")
  assert(prepared.path === "/devclaw_event/_search?timeout=10s", "search path should be fixed")
  const body = parseBody(prepared)
  assert(body.size === 1000, "root size should be clamped to hard limit")
  assert(body.track_total_hits === false, "track_total_hits should default false")
  const source = body._source as Record<string, unknown>
  assert(JSON.stringify(source.includes) === JSON.stringify(["eventName"]), "sensitive source fields should be removed")
  assert(
    Array.isArray(source.excludes) && source.excludes.includes("properties.filePath"),
    "sensitive source excludes should always be appended"
  )
  const query = body.query as Record<string, unknown>
  assert(Boolean((query.bool as Record<string, unknown>).filter), "injected filters should be appended")
  const aggs = body.aggs as Record<string, unknown>
  const byUser = aggs.by_user as Record<string, unknown>
  const terms = byUser.terms as Record<string, unknown>
  assert(terms.size === 5000, "aggregation size should be clamped")
}

function testUnsupportedWriteOperationIsRejected(): void {
  let failed = false
  try {
    prepareDashboardEsQuery(
      {
        indexAlias: "event",
        operation: "update_by_query" as DashboardEsQueryInput["operation"],
        body: { script: { source: "ctx._source.x = 1" } }
      },
      baseOptions
    )
  } catch (error) {
    failed = error instanceof Error && error.message.includes("Unsupported dashboard ES operation")
  }
  assert(failed, "write-like operation should be rejected by operation allowlist")
}

function testUnknownIndexAliasIsRejected(): void {
  let failed = false
  try {
    prepareDashboardEsQuery(
      {
        indexAlias: "all" as DashboardEsQueryInput["indexAlias"],
        operation: "search",
        body: {}
      },
      baseOptions
    )
  } catch (error) {
    failed = error instanceof Error && error.message.includes("index alias is not allowed")
  }
  assert(failed, "unknown index alias should be rejected")
}

function testMsearchRemovesHeaderIndexOverride(): void {
  const prepared = prepareDashboardEsQuery(
    {
      indexAlias: "trace",
      operation: "msearch",
      body: {
        searches: [
          {
            header: { index: "other_index", preference: "local" },
            body: { size: 1, query: { match_all: {} } }
          }
        ]
      }
    },
    baseOptions
  )
  assert(prepared.contentType === "application/x-ndjson", "msearch should use NDJSON")
  assert(prepared.path === "/devclaw_trace/_msearch?timeout=10s", "msearch path should use alias index")
  assert(prepared.bodyText?.startsWith('{"preference":"local"}\n') === true, "header index override should be removed")
  assert(prepared.warnings.some((item) => item.includes("header index override")), "warning should mention header override")
}

function testOversizedTermsIsRejected(): void {
  let failed = false
  try {
    prepareDashboardEsQuery(
      {
        indexAlias: "event",
        operation: "search",
        body: {
          query: {
            terms: {
              sapId: Array.from({ length: 10_001 }, (_, index) => String(index))
            }
          }
        }
      },
      baseOptions
    )
  } catch (error) {
    failed = error instanceof Error && error.message.includes("exceeding 10000")
  }
  assert(failed, "oversized terms array should be rejected")
}

function testMappingIsReadOnlyGet(): void {
  const prepared = prepareDashboardEsQuery(
    { indexAlias: "event", operation: "mapping" },
    baseOptions
  )
  assert(prepared.method === "GET", "mapping should use GET")
  assert(prepared.path === "/devclaw_event/_mapping", "mapping path should be fixed")
  assert(prepared.bodyText === undefined, "mapping should not send body")
}

function run(): void {
  testSearchIsReadOnlyAndRewritten()
  console.log("PASS dashboard ES search guardrails")
  testUnsupportedWriteOperationIsRejected()
  console.log("PASS dashboard ES write operation rejection")
  testUnknownIndexAliasIsRejected()
  console.log("PASS dashboard ES index alias rejection")
  testMsearchRemovesHeaderIndexOverride()
  console.log("PASS dashboard ES msearch header guard")
  testOversizedTermsIsRejected()
  console.log("PASS dashboard ES terms guard")
  testMappingIsReadOnlyGet()
  console.log("PASS dashboard ES mapping guard")
}

run()
