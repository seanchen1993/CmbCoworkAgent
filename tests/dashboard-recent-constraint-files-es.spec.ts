/**
 * Real ES regression: DASHBOARD_TEST_ES_URL=http://127.0.0.1:19210 npx tsx tests/dashboard-recent-constraint-files-es.spec.ts
 * Uses temporary indices on a local test server only; never loads production .env.
 */
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Worker } from "node:worker_threads"
import { build } from "esbuild"
import {
  DashboardEsWorkerClient,
  type DashboardEsQueryRequest
} from "../src/main/services/dashboard-es-client"
import { prepareDashboardFieldCapsRequest } from "../src/main/services/dashboard-es-field-caps-request"
import {
  fetchRecentConstraintFiles,
  resolveRecentConstraintFields
} from "../src/main/ipc/dashboard-recent-constraint-files"
import { buildUserProfileIdFilter } from "../src/main/ipc/dashboard-user-profile-query"

const base = new URL(process.env.DASHBOARD_TEST_ES_URL ?? "http://127.0.0.1:19210")
assert(
  ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname),
  "Only a local test ES is allowed"
)
const prefix = `dashboard-regression-${Date.now()}`
const indices = ["native", "legacy", "empty", "users"].map((kind) => `${prefix}-${kind}`)
const directory = mkdtempSync(join(tmpdir(), "dashboard-es-regression-"))
const bundle = join(directory, "worker.cjs")
const now = new Date("2026-10-13T11:30:00.000Z")
const recent = now.toISOString()
const old = "2026-09-01T00:00:00.000Z"
const capsFields = [
  "properties.constraintFiles",
  "properties.constraintFiles.keyword",
  "properties.pluginId",
  "properties.pluginId.keyword",
  "properties.pluginName",
  "properties.pluginName.keyword",
  "properties.harnessAdapterName",
  "properties.harnessAdapterName.keyword",
  "properties.lastReadAt"
]
let client: DashboardEsWorkerClient | undefined

async function admin(path: string, method: string, body?: unknown) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000)
  })
  const data = await response.json()
  assert(response.ok, JSON.stringify(data))
  return data
}

async function bulk(index: string, docs: Record<string, unknown>[]) {
  const lines = docs.flatMap((doc) => [JSON.stringify({ index: {} }), JSON.stringify(doc)])
  const response = await fetch(new URL(`/${index}/_bulk?refresh=true`, base), {
    method: "POST",
    headers: { "content-type": "application/x-ndjson" },
    body: `${lines.join("\n")}\n`,
    signal: AbortSignal.timeout(20_000)
  })
  const data = await response.json()
  assert(response.ok && !data.errors, JSON.stringify(data).slice(0, 1000))
}

function readEvent(
  file: string,
  extra: Record<string, unknown> = {},
  org = "甲室",
  eventTime = recent
) {
  return {
    eventName: "harness.system_constraint.read_summary",
    eventTime,
    upperOrgLv1: org,
    properties: {
      harnessProjectId: "project",
      successfulReadCount: 1,
      filesTruncated: false,
      constraintFiles: [file],
      pluginId: "p",
      pluginName: "插件",
      harnessAdapterName: "插件",
      lastReadAt: recent,
      ...extra
    }
  }
}

