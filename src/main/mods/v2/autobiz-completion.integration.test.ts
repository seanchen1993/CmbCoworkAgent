import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { promisify } from "node:util"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { ModControlStore } from "../control-store"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionModsManager } from "./manager"
import { runCompletionHooksWithRevision } from "../../agent/skill-lifecycle/completion-hooks"
import type { HookScopeController } from "../../hooks/scope"
import { withPinnedAutobiz } from "./autobiz-source"

vi.mock("../../hooks/required-skill", () => ({ runHooksEnriched: vi.fn() }))
vi.mock("../../services/harness-stage-attribution", () => ({
  markHarnessStageAttributionDirty: vi.fn()
}))
vi.mock("../../hooks/scope", () => ({ resolveEnabledHooksForRun: vi.fn() }))
// The real pinned validator starts a Python subprocess and can contend with
// the other Mods suites when Vitest runs them in parallel.
vi.setConfig({ testTimeout: 60_000 })

const roots: string[] = []
const hostJournal = vi.hoisted(() => ({ root: "" }))
vi.mock("../../app-data-root", () => ({ getCmbCoworkAgentDataRoot: () => hostJournal.root }))
beforeEach(async () => {
  hostJournal.root = await mkdtemp(join(tmpdir(), "mods-autobiz-journal-"))
  roots.push(hostJournal.root)
})
const cleanups: Array<() => Promise<void>> = []
const execute = promisify(execFile)

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function writeArtifacts(
  root: string,
  options: { report?: string; removeProposal?: boolean } = {}
) {
  const featureDir = join(root, ".autobizdevops", "features", "order-export")
  await mkdir(join(featureDir, "specs", "orders"), { recursive: true })
  const proposal = `# Order export\n\n## Why\nThe export needs a stable contract.\n\n## What Changes\nAdd the order export contract.\n\n## Capability Index\n| Capability ID | Name | Operations | Path | Status |\n| --- | --- | --- | --- | --- |\n| CAP-orders | orders | ADDED | specs/orders/spec.md | planned |\n\n## Impact\nNo external impact.\n\n## Out of Scope\nNo migration.\n`
  if (!options.removeProposal) await writeFile(join(featureDir, "proposal.md"), proposal)
  await writeFile(
    join(featureDir, "specs", "orders", "spec.md"),
    `# Orders\n\nCapability-ID: \`CAP-orders\`\n\n## ADDED Requirements\n\n### REQ-orders-001: Export orders\n\n#### SCN-orders-001-01: Export succeeds\n- **WHEN** an order is ready\n- **THEN** it appears in the export\n`
  )
  await writeFile(
    join(featureDir, "design.md"),
    `# Design\n\n## Context / 输入上下文\nfixture\n\n## Code Evidence\nfixture\n\n## Spec Traceability\nREQ-orders-001\n\n## API Decisions\n| ID | Decision | |\n| --- | --- |\n| API-1 | none | |\n\nx-auto-no-http-api: true\n\n## Data Decisions\n| ID | Decision | |\n| --- | --- |\n| DATA-1 | none | |\n\nx-auto-no-sql: true\n\n## Technical Design\nfixture\n\n## Risks / Open Questions\nnone\n`
  )
  await writeFile(
    join(featureDir, "PLAN.md"),
    `# PLAN\n\n## 任务总览\n| ID | 状态 |\n| --- | --- |\n| T1 | 待做 |\n\n## 任务详情\n- T1\n  - **状态:** 待做\n  - **完成记录:** 无\n\n## Contract Coverage\n- REQ-orders-001 -> T1\n`
  )
  if (options.report !== undefined)
    await writeFile(join(featureDir, "REQUIREMENTS_EVAL.md"), options.report)
  return featureDir
}

async function canonicalizeState(root: string) {
  await withPinnedAutobiz(undefined, async (source) => {
    await execute(
      "python",
      [
        "-I",
        "-B",
        "-c",
        "import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from board_core.state_store import check_or_fix_state_sync; r=check_or_fix_state_sync(Path(sys.argv[2]), fix=True); assert not r.errors, r.errors",
        source,
        root
      ],
      { windowsHide: true }
    )
  })
}

