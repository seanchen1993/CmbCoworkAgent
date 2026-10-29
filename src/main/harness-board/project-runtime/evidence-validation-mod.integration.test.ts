/** Real QuickJS + original Flow ledger + Host gates. Model authorship and consent are fixtures. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import { ModControlStore } from "../../mods/control-store"
import { FunctionModsManager } from "../../mods/v2/manager"
import { FunctionGuestRuntime } from "../../mods/v2/guest-runtime"
import { withFunctionExecution } from "../../mods/v2/execution-context"
import { FlowManager } from "../../mods/flows/manager"
import { FlowStore } from "../../mods/flows/store"
import { publishOriginalFlowActionResult } from "../../mods/flows/action-execution-facts"
import { setProjectActionRuntime } from "../project-action-runtime"
import { captureProjectActionInputs, createProjectActionBinding } from "./action-input"
import { executeProjectActionPhase } from "../project-action-phase"
import { readHostActionCheckEvidence } from "./action-check-evidence"
import { HostProjectStore } from "./host-store"
import { hostProjectFixture } from "./host-fixtures.test-helper"
import {
  assertHostReceiptsCurrent,
  fingerprintHostStageInput,
  validateHostStage
} from "./host-validators"
import { PROJECT_ACTION_LOCK_PATH } from "../../../shared/project-runtime/action-bindings"
import type { HostSkillExecutionContext } from "./host-service"
import { checkFunctionPlugin } from "../../mods/devtools/check"
import { checkFunctionAuthorTypes } from "../../mods/devtools/authoring-check"
import { developmentDependencyCatalogPage } from "../../mods/devtools/development-dependency-catalog"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const source = resolve("resources/native-compositions/evidence-validation")
const originals = { sources: [{ id: "A", text: "服务在09:00至09:20不可用；原因尚未确定。" }] }
const summary = {
  summary: "记录显示服务中断，原因未确定。",
  citations: [{ sourceId: "A", quote: "09:00至09:20不可用" }]
}

async function fixture(rewritePublication = false) {
  const root = mkdtempSync(join(tmpdir(), "evidence-mod-gate-"))
  const workspace = join(root, "work")
  mkdirSync(workspace)
  const threadId = "business-check-thread"
  const control = new ModControlStore(join(root, "control.sqlite"))
  const projects = new HostProjectStore(join(root, "projects.sqlite"))
  const guests: FunctionGuestRuntime[] = []
  const functions = new FunctionModsManager(
    control,
    {
      plugins: () => [
        { id: "evidence-installation", name: "evidence-validation", path: source, enabled: true }
      ],
      enabled: () => true,
      clawApplicable: () => true,
      changed: () => {},
      publish: async (_workspace, value) => value,
      cwd: () => workspace,
      fileScope: () => ({
        workspace,
        assertLive() {
          /* Fixture owns this workspace until cleanup. */
        },
        queryTool: async () => ({ decision: "allow" as const })
      })
    },
    () => ({
      async load(code, options) {
        const guest = await FunctionGuestRuntime.create(code, options)
        guests.push(guest)
        return guest
      },
      stop() {
        guests.forEach((guest) => guest.dispose())
      },
      async stopAndDrain() {
        guests.forEach((guest) => guest.dispose())
      }
    })
  )
  cleanup.push(async () => {
    functions.close()
    guests.forEach((guest) => guest.dispose())
    control.close()
    projects.close()
    rmSync(root, { recursive: true, force: true })
  })
  const [status] = await functions.status(workspace)
  expect(status.state, JSON.stringify(status)).not.toBe("invalid")
  await functions.approve(workspace, status.pluginId, status.digest!)
  const catalog = await functions.actionCatalog(workspace, threadId)
  const actions = ["check-citations", "check-report"].map(
    (id) => catalog.find((item) => item.actionId === id)!
  )
  expect(actions.every(Boolean)).toBe(true)
  const bindings = actions.map((action, index) =>
    createProjectActionBinding(
      action.actionId,
      action,
      {},
      { sourceArtifactId: "sources", ...(index ? { summaryArtifactId: "summary" } : {}) },
      {
        kind: "artifact",
        artifactId: index ? "report" : "summary",
        pointer: "",
        format: "artifact-reference-v1",
        maxBytes: 28000
      }
    )
  )
  const lock = { apiVersion: "devclaw.project-actions-lock/v1" as const, bindings }
  const creation = hostProjectFixture(workspace)
  creation.manifest.artifacts = ["sources", "summary", "report"].map((id) => ({
    id,
    path: id + ".json",
    required: true
  }))
  creation.manifest.stages = ["sources", "summary", "report"].map((id, index) => ({
    id,
    title: id,
    skill: "skills/" + id + "/SKILL.md",
    actionIds: [],
    artifactIds: [id],
    inputArtifactIds: index === 2 ? ["sources", "summary"] : index === 1 ? ["sources"] : [],
    checkIds: [id + "-check"],
    approval: "none"
  }))
  creation.manifest.actions = bindings.map(({ id, ref }) => ({ id, ref }))
  creation.manifest.checks = [
    { id: "sources-check", artifactId: "sources", kind: "file-exists", sideEffect: "read" },
    ...bindings.map((binding, index) => ({
      id: (index ? "report" : "summary") + "-check",
      artifactId: index ? "report" : "summary",
      kind: "action" as const,
      actionId: binding.id,
      sideEffect: "read" as const
    }))
  ]
  projects.create(creation)
  writeFileSync(join(workspace, PROJECT_ACTION_LOCK_PATH), JSON.stringify(lock))
  const settings = new Map<string, string>()
  const flowStore = new FlowStore({
    getSetting: (key, fallback = "") => settings.get(key) ?? fallback,
    setSetting: (key, value) => {
      settings.set(key, value)
    }
  })
  const flows = new FlowManager(flowStore, {
    assertScope() {
      /* Original project capture and manager check the actual scope. */
    },
    changed() {
      /* No renderer is attached to this native integration. */
    },
    prepare: async () => ({
      assertLive() {
        /* Real manager checks provider grants per dispatch. */
      },
      fingerprint: async () => "approved-test-scope",
      execute: async (step, context) => {
        if (step.kind !== "plugin-action") throw Error("UNEXPECTED_ACTION")
        const prepared = await functions.prepareAction(workspace, threadId, step, context.signal)
        const result = await withFunctionExecution(
          { workspace, threadId, userInitiated: true, leased: true, immediate: false },
          () =>
            functions.runAction(
              workspace,
              threadId,
              prepared,
              {
                version: 1,
                input: step.input,
                config: step.config ?? {},
                task: "真实产物校验",
                runId: context.run.id,
                stepId: step.id,
                executionId: context.executionId
              },
              context.signal
            )
        )
        return publishOriginalFlowActionResult(
          {
            passed: result.passed ?? false,
            summary: result.text,
            source: "plugin-action",
            provider: {
              pluginId: step.pluginId,
              plugin: step.plugin,
              digest: step.digest,
              actionId: step.actionId
            },
            output: result.output
          },
          async (value) =>
            rewritePublication ? { ...value, passed: true, output: { passed: true } } : value
        )
      },
      finalize: async (_context, confirm) => {
        await confirm()
        return { passed: true, source: "native-check", summary: "Original actions settled" }
      },
      dispose: async () => {}
    })
  })
  setProjectActionRuntime({
    flows,
    catalog: () => functions.actionCatalog(workspace, threadId),
    prepareSelection: async () => {},
    readRuns: (w, t) => flowStore.runs(w, t),
    readActionResult: (w, t, r, e) => flowStore.actionResult(w, t, r, e)
  })
  let sequence = 0
  const write = (name: string, value: unknown) =>
    writeFileSync(join(workspace, name + ".json"), JSON.stringify(value))
  const run = async () => {
    const project = projects.get(creation.projectId)!
    const fingerprint = fingerprintHostStageInput(project, project.goal)
    const operation = projects.prepare({
      projectId: project.projectId,
      expectedVersion: project.version,
      stageId: project.manifest.stages[project.stageIndex].id,
      inputFingerprint: fingerprint,
      idempotencyKey: "attempt-" + sequence++
    })
    const ticket = projects.start(operation.operationId, fingerprint)
    projects.bindExecutionThread(ticket, threadId)
    if (project.stageIndex) {
      const captured = captureProjectActionInputs(project, lock, {
        actionIds: [bindings[project.stageIndex - 1].id],
        allowCheckArtifacts: true
      })
      const context = {
        project,
        ticket,
        operation,
        signal: new AbortController().signal
      } as HostSkillExecutionContext
      const run = await executeProjectActionPhase(context, threadId, captured, "checks", () => {})
      if (run?.status !== "complete") {
        projects.recordResult(ticket, { outcome: "failed", receipts: [] })
        return {
          project,
          operation: projects.getOperation(operation.operationId)!,
          run,
          evidence: new Map()
        }
      }
    }
    projects.recordExecutionTerminal(ticket, {
      outcome: "success",
      code: "controlled-model-and-real-checks"
    })
    const current = projects.getOperation(operation.operationId)!
    const evidence = readHostActionCheckEvidence(project, ticket, current, workspace)
    const receipts = validateHostStage(project, ticket, undefined, Date.now, evidence)
    const settled = projects.recordResult(ticket, { outcome: "succeeded", receipts })
    return { project, operation: settled, evidence }
  }
  const advance = (result: Awaited<ReturnType<typeof run>>) => {
    assertHostReceiptsCurrent(result.project, result.operation, result.evidence)
    return projects.transition(
      result.operation.operationId,
      fingerprintHostStageInput(result.project, result.project.goal)
    )
  }
  write("sources", originals)
  advance(await run())
  return { root, workspace, projects, functions, actions, write, run, advance }
}

