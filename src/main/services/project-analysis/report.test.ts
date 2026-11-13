import {
  mockStreamingModel,
  TEST_PROJECT_BUDGET,
  testReviewer
} from "./streaming-model-test-fixture"
import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, readdirSync, existsSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
vi.mock("../../models/registry", () => ({ getDefaultModelConfig: () => null }))
vi.mock("../../models/connection", () => ({ getModelClientOptions: () => ({}) }))
import { buildReportSnapshot, reportDataPage } from "./report-data"
import { makeReportPeriodExample } from "./report-mock"
import { renderReportHtml, extractReportTemplate } from "./report-html"
import { ProjectReportStore } from "./report-store"
import { generateProjectReport, parseReportGeneration } from "./report-agent"
import { projectListPageData } from "./page-data"
import { makeMockRunAnalysis } from "../../ipc/project-run-analysis-mock"
import { RECOMMENDED_REPORT_TEMPLATE_ID } from "../../../shared/project-analysis-report"

const scope = {
  upperOrgLv1: "开发一室",
  period: { kind: "week" as const, anchorDate: "2026-10-27" }
}
const snapshot = () =>
  buildReportSnapshot({
    scope,
    data: makeReportPeriodExample(scope),
    accumulation: {
      totals: { totalNum: 45, activeNum: 8, abandonedNum: 2 },
      users: null,
      orgs: null,
      systems: null,
      errors: {}
    },
    active: { items: [] },
    knowledgeAsOf: "2026-11-12T02:00:00.000Z",
    exampleData: true
  })
const source = `<!doctype html><html><head><style>body{color:#123}table{width:100%}</style></head><body><h1>综合报告</h1><p>项目 <b data-report-value="summary.projectCount">999</b></p><p data-report-value="knowledge.window"></p><table><tbody><tr data-report-repeat="members"><td data-report-value="name"></td><td data-report-value="generatedLines"></td><td data-report-value="knowledgeReads"></td></tr></tbody></table><p data-report-insight>本周曾有123次变化，张某需要关注。</p></body></html>`
const roots: string[] = []
const root = () => {
  const p = mkdtempSync(join(tmpdir(), "project-report-"))
  roots.push(p)
  return p
}
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true })
})

