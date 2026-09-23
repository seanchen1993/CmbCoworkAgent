import { LocalSandbox } from "../../agent/local-sandbox"
import { ModsManager, getModsManager, setModsManager } from "../manager"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"
import { withFunctionExecution } from "./execution-context"
import { runProjectCheck } from "../../../../tests/support/project-check-executor"
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { promisify } from "node:util"
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest"
import { ModControlStore } from "../control-store"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionModsManager } from "./manager"
import { runCompletionHooksWithRevision } from "../../agent/skill-lifecycle/completion-hooks"
import type { HookScopeController } from "../../hooks/scope"
import { withPinnedAutobiz } from "./autobiz-source"

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => {} }
}))
vi.mock("../../hooks/required-skill", () => ({ runHooksEnriched: vi.fn() }))
vi.mock("../../services/harness-stage-attribution", () => ({
  markHarnessStageAttributionDirty: vi.fn()
}))
vi.mock("../../hooks/scope", () => ({ resolveEnabledHooksForRun: vi.fn() }))
// The real pinned validator starts a Python subprocess and can contend with
// the other Mods suites when Vitest runs them in parallel.
vi.setConfig({ testTimeout: 60_000 })

const roots: string[] = []
const hostJournal = vi.hoisted(() => ({ root: "", applicationRoot: "" }))
vi.mock("../../app-data-root", async () => {
  const { mkdtemp } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  hostJournal.applicationRoot = await mkdtemp(join(tmpdir(), "mods-autobiz-app-"))
  return { getCmbCoworkAgentDataRoot: () => hostJournal.root || hostJournal.applicationRoot }
})
afterAll(async () => {
  await rm(hostJournal.applicationRoot, { recursive: true, force: true })
})
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
    nativeTransition?: boolean
    nativeBridge?: boolean
    approved?: boolean
    autoStage?: string
    guestStage?: string
    revokeAfterCommit?: boolean
    approvalObserver?: () => void
  } = {}
) {
  let root = await mkdtemp(join(tmpdir(), "mods-autobiz-completion-"))
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

  const native = options.nativeBridge
    ? new ModsManager(
        join(hostJournal.root, "native-control.sqlite"),
        () => [],
        async () => {
          options.approvalObserver?.()
          return options.approved !== false
        },
        () => {}
      )
    : undefined
  const previous = getModsManager()
  const nativeController = new AbortController()
  const signal = nativeController.signal
  let release = () => {}
  let authority: ReturnType<ModsManager["createRuntimeAuthority"]> | undefined
  if (native) {
    root = native.workspaceKey(root)
    native.configure(root, true, false)
    setModsManager(native)
    authority = native.createRuntimeAuthority({
      workspace: root,
      threadId: "thread",
      turnId: "turn",
      signal
    })
    expect(
      claimLocalThreadRunLease({ threadId: "thread", owner: "mods", runId: "run" }).acquired
    ).toBe(true)
    new LocalSandbox({
      rootDir: root,
      modWorkspace: root,
      modRuntimeAuthority: authority.authority,
      runId: "thread",
      hookTurnId: "turn",
      windowsSandbox: "none",
      abortSignal: signal,
      onModBinding: (dispose) => {
        release = dispose
      }
    })
  }
  const store = native?.store ?? new ModControlStore(join(root, "control.sqlite"))
  const allGuests = new Set<FunctionGuestRuntime>()
  const manager = new FunctionModsManager(
    store,
    {
      // Upstream contract fixture only. Native approval/lease integration lives in tool-sdk.integration.test.ts.
      checkpointTransition: native
        ? (workspace, thread, grant, input, signal, commit) =>
            native.runCompletionCheckpoint(
              workspace,
              thread,
              grant,
              input,
              signal,
              async (signal) => {
                const result = await commit(signal)
                if (options.revokeAfterCommit) manager.revoke(root, "function-commands")
                return result
              }
            )
        : options.nativeTransition === false
          ? undefined
          : (_workspace, _thread, _grant, _input, signal, commit) => commit(signal),
      projectCheck: (workspace, _thread, _grant, kind, signal, timeout) =>
        runProjectCheck(workspace, kind, signal, timeout),
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
    nativeController.abort()
    release()
    authority?.release()
    if (native) releaseLocalThreadRunLease("thread", "mods", "run")
    manager.close()
    if (native) {
      native.close()
      setModsManager(previous)
    } else store.close()
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
    modelTokenBudget: 512,
    ...(options.guestStage ? { autobizStartCheckpoint: options.guestStage } : {})
  })
  if (options.autoStage)
    manager.setCompletionPolicy(root, "thread", "function-commands", {
      mode: options.mode ?? "check",
      scope: "feature",
      feature: "order-export",
      checks: options.checks ?? ["autobiz-validator"],
      maxRepairs: 1,
      timeoutMs: 30000,
      modelTokenBudget: 512,
      autobizStartCheckpoint: options.autoStage
    })
  native?.attachFunctions({
    completionGate: (...args) => manager.completionGate(...args),
    invalidate: (workspace) => manager.invalidate(workspace),
    closeThread: (thread) => manager.closeThread(thread),
    close: () => manager.close()
  })
  await manager.turnStart(root, "thread", { turnId: "turn", text: "review" }, signal)
  return { root, featureDir, manager, store, signal, native, authority: authority?.authority }
}