async function autobizFixture(
  options: {
    checkpoint?: string
    profile?: string
    report?: string
    removeProposal?: boolean
    mode?: "off" | "check" | "repair"
    checks?: Array<"autobiz-validator" | "unit-test">
    realTestRunner?: boolean
    testPass?: boolean
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "mods-autobiz-completion-"))
  roots.push(root)
  const plugin = join(root, "plugin")
  await cp(resolve("resources/mods/function-commands"), plugin, { recursive: true })
  const featureDir = await writeArtifacts(root, options)
  const profile = options.profile ?? "standard"
  if (profile !== "standard") {
    await mkdir(join(root, ".autobizdevops", "workflow.d"), { recursive: true })
    await writeFile(
      join(root, ".autobizdevops", "workflow.d", `${profile}.json`),
      JSON.stringify({ profile, nodes: [] })
    )
  }
  await mkdir(join(root, ".autobizdevops"), { recursive: true })
  await writeFile(
    join(root, ".autobizdevops", "state.json"),
    JSON.stringify({
      schemaVersion: "autobizdevops.state.v3",
      features: {
        "order-export": {
          feature: "order-export",
          checkpoint: options.checkpoint ?? "requirements_eval_in_progress",
          workflowProfile: profile,
          workflowTemplate: "standard",
          workflowDecisions: {}
        }
      }
    })
  )
  await canonicalizeState(root)
  if (options.realTestRunner) {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "autobiz-fixture", private: true })
    )
    await symlink(resolve("node_modules"), join(root, "node_modules"), "junction")
    await mkdir(join(root, "src"), { recursive: true })
    await mkdir(join(root, "tests"), { recursive: true })
    await writeFile(
      join(root, "src", "order-export.js"),
      "export const exportOrder = (value) => value\n"
    )
    await writeFile(
      join(root, "tests", "order-export.test.js"),
      options.testPass === false
        ? "import { expect, it } from 'vitest'; it('fails the real runner', () => expect(1).toBe(2))\n"
        : "import { expect, it } from 'vitest'; import { exportOrder } from '../src/order-export.js'; it('runs the real runner', () => expect(exportOrder('ok')).toBe('ok'))\n"
    )
  }

  const hooksPath = join(plugin, "hooks", "hooks.json")
  const hooks = JSON.parse(await readFile(hooksPath, "utf8")) as { modules: string[] }
  hooks.modules.push("./completion-gate.ts")
  await writeFile(hooksPath, JSON.stringify(hooks))
  await writeFile(
    join(plugin, "hooks", "completion-gate.ts"),
    `export function register(on) {\n  on("completion.check", () => ({ decision: "pass" }))\n}\n`
  )

  const store = new ModControlStore(join(root, "control.sqlite"))
  const allGuests = new Set<FunctionGuestRuntime>()
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => [{ id: "source", name: "function-commands", path: plugin, enabled: true }],
      enabled: () => true,
      registeredTool: async (_workspace, _thread, _grant, _input, _origin, _signal, run) => run(),
      publish: async (_workspace, value) => value,
      changed: () => undefined
    },
    () => {
      const guests = new Set<FunctionGuestRuntime>()
      return {
        async load(code, loadOptions) {
          const guest = await FunctionGuestRuntime.create(code, loadOptions)
          guests.add(guest)
          allGuests.add(guest)
          return guest
        },
        stop() {
          for (const guest of guests) guest.dispose()
        }
      }
    }
  )
  cleanups.push(async () => {
    manager.close()
    store.close()
    for (const guest of allGuests) guest.dispose()
  })
  const status = await manager.status(root)
  await manager.approve(root, "source", status[0].digest!)
  store.functionState.set(JSON.stringify([root, "function-commands"]), "completion-config", {
    mode: options.mode ?? "check",
    scope: "feature",
    feature: "order-export",
    checks: options.checks ?? ["autobiz-validator"],
    maxRepairs: 1,
    timeoutMs: 30_000,
    modelTokenBudget: 512
  })
  const signal = new AbortController().signal
  await manager.turnStart(root, "thread", { turnId: "turn", text: "review" }, signal)
  return { root, featureDir, manager, store, signal }
}

async function runLoop(
  fixture: Awaited<ReturnType<typeof autobizFixture>>,
  runRevision: () => Promise<void> = async () => {}
) {
  const gate = await fixture.manager.completionGate(fixture.root, "thread", () => ({
    turnId: "turn",
    runId: "run",
    answer: "done"
  }))
  expect(gate).toBeDefined()
  return runCompletionHooksWithRevision({
    threadId: "thread",
    turnId: "turn",
    runId: "run",
    abortSignal: fixture.signal,
    getStopContext: () => ({ assistantResponse: "done" }),
    hookScope: {} as HookScopeController,
    runRevision,
    sendNotice: () => {},
    sendError: () => {},
    maxRevisionAttempts: 1,
    revisionPromptPrefix: "fix",
    runPostSkillUseHooks: async () => null,
    runStopHooks: async () => null,
    completionGate: gate!
  })
}