async function main(): Promise<void> {
  // The app keeps Node alive; its reusable ES worker deliberately unrefs itself.
  const keepAlive = setInterval(() => undefined, 1000)
  try {
    const version = (await admin("/", "GET")).version.number
    console.log(`Testing Elasticsearch ${version}`)
    await build({
      entryPoints: [join(__dirname, "../src/main/services/dashboard-es-worker.ts")],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22"
    })
    client = new DashboardEsWorkerClient(async () => new Worker(bundle))
    const execute = (
      request: Pick<DashboardEsQueryRequest, "method" | "path" | "bodyText" | "projection">
    ) =>
      client!.query({
        nodes: [base.origin],
        headers: { "content-type": "application/json" },
        timeoutMs: 10_000,
        ...request
      })
    const search = (index: string, body: Record<string, unknown>) =>
      execute({
        method: "POST",
        path: `/${index}/_search`,
        bodyText: JSON.stringify(body)
      })

    for (const [kind, index] of ["native", "legacy", "empty"].map((kind, i) => [
      kind,
      indices[i]
    ])) {
      const text = { type: "text", fields: { keyword: { type: "keyword" } } }
      const keyword = { type: "keyword" }
      await admin(`/${index}`, "PUT", {
        settings: { number_of_shards: 1, number_of_replicas: 0 },
        mappings: {
          properties: {
            eventName: keyword,
            eventTime: { type: "date" },
            upperOrgLv1: keyword,
            ...(kind === "empty"
              ? {}
              : {
                  properties: {
                    properties: {
                      harnessProjectId: keyword,
                      successfulReadCount: { type: "long" },
                      filesTruncated: { type: "boolean" },
                      constraintFiles: kind === "legacy" ? text : keyword,
                      pluginId: kind === "legacy" ? text : keyword,
                      pluginName: keyword,
                      harnessAdapterName: keyword,
                      lastReadAt: kind === "legacy" ? keyword : { type: "date" }
                    }
                  }
                })
          }
        }
      })
    }
    await bulk(indices[0], [
      ...Array.from({ length: 1200 }, (_, i) => readEvent(`sys/${i}.md`)),
      readEvent("sys/0.md", { harnessProjectId: "other-project", harnessNode: "ops" }),
      readEvent("sys/0.md", { pluginId: null }),
      readEvent("sys/0.md", {
        pluginId: "q",
        pluginName: "另一插件",
        harnessAdapterName: "另一插件"
      }),
      readEvent("sys/legacy.md", { pluginId: null }),
      readEvent("sys/missing-last-read.md", { lastReadAt: null }),
      readEvent("sys/outside.md", {}, "乙室"),
      readEvent("sys/old.md", { lastReadAt: old }),
      readEvent("sys/not-project.md", { harnessProjectId: null })
    ])
    await bulk(indices[1], [
      readEvent("sys/0.md"),
      readEvent("sys/0.md", { pluginId: null }),
      readEvent("sys/1.md", { lastReadAt: old }),
      readEvent("sys/old-event.md", {}, "甲室", old)
    ])

    if (version.startsWith("7.10.")) {
      await assert.rejects(
        execute({
          method: "POST",
          path: `/${indices[0]}/_field_caps`,
          bodyText: JSON.stringify({ fields: capsFields })
        }),
        (error: unknown) => {
          assert.match(
            String((error as Error).cause && ((error as Error).cause as Error).message),
            /specified fields can't be null or empty/
          )
          return true
        }
      )
      console.log("PASS original field_caps request reproduces the production 400")
    }
    for (const [i, expected] of [
      [0, 1203],
      [1, 2],
      [2, 0]
    ]) {
      const caps = await execute(
        prepareDashboardFieldCapsRequest(indices[i], { fields: capsFields })
      )
      const fields = resolveRecentConstraintFields(caps)
      let pages = 0
      let peak = 0
      let active = 0
      const result = await fetchRecentConstraintFiles(
        fields,
        [{ term: { upperOrgLv1: "甲室" } }],
        async (body) => {
          pages++
          active++
          peak = Math.max(peak, active)
          assert.equal(body.size, 0)
          assert(!JSON.stringify(body).includes("_raw"))
          try {
            return await search(indices[i], body)
          } finally {
            active--
          }
        },
        undefined,
        now
      )
      assert.deepEqual(result, { fileCount: expected, complete: true })
      assert.equal(peak, 1)
      assert(pages <= Math.ceil(expected / 500) + 1)
      console.log(
        `PASS ${indices[i].split("-").at(-1)} mapping: ${expected} distinct files, ${pages} aggregation requests, peak concurrency ${peak}`
      )
    }

    const keyword = { type: "keyword" }
    await admin(`/${indices[3]}`, "PUT", {
      settings: { number_of_shards: 1, number_of_replicas: 0 },
      mappings: {
        properties: {
          sapId: keyword,
          userName: keyword,
          orgName: keyword,
          startedAt: { type: "date" }
        }
      }
    })
    await bulk(indices[3], [
      { sapId: "80300000", userName: "用户甲", startedAt: recent },
      { sapId: "姓名80300001", userName: "用户乙", startedAt: recent },
      { sapId: "other", userName: "其他", startedAt: recent }
    ])
    const ids = Array.from({ length: 500 }, (_, i) => String(80300000 + i))
    const oldFilter = {
      bool: {
        should: ids.flatMap((id) => [
          { term: { sapId: id } },
          { term: { "sapId.keyword": id } },
          { wildcard: { sapId: `*${id}*` } },
          { wildcard: { "sapId.keyword": `*${id}*` } }
        ]),
        minimum_should_match: 1
      }
    }
    if (version.startsWith("7.")) {
      await assert.rejects(search(indices[3], { size: 0, query: oldFilter }), (error: unknown) => {
        assert.match(
          String((error as Error).cause && ((error as Error).cause as Error).message),
          /too_many_clauses|maxClauseCount/
        )
        return true
      })
      console.log("PASS original 500-user query reproduces ES too_many_clauses")
    }
    const userBody = {
      size: 0,
      query: { bool: { filter: [buildUserProfileIdFilter(ids)] } },
      aggs: {
        by_sap: {
          terms: { field: "sapId", size: 2000 },
          aggs: {
            latest_user_info: {
              top_hits: {
                size: 1,
                sort: [{ startedAt: { order: "desc" } }],
                _source: ["userName", "orgName"]
              }
            }
          }
        }
      }
    }
    const profiles = (await execute({
      method: "POST",
      path: `/${indices[3]}/_search`,
      bodyText: JSON.stringify(userBody),
      projection: { kind: "user-directory" }
    })) as { items: Array<{ sapId: string }> }
    assert.deepEqual(profiles.items.map((user) => user.sapId).sort(), ["80300000", "姓名80300001"])
    console.log(
      "PASS fixed 500-user query preserves exact and historic substring matches with one request"
    )
  } finally {
    await client?.close()
    await Promise.all(
      indices.map((index) =>
        fetch(new URL(`/${index}`, base), {
          method: "DELETE",
          signal: AbortSignal.timeout(5000)
        }).catch(() => undefined)
      )
    )
    rmSync(directory, { recursive: true, force: true })
    clearInterval(keepAlive)
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