async function runLoop(
  fixture: Awaited<ReturnType<typeof autobizFixture>>,
  runRevision: () => Promise<void> = async () => {}
) {
  const context = () => ({ turnId: "turn", runId: "run", answer: "done" })
  const gate = fixture.native
    ? await fixture.native.createCompletionGate(fixture.root, "thread", context)
    : await fixture.manager.completionGate(fixture.root, "thread", context)
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
  if (!started.binding || !validator.binding) throw Error("Expected bound completion proof")
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
  if (!started.binding || !validator.binding) throw Error("Expected bound completion proof")
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
  if (!started.binding || !validator.binding) throw Error("Expected bound completion proof")
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
  if (!started.binding || !validator.binding) throw Error("Expected bound completion proof")
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
    detail: { ...input, plugin: "function-commands", applied: true, duplicate: false }
  })
  const statePath = join(fixture.root, ".autobizdevops", "state.json")
  const before = await readFile(statePath, "utf8")
  await expect(fixture.manager.advanceAutobizCheckpoint(
    fixture.root, "thread", input, fixture.signal
  )).rejects.toThrow("AUTOBIZ_RECEIPT_REQUIRED")
  expect(await readFile(statePath, "utf8")).toBe(before)
})

it("cannot advance valid upstream evidence without the native transition authority adapter", async () => {
  const f = await autobizFixture({
    report: "verdict: PASS\ncontract fixture only",
    nativeTransition: false
  })
  const gate = await f.manager.completionGate(f.root, "thread", () => ({ turnId: "turn" }))
  expect(
    await gate!({ signal: f.signal, revisionAttempts: 0, maxRevisionAttempts: 2 })
  ).toMatchObject({ decision: "pass" })
  const rows = f.manager.completionEvidence(f.root, "thread")
  const start = rows.find((row) => row.phase === "check.started")!
  if (
    !start.binding ||
    !start.detail ||
    typeof start.detail !== "object" ||
    Array.isArray(start.detail)
  )
    throw Error("missing evidence")
  const before = await readFile(join(f.root, ".autobizdevops", "state.json"), "utf8")
  await expect(
    f.manager.advanceAutobizCheckpoint(
      f.root,
      "thread",
      {
        evidenceId: String(start.detail.attempt),
        feature: "order-export",
        from: "requirements_eval_in_progress",
        to: "requirements_eval_done",
        stateFingerprint: start.binding.stateFingerprint,
        idempotencyKey: "missing-native-adapter"
      },
      f.signal
    )
  ).rejects.toThrow("MODS_AUTOBIZ_TRANSITION_AUTHORITY_REQUIRED")
  expect(await readFile(join(f.root, ".autobizdevops", "state.json"), "utf8")).toBe(before)
})