describe("report snapshot and HTML", () => {
  it("queries a single project's period facts by stable identifiers and rejects mixed scopes", () => {
    const s = snapshot()
    const projectId = s.periodData.projects[0].projectId
    const projects = reportDataPage(s, "projects", 0, projectId)
    expect(projects).toMatchObject({ total: 1, rows: [s.facts.projects[0]] })
    const features = reportDataPage(s, "features", 0, projectId)
    expect(features.rows?.length).toBeGreaterThan(0)
    expect(
      features.rows?.every(
        (row) => row.projectId === projectId && Object.hasOwn(row, "featureSlug")
      )
    ).toBe(true)
    expect(() => reportDataPage(s, "overview", 0, projectId)).toThrow("全室汇总")
    expect(() => reportDataPage(s, "features", 0, "outside")).toThrow("没有本报告周期数据")
    delete s.facts.features[0].projectId
    expect(() => reportDataPage(s, "features", 0, projectId)).toThrow("历史报告缺少")
  })
  it("keeps period metrics and the rolling30day knowledge window distinct, with weighted rates", () => {
    const s = snapshot()
    expect(s.facts.summary.adoptionRate).toBe("50.0%")
    expect(s.facts.knowledge.window).toContain("2026-10-13 — 2026-11-12")
    expect(s.facts.meta.period).toBe("2026-10-26 — 2026-11-01")
    expect(s.facts.members[7].knowledgeReads).toBeNull()
    expect(s.notes.join(" ")).toContain("演示数据")
    expect(reportDataPage(s, "members", 6)).toMatchObject({
      total: 8,
      nextOffset: null,
      rows: [s.facts.members[6], s.facts.members[7]]
    })
  })
  it("expands all rows, escapes dataset HTML and preserves null rather than converting to zero", () => {
    const s = snapshot()
    s.facts.members[0].name = '<img src=x onerror="bad()">'
    const output = renderReportHtml(source, s)
    expect(output.html.match(/<tr>/g)).toHaveLength(8)
    expect(output.html).toContain("&lt;img")
    expect(output.html).toContain("未记录")
    expect(output.html).not.toContain(">999<")
    expect(output.source).toContain("data-report-repeat")
    expect(output.source).not.toContain("演示成员1")
    expect(output.html).toContain("data-report-provenance")
    expect(output.html).toContain("非报告周期")
  })
  it("sanitizes active content and external navigation in the offline artifact", () => {
    const malicious = source.replace(
      "<body>",
      '<body onload="bad()"><script>bad()</script><iframe srcdoc="bad"></iframe><a href="https://outside">link</a><form action="file:///tmp"><input></form><svg><foreignObject><script>bad()</script></foreignObject><a href="javascript:bad()">x</a></svg><meta http-equiv="refresh" content="0;url=https://outside">'
    )
    const html = renderReportHtml(malicious, snapshot()).html
    expect(html).not.toMatch(
      /<script|<iframe|<form|onload|javascript:|https:\/\/outside|http-equiv="refresh"/
    )
    expect(html).toContain("script-src 'none'")
    expect(html).toContain("connect-src 'none'")
  })
  it("rejects truncated output, unknown refs and nested repeats; validates empty lists", () => {
    expect(() => renderReportHtml(source.slice(0, -7), snapshot())).toThrow("完整")
    expect(() =>
      renderReportHtml(source.replace("summary.projectCount", "summary.fakeCount"), snapshot())
    ).toThrow("未知")
    expect(() =>
      renderReportHtml(
        source.replace('data-report-value="name"', 'data-report-repeat="projects"'),
        snapshot()
      )
    ).toThrow("列表")
    const s = snapshot()
    s.facts.members = []
    expect(renderReportHtml(source, s).html).not.toContain("<tr>")
    expect(() =>
      renderReportHtml(source.replace('data-report-value="name"', 'data-report-value="salary"'), s)
    ).toThrow("未知")
  })
  it("retains layout/references but removes old narrative, names and hard-coded figures from templates", () => {
    const layout = extractReportTemplate(source)
    expect(layout).toContain("body{color:#123}")
    expect(layout).toContain("data-report-value")
    expect(layout).not.toMatch(/张某|123次|>999</)
  })
  it("preserves module headings while removing period names and stale chart geometry", () => {
    const s = snapshot()
    const layout = extractReportTemplate(
      source.replace(
        "<h1>综合报告</h1>",
        '<h1>开发一室</h1><h2>项目效果</h2><svg><rect width="123" height="40"></rect></svg>'
      ),
      s
    )
    expect(layout).toContain("项目效果")
    expect(layout).not.toContain("开发一室")
    expect(layout).not.toContain("<rect")
    expect(() => renderReportHtml(layout, s)).toThrow("占位")
  })
})