it("runs the production completion loop against the pinned validator and advances once", async () => {
  const fixture = await autobizFixture({ report: "verdict: PASS\nreal fixture report" })
  const outcome = await runLoop(fixture)
  expect(outcome).toBe("passed")
  const records = fixture.store.completionEvidence(fixture.root, "thread", 100)
  const started = records.find((record) => record.phase === "check.started")!
  const validator = records.find((record) => record.phase === "validator.result")!
  if (started.phase === "capture.failed" || validator.phase === "capture.failed")
    throw Error("Expected bound completion proof")
  expect(validator.detail).toMatchObject({ kind: "autobiz-validator", passed: true })
  const input = {
    evidenceId:
      started.detail && typeof started.detail === "object" && "attempt" in started.detail
        ? String(started.detail.attempt)
        : "",
    feature: "order-export",
    from: "requirements_eval_in_progress",
    to: "requirements_eval_done",
    stateFingerprint: validator.binding.stateFingerprint,
    idempotencyKey: randomUUID()
  }
  const applied = await fixture.manager.advanceAutobizCheckpoint(
    fixture.root,
    "thread",
    input,
    fixture.signal
  )
  expect(applied).toMatchObject({ applied: true, duplicate: false })
  const duplicate = await fixture.manager.advanceAutobizCheckpoint(
    fixture.root,
    "thread",
    input,
    fixture.signal
  )
  expect(duplicate).toMatchObject({ applied: false, duplicate: true })
  const state = JSON.parse(
    await readFile(join(fixture.root, ".autobizdevops", "state.json"), "utf8")
  )
  expect(state.features["order-export"].checkpoint).toBe("requirements_eval_done")
})

it("runs a real temporary project test runner alongside Autobiz validation", async () => {
  const fixture = await autobizFixture({
    report: "verdict: PASS\nreal fixture report",
    checks: ["unit-test", "autobiz-validator"],
    realTestRunner: true,
    testPass: true
  })
  const outcome = await runLoop(fixture)
  expect(outcome).toBe("passed")
  expect(fixture.store.completionEvidence(fixture.root, "thread", 100)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        phase: "validator.result",
        detail: expect.objectContaining({ kind: "unit-test", passed: true })
      })
    ])
  )
})

it("blocks completion when the real temporary test runner fails", async () => {
  const fixture = await autobizFixture({
    checks: ["unit-test"],
    realTestRunner: true,
    testPass: false
  })
  expect(await runLoop(fixture)).toBe("failed")
  expect(fixture.store.completionEvidence(fixture.root, "thread", 100)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        phase: "validator.result",
        status: "block",
        detail: expect.objectContaining({ kind: "unit-test", passed: false })
      })
    ])
  )
})

it("binds dynamic workflow overlays and rejects a transition after the overlay changes", async () => {
  const fixture = await autobizFixture({
    profile: "review-overlay",
    report: "verdict: PASS\nreal fixture report"
  })
  expect(await runLoop(fixture)).toBe("passed")
  const records = fixture.store.completionEvidence(fixture.root, "thread", 100)
  const started = records.find((record) => record.phase === "check.started")!
  const validator = records.find((record) => record.phase === "validator.result")!
  if (started.phase === "capture.failed" || validator.phase === "capture.failed")
    throw Error("Expected bound completion proof")
  await writeFile(
    join(fixture.root, ".autobizdevops", "workflow.d", "review-overlay.json"),
    JSON.stringify({ profile: "review-overlay", nodes: [], changed: true })
  )
  await expect(
    fixture.manager.advanceAutobizCheckpoint(
      fixture.root,
      "thread",
      {
        evidenceId: String((started.detail as { attempt: string }).attempt),
        feature: "order-export",
        from: "requirements_eval_in_progress",
        to: "requirements_eval_done",
        stateFingerprint: validator.binding.stateFingerprint,
        idempotencyKey: randomUUID()
      },
      fixture.signal
    )
  ).rejects.toThrow("MODS_AUTOBIZ_VALIDATOR_STALE")
})

it("rechecks a failed validator after a real repair revision", async () => {
  const fixture = await autobizFixture({ mode: "repair" })
  let repaired = false
  const outcome = await runLoop(fixture, async () => {
    repaired = true
    await writeFile(
      join(fixture.featureDir, "REQUIREMENTS_EVAL.md"),
      "verdict: PASS\nrepair evidence"
    )
  })
  expect(repaired).toBe(true)
  expect(outcome).toBe("passed")
  const validators = fixture.store
    .completionEvidence(fixture.root, "thread", 100)
    .filter((record) => record.phase === "validator.result")
  expect(validators).toHaveLength(2)
  expect(validators[1].status).toBe("block")
  expect(validators[0].status).toBe("pass")
})

