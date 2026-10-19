import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AIMessage } from "@langchain/core/messages"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import ts from "typescript"
import type { AdoptionContext } from "../../services/adoption-tracker"

const contexts = vi.hoisted(() => new Map<string, AdoptionContext>())

vi.mock("electron", () => ({ app: { getVersion: () => "test" }, safeStorage: {} }))
vi.mock("../../net-utils", () => ({ getLocalIP: () => "127.0.0.1" }))
vi.mock("../../storage", () => ({
  getUserInfo: () => null,
  getEnabledPluginSkillSourceMetadata: () => []
}))
vi.mock("../../ipc/skills", () => ({ listAllSkills: async () => [] }))
vi.mock("../../harness-board/service", () => ({
  getHarnessProjectAdapterSnapshot: async () => null
}))
vi.mock("../../services/adoption-tracker", () => ({
  setAdoptionContext(threadId: string, context: AdoptionContext) {
    contexts.set(threadId, { ...contexts.get(threadId), ...context })
  },
  clearAdoptionContext(threadId: string, traceId?: string) {
    if (!traceId || contexts.get(threadId)?.traceId === traceId) contexts.delete(threadId)
  }
}))
vi.mock("../skill-eval/documents", () => ({ buildSkillEvalTraceExtension: () => undefined }))
vi.mock("../skill-eval/window", () => ({
  appendSkillEvalWindowTurn: () => ({ evalSkillNames: [] }),
  getSkillEvalWindowAssistantText: () => "",
  getSkillEvalWindowContextByRawName: () => ({})
}))

import { classifyHarnessStageBucket } from "../../../shared/harness-stage-bucket"
import { getThreadActiveSkills, setThreadActiveSkills } from "../skill-evolution/proposal-window"
import {
  flushPendingTraceReports,
  flushTraceWriteQueue,
  setTraceReporter,
  TraceCollector
} from "../trace/collector"
import type { AgentTrace } from "../trace/types"
import { runWorkflowSubagent, type WorkflowSubagentDeps } from "./subagent"

let tracesDir = ""
let parentThreadId = ""
let previousTracesDir: string | undefined
let previousStorageMode: string | undefined
const traces: AgentTrace[] = []
const parentSkills = ["parent-skill-v1.0.0"]
const parentSources = ["plugin:parent/parent-skill-v1.0.0"]

beforeEach(() => {
  tracesDir = mkdtempSync(join(tmpdir(), "workflow-skill-attribution-"))
  parentThreadId = `parent-${tracesDir}`
  previousTracesDir = process.env.CMB_COWORK_TRACES_DIR
  previousStorageMode = process.env.CMB_COWORK_TRACE_STORAGE_MODE
  process.env.CMB_COWORK_TRACES_DIR = tracesDir
  process.env.CMB_COWORK_TRACE_STORAGE_MODE = "plaintext"
  contexts.clear()
  traces.length = 0
  setTraceReporter({
    async report(trace) {
      traces.push(trace)
    }
  })
})

afterEach(async () => {
  await flushPendingTraceReports(1_000)
  await flushTraceWriteQueue()
  setTraceReporter({ report: async () => undefined })
  if (previousTracesDir === undefined) delete process.env.CMB_COWORK_TRACES_DIR
  else process.env.CMB_COWORK_TRACES_DIR = previousTracesDir
  if (previousStorageMode === undefined) delete process.env.CMB_COWORK_TRACE_STORAGE_MODE
  else process.env.CMB_COWORK_TRACE_STORAGE_MODE = previousStorageMode
  rmSync(tracesDir, { recursive: true, force: true })
})

async function runChild(options: {
  withTrace: boolean
  readOwnSkill?: boolean
  beforeFirstWrite?: () => void
}) {
  const parent = options.withTrace
    ? new TraceCollector(parentThreadId, "delegate", "test", {
        includeSkillEval: false,
        harnessFeature: {
          projectId: "p",
          slug: "f",
          nodeName: "Dev-代码实现",
          nodeStatus: "进行中"
        }
      })
    : undefined
  let firstWriteContext: AdoptionContext | undefined
  let laterWriteContext: AdoptionContext | undefined
  const deps: WorkflowSubagentDeps = {
    parentThreadId,
    defaultModelId: "test",
    traceContext: parent?.getTraceContext(),
    cleanupThread: async () => undefined,
    isRetryableApiError: () => false,
    createRuntime: async ({ threadId }) => ({
      stream: async () =>
        (async function* () {
          options.beforeFirstWrite?.()
          // The first tool can write before the stream observes any Skill read.
          firstWriteContext = structuredClone(contexts.get(threadId))
          const messages: AIMessage[] = []
          if (options.readOwnSkill) {
            messages.push(
              new AIMessage({
                id: "read-own-skill",
                content: "",
                tool_calls: [
                  { id: "read", name: "read_file", args: { path: "/skills/own/SKILL.md" } }
                ]
              })
            )
            yield [
              "values",
              {
                skillsMetadata: [
                  { name: "own-skill", version: "2.0.0", path: "/skills/own/SKILL.md" }
                ],
                messages: [...messages]
              }
            ]
          }
          laterWriteContext = structuredClone(contexts.get(threadId))
          messages.push(new AIMessage({ id: "done", content: "done" }))
          yield ["values", { messages }]
        })()
    })
  }
  expect(
    (
      await runWorkflowSubagent(deps, {
        runId: "wf_attribution",
        agentIndex: 0,
        label: "implementer",
        prompt: "write code without rereading the parent Skill",
        signal: new AbortController().signal
      })
    ).text
  ).toBe("done")
  if (parent) {
    await vi.waitFor(() => expect(traces).toHaveLength(1))
    await parent.finish("success")
  }
  return { firstWriteContext, laterWriteContext, childTrace: traces[0] }
}

