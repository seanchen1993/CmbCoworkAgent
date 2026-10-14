import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { HostProjectStore } from "../src/main/harness-board/project-runtime/host-store"
import { LegacyOperationStore } from "../src/main/harness-board/project-runtime/legacy-operation-store"
import { TEST_FINGERPRINT } from "../src/main/harness-board/project-runtime/host-fixtures.test-helper"
import { ModControlStore } from "../src/main/mods/control-store"
import { FlowStore } from "../src/main/mods/flows/store"
import { FlowManager } from "../src/main/mods/flows/manager"

async function interrupt(root: string, family: string, phase: string) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      resolve(__dirname, "support/project-platform-crash-worker.ts"),
      root,
      family,
      phase
    ],
    { cwd: resolve(__dirname, ".."), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
  )
  let output = "",
    error = ""
  child.stderr.on("data", (chunk) => {
    error += chunk.toString()
  })
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", () => resolve())
  })
  try {
    const checkpoint = await new Promise<Record<string, string>>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(Error(`Crash checkpoint timeout: ${family}/${phase}: ${error}`)),
        45000
      )
      child.once("exit", (code) => {
        clearTimeout(timeout)
        reject(Error(`Child exited ${code}: ${error}`))
      })
      child.stdout.on("data", (chunk) => {
        output += chunk.toString()
        const row = output.split(/\r?\n/).find((line) => line.startsWith('{"checkpoint"'))
        if (row) {
          clearTimeout(timeout)
          resolve(JSON.parse(row))
        }
      })
    })
    assert.equal(checkpoint.checkpoint, phase)
    assert(child.kill("SIGKILL"), "Kill only the test-owned child after the checkpoint receipt")
    await exited
    return checkpoint
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL")
      await exited
    }
  }
}

async function main() {
  let count = 0
  for (const family of ["host", "legacy"])
    for (const phase of family === "host"
      ? [
          "prepared",
          "waiting-approval",
          "approved-before-execute",
          "before-execute",
          "after-effect",
          "before-result-ledger",
          "result-persisted"
        ]
      : [
          "prepared",
          "before-execute",
          "after-effect",
          "before-result-ledger",
          "waiting-approval"
        ]) {
      const root = mkdtempSync(join(tmpdir(), "project-crash-recovery-"))
      try {
        const checkpoint = await interrupt(root, family, phase)
        const effectBefore = existsSync(join(root, "effect.txt"))
          ? readFileSync(join(root, "effect.txt"), "utf8")
          : null
        if (family === "host") {
          const store = new HostProjectStore(join(root, "host.sqlite"))
          try {
            store.recoverInterrupted()
            const operation = store.getOperation(checkpoint.operationId)!
            const prepared = ["prepared", "waiting-approval", "approved-before-execute"].includes(
              phase
            )
            assert.equal(
              operation.status,
              prepared ? "prepared" : phase === "result-persisted" ? "succeeded" : "unknown"
            )
            assert.equal(store.get(operation.projectId)?.version, 1)
            if (!prepared)
              assert.throws(
                () => store.start(operation.operationId, TEST_FINGERPRINT),
                /OPERATION_NOT_PREPARED/
              )
            if (phase === "waiting-approval")
              assert.throws(
                () => store.start(operation.operationId, TEST_FINGERPRINT),
                /APPROVAL_REQUIRED/
              )
            if (phase === "approved-before-execute") {
              assert.throws(
                () => store.start(operation.operationId, "c".repeat(64)),
                /INPUT_CHANGED/
              )
              store.cancel(operation.operationId)
              const retry = store.prepare({
                projectId: operation.projectId,
                expectedVersion: 1,
                stageId: "draft",
                idempotencyKey: "new-intent",
                inputFingerprint: TEST_FINGERPRINT
              })
              assert.equal(retry.approval, null)
              assert.throws(
                () => store.start(retry.operationId, TEST_FINGERPRINT),
                /APPROVAL_REQUIRED/
              )
            }
          } finally {
            store.close()
          }
        } else {
          const store = new LegacyOperationStore(join(root, "legacy.sqlite"))
          try {
            store.recoverInterrupted()
            const operation = store.get(checkpoint.operationId)!
            assert.equal(operation.status, "unknown")
            assert.throws(() => store.disable("legacy"), /LEGACY_OPERATION_ACTIVE/)
            assert.throws(
              () => store.admit({ ...operation, requestId: "explicit-retry" }),
              /LEGACY_OPERATION_ACTIVE/
            )
            const mods = new ModControlStore(join(root, "flows.sqlite"))
            try {
              const flows = new FlowStore(mods)
              const manager = new FlowManager(flows, {
                assertScope: () => undefined,
                changed: () => undefined,
                prepare: async () => {
                  throw Error("Readonly recovery must not create an executor")
                }
              })
              const runs = manager.runs(root, "thread")
              assert.equal(runs.length, 1)
              if (phase === "waiting-approval") {
                assert.equal(runs[0].status, "interrupted")
                assert.equal(runs[0].pendingApproval, undefined)
                await assert.rejects(
                  manager.decide(
                    root,
                    "thread",
                    checkpoint.flowRunId,
                    checkpoint.approvalNonce,
                    true
                  )
                )
              }
            } finally {
              mods.close()
            }
          } finally {
            store.close()
          }
        }
        assert.equal(
          existsSync(join(root, "effect.txt"))
            ? readFileSync(join(root, "effect.txt"), "utf8")
            : null,
          effectBefore
        )
        console.log(`PASS ${family}/${phase}: killed child, reopened SQLite, no replay`)
        count++
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  console.log(
    JSON.stringify({
      passed: count,
      scope:
        "real process termination and production SQLite/Flow recovery using isolated host callbacks",
      businessServices: "not exercised"
    })
  )
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