it("disables the gate when configured off, then blocks the same task when enabled", async () => {
  const fixture = await autobizFixture({
    mode: "off",
    report: "verdict: FAIL\nreal fixture report"
  })
  expect(
    await fixture.manager.completionGate(fixture.root, "thread", () => ({ turnId: "turn" }))
  ).toBeUndefined()
  fixture.store.functionState.set(
    JSON.stringify([fixture.root, "function-commands"]),
    "completion-config",
    {
      mode: "check",
      scope: "feature",
      feature: "order-export",
      checks: ["autobiz-validator"],
      maxRepairs: 0,
      timeoutMs: 30_000,
      modelTokenBudget: 512
    }
  )
  const outcome = await runLoop(fixture)
  expect(outcome).toBe("failed")
})

it("blocks completion and checkpoint progression for a blocked checkpoint", async () => {
  const fixture = await autobizFixture({
    checkpoint: "needs_fix",
    report: "verdict: PASS\nreal fixture report"
  })
  const outcome = await runLoop(fixture)
  expect(outcome).toBe("failed")
  expect(fixture.store.completionEvidence(fixture.root, "thread", 100)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        phase: "validator.result",
        status: "block",
        detail: expect.objectContaining({
          passed: false,
          reason: expect.stringContaining("AUTOBIZ_CHECKPOINT_BLOCKED")
        })
      })
    ])
  )
})

it("does not accept a failed real artifact check as business completion", async () => {
  const fixture = await autobizFixture({ report: "verdict: FAIL\nreal fixture report" })
  const outcome = await runLoop(fixture)
  expect(outcome).toBe("failed")
  const records = fixture.store.completionEvidence(fixture.root, "thread", 100)
  expect(records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        phase: "validator.result",
        status: "block",
        detail: expect.objectContaining({ passed: false })
      })
    ])
  )
  expect(
    records.some((record) => record.phase === "state.transition" && record.status === "pass")
  ).toBe(false)
})

it("rejects a duplicate completion after external state competition", async () => {
  const fixture = await autobizFixture({ report: "verdict: PASS\nreal fixture report" })
  expect(await runLoop(fixture)).toBe("passed")
  const records = fixture.store.completionEvidence(fixture.root, "thread", 100)
  const started = records.find((record) => record.phase === "check.started")!
  const validator = records.find((record) => record.phase === "validator.result")!
  if (started.phase === "capture.failed" || validator.phase === "capture.failed")
    throw Error("Expected bound completion proof")
  const input = {
    evidenceId: String((started.detail as { attempt: string }).attempt),
    feature: "order-export",
    from: "requirements_eval_in_progress",
    to: "requirements_eval_done",
    stateFingerprint: validator.binding.stateFingerprint,
    idempotencyKey: randomUUID()
  }
  await expect(
    fixture.manager.advanceAutobizCheckpoint(fixture.root, "thread", input, fixture.signal)
  ).resolves.toMatchObject({ applied: true })
  const statePath = join(fixture.root, ".autobizdevops", "state.json")
  const state = JSON.parse(await readFile(statePath, "utf8"))
  state.features["order-export"].checkpoint = "needs_fix"
  await writeFile(statePath, JSON.stringify(state))
  await expect(
    fixture.manager.advanceAutobizCheckpoint(fixture.root, "thread", input, fixture.signal)
  ).rejects.toThrow("AUTOBIZ_STATE_CHANGED")
})

it("does not reapply a ledger-only transition when the trusted commit receipt is missing", async () => {
  const fixture = await autobizFixture({ report: "verdict: PASS\nreal fixture report" })
  expect(await runLoop(fixture)).toBe("passed")
  const records = fixture.store.completionEvidence(fixture.root, "thread", 100)
  const started = records.find((record) => record.phase === "check.started")!
  const validator = records.find((record) => record.phase === "validator.result")!
  if (started.phase === "capture.failed" || validator.phase === "capture.failed")
    throw Error("Expected bound completion proof")
  const input = {
    evidenceId: String((started.detail as { attempt: string }).attempt),
    feature: "order-export",
    from: "requirements_eval_in_progress",
    to: "requirements_eval_done",
    stateFingerprint: validator.binding.stateFingerprint,
    idempotencyKey: randomUUID()
  }
  fixture.store.saveCompletionEvidence({
    ...started, id: randomUUID(), idempotencyKey: `ledger-only:${input.idempotencyKey}`,
    phase: "state.transition", status: "pass", at: Date.now(),
    detail: { ...input, applied: true, duplicate: false }
  })
  const statePath = join(fixture.root, ".autobizdevops", "state.json")
  const before = await readFile(statePath, "utf8")
  await expect(fixture.manager.advanceAutobizCheckpoint(
    fixture.root, "thread", input, fixture.signal
  )).rejects.toThrow("AUTOBIZ_RECEIPT_REQUIRED")
  expect(await readFile(statePath, "utf8")).toBe(before)
})
