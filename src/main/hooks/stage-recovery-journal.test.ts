import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { ModControlStore } from "../mods/control-store"
import { StageRecoveryHookJournal, type StageRecoveryHookIdentity } from "./stage-recovery-journal"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close()
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "recovery-hook-journal-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const settings = new ModControlStore(join(root, "journal.sqlite"))
  cleanups.push(() => settings.close())
  const journal = new StageRecoveryHookJournal(settings)
  const identity: StageRecoveryHookIdentity = {
    projectId: "branch",
    operationId: "operation",
    threadId: "thread",
    baselineId: "baseline",
    packageDigest: "a".repeat(64),
    stageId: "review",
    policyDigest: "b".repeat(64),
    hookDigest: "c".repeat(64)
  }
  return { settings, journal, identity }
}

it("persists the exact intent before execution and keeps uncertain effects blocked after restart", () => {
  const f = fixture(),
    receipt = f.journal.begin(f.identity, () => {})
  const [intent] = f.journal.list("branch")
  expect(intent).toMatchObject({ phase: "started", identity: f.identity })
  const cold = new StageRecoveryHookJournal(f.settings)
  expect(cold.hasUnresolved("branch", "operation")).toBe(true)
  expect(() => cold.begin({ ...f.identity, operationId: "retry" }, () => {})).toThrow(
    "RECOVERY_HOOK_OUTCOME_UNCONFIRMED"
  )
  receipt.settle(null, true)
  expect(cold.list("branch")).toMatchObject([{ id: intent.id, phase: "unknown" }])
  expect(() => cold.begin(f.identity, () => {})).toThrow("RECOVERY_HOOK_OUTCOME_UNCONFIRMED")
  expect(() => receipt.settle(0, false)).toThrow("HOOK_JOURNAL_CHANGED")
})

it("separates a settled denial from missing results and never treats cancellation as rollback", () => {
  const f = fixture()
  f.journal.begin(f.identity, () => {}).settle(2, false)
  expect(f.journal.list("branch")).toMatchObject([{ phase: "settled", exitCode: 2 }])
  expect(f.journal.inspectPhysical(f.journal.list("branch")[0])).toMatchObject({
    outcome: "confirmed-completed",
    exitCode: 2
  })
  expect(f.journal.hasUnresolved("branch")).toBe(false)
  f.journal
    .begin({ ...f.identity, operationId: "fresh-approved-operation" }, () => {})
    .settle(0, true)
  expect(f.journal.hasUnresolved("branch", "fresh-approved-operation")).toBe(true)
  expect(f.journal.list("branch")[1]).toMatchObject({ phase: "unknown", exitCode: 0 })
})

it("refuses changed facts, invalid identities and a revoked admission without publishing a success", () => {
  const f = fixture()
  expect(() =>
    f.journal.begin(f.identity, () => {
      throw Error("REVOKED")
    })
  ).toThrow("REVOKED")
  expect(f.journal.list("branch")).toEqual([])
  expect(() => f.journal.begin({ ...f.identity, packageDigest: "invalid" }, () => {})).toThrow(
    "HOOK_JOURNAL_CHANGED"
  )
  expect(f.journal.list("branch")).toEqual([])
  const receipt = f.journal.begin(f.identity, () => {})
  const key = "project-stage-recovery-hooks-v1:branch"
  const before = f.settings.getSetting(key)
  const changed = f.journal.list("branch")
  changed[0].identity.hookDigest = "d".repeat(64)
  expect(f.settings.compareAndSetSetting(key, before, JSON.stringify(changed))).toBe(true)
  expect(() => receipt.settle(0, false)).toThrow("HOOK_JOURNAL_CHANGED")
  expect(f.journal.hasUnresolved("branch")).toBe(true)
})

