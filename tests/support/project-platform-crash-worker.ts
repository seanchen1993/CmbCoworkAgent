import { mkdirSync, writeFileSync, writeSync } from "node:fs"
import { join } from "node:path"
import { validateHostStage } from "../../src/main/harness-board/project-runtime/host-validators"
import { HostProjectStore } from "../../src/main/harness-board/project-runtime/host-store"
import {
  hostProjectFixture,
  prepareFixture,
  TEST_FINGERPRINT
} from "../../src/main/harness-board/project-runtime/host-fixtures.test-helper"
import { LegacyOperationStore } from "../../src/main/harness-board/project-runtime/legacy-operation-store"
import { LegacyProjectRuntimeService } from "../../src/main/harness-board/project-runtime/legacy-runtime-service"
import { HostPackageSnapshots } from "../../src/main/harness-board/project-runtime/package-snapshots"
import { FlowManager } from "../../src/main/mods/flows/manager"
import { FlowStore } from "../../src/main/mods/flows/store"
import { ModControlStore } from "../../src/main/mods/control-store"
import type { PluginMetadata } from "../../src/main/types"

const [root, family, phase] = process.argv.slice(2)
function checkpoint(details: object): never {
  // A synchronous pipe write proves the selected production persistence boundary was reached.
  writeSync(1, JSON.stringify({ checkpoint: phase, family, ...details }) + "\n")
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  throw Error("Unexpected checkpoint wake")
}
async function main() {
  if (family === "host") {
    const store = new HostProjectStore(join(root, "host.sqlite"))
    const input = hostProjectFixture(root)
    if (phase === "waiting-approval" || phase === "approved-before-execute")
      input.manifest.stages[0].approval = "human"
    store.create(input)
    const operation = store.prepare(prepareFixture())
    const details = { operationId: operation.operationId }
    if (phase === "prepared" || phase === "waiting-approval") checkpoint(details)
    if (phase === "approved-before-execute") {
      store.decideApproval(operation.operationId, {
        expectedVersion: 1,
        inputFingerprint: TEST_FINGERPRINT,
        decision: "approved",
        actorId: "fixture-human"
      })
      checkpoint(details)
    }
    const ticket = store.start(operation.operationId, TEST_FINGERPRINT)
    if (phase === "before-execute") checkpoint(details)
    writeFileSync(join(root, "effect.txt"), "effect-once")
    if (phase === "after-effect") checkpoint(details)
    store.bindExecutionThread(ticket, "real-fixture-thread")
    store.recordExecutionTerminal(ticket, { outcome: "success", code: "fixture-original-terminal" })
    if (phase === "before-result-ledger") checkpoint(details)
    writeFileSync(join(root, "document.md"), "validated fixture artifact")
    store.recordResult(ticket, {
      outcome: "succeeded",
      receipts: validateHostStage(store.get(input.projectId)!, ticket)
    })
    checkpoint(details)
  }
  const pluginRoot = join(root, "plugin")
  mkdirSync(pluginRoot)
  const manifest = hostProjectFixture(root).manifest
  manifest.mode = "legacy"
  manifest.stateOwner = "plugin"
  writeFileSync(join(pluginRoot, "plugin.json"), '{"name":"docs","version":"1.0.0"}')
  writeFileSync(join(pluginRoot, "devclaw.project-runtime.json"), JSON.stringify(manifest))
  const ledger = new LegacyOperationStore(join(root, "legacy.sqlite"))
  const service = new LegacyProjectRuntimeService(
    ledger,
    new HostPackageSnapshots(join(root, "packages")),
    {
      resolveThread: () => ({
        projectId: "legacy",
        featureId: "feature",
        workspace: root,
        incarnation: "original"
      }),
      resolvePlugin: async () =>
        ({
          id: "plugin",
          name: "docs",
          version: "1.0.0",
          path: pluginRoot,
          enabled: true
        }) as PluginMetadata,
      assertProjectIdle: () => undefined
    }
  )
  await service.enable("legacy", root)
  service.register()
  const mods = new ModControlStore(join(root, "flows.sqlite"))
  const flows = new FlowStore(mods)
  if (phase === "before-result-ledger") {
    ledger.settle = () => checkpoint({ operationId: service.operations("legacy")[0].operationId })
  }
  const pass = () => ({
    passed: true,
    source: "native-check" as const,
    summary: "real fixture check"
  })
  const manager = new FlowManager(flows, {
    assertScope: () => undefined,
    changed: () => {
      const waiting = flows
        .runs(root, "thread")
        .find((run) => run.status === "waiting" && run.pendingApproval)
      if (phase === "waiting-approval" && waiting)
        checkpoint({
          operationId: service.operations("legacy")[0].operationId,
          flowRunId: waiting.id,
          approvalNonce: waiting.pendingApproval!.nonce
        })
    },
    prepare: async () => {
      if (phase === "prepared")
        checkpoint({ operationId: service.operations("legacy")[0].operationId })
      return {
        assertLive: () => undefined,
        fingerprint: async () => "fixture-input",
        execute: async () => {
          if (phase === "before-execute")
            checkpoint({ operationId: service.operations("legacy")[0].operationId })
          writeFileSync(join(root, "effect.txt"), "effect-once")
          if (phase === "after-effect")
            checkpoint({ operationId: service.operations("legacy")[0].operationId })
          return pass()
        },
        finalize: async (_context, confirm) => {
          await confirm()
          return pass()
        },
        dispose: async () => undefined
      }
    }
  })
  const saved = flows.save(
    root,
    {
      schemaVersion: 1,
      id: "fixture",
      name: "Fixture",
      plugin: "docs",
      goal: "isolated crash boundary",
      timeoutMs: 60000,
      maxExecutions: 4,
      steps:
        phase === "waiting-approval"
          ? [
              {
                id: "approval",
                name: "Approval",
                kind: "approval",
                enabled: true,
                prompt: "Approve this version"
              }
            ]
          : [{ id: "check", name: "Check", kind: "check", enabled: true, check: "unit-test" }]
    },
    0
  )
  const run = await manager.startSaved(root, "thread", saved)
  await manager.waitForSettlement(root, "thread", run.id)
  throw Error("Expected process interruption checkpoint was not reached")
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