describe("Workflow child code attribution at startup", () => {
  it.each([true, false])(
    "inherits parent Skills before the first write, with telemetry=%s",
    async (withTrace) => {
      setThreadActiveSkills(parentThreadId, parentSkills, parentSources, { persist: false })
      const { firstWriteContext, laterWriteContext, childTrace } = await runChild({ withTrace })
      expect(firstWriteContext).toMatchObject({
        usedSkills: parentSkills,
        skillSource: parentSources
      })
      expect(laterWriteContext?.usedSkills).toEqual(parentSkills)
      if (withTrace) {
        expect(firstWriteContext?.traceId).toBe(childTrace.traceId)
        expect(firstWriteContext?.parentThreadId).toBe(parentThreadId)
        expect(
          classifyHarnessStageBucket(
            firstWriteContext?.harnessNodeStatus,
            Boolean(firstWriteContext?.usedSkills?.length)
          )
        ).toBe("plugin_constrained")
        // Inheritance attributes code; it must not invent a second Skill invocation.
        expect(childTrace.usedSkills).toEqual([])
        expect(childTrace.skillSource ?? []).toEqual([])
      }
    }
  )

  it("switches subsequent code to the child's own Skill when it reads one", async () => {
    setThreadActiveSkills(parentThreadId, parentSkills, parentSources, { persist: false })
    const { firstWriteContext, laterWriteContext, childTrace } = await runChild({
      withTrace: true,
      readOwnSkill: true
    })
    expect(firstWriteContext?.usedSkills).toEqual(parentSkills)
    expect(laterWriteContext?.usedSkills).toEqual(["own-skill-v2.0.0"])
    expect(laterWriteContext?.skillSource).toEqual([])
    expect(childTrace.usedSkills).toEqual(["own-skill-v2.0.0"])
    expect(getThreadActiveSkills(parentThreadId)).toEqual([...parentSkills, "own-skill-v2.0.0"])
    expect(traces.find((trace) => trace.threadId === parentThreadId)?.usedSkills).toEqual([])
  })

  it("keeps an empty startup snapshot when a parallel agent contributes a Skill later", async () => {
    const { firstWriteContext, childTrace } = await runChild({
      withTrace: true,
      beforeFirstWrite: () => setThreadActiveSkills(parentThreadId, parentSkills, parentSources)
    })
    expect(firstWriteContext?.usedSkills).toEqual([])
    expect(childTrace.usedSkills).toEqual([])
    expect(getThreadActiveSkills(parentThreadId)).toEqual(parentSkills)
  })

  it("keeps genuinely Skill-less code in VibeCoding", async () => {
    const { firstWriteContext, childTrace } = await runChild({ withTrace: true })
    expect(firstWriteContext?.usedSkills).toEqual([])
    expect(
      classifyHarnessStageBucket(
        firstWriteContext?.harnessNodeStatus,
        Boolean(firstWriteContext?.usedSkills?.length)
      )
    ).toBe("vibecoding")
    expect(childTrace.usedSkills).toEqual([])
  })
})

// Team's runner is a closure in the runtime factory. Check the actual entry
// points (inside the synchronous session-capture wrapper) as well as the
// behavior above: the old helper tests passed while its
// callers only synchronized after observing a new Skill read.
describe("subagent attribution initialization order", () => {
  it.each([
    ["../runtime.ts", "runCoordinatorWorkerTurn", "syncWorkerSkillAttribution"],
    ["./subagent.ts", "runOnce", "syncSkillAttribution"]
  ])(
    "initializes %s after trace reset and before runtime creation",
    (path, entryName, syncName) => {
      const source = readFileSync(new URL(path, import.meta.url), "utf8")
      const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
      let body: ts.Block | undefined
      const visit = (node: ts.Node): void => {
        if (ts.isFunctionDeclaration(node) && node.name?.text === entryName) body = node.body
        if (
          ts.isVariableDeclaration(node) &&
          node.name.getText(file) === entryName &&
          node.initializer &&
          ts.isArrowFunction(node.initializer) &&
          ts.isBlock(node.initializer.body)
        )
          body = node.initializer.body
        ts.forEachChild(node, visit)
      }
      visit(file)
      expect(body).toBeDefined()
      const setup = body!.statements.find(ts.isTryStatement)?.tryBlock
      expect(setup).toBeDefined()
      // A direct statement in the try block cannot be gated by trace availability
      // or by a stream observer reporting a new Skill.
      const initIndex = setup!.statements.findIndex((statement) => {
        if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression))
          return false
        const call = statement.expression
        return (
          call.expression.getText(file) === "runTraceSideEffect" &&
          call.arguments[1]?.getText(file) === syncName
        )
      })
      const traceIndex = setup!.statements.findIndex((statement) =>
        /createTraceCollectorSafely\(|createWorkflowSubagentTrace\(/.test(statement.getText(file))
      )
      const runtimeIndex = setup!.statements.findIndex((statement) =>
        /createAgentRuntime\(|createRuntimeWithModelFallback\(/.test(statement.getText(file))
      )
      expect(traceIndex).toBeGreaterThanOrEqual(0)
      expect(initIndex).toBeGreaterThan(traceIndex)
      expect(runtimeIndex).toBeGreaterThan(initIndex)
    }
  )
})