it.each([true, false])(
  "uses the real native authority and upstream journal with approval=%s",
  async (approved) => {
    const f = await autobizFixture({
      nativeBridge: true,
      approved,
      report: "verdict: PASS\nupstream contract fixture only"
    })
    expect(await runLoop(f)).toBe("passed")
    const start = f.store
      .completionEvidence(f.root, "thread")
      .find((row) => row.phase === "check.started")!
    if (
      !start.binding ||
      !start.detail ||
      typeof start.detail !== "object" ||
      Array.isArray(start.detail)
    )
      throw Error("missing evidence")
    const input = {
      evidenceId: String(start.detail.attempt),
      feature: "order-export",
      from: "requirements_eval_in_progress",
      to: "requirements_eval_done",
      stateFingerprint: start.binding.stateFingerprint,
      idempotencyKey: "native-upstream-operation"
    }
    const state = join(f.root, ".autobizdevops", "state.json")
    const before = await readFile(state, "utf8")
    const advance = () =>
      withFunctionExecution(
        {
          workspace: f.root,
          threadId: "thread",
          turnId: "turn",
          runtimeAuthority: f.authority,
          leased: true,
          immediate: false,
          userInitiated: false
        },
        () => f.manager.advanceAutobizCheckpoint(f.root, "thread", input, f.signal)
      )
    if (approved) {
      expect(await advance()).toMatchObject({ applied: true, duplicate: false })
      const after = await readFile(state, "utf8")
      expect(JSON.parse(after).features["order-export"].checkpoint).toBe("requirements_eval_done")
      expect(await advance()).toMatchObject({ applied: false, duplicate: true })
      expect(await readFile(state, "utf8")).toBe(after)
      expect(
        f.store
          .audit(f.root)
          .filter((row) => row.toolId === "host:autobiz_checkpoint")
          .every((row) => row.status === "succeeded")
      ).toBe(true)
    } else {
      await expect(advance()).rejects.toThrow("MODS_USER_REJECTED")
      expect(await readFile(state, "utf8")).toBe(before)
      expect(f.store.audit(f.root).some((row) => row.status === "succeeded")).toBe(false)
    }
  }
)

it("automatically advances the configured stage once through the original completion loop and native authority", async () => {
  const f = await autobizFixture({
    nativeBridge: true,
    autoStage: "requirements_eval_in_progress",
    report: "verdict: PASS\ncontract fixture only"
  })
  expect(await runLoop(f)).toBe("passed")
  const statePath = join(f.root, ".autobizdevops", "state.json")
  const after = await readFile(statePath, "utf8")
  expect(JSON.parse(after).features["order-export"].checkpoint).toBe("requirements_eval_done")
  expect(await runLoop(f)).toBe("passed")
  expect(await readFile(statePath, "utf8")).toBe(after)
  expect(
    f.store
      .completionEvidence(f.root, "thread")
      .filter((row) => row.phase === "state.transition" && row.status === "pass")
  ).toHaveLength(1)
  expect(
    f.store.audit(f.root).filter((row) => row.toolId === "host:autobiz_checkpoint")
  ).toHaveLength(1)
})

it("keeps guest-selected stage metadata read-only and requires an explicit app opt-in", async () => {
  const f = await autobizFixture({
    nativeBridge: true,
    guestStage: "requirements_eval_in_progress",
    report: "verdict: PASS\ncontract fixture only"
  })
  const statePath = join(f.root, ".autobizdevops", "state.json")
  const before = await readFile(statePath, "utf8")
  expect(await runLoop(f)).toBe("passed")
  expect(await readFile(statePath, "utf8")).toBe(before)
  expect(f.store.audit(f.root)).toHaveLength(0)
})

