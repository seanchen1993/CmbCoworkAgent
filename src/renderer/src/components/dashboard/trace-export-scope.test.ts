import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import {
  createSourceFile,
  forEachChild,
  isVariableDeclaration,
  isCallExpression,
  ScriptTarget,
  transpileModule,
  type Node
} from "typescript"
import { describe, expect, it, vi } from "vitest"
import { unwrapThreadTracesResponse } from "./thread-traces-response"

// Run the production callbacks without mounting the full operations dashboard.
const source = createSourceFile(
  "DashboardView.tsx",
  readFileSync(new URL("./DashboardView.tsx", import.meta.url), "utf8"),
  ScriptTarget.Latest
)
const names = ["handleSkillTraceExport", "loadProjectThreadTraces", "loadProjectUserThreadTraces"]
const callbacks = new Map<string, string>()
function visit(node: Node): void {
  if (
    isVariableDeclaration(node) &&
    names.includes(node.name.getText(source)) &&
    node.initializer &&
    isCallExpression(node.initializer)
  ) {
    callbacks.set(node.name.getText(source), node.initializer.arguments[0].getText(source))
  }
  forEachChild(node, visit)
}
visit(source)
expect(callbacks.size).toBe(names.length)
const compiled = transpileModule(
  `globalThis.callbacks = {${[...callbacks].map(([name, code]) => `${name}: ${code}`).join(",")}}`,
  { compilerOptions: { target: ScriptTarget.ES2022 } }
).outputText

function fixture() {
  const exportSkillTraces = vi.fn(async () => ({ success: true }))
  const threadTraces = vi.fn(async () => ({
    success: true,
    data: []
  }))
  const context = {
    window: { api: { dashboard: { exportSkillTraces, threadTraces } }, alert: vi.fn() },
    unwrapThreadTracesResponse,
    selectedSkill: "skill",
    skillTraceViewMode: "thread",
    skillTraceTriggerScope: "active",
    skillDetail: {
      traceViewMode: "trace",
      traceTriggerScope: "all",
      tracePageSize: 10,
      totalTraces: 5,
      traces: [{ traceId: "trace" }]
    },
    range: { from: "2026-10-01", to: "2026-10-15" },
    skillTracePage: 1,
    SKILL_TRACE_PAGE_SIZE: 10,
    setSkillTraceExporting: vi.fn(),
    projectTraceProject: { projectId: "project" },
    projectTraceFeature: { slug: "feature" },
    projectTraceNode: { nodeName: "dev" },
    projectTraceStatus: "进行中",
    projectTraceStageBucket: "plugin_constrained",
    PROJECT_TRACE_TRIGGER_SCOPE: "active",
    userDetailTraceTriggerScope: "all"
  }
  runInNewContext(compiled, context)
  return {
    context,
    exportSkillTraces,
    threadTraces,
    callbacks: (
      context as typeof context & {
        callbacks: Record<string, (...args: string[]) => Promise<void>>
      }
    ).callbacks
  }
}

describe("dashboard trace export/detail scope", () => {
  it("passes the loaded skill page's actual view and trigger modes to export", async () => {
    const { callbacks, exportSkillTraces, context } = fixture()
    await callbacks.handleSkillTraceExport()
    expect(exportSkillTraces).toHaveBeenCalledWith(
      expect.objectContaining({
        viewMode: "trace",
        triggerScope: "all",
        traces: context.skillDetail.traces
      })
    )
    expect(context.setSkillTraceExporting.mock.calls).toEqual([[true], [false]])
  })
  it("loads project-list thread details cumulatively, retaining project/feature/stage filters", async () => {
    const { callbacks, threadTraces } = fixture()
    await callbacks.loadProjectThreadTraces("thread")
    expect(threadTraces).toHaveBeenCalledWith("thread", {
      scope: "project",
      projectId: "project",
      featureSlug: "feature",
      nodeName: "dev",
      nodeStatus: "进行中",
      stageBucket: "plugin_constrained",
      triggerScope: "active"
    })
  })
  it("retains the selected date range for project-user analysis details", async () => {
    const { callbacks, threadTraces, context } = fixture()
    await callbacks.loadProjectUserThreadTraces("thread")
    expect(threadTraces).toHaveBeenCalledWith("thread", {
      scope: "project",
      range: context.range,
      triggerScope: "all"
    })
  })
})