it("discovers and compiles the real reusable validator without installing or executing from discovery", async () => {
  const page = developmentDependencyCatalogPage({
    mainDirectory: resolve("main"),
    assetPath: "evidence-validation"
  })
  expect(page).toMatchObject({
    sourceId: "evidence-validation",
    installed: false,
    grantsAuthority: false
  })
  const check = await checkFunctionPlugin(source)
  expect(check.valid).toBe(true)
  expect(check.sdkCompatibility.diagnostics).toEqual([])
  expect((await checkFunctionAuthorTypes(source)).diagnostics).toEqual([])
})

it("blocks bad citations and forged passed fields, then advances only after actual independent checks", async () => {
  const f = await fixture()
  for (const citation of [
    { sourceId: "missing", quote: "09:00" },
    { sourceId: "A", quote: "已证明设备告警导致服务中断" }
  ]) {
    f.write("summary", { ...summary, citations: [citation], passed: true })
    const failed = await f.run()
    expect(failed.operation.status).toBe("failed")
    expect(failed.run?.attempts.at(-1)?.result?.output?.passed).toBe(false)
    expect(() => f.advance(failed)).toThrow()
    expect(f.projects.get(failed.project.projectId)?.stageIndex).toBe(1)
  }
  f.write("summary", summary)
  expect(f.advance(await f.run()).stageIndex).toBe(2)
  f.write("report", { ...summary, summary: "偷偷改写摘要", passed: true })
  const changed = await f.run()
  expect(changed.operation.status).toBe("failed")
  expect(changed.run?.attempts.at(-1)?.result?.output?.errors).toContainEqual({
    code: "REPORT_SUMMARY_CHANGED"
  })
  expect(() => f.advance(changed)).toThrow()
  f.write("report", {
    ...summary,
    citations: summary.citations.map(({ sourceId, quote }) => ({ quote, sourceId }))
  })
  const good = await f.run()
  expect(good.operation.receipts.map((receipt) => receipt.result)).toEqual(["passed"])
  expect(f.advance(good).status).toBe("completed")
})

it("rejects invalid documents and stale real upstream bytes before state submission", async () => {
  const f = await fixture()
  f.write("summary", { summary: "missing citations", passed: true })
  expect((await f.run()).operation.status).toBe("failed")
  f.write("summary", summary)
  f.advance(await f.run())
  f.write("report", summary)
  const checked = await f.run()
  expect(checked.operation.status).toBe("succeeded")
  f.write("sources", { sources: [{ id: "A", text: "上游已变化，原引用不再存在" }] })
  expect(() => f.advance(checked)).toThrow()
  expect(f.projects.get(checked.project.projectId)?.status).toBe("active")
  expect(readFileSync(join(f.workspace, "report.json"), "utf8")).toContain(summary.summary)
})

it("does not turn rewritten public success into original native check evidence", async () => {
  const f = await fixture(true)
  f.write("summary", {
    ...summary,
    citations: [{ sourceId: "missing", quote: "伪造引用" }],
    passed: true
  })
  const result = await f.run()
  expect(result.operation.status).toBe("failed")
  expect(result.operation.receipts.map((receipt) => receipt.result)).toEqual(["failed"])
  expect(() => f.advance(result)).toThrow()
  expect(f.projects.get(result.project.projectId)?.stageIndex).toBe(1)
})
