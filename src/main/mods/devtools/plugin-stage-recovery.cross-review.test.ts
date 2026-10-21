import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { existsSync } from "node:fs"
import { afterEach, expect, it, vi } from "vitest"
import { ModControlStore } from "../control-store"
import { PluginStageRecoverySessions, type PluginStageRecoveryOwner } from "./plugin-stage-recovery"

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "plugin-recovery-review-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const packageRoot = join(root, "package"),
    workspace = join(root, "source")
  await mkdir(packageRoot)
  await mkdir(workspace)
  await writeFile(join(workspace, "product.txt"), "original product")
  await writeFile(
    join(packageRoot, "adapter.py"),
    "# Native protocol fixture; execution is injected.\n"
  )
  await writeFile(
    join(packageRoot, "devclaw.stage-recovery-adapter.json"),
    JSON.stringify({
      apiVersion: "devclaw.plugin-stage-recovery/v1",
      entry: "adapter.py",
      runtime: "python",
      isolation: "private-output-copy",
      codeSource: "keep",
      externalEffects: "network-requires-confirmation"
    })
  )
  const settings = new ModControlStore(join(root, "settings.sqlite"))
  cleanup.push(() => settings.close())
  const scope = {
    threadId: "creator",
    workspace: root,
    incarnation: { token: "native", legacyCreatedAt: 1 }
  }
  const owner: PluginStageRecoveryOwner = {
    id: "ended-trial",
    scope,
    workspace,
    packageRoot,
    packageDigest: "a".repeat(64),
    featureId: "feature",
    guard: vi.fn()
  }
  const command = vi.fn(async () => ({
    code: 0,
    stdout: JSON.stringify({
      apiVersion: "devclaw.plugin-stage-recovery-result/v1",
      ok: true,
      summary: "verified fixture",
      affectedArtifacts: [],
      diagnostics: [],
      evidence: { checkpoint: "draft" }
    })
  }))
  const adopt = vi.fn(async () => ({ trialId: "new-trial", projectId: "new-trial" }))
  const deps = { root: join(root, "trials"), settings, owner: async () => owner, command, adopt }
  const service = new PluginStageRecoverySessions(deps)
  const inspected = await service.inspect(scope, owner.id)
  const request = {
    scope,
    trialId: owner.id,
    stageId: "draft",
    stateMode: "target_in_progress" as const,
    expectedPackageDigest: inspected.packageDigest,
    expectedAdapterDigest: inspected.adapterDigest,
    expectedInputsDigest: inspected.inputsDigest,
    allowNetworkSideEffects: true as const
  }
  return { service, request, command, adopt, deps, scope }
}

it("does not let a new preparation hide an unresolved prior physical apply", async () => {
  const f = await fixture()
  const prepared = await f.service.prepare(f.request)
  f.command.mockResolvedValueOnce({
    code: 0,
    uncertain: true,
    stdout: JSON.stringify({
      apiVersion: "devclaw.plugin-stage-recovery-result/v1",
      ok: true,
      summary: "physical cancellation",
      affectedArtifacts: [],
      diagnostics: [],
      evidence: {}
    })
  } as never)
  await expect(
    f.service.apply({
      scope: f.scope,
      preparationId: prepared.id,
      expectedDigest: prepared.digest,
      allowNetworkSideEffects: true
    })
  ).rejects.toThrow()
  const calls = f.command.mock.calls.length
  await expect(f.service.prepare(f.request)).rejects.toThrow("OUTCOME_UNCONFIRMED")
  expect(f.command).toHaveBeenCalledTimes(calls)
  expect(await f.service.latest(f.scope, f.request.trialId)).toMatchObject({
    id: prepared.id,
    phase: "unknown"
  })
})

