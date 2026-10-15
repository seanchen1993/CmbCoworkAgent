import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInNewContext } from "node:vm"
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from "typescript"
import AdmZip from "adm-zip"
import { afterEach, describe, expect, it, vi } from "vitest"
import { loadTraceExportDetails } from "./dashboard-trace-export"
import { buildThreadTraceScopeFilters } from "./dashboard-trace-thread-list"
import { redactTraceDetailForDisplay } from "../agent/trace/display-redaction"
import { isDashboardEsResponseTooLarge } from "../services/dashboard-es-client"

// Exercise the actual IPC handlers and Markdown/JSON formatters, with only ES,
// authentication and native dialogs replaced. Electron must not boot in Vitest.
const source = createSourceFile(
  "dashboard.ts",
  readFileSync(new URL("./dashboard.ts", import.meta.url), "utf8"),
  ScriptTarget.Latest
)
const names = [
  "asRecord",
  "asString",
  "asNumber",
  "asOptionalString",
  "getErrorDetail",
  "makeEsUnavailableError",
  "clampLimit",
  "normalizeTraceViewMode",
  "normalizeTraceTriggerScope",
  "safeExportFileName",
  "escapeMarkdown",
  "stringifyExportValue",
  "appendTraceExportMarkdown",
  "formatTraceExportMarkdown",
  "traceExportThreadId",
  "groupTraceExportThreads",
  "formatUserTraceExportMarkdown",
  "normalizeTraceExportPayload",
  "normalizeUserTraceExportPayload",
  "fetchTraceExportDetails",
  "dashboardTraceSourceIncludes",
  "appendOptionalFilter"
]
const functions = source.statements.filter(
  (node) => isFunctionDeclaration(node) && names.includes(node.name?.text ?? "")
)
expect(functions).toHaveLength(names.length)
const register = source.statements.find(
  (node) => isFunctionDeclaration(node) && node.name?.text === "registerDashboardHandlers"
)!
const registrations = isFunctionDeclaration(register)
  ? register.body!.statements.filter((node) =>
      /^_ipcMain\.handle\("dashboard:export(?:Skill|User)Traces",/.test(node.getText(source))
    )
  : []
expect(registrations).toHaveLength(2)
const compiled = transpileModule(
  [...functions, ...registrations]
    .map((node) => node.getText(source))
    .join("\n")
    .replaceAll("import.meta.env.DEV", "false"),
  { compilerOptions: { target: ScriptTarget.ES2022 } }
).outputText
const directories: string[] = []
type ExportHandler = (
  event: unknown,
  payload: unknown
) => Promise<{ success: boolean; canceled?: boolean; error?: string }>
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "dashboard-export-test-"))
  directories.push(directory)
  const path = join(directory, "export.zip")
  const registrations = new Map<string, ExportHandler>()
  const details = Array.from({ length: 3 }, (_, index) => ({
    traceId: `trace-${index}`,
    threadId: index === 1 ? "worker-thread" : "root-thread",
    rootThreadId: "root-thread",
    traceKind: index === 1 ? "subagent" : "root",
    startedAt: `2026-10-15T10:0${index}:00.000Z`,
    durationMs: 1000,
    totalToolCalls: 1,
    totalInputTokens: 10,
    totalOutputTokens: 20,
    totalTokens: 30,
    usedSkills: [],
    userMessage: "完整用户问题",
    rawAvailable: true,
    nodes: [
      {
        id: `llm-${index}`,
        type: "llm" as const,
        parentId: null,
        name: "model",
        startedAt: "now",
        output: "真实模型回复"
      },
      {
        id: `tool-${index}`,
        type: "tool" as const,
        parentId: null,
        name: "read_file",
        startedAt: "now",
        input: { path: "真实工具输入", password: "secret-value" },
        output: "真实工具输出"
      }
    ]
  }))
  const esQuery = vi.fn(async (_index: string, body: Record<string, unknown>) => {
    const query = body.query as {
      bool: { filter: Array<{ bool?: { should: Array<{ terms: Record<string, string[]> }> } }> }
    }
    const selection = query.bool.filter.at(-1)!.bool!.should
    const chosen = details.filter((trace) =>
      selection.some(({ terms }) =>
        Object.entries(terms).some(([field, ids]) =>
          ids.includes(String((trace as Record<string, unknown>)[field]))
        )
      )
    )
    return {
      hits: {
        hits: chosen.map((detail) => ({
          _source: { detail },
          sort: [detail.startedAt, detail.traceId]
        }))
      }
    }
  })
  const save = vi.fn(async () => ({ canceled: false, filePath: path }))
  const platformAccess = vi.fn(() => ({ upperOrgLv1: "平台本室" }))
  const projectAccess = vi.fn(() => ({ upperOrgLv1: "项目本室" }))
  const context = {
    _ipcMain: {
      handle: (channel: string, handler: ExportHandler) => registrations.set(channel, handler)
    },
    AdmZip,
    Buffer,
    console: { error: vi.fn(), warn: vi.fn() },
    Error,
    loadTraceExportDetails,
    buildThreadTraceScopeFilters,
    redactTraceDetailForDisplay,
    isDashboardEsResponseTooLarge,
    esQuery,
    dialog: { showSaveDialog: save },
    BrowserWindow: {
      fromWebContents: () => ({}),
      getFocusedWindow: () => ({}),
      getAllWindows: () => [{}]
    },
    requireDashboardAccess: platformAccess,
    requireDashboardProjectModeAccess: projectAccess,
    buildTraceAccessFilter: (access: { upperOrgLv1: string }) => ({
      term: { upperOrgLv1: access.upperOrgLv1 }
    }),
    buildProjectModeAccessFilter: (access: { upperOrgLv1: string }) => ({
      term: { upperOrgLv1: access.upperOrgLv1 }
    }),
    getEsIndex: () => "traces",
    normalizeTraceDetail: (hit: { _source: { detail: (typeof details)[number] } }) =>
      redactTraceDetailForDisplay(hit._source.detail)
  }
  runInNewContext(compiled, context)
  const payload = {
    skill: "skill",
    sapId: "user",
    userName: "用户",
    page: 1,
    pageSize: 10,
    totalTraces: 1,
    totalItems: 1,
    viewMode: "thread",
    triggerScope: "active",
    projectMode: false,
    range: { from: "2026-10-01", to: "2026-10-15" },
    traces: [
      {
        ...details[0],
        nodes: undefined,
        userMessage: "摘要",
        rawAvailable: false,
        rawPending: true,
        rawError: "列表仅展示摘要，选中该会话后自动加载完整对话"
      }
    ]
  }
  const invoke = (kind: "Skill" | "User", value: unknown = payload) =>
    registrations.get(`dashboard:export${kind}Traces`)!({ sender: {} }, value)
  return { path, payload, details, invoke, esQuery, save, platformAccess, projectAccess, context }
}