it("performs a real artifact repair and revalidation before the automatic stage transition", async () => {
  const f = await autobizFixture({
    nativeBridge: true,
    autoStage: "requirements_eval_in_progress",
    mode: "repair"
  })
  const repair = vi.fn(async () => {
    await writeFile(
      join(f.featureDir, "REQUIREMENTS_EVAL.md"),
      "verdict: PASS\ncontract fixture repaired"
    )
  })
  expect(await runLoop(f, repair)).toBe("passed")
  expect(repair).toHaveBeenCalledTimes(1)
  expect(
    JSON.parse(await readFile(join(f.root, ".autobizdevops", "state.json"), "utf8")).features[
      "order-export"
    ].checkpoint
  ).toBe("requirements_eval_done")
})

it("leaves the same task ungated when off and advances only after the application stage is enabled", async () => {
  const f = await autobizFixture({
    nativeBridge: true,
    report: "verdict: PASS\ncontract fixture only"
  })
  const policy = {
    mode: "check",
    scope: "feature",
    feature: "order-export",
    checks: ["autobiz-validator"],
    maxRepairs: 1,
    timeoutMs: 30000,
    modelTokenBudget: 512,
    autobizStartCheckpoint: "requirements_eval_in_progress"
  }
  f.manager.setCompletionPolicy(f.root, "thread", "function-commands", { ...policy, mode: "off" })
  expect(
    await f.native!.createCompletionGate(f.root, "thread", () => ({ turnId: "turn" }))
  ).toBeUndefined()
  expect(f.store.audit(f.root)).toHaveLength(0)
  f.manager.setCompletionPolicy(f.root, "thread", "function-commands", policy)
  expect(await runLoop(f)).toBe("passed")
  expect(
    JSON.parse(await readFile(join(f.root, ".autobizdevops", "state.json"), "utf8")).features[
      "order-export"
    ].checkpoint
  ).toBe("requirements_eval_done")
})

it("fails the original completion when native checkpoint approval is rejected", async () => {
  const f = await autobizFixture({
    nativeBridge: true,
    approved: false,
    autoStage: "requirements_eval_in_progress",
    report: "verdict: PASS\ncontract fixture only"
  })
  const statePath = join(f.root, ".autobizdevops", "state.json")
  const before = await readFile(statePath, "utf8")
  expect(await runLoop(f)).toBe("failed")
  expect(await readFile(statePath, "utf8")).toBe(before)
  expect(
    f.store
      .completionEvidence(f.root, "thread")
      .some((row) => row.phase === "state.transition" && row.status === "pass")
  ).toBe(false)
})

it("retains read-only project validation when no explicit feature or automatic stage is selected", async () => {
  const f = await autobizFixture({
    nativeBridge: true,
    report: "verdict: PASS\ncontract fixture only"
  })
  f.manager.setCompletionPolicy(f.root, "thread", "function-commands", {
    mode: "check",
    scope: "project",
    checks: ["autobiz-validator"],
    maxRepairs: 0,
    timeoutMs: 30000,
    modelTokenBudget: 512
  })
  const path = join(f.root, ".autobizdevops", "state.json")
  const before = await readFile(path, "utf8")
  expect(await runLoop(f)).toBe("passed")
  expect(await readFile(path, "utf8")).toBe(before)
  expect(f.store.audit(f.root)).toHaveLength(0)
})

it("persists separate transition receipts when two projects reuse the same completion key", async () => {
  const first = await autobizFixture({ report: "verdict: PASS\ncontract fixture only" })
  const second = await autobizFixture({ report: "verdict: PASS\ncontract fixture only" })
  for (const f of [first, second]) {
    expect(await runLoop(f)).toBe("passed")
    const start = f.store
      .completionEvidence(f.root, "thread")
      .find((row) => row.phase === "check.started")!
    if (
      !start.binding ||
      !start.detail ||
      typeof start.detail !== "object" ||
      Array.isArray(start.detail)
    )
      throw Error("missing evidence")
    await f.manager.advanceAutobizCheckpoint(
      f.root,
      "thread",
      {
        evidenceId: String(start.detail.attempt),
        feature: "order-export",
        from: "requirements_eval_in_progress",
        to: "requirements_eval_done",
        stateFingerprint: start.binding.stateFingerprint,
        idempotencyKey: "same-project-local-key"
      },
      f.signal
    )
    const committed = f.store
      .completionEvidence(f.root, "thread")
      .filter((row) => row.phase === "state.transition")
    expect(committed).toHaveLength(1)
    // Production uses one control store for all workspaces. Import the genuine first
    // receipt into the second fixture's store before its operation starts.
    if (f === first) second.store.saveCompletionEvidence(committed[0])
  }
})