it("reads adopted history after its target starts without reviving a proof or touching the old source", async () => {
  const f = await fixture()
  const prepared = await f.service.prepare(f.request)
  await f.service.apply({
    scope: f.scope,
    preparationId: prepared.id,
    expectedDigest: prepared.digest,
    allowNetworkSideEffects: true
  })
  const owner = vi.fn(async (): Promise<PluginStageRecoveryOwner> => {
    throw Error("OLD_SOURCE_CHANGED")
  })
  const adoptedOwner = vi.fn(async (): Promise<PluginStageRecoveryOwner> => {
    throw Error("RECOVERY_ALREADY_STARTED")
  })
  const historyGuard = vi.fn()
  const cold = new PluginStageRecoverySessions({
    ...f.deps,
    owner,
    adoptedOwner,
    adoptionStatus: () => ({ canResume: false, guard: historyGuard })
  })
  const commands = f.command.mock.calls.length
  expect(await cold.latest(f.scope, f.request.trialId)).toMatchObject({
    phase: "adopted",
    canReconcile: false
  })
  expect(
    await cold.reconcile({
      scope: f.scope,
      preparationId: prepared.id,
      expectedDigest: prepared.digest
    })
  ).toMatchObject({ phase: "adopted", canReconcile: false })
  expect(owner).not.toHaveBeenCalled()
  expect(adoptedOwner).not.toHaveBeenCalled()
  expect(historyGuard).toHaveBeenCalled()
  expect(f.command).toHaveBeenCalledTimes(commands)
  await expect(
    cold.reconcile({
      scope: f.scope,
      preparationId: prepared.id,
      expectedDigest: prepared.digest,
      allowNetworkSideEffects: true
    })
  ).rejects.toThrow("ALREADY_STARTED")
  expect(f.command).toHaveBeenCalledTimes(commands)
  expect(f.adopt).toHaveBeenCalledTimes(1)
  await expect(cold.latest({ ...f.scope, threadId: "foreign" }, f.request.trialId)).rejects.toThrow(
    "OLD_SOURCE_CHANGED"
  )
})

it.each([
  { code: 0, uncertain: false, missingReceipt: false, canRestart: true },
  { code: 2, uncertain: false, missingReceipt: false, canRestart: false },
  { code: 0, uncertain: true, missingReceipt: false, canRestart: false },
  { code: 0, uncertain: false, missingReceipt: true, canRestart: false }
])(
  "cold-recovers a plan publication crash only with exact successful physical completion: %j",
  async ({ code, uncertain, missingReceipt, canRestart }) => {
    const f = await fixture()
    const physical = f.command.getMockImplementation()!
    f.command.mockImplementationOnce(async () => ({ ...(await physical()), code, uncertain }))
    const nativeCas = f.deps.settings.compareAndSetSetting.bind(f.deps.settings)
    let publicationWrites = 0
    const publication = vi
      .spyOn(f.deps.settings, "compareAndSetSetting")
      .mockImplementation((key, previous, next) => {
        if (key.startsWith("plugin-stage-recovery-v1:") && ++publicationWrites > 1)
          throw Error("SIMULATED_PROCESS_LOST_BEFORE_PLAN_PUBLICATION")
        return nativeCas(key, previous, next)
      })
    await expect(f.service.prepare(f.request)).rejects.toThrow()
    publication.mockRestore()
    const cold = new PluginStageRecoverySessions(f.deps)
    const pending = (await cold.latest(f.scope, f.request.trialId))!
    expect(pending.phase).toBe("unknown")
    if (missingReceipt) {
      const entries = JSON.parse(
        f.deps.settings.getSetting(`project-stage-recovery-hooks-v1:${pending.id}`, "[]")
      )
      f.deps.settings.setSetting(
        `project-stage-recovery-hook-physical-v1:${pending.id}:${entries[0].id}`,
        ""
      )
    }
    const commands = f.command.mock.calls.length
    const reconciled = await cold.reconcile({
      scope: f.scope,
      preparationId: pending.id,
      expectedDigest: pending.digest
    })
    expect(reconciled.phase).toBe(canRestart ? "failed" : "unknown")
    expect(reconciled.canApply).toBe(false)
    expect(f.command).toHaveBeenCalledTimes(commands)
    expect(f.adopt).not.toHaveBeenCalled()
    if (canRestart) {
      await expect(
        cold.apply({
          scope: f.scope,
          preparationId: pending.id,
          expectedDigest: pending.digest,
          allowNetworkSideEffects: true
        })
      ).rejects.toThrow("FRESH_APPROVAL")
      const reviewed = await cold.inspect(f.scope, f.request.trialId)
      const fresh = await cold.prepare({
        ...f.request,
        expectedPackageDigest: reviewed.packageDigest,
        expectedAdapterDigest: reviewed.adapterDigest,
        expectedInputsDigest: reviewed.inputsDigest
      })
      expect(fresh.id).not.toBe(pending.id)
      expect(fresh.phase).toBe("needs-confirmation")
      expect(f.command).toHaveBeenCalledTimes(commands + 1)
    } else await expect(cold.prepare(f.request)).rejects.toThrow("OUTCOME_UNCONFIRMED")
  }
)