describe("real dashboard ZIP export", () => {
  it.each(["Skill", "User"] as const)(
    "%s exports real content for all page-thread traces without relying on renderer caches",
    async (kind) => {
      const { invoke, path, esQuery } = fixture()
      expect(await invoke(kind)).toMatchObject({ success: true })
      const zip = new AdmZip(path)
      const base = kind === "Skill" ? "traces" : "threads"
      const markdown = zip.readAsText(`${base}.md`)
      const json = zip.readAsText(`${base}.json`)
      for (const content of [markdown, json]) {
        expect(content).toContain("真实模型回复")
        expect(content).toContain("真实工具输入")
        expect(content).toContain("真实工具输出")
        expect(content).not.toMatch(/rawPending|列表仅展示摘要|secret-value/)
        expect(content).toContain("[REDACTED]")
      }
      const data = JSON.parse(json)
      expect(kind === "Skill" ? data.traces.length : data.threads[0].traces.length).toBe(3)
      const query = esQuery.mock.calls[0][1]
      expect((query._source as { includes: string[] }).includes).toContain("_raw")
      expect(JSON.stringify(query.query)).toContain("平台本室")
      expect(JSON.stringify(query.query)).not.toContain('"range"')
    }
  )

  it("retains project permissions, dates and trigger scope for project-user exports", async () => {
    const { invoke, payload, esQuery, projectAccess, platformAccess } = fixture()
    expect(await invoke("User", { ...payload, projectMode: true })).toMatchObject({ success: true })
    expect(projectAccess).toHaveBeenCalledOnce()
    expect(platformAccess).not.toHaveBeenCalled()
    const query = JSON.stringify(esQuery.mock.calls[0][1].query)
    expect(query).toContain("项目本室")
    expect(query).toContain("2026-10-01")
    expect(query).toContain("triggerSource")
  })

  it.each(["Skill", "User"] as const)(
    "keeps %s trace-mode export limited to the selected trace",
    async (kind) => {
      const { invoke, payload, path } = fixture()
      expect(await invoke(kind, { ...payload, viewMode: "trace" })).toMatchObject({ success: true })
      expect(JSON.parse(new AdmZip(path).readAsText("traces.json")).traces).toHaveLength(1)
    }
  )

  it("retains the ES size-error cause so the export can reduce its batch size", async () => {
    const { context } = fixture()
    const wrap = runInNewContext("makeEsUnavailableError", context) as (
      nodes: string[],
      error: Error
    ) => Error
    const sourceError = Object.assign(new Error("response exceeds byte limit"), {
      code: "DASHBOARD_ES_RESPONSE_TOO_LARGE"
    })
    expect(isDashboardEsResponseTooLarge(wrap(["test-node"], sourceError))).toBe(true)
  })

  it("does not query ES or create a ZIP after canceling the save dialog", async () => {
    const { invoke, save, esQuery, path } = fixture()
    save.mockResolvedValue({ canceled: true, filePath: path })
    expect(await invoke("Skill")).toMatchObject({ canceled: true })
    expect(esQuery).not.toHaveBeenCalled()
    expect(existsSync(path)).toBe(false)
  })

  it("rejects inaccessible or truly missing content instead of saving summary placeholders", async () => {
    const missing = fixture()
    missing.details[0].rawAvailable = false
    expect(await missing.invoke("User")).toMatchObject({
      success: false,
      error: expect.stringContaining("缺少完整内容")
    })
    expect(existsSync(missing.path)).toBe(false)
    const denied = fixture()
    denied.platformAccess.mockImplementation(() => {
      throw new Error("无权查看")
    })
    expect(await denied.invoke("Skill")).toMatchObject({ success: false, error: "无权查看" })
    expect(denied.esQuery).not.toHaveBeenCalled()
    expect(existsSync(denied.path)).toBe(false)
  })
})