it("cannot use a stage validator proof to authorize a different destination", async () => {
  const f = await autobizFixture({ report: "verdict: PASS\ncontract fixture only" })
  expect(await runLoop(f)).toBe("passed")
  const start = f.store
    .completionEvidence(f.root, "thread")
    .find((row) => row.phase === "check.started")!
  if (
    !start.binding ||
    !start.detail ||
    typeof start.detail !== "object" ||
    Array.isArray(start.detail)
  )
    throw Error("missing evidence")
  const path = join(f.root, ".autobizdevops", "state.json")
  const before = await readFile(path, "utf8")
  await expect(
    f.manager.advanceAutobizCheckpoint(
      f.root,
      "thread",
      {
        evidenceId: String(start.detail.attempt),
        feature: "order-export",
        from: "requirements_eval_in_progress",
        to: "development_in_progress",
        stateFingerprint: start.binding.stateFingerprint,
        idempotencyKey: "different-destination"
      },
      f.signal
    )
  ).rejects.toThrow("MODS_AUTOBIZ_STAGE_EVIDENCE_REQUIRED")
  expect(await readFile(path, "utf8")).toBe(before)
})

it("preserves a blocked transition attempt when native approval throws before the commit", async () => {
  let observedStart = false
  const f = await autobizFixture({
    nativeBridge: true,
    approved: false,
    autoStage: "requirements_eval_in_progress",
    report: "verdict: PASS\ncontract fixture only",
    approvalObserver: () => {
      observedStart = f.store
        .completionEvidence(f.root, "thread")
        .some((row) => String(row.phase) === "state.transition.started" && row.status === "running")
    }
  })
  expect(await runLoop(f)).toBe("failed")
  expect(observedStart).toBe(true)
  const attempt = f.store
    .completionEvidence(f.root, "thread")
    .find((row) => row.phase === "state.transition")
  expect(attempt).toMatchObject({ status: "block", detail: { reason: "MODS_USER_REJECTED" } })
  expect(
    f.store
      .completionEvidence(f.root, "thread")
      .some((row) => String(row.phase) === "state.transition.started" && row.status === "completed")
  ).toBe(true)
  expect(
    JSON.parse(await readFile(join(f.root, ".autobizdevops/state.json"), "utf8")).features[
      "order-export"
    ].checkpoint
  ).toBe("requirements_eval_in_progress")
})

it("retains an interrupted transition fact if revocation arrives after the physical journal commit", async () => {
  const f = await autobizFixture({
    nativeBridge: true,
    revokeAfterCommit: true,
    autoStage: "requirements_eval_in_progress",
    report: "verdict: PASS\ncontract fixture only"
  })
  await runLoop(f).catch(() => undefined)
  expect(
    JSON.parse(await readFile(join(f.root, ".autobizdevops/state.json"), "utf8")).features[
      "order-export"
    ].checkpoint
  ).toBe("requirements_eval_done")
  const attempts = f.store
    .completionEvidence(f.root, "thread")
    .filter((row) => row.phase === "state.transition")
  expect(attempts).toHaveLength(1)
  expect(attempts[0]).toMatchObject({
    status: "interrupted",
    detail: { applied: true, status: "committed" }
  })
  expect((attempts[0].detail as { operationId: string }).operationId).toMatch(/^[a-f0-9]{64}$/)
  expect(attempts.some((row) => row.status === "pass")).toBe(false)
})