describe("private report storage", () => {
  it("keeps immutable versions, freezes facts and applies saved layouts to fresh data", () => {
    const store = new ProjectReportStore(root(), "sap:1", (room) => room === scope.upperOrgLv1)
    const s = snapshot(),
      output = renderReportHtml(source, s)
    const doc = store.create(s, output, "简洁", "deepsekkflash-4.0")
    const template = store.saveTemplate(doc.summary.id, 1, "室周报", "简洁蓝色")
    const v2 = store.revise(
      doc.summary.id,
      1,
      renderReportHtml(source.replace("#123", "#456"), s),
      "蓝色",
      "model"
    )
    expect(v2.versions).toHaveLength(2)
    expect(store.read(doc.summary.id, 1).html).toBe(output.html)
    expect(store.snapshot(doc.summary.id).periodData.dataAsOf).toBe(s.periodData.dataAsOf)
    expect(() => store.revise(doc.summary.id, 1, output, "旧版本修改", "model")).toThrow("新版本")
    const fresh = snapshot()
    fresh.facts.summary.projectCount = 99
    // A template must pass through the Agent to regenerate prose; it cannot be published verbatim.
    const layout = store.readTemplate(template.id).layout
    expect(() => renderReportHtml(layout, fresh)).toThrow("占位")
    const html = renderReportHtml(layout.replaceAll("【按本期重新撰写】", "本期概览"), fresh).html
    expect(html).toContain(">99</b>")
    store.deleteTemplate(template.id)
    expect(store.listTemplates().map((item) => item.id)).toEqual([RECOMMENDED_REPORT_TEMPLATE_ID])
    store.deleteReport(doc.summary.id)
    expect(store.listReports()).toEqual([])
  })
  it("keeps the built-in reference immutable while a personalized version is saved and reused with new facts", () => {
    const base = root()
    const store = new ProjectReportStore(base, "sap:template-owner", () => true)
    const original = store.readTemplate(RECOMMENDED_REPORT_TEMPLATE_ID)
    expect(store.listTemplates()).toEqual([
      expect.objectContaining({ id: original.id, kind: "builtin" })
    ])
    expect(store.listTemplates()[0]).not.toHaveProperty("layout")
    expect(() => store.deleteTemplate(original.id)).toThrow("内置推荐不能删除")
    expect(() => renderReportHtml(original.layout, snapshot())).toThrow("占位")
    const firstSource = original.layout.replaceAll("【按本期重新撰写】", "旧周期结论 1234")
    const report = store.create(snapshot(), renderReportHtml(firstSource, snapshot()), "", "test")
    const changed = firstSource
      .replaceAll("#25584d", "#234789")
      .replace("成员贡献明细", "完整成员贡献")
    const revised = store.revise(
      report.summary.id,
      1,
      renderReportHtml(changed, snapshot()),
      "改成蓝色，保留完整成员表",
      "test"
    )
    const personal = store.saveTemplate(
      report.summary.id,
      revised.version.version,
      "我的完整室周报",
      "先展示成员贡献，使用蓝色"
    )
    expect(personal).toMatchObject({ kind: "personal" })
    expect(personal.id).not.toBe(original.id)
    const saved = store.readTemplate(personal.id)
    expect(saved.layout).toContain("#234789")
    expect(saved.layout).toContain("完整成员贡献")
    expect(saved.layout).not.toMatch(/旧周期结论|1234|演示成员|2026-10-26/)
    const fresh = snapshot()
    fresh.facts.meta.period = "2026-11-09 — 2026-11-15"
    fresh.facts.members[0].name = "新周期成员"
    fresh.facts.summary.projectCount = 27
    const next = renderReportHtml(
      saved.layout.replaceAll("【按本期重新撰写】", "本期数据已核实"),
      fresh
    )
    expect(next.html).toContain("新周期成员")
    expect(next.html).toContain("2026-11-09 — 2026-11-15")
    expect(next.html).toContain(">27</strong>")
    expect(store.readTemplate(original.id)).toEqual(original)
    expect(store.listTemplates().map((item) => item.id)).toEqual([original.id, personal.id])
    expect(
      new ProjectReportStore(base, "sap:other", () => true).listTemplates().map((item) => item.id)
    ).toEqual([original.id])
    store.deleteTemplate(personal.id)
    expect(store.listTemplates().map((item) => item.id)).toEqual([original.id])
  })
  it("isolates account files, rechecks room access and rejects traversal and symlinks", () => {
    const base = root(),
      a = new ProjectReportStore(base, "sap:a", () => true)
    const s = snapshot(),
      doc = a.create(s, renderReportHtml(source, s), "", "model")
    expect(new ProjectReportStore(base, "sap:b", () => true).listReports()).toEqual([])
    const revoked = new ProjectReportStore(base, "sap:a", () => false)
    expect(revoked.listReports()).toEqual([])
    expect(() => revoked.read(doc.summary.id)).toThrow("权限")
    expect(() => a.read("../../outside")).toThrow("标识")
    const owner = readdirSync(join(base, "project-analysis")).find((id) =>
      existsSync(join(base, "project-analysis", id, "reports", doc.summary.id))
    )!
    const dir = join(base, "project-analysis", owner, "reports", doc.summary.id)
    rmSync(dir, { recursive: true })
    symlinkSync(root(), dir)
    expect(() => a.read(doc.summary.id)).toThrow("不存在")
  })
})

