import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from "typescript"
import { describe, expect, it, vi } from "vitest"
import { resolveKnowledgeOverviewScope } from "./dashboard-knowledge-overview"
import {
  fetchRecentConstraintFileDetails,
  resolveRecentConstraintFields
} from "./dashboard-recent-constraint-files"
import { ProjectModePageCache } from "./project-mode-page-cache"
import {
  fetchKnowledgeFileReaders,
  normalizeKnowledgeReadFileRef,
  resolveKnowledgeReaderFields
} from "./dashboard-knowledge-readers"

// Run production entry points without starting Electron. Only network/auth dependencies are mocked.
const source = createSourceFile(
  "dashboard.ts",
  readFileSync(new URL("./dashboard.ts", import.meta.url), "utf8"),
  ScriptTarget.Latest
)
const names = [
  "resolveKnowledgeRequestScope",
  "getKnowledgeConstraintFields",
  "fetchKnowledgeActiveDetails",
  "fetchKnowledgeRecentConstraintFileDetails",
  "fetchKnowledgeRecentConstraintFiles",
  "fetchKnowledgeReadReaders"
]
const functions = source.statements.filter(
  (node) => isFunctionDeclaration(node) && names.includes(node.name?.text ?? "")
)
expect(functions).toHaveLength(names.length)
const compiled = transpileModule(
  `${functions.map((node) => node.getText(source)).join("\n")}\nglobalThis.api = {${names.join(",")}}`
    .replaceAll("import.meta.env.DEV", "false")
    .replaceAll("import.meta.env.VITE_KNOWLEDGE_OVERVIEW_BASE_URL", '"http://kb.test"'),
  { compilerOptions: { target: ScriptTarget.ES2022 } }
).outputText

function fixture() {
  const access = { admin: true, upperOrgLv1: "甲室" }
  const requireAccess = vi.fn(() => access)
  const fetchUpdates = vi.fn(async () => [])
  const query = vi.fn(
    async (_index: string, body: Record<string, unknown>, options?: { operation: string }) => {
      if (options?.operation === "field_caps") {
        expect(body.fields).toContain("properties.constraintFiles")
        return {
          fields: Object.fromEntries(
            [
              "properties.constraintFiles",
              "properties.pluginId",
              "properties.pluginName",
              "sapId",
              "ystId",
              "userName",
              "upperOrgLv1",
              "upperOrgLv0"
            ].map((name) => [name, { keyword: { type: "keyword", aggregatable: true } }])
          )
        }
      }
      expect(body.size).toBe(0)
      const scope = JSON.stringify(body.query)
      if ((body.aggs as Record<string, unknown>).readers)
        return {
          aggregations: {
            readers: {
              buckets: [
                {
                  key: {
                    sapId: "8031",
                    userName: "张三",
                    room: scope.includes("乙室") ? "乙室" : "甲室"
                  }
                }
              ]
            }
          }
        }
      return {
        aggregations: {
          files: {
            buckets: [
              {
                key: {
                  pluginId: "p",
                  pluginName: "插件",
                  file: `${scope.includes("乙室") ? "乙" : "甲"}/rules.md`
                }
              }
            ]
          }
        }
      }
    }
  )
  const context = {
    Date,
    getDashboardRequestSignal: () => undefined,
    requireDashboardProjectModeAccess: requireAccess,
    buildProjectModeOrgFilter: (opts?: { upperOrgLv1?: string[] }) => ({
      term: { upperOrgLv1: access.admin ? (opts?.upperOrgLv1?.[0] ?? "all") : access.upperOrgLv1 }
    }),
    getEsIndex: () => "events",
    getEsNodes: () => ["http://es.test"],
    esQuery: query,
    fetchRecentConstraintFileDetails,
    resolveRecentConstraintFields,
    resolveKnowledgeReaderFields,
    normalizeKnowledgeReadFileRef,
    fetchKnowledgeFileReaders,
    recentConstraintFieldCache: new Map(),
    recentConstraintDetailsCache: new ProjectModePageCache(),
    knowledgeFileReadersCache: new ProjectModePageCache(),
    resolveKnowledgeOverviewScope,
    isDashboardProjectModeAdmin: (user: typeof access) => user.admin,
    normalizeUpperOrgLv1List: (rooms?: string[]) => rooms ?? [],
    DASHBOARD_UNCLASSIFIED_ORG: "__unclassified__",
    getKnowledgeRoomOrgIds: () =>
      new Map([
        ["甲室", "1"],
        ["乙室", "2"]
      ]),
    fetchKnowledgeActiveList: fetchUpdates,
    api: {} as {
      fetchKnowledgeActiveDetails: (opts?: { upperOrgLv1?: string[] }) => Promise<unknown>
      fetchKnowledgeRecentConstraintFiles: (opts?: { upperOrgLv1?: string[] }) => Promise<unknown>
      fetchKnowledgeRecentConstraintFileDetails: (opts?: {
        upperOrgLv1?: string[]
      }) => Promise<unknown>
      fetchKnowledgeReadReaders: (
        file: unknown,
        opts?: { upperOrgLv1?: string[] }
      ) => Promise<unknown>
    }
  }
  runInNewContext(compiled, context)
  return { ...context, access, requireAccess, fetchUpdates, query }
}