it("recovers a lost publication only from the independently persisted exact host close receipt", async () => {
  const f = fixture()
  let losePublication = false
  const journal = new StageRecoveryHookJournal({
    getSetting: (key, fallback) => f.settings.getSetting(key, fallback),
    compareAndSetSetting: (key, before, next) =>
      losePublication && key.startsWith("project-stage-recovery-hooks-v1:")
        ? false
        : f.settings.compareAndSetSetting(key, before, next)
  })
  const receipt = journal.begin(f.identity, () => {})
  losePublication = true
  expect(() => receipt.settle(0, false, "d".repeat(64))).toThrow("HOOK_JOURNAL_CHANGED")
  const cold = new StageRecoveryHookJournal(f.settings)
  const [intent] = cold.list("branch")
  expect(intent.phase).toBe("started")
  expect(cold.hasUnresolved("branch")).toBe(true)
  expect(cold.inspectPhysical(intent)).toMatchObject({
    outcome: "confirmed-completed",
    exitCode: 0
  })
  await expect(
    cold.reconcile(
      "branch",
      intent.id,
      async (value) => cold.inspectPhysical(value),
      () => {}
    )
  ).resolves.toBe(true)
  expect(cold.list("branch")).toMatchObject([
    {
      phase: "reconciled",
      reconciliation: {
        outcome: "confirmed-completed"
      }
    }
  ])
  expect(cold.hasUnresolved("branch")).toBe(false)
  // A fact restores only the receipt. It never relabels an operation or reuses an approval.
  expect(cold.list("branch")[0]).not.toHaveProperty("stagePassed")
  expect(() => receipt.settle(0, false)).toThrow("HOOK_JOURNAL_CHANGED")
})

it("retains cancelled, missing and revoked observations without accepting renderer-shaped evidence", async () => {
  const f = fixture()
  f.journal.begin(f.identity, () => {}).settle(0, true)
  const [intent] = f.journal.list("branch")
  await expect(
    f.journal.reconcile(
      "branch",
      intent.id,
      async (value) => f.journal.inspectPhysical(value),
      () => {}
    )
  ).resolves.toBe(false)
  await expect(
    f.journal.reconcile(
      "branch",
      intent.id,
      async () =>
        ({
          outcome: "confirmed-not-executed",
          evidenceDigest: "d".repeat(64)
        }) as never,
      () => {}
    )
  ).rejects.toThrow("HOOK_JOURNAL_CHANGED")
  await expect(
    f.journal.reconcile(
      "branch",
      intent.id,
      async () => ({
        outcome: "confirmed-not-executed",
        evidenceDigest: "d".repeat(64),
        assertCurrent: () => {
          throw Error("EVIDENCE_CHANGED")
        }
      }),
      () => {}
    )
  ).rejects.toThrow("EVIDENCE_CHANGED")
  expect(f.journal.hasUnresolved("branch")).toBe(true)
})

it("requires immutable exact inspection evidence and CAS even from a trusted native adapter", async () => {
  const f = fixture()
  const receipt = f.journal.begin(f.identity, () => {})
  const [intent] = f.journal.list("branch")
  await expect(
    f.journal.reconcile(
      "branch",
      intent.id,
      async () => {
        receipt.settle(null, true)
        return {
          outcome: "confirmed-not-executed",
          evidenceDigest: "d".repeat(64),
          assertCurrent: () => {}
        }
      },
      () => {}
    )
  ).rejects.toThrow("HOOK_JOURNAL_CHANGED")
  const cold = new StageRecoveryHookJournal(f.settings)
  await expect(
    cold.reconcile(
      "branch",
      intent.id,
      async () => ({
        outcome: "confirmed-not-executed",
        evidenceDigest: "e".repeat(64),
        assertCurrent: () => {}
      }),
      () => {}
    )
  ).resolves.toBe(true)
  expect(cold.hasUnresolved("branch")).toBe(false)
  const next = cold.begin({ ...f.identity, operationId: "new-native-approval" }, () => {})
  next.settle(2, false)
  expect(cold.list("branch")[1]).toMatchObject({ phase: "settled", exitCode: 2 })
})