it("cannot adopt a copy changed during asynchronous native registration as the verified evidence", async () => {
  const f = await fixture()
  const service = new PluginStageRecoverySessions({
    ...f.deps,
    adopt: async (_owner, receipt) => {
      await writeFile(join(receipt.workspace, "product.txt"), "changed after verification")
      service.assertReceipt(receipt)
      return { trialId: "new-trial", projectId: "new-trial" }
    }
  })
  const prepared = await service.prepare(f.request)
  await expect(
    service.apply({
      scope: f.scope,
      preparationId: prepared.id,
      expectedDigest: prepared.digest,
      allowNetworkSideEffects: true
    })
  ).rejects.toThrow()
  expect(await service.latest(f.scope, f.request.trialId)).toMatchObject({
    id: prepared.id,
    phase: "unknown"
  })
})

it("binds the first adapter command to native package, adapter and input identities", async () => {
  const f = await fixture()
  const owner = await f.deps.owner()
  owner.inputsDigest = "b".repeat(64)
  await expect(f.service.prepare(f.request)).rejects.toThrow("FRESH_APPROVAL_REQUIRED")
  expect(f.command).not.toHaveBeenCalled()
  delete owner.inputsDigest
  await writeFile(join(owner.packageRoot, "adapter.py"), "# Changed after review\n")
  await expect(f.service.prepare(f.request)).rejects.toThrow("FRESH_APPROVAL_REQUIRED")
  expect(f.command).not.toHaveBeenCalled()
})

it("cannot apply an abandoned preparation after a newer explicit plan replaces it", async () => {
  const f = await fixture()
  const old = await f.service.prepare(f.request)
  const fresh = await f.service.prepare(f.request)
  await expect(
    f.service.apply({
      scope: f.scope,
      preparationId: old.id,
      expectedDigest: old.digest,
      allowNetworkSideEffects: true
    })
  ).rejects.toThrow("VERSION_CHANGED")
  expect(f.command).toHaveBeenCalledTimes(2)
  expect(await f.service.latest(f.scope, f.request.trialId)).toMatchObject({
    id: fresh.id,
    canApply: true
  })
})

it("cannot publish native adoption after its recovery controller is closed during a physical command", async () => {
  const f = await fixture()
  const prepared = await f.service.prepare(f.request)
  const physical = f.command.getMockImplementation()!
  f.command.mockImplementationOnce(async () => {
    f.service.close()
    return physical()
  })
  await expect(
    f.service.apply({
      scope: f.scope,
      preparationId: prepared.id,
      expectedDigest: prepared.digest,
      allowNetworkSideEffects: true
    })
  ).rejects.toThrow("CLOSED")
  expect(f.adopt).not.toHaveBeenCalled()
  expect(await f.service.latest(f.scope, f.request.trialId)).toMatchObject({ phase: "unknown" })
  await expect(f.service.prepare(f.request)).rejects.toThrow("CLOSED")
})

it("keeps a cancelled physical apply unknown across restart without verify, adoption or replay", async () => {
  const f = await fixture()
  const prepared = await f.service.prepare(f.request)
  const output = f.command.getMockImplementation()!
  f.command.mockImplementationOnce(async () => ({ ...(await output()), uncertain: true }))
  await expect(
    f.service.apply({
      scope: f.scope,
      preparationId: prepared.id,
      expectedDigest: prepared.digest,
      allowNetworkSideEffects: true
    })
  ).rejects.toThrow()
  const calls = f.command.mock.calls.length
  const cold = new PluginStageRecoverySessions(f.deps)
  expect(
    await cold.reconcile({
      scope: f.scope,
      preparationId: prepared.id,
      expectedDigest: prepared.digest,
      allowNetworkSideEffects: true
    })
  ).toMatchObject({ phase: "unknown" })
  await expect(cold.prepare(f.request)).rejects.toThrow("OUTCOME_UNCONFIRMED")
  expect(f.command).toHaveBeenCalledTimes(calls)
  expect(f.adopt).not.toHaveBeenCalled()
})