describe("knowledge detail scope and query reuse", () => {
  it("loads readers on demand with authorization on cached hits and rejects files outside the current catalogue", async () => {
    const f = fixture()
    const file = {
      pluginId: "p",
      pluginName: "插件",
      filePath: "甲/rules.md",
      pluginAliases: ["不可信别名"]
    }
    const opts = { upperOrgLv1: ["甲室"] }
    await f.api.fetchKnowledgeRecentConstraintFiles(opts)
    expect(await f.api.fetchKnowledgeReadReaders(file, opts)).toMatchObject({
      items: [{ sapId: "8031", userName: "张三", departments: ["甲室"] }]
    })
    expect(f.query).toHaveBeenCalledTimes(3)
    expect(await f.api.fetchKnowledgeReadReaders(file, opts)).toMatchObject({
      hasUnknownReaders: false
    })
    expect(f.query).toHaveBeenCalledTimes(3)
    const last = f.query.mock.calls[2][1]
    expect(JSON.stringify(last)).toContain("甲/rules.md")
    expect(JSON.stringify(last)).toContain("甲室")
    expect(JSON.stringify(last)).not.toContain("不可信别名")
    await expect(f.api.fetchKnowledgeReadReaders(file, { upperOrgLv1: ["乙室"] })).rejects.toThrow(
      "未找到"
    )
    expect(f.query).toHaveBeenCalledTimes(4)
    f.requireAccess.mockImplementation(() => {
      throw new Error("access denied")
    })
    await expect(f.api.fetchKnowledgeReadReaders(file, opts)).rejects.toThrow("access denied")
    expect(f.query).toHaveBeenCalledTimes(4)
  })
  it("shares accumulation room mapping with updates and never sends null for denied or unmapped scopes", async () => {
    const f = fixture()
    await f.api.fetchKnowledgeActiveDetails()
    expect(f.fetchUpdates).toHaveBeenLastCalledWith("http://kb.test", null, undefined)
    await f.api.fetchKnowledgeActiveDetails({ upperOrgLv1: ["甲室", "乙室"] })
    expect(f.fetchUpdates).toHaveBeenLastCalledWith("http://kb.test", ["1", "2"], undefined)
    f.access.admin = false
    await f.api.fetchKnowledgeActiveDetails()
    expect(f.fetchUpdates).toHaveBeenLastCalledWith("http://kb.test", ["1"], undefined)
    f.fetchUpdates.mockClear()
    expect(await f.api.fetchKnowledgeActiveDetails({ upperOrgLv1: ["乙室"] })).toEqual({
      items: [],
      unavailableReason: "noAccess"
    })
    expect(f.fetchUpdates).not.toHaveBeenCalled()
    f.access.admin = true
    expect(await f.api.fetchKnowledgeActiveDetails({ upperOrgLv1: ["未映射"] })).toEqual({
      items: [],
      unavailableReason: "roomNotMapped"
    })
    expect(f.fetchUpdates).not.toHaveBeenCalled()
  })
  it("reuses count keys for details while isolating cached data by actual permission filters", async () => {
    const f = fixture()
    const first = { upperOrgLv1: ["甲室"] }
    expect(await f.api.fetchKnowledgeRecentConstraintFiles(first)).toEqual({
      fileCount: 1,
      complete: true
    })
    expect(await f.api.fetchKnowledgeRecentConstraintFileDetails(first)).toMatchObject({
      items: [{ filePath: "甲/rules.md" }]
    })
    expect(f.query).toHaveBeenCalledTimes(2) // one field_caps, one aggregation
    expect(
      await f.api.fetchKnowledgeRecentConstraintFileDetails({ upperOrgLv1: ["乙室"] })
    ).toMatchObject({ items: [{ filePath: "乙/rules.md" }] })
    expect(f.query).toHaveBeenCalledTimes(3)
    f.access.admin = false
    expect(
      await f.api.fetchKnowledgeRecentConstraintFileDetails({ upperOrgLv1: ["乙室"] })
    ).toMatchObject({ items: [{ filePath: "甲/rules.md" }] })
    expect(f.query).toHaveBeenCalledTimes(3)
    f.requireAccess.mockImplementation(() => {
      throw new Error("access denied")
    })
    await expect(f.api.fetchKnowledgeRecentConstraintFileDetails(first)).rejects.toThrow(
      "access denied"
    )
    expect(f.query).toHaveBeenCalledTimes(3)
  })
  it("does not cache a failed or partial query as an empty detail list", async () => {
    const f = fixture()
    await f.api.fetchKnowledgeRecentConstraintFiles()
    f.recentConstraintDetailsCache.clear()
    f.query.mockResolvedValueOnce({ timed_out: true } as never)
    await expect(f.api.fetchKnowledgeRecentConstraintFileDetails()).rejects.toThrow("未完整")
    expect(await f.api.fetchKnowledgeRecentConstraintFileDetails()).toMatchObject({
      fileCount: 1,
      items: [{ filePath: "甲/rules.md" }]
    })
    expect(f.query).toHaveBeenCalledTimes(4)
  })
})