describe("bounded report Agent", () => {
  function model(agentResponses: Array<AIMessage | Error>, finalResponses: AIMessage[] = []) {
    const agent = {
      invoke: vi.fn(async () => {
        const r = agentResponses.shift()
        if (r instanceof Error) throw r
        if (!r) throw new Error("unexpected call")
        return r
      })
    }
    const final = {
      invoke: vi.fn(async () => {
        const r = finalResponses.shift()
        if (!r) throw new Error("unexpected final call")
        return r
      })
    }
    return {
      name: "deepsekkflash-4.0",
      budget: TEST_PROJECT_BUDGET,
      reviewer: testReviewer(),
      agent: mockStreamingModel(agent),
      final: mockStreamingModel(final)
    }
  }
  it("provides complete facts and page-oriented read-only tools before generating", async () => {
    const m = model([new AIMessage(source)])
    let names: string[] = []
    const result = await generateProjectReport({
      snapshot: snapshot(),
      instruction: "",
      createModel: (tools) => {
        names = tools.map((t) => t.name)
        return m
      }
    })
    expect(names).toEqual([
      "report_data",
      "project_list",
      "project_analysis",
      "diagnose_projects",
      "feature_stages",
      "feature_sessions",
      "read_context"
    ])
    expect(m.agent.invoke).toHaveBeenCalledTimes(1)
    expect(result.html).toContain("演示成员8")
  })
  it("falls back without tools on incompatible endpoints, then repairs malformed HTML once", async () => {
    const m = model(
      [Object.assign(new Error("unsupported tools"), { status: 400 })],
      [new AIMessage("<html>unfinished"), new AIMessage(source)]
    )
    expect(
      (await generateProjectReport({ snapshot: snapshot(), instruction: "", createModel: () => m }))
        .html
    ).toContain("综合报告")
    expect(m.final.invoke).toHaveBeenCalledTimes(2)
  })
  it("caps tool rounds and calls, returns errors for unsupported tool arguments", async () => {
    const call = (name: string, args: Record<string, unknown>) =>
      new AIMessage({ content: "", tool_calls: [{ name, args, id: "query" }] })
    const m = model(
      [
        call("report_data", { section: "members", offset: 0 }),
        call("report_data", { section: "projects", offset: 0 }),
        call("report_data", { section: "features", offset: 0 }),
        call("report_data", { section: "knowledge", offset: 0 }),
        call("shell", { cmd: "cat /secret" })
      ],
      [new AIMessage(source)]
    )
    await generateProjectReport({ snapshot: snapshot(), instruction: "", createModel: () => m })
    expect(m.agent.invoke).toHaveBeenCalledTimes(5)
    expect(m.final.invoke).toHaveBeenCalledTimes(1)
  })
  it("honors cancellation after model returns and does not accept invalid scope/dates", async () => {
    const controller = new AbortController()
    const m = model([])
    m.agent.invoke.mockImplementation(async () => {
      controller.abort()
      return new AIMessage(source)
    })
    await expect(
      generateProjectReport({
        snapshot: snapshot(),
        instruction: "",
        signal: controller.signal,
        createModel: () => m
      })
    ).rejects.toThrow()
    expect(() =>
      parseReportGeneration({
        action: "create",
        scope: { ...scope, upperOrgLv1: ["甲", "乙"] },
        instruction: ""
      })
    ).toThrow()
    expect(() =>
      parseReportGeneration({
        action: "create",
        scope: { ...scope, period: { kind: "month", month: "2026-13" } },
        instruction: ""
      })
    ).toThrow()
  })
  it("includes every page row and guards/caches stage drilldowns within the frozen scope", async () => {
    const s = snapshot()
    const rows = makeMockRunAnalysis({ from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z" })
    s.pageData = projectListPageData(
      [{ projectId: "project-last", name: "列表末尾项目", managedRunCount: 8, features: [] }],
      rows
    )
    const selected = rows.rows[0]
    const call = (projectId: string) =>
      new AIMessage({
        content: "",
        tool_calls: [
          {
            name: "feature_stages",
            args: { projectId, featureSlug: selected.featureSlug },
            id: "stage"
          }
        ]
      })
    const responses = [
      call("outside"),
      call(selected.projectId),
      call(selected.projectId),
      new AIMessage(source)
    ]
    const received: BaseMessage[][] = []
    const reviewed: string[] = []
    const runner = {
      invoke: vi.fn(async (messages: BaseMessage[]) => {
        received.push([...messages])
        return responses.shift()!
      })
    }
    const loadStages = vi.fn(async () => ({ rows: [], dataAsOf: "2026-11-12T00:00:00Z" }))
    const output = await generateProjectReport({
      snapshot: s,
      instruction: "诊断异常项目",
      loadStages,
      createModel: () => ({
        name: "model",
        budget: TEST_PROJECT_BUDGET,
        reviewer: testReviewer((messages) =>
          reviewed.push(messages.map((m) => String(m.content)).join("\n"))
        ),
        agent: mockStreamingModel(runner),
        final: mockStreamingModel(runner)
      })
    })
    expect(received[0].map((message) => message.content).join("\n")).toContain(
      rows.rows.at(-1)!.projectId
    )
    expect(reviewed.join("\n")).toContain(rows.rows.at(-1)!.projectId)
    expect(reviewed.join("\n")).toContain("列表末尾项目")
    expect(received[0].map((message) => message.content).join("\n")).not.toContain('"values":')
    expect(loadStages).toHaveBeenCalledTimes(1)
    const error = received[1].find((message) => message instanceof ToolMessage)!
    expect(String(error.content)).toContain("当前筛选与权限范围")
    expect(output.reviewNote).toContain("项目分析 36条")
    expect(
      s.pageData.stages[JSON.stringify([selected.projectId, selected.featureSlug])]
    ).toBeDefined()
  })
})