it("cannot use the old recovery evidence after the unknown operation's original inputs change", async () => {
  const f = await fixture()
  const prepared = await f.service.prepare(f.request)
  f.adopt.mockRejectedValueOnce(Error("LOST_ADOPTION_REPLY"))
  await expect(
    f.service.apply({
      scope: f.scope,
      preparationId: prepared.id,
      expectedDigest: prepared.digest,
      allowNetworkSideEffects: true
    })
  ).rejects.toThrow("LOST_ADOPTION_REPLY")
  const calls = f.command.mock.calls.length
  const owner = await f.deps.owner()
  await writeFile(join(owner.workspace, "product.txt"), "changed original inputs")
  const cold = new PluginStageRecoverySessions(f.deps)
  await expect(
    cold.reconcile({
      scope: f.scope,
      preparationId: prepared.id,
      expectedDigest: prepared.digest,
      allowNetworkSideEffects: true
    })
  ).rejects.toThrow("INPUT_CHANGED")
  expect(f.command).toHaveBeenCalledTimes(calls)
  expect(f.adopt).toHaveBeenCalledTimes(1)
  expect(await cold.latest(f.scope, f.request.trialId)).toMatchObject({ phase: "unknown" })
})

it("keeps an IPC caller guard effective through native execution and prevents adoption after revocation", async () => {
  const f = await fixture()
  const prepared = await f.service.prepare(f.request)
  let callerCurrent = true
  const assertCaller = () => {
    if (!callerCurrent) throw Error("NATIVE_CALLER_REVOKED")
  }
  const physical = f.command.getMockImplementation()!
  f.command.mockImplementationOnce(async () => {
    await Promise.resolve()
    callerCurrent = false
    return physical()
  })
  await expect(
    f.service.apply(
      {
        scope: f.scope,
        preparationId: prepared.id,
        expectedDigest: prepared.digest,
        allowNetworkSideEffects: true
      },
      assertCaller
    )
  ).rejects.toThrow("CALLER_REVOKED")
  expect(f.adopt).not.toHaveBeenCalled()
  expect(await f.service.latest(f.scope, f.request.trialId)).toMatchObject({ phase: "unknown" })
})

it.skipIf(process.platform !== "win32" || !existsSync("resources/bin/win32/codex.exe"))(
  "can repair a proven pre-spawn sandbox failure and prepare again without inventing an execution receipt",
  async () => {
    const f = await fixture()
    const owner = await f.deps.owner()
    await writeFile(
      join(owner.packageRoot, "adapter.py"),
      "import json\nprint(json.dumps({'apiVersion':'devclaw.plugin-stage-recovery-result/v1','ok':True,'summary':'actual prepared command','affectedArtifacts':[],'diagnostics':[],'evidence':{}}))\n"
    )
    const service = new PluginStageRecoverySessions({ ...f.deps, command: undefined })
    const reviewed = await service.inspect(f.scope, owner.id)
    const request = {
      ...f.request,
      expectedAdapterDigest: reviewed.adapterDigest,
      expectedInputsDigest: reviewed.inputsDigest
    }
    owner.readOnlyRoots = [join(owner.packageRoot, "missing-readonly-root")]
    await expect(service.prepare(request)).rejects.toThrow()
    const failed = (await service.latest(f.scope, owner.id))!
    expect(failed.phase).toBe("failed")
    expect(f.deps.settings.getSetting(`project-stage-recovery-hooks-v1:${failed.id}`, "[]")).toBe(
      "[]"
    )
    delete owner.readOnlyRoots
    const prepared = await service.prepare(request)
    expect(prepared).toMatchObject({ phase: "needs-confirmation", canApply: true })
    expect(prepared.id).not.toBe(failed.id)
    const facts = JSON.parse(
      f.deps.settings.getSetting(`project-stage-recovery-hooks-v1:${prepared.id}`, "[]")
    )
    expect(facts).toMatchObject([{ phase: "settled", exitCode: 0 }])
    expect(f.adopt).not.toHaveBeenCalled()
  },
  30000
)
