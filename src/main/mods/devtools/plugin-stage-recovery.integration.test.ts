import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"
import { afterEach, expect, it, vi } from "vitest"
import {
  PluginStageRecoverySessions,
  type PluginStageRecoveryOwner,
  type PluginStageRecoveryReceipt
} from "./plugin-stage-recovery"
import { ModControlStore } from "../control-store"
import { snapshotDerivationSource, writeDerivationFiles } from "../../plugins/derivation-source"
import { readBoundedProjectFiles } from "../../harness-board/project-runtime/bounded-project-files"
import { startOwnedHookCommand } from "../../hooks/owned-command"

const execute = promisify(execFile)
const original = resolve(process.env.AUTOBIZ_BUSINESS_SOURCE ?? "C:/ai/autobiz_kanban")
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function fixture(sandbox = false) {
  const root = await mkdtemp(join(tmpdir(), "abr-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const packageRoot = join(root, "package")
  await mkdir(packageRoot)
  // Read only the explicitly selected original. Original business code stays byte-identical.
  const originalSnapshot = await snapshotDerivationSource(original)
  await writeDerivationFiles(packageRoot, originalSnapshot.files)
  await mkdir(join(packageRoot, "mods/stage-recovery"), { recursive: true })
  await cp(
    resolve("resources/mods/autobiz-stage-recovery/adapter.py"),
    join(packageRoot, "mods/stage-recovery/adapter.py")
  )
  await cp(
    resolve("resources/mods/autobiz-stage-recovery/devclaw.stage-recovery-adapter.json"),
    join(packageRoot, "devclaw.stage-recovery-adapter.json")
  )
  const workspace = join(root, "source", "project")
  await mkdir(workspace, { recursive: true })
  const setup = join(root, "fixture.py")
  await writeFile(
    setup,
    `import sys,json
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from hooks.init_workspace import init_workspace,create_feature
from board_core.state_store import load_state_json_records,write_state_records
w=Path(sys.argv[2]);init_workspace(w);create_feature(w,'alpha')
records,errors,exists=load_state_json_records(w)
assert exists and not errors
records['alpha']['checkpoint']='plan_done'
records['alpha']['stage']='plan_done'
write_state_records(w,records)
d=w/'.autobizdevops/features/alpha'
(d/'proposal.md').write_text('specs product',encoding='utf-8')
(d/'PRD.md').write_text('upstream prd retained',encoding='utf-8')
(d/'UI_CONTEXT.json').write_text(json.dumps({'scope':'confirmed','path':str(w/'knowledge')}),encoding='utf-8')
(w/'knowledge').mkdir();(w/'knowledge/domain.md').write_text('domain knowledge',encoding='utf-8')
(w/'config.json').write_text(json.dumps({'localRepoPath':str(w)}),encoding='utf-8')
`
  )
  await execute("python", ["-I", "-B", "-X", "utf8", setup, packageRoot, workspace], {
    windowsHide: true,
    timeout: 30_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }
  })
  const settings = new ModControlStore(join(root, "settings.sqlite"))
  cleanup.push(() => settings.close())
  const scope = {
    workspace: root,
    threadId: "creator",
    incarnation: { token: "owner", legacyCreatedAt: 1 }
  }
  let alive = true
  const owner: PluginStageRecoveryOwner = {
    id: "original-trial",
    scope,
    workspace,
    packageRoot,
    packageDigest: "a".repeat(64),
    featureId: "alpha",
    guard() {
      if (!alive) throw Error("OWNER_CHANGED")
    }
  }
  const adopt = vi.fn(
    async (_owner: PluginStageRecoveryOwner, receipt: PluginStageRecoveryReceipt) => {
      service.assertReceipt(receipt)
      return { trialId: "new-trial", projectId: "new-trial" }
    }
  )
  let commandCount = 0
  const operations: string[] = []
  const command = async (
    input: Parameters<
      NonNullable<ConstructorParameters<typeof PluginStageRecoverySessions>[0]["command"]>
    >[0]
  ) => {
    commandCount++
    operations.push(String(input.request.operation))
    input.guard()
    const chunks: Buffer[] = []
    const running = startOwnedHookCommand({
      executable: "python",
      args: ["-I", "-B", "-X", "utf8", join(input.owner.packageRoot, input.entry)],
      cwd: input.workspace,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } as Record<string, string>,
      stdin: JSON.stringify(input.request),
      stdout: (chunk) => chunks.push(chunk),
      stderr: () => {}
    })
    const result = await running.completion
    return {
      code: result.code,
      stdout: Buffer.concat(chunks).toString("utf8"),
      uncertain: !!result.error
    }
  }
  const deps = {
    root: join(root, "trials"),
    settings,
    owner: async () => owner,
    adopt,
    ...(sandbox ? {} : { command })
  }
  const service = new PluginStageRecoverySessions(deps)
  const inspected = await service.inspect(scope, owner.id)
  const request = {
    scope,
    trialId: owner.id,
    stageId: "dev.specs",
    stateMode: "target_in_progress" as const,
    expectedPackageDigest: inspected.packageDigest,
    expectedAdapterDigest: inspected.adapterDigest,
    expectedInputsDigest: inspected.inputsDigest,
    allowNetworkSideEffects: true as const
  }
  return {
    root,
    workspace,
    packageRoot,
    settings,
    scope,
    service,
    request,
    adopt,
    deps,
    setAlive: () => {
      alive = false
    },
    count: () => commandCount,
    operations
  }
}

it.skipIf(!existsSync(original))(
  "executes the real original CLI plan/apply/verify on a relocated private output copy",
  async () => {
    const f = await fixture()
    const sourceBefore = await readBoundedProjectFiles(f.workspace, { guard: vi.fn() })
    const pluginBefore = await snapshotDerivationSource(f.packageRoot)
    const prepared = await f.service.prepare(f.request)
    expect(prepared.canApply).toBe(true)
    expect(prepared.affectedArtifacts).toContain("proposal.md")
    expect(f.adopt).not.toHaveBeenCalled()
    const result = await f.service.apply({
      scope: f.scope,
      preparationId: prepared.id,
      expectedDigest: prepared.digest,
      allowNetworkSideEffects: true
    })
    expect(result.preparation.phase).toBe("adopted")
    expect(f.count()).toBe(3)
    const receipt = f.adopt.mock.calls[0][1]
    const recovered = JSON.parse(
      await readFile(join(receipt.workspace, ".autobizdevops/state.json"), "utf8")
    )
    expect(JSON.stringify(recovered)).toContain("specs_in_progress")
    expect(existsSync(join(receipt.workspace, ".autobizdevops/features/alpha/proposal.md"))).toBe(
      false
    )
    expect(
      await readFile(join(receipt.workspace, ".autobizdevops/features/alpha/PRD.md"), "utf8")
    ).toBe("upstream prd retained")
    expect(await readFile(join(receipt.workspace, "knowledge/domain.md"), "utf8")).toBe(
      "domain knowledge"
    )
    expect(JSON.parse(await readFile(join(receipt.workspace, "config.json"), "utf8"))).toEqual({
      localRepoPath: receipt.workspace
    })
    expect(
      JSON.stringify(
        await readFile(
          join(receipt.workspace, ".autobizdevops/features/alpha/UI_CONTEXT.json"),
          "utf8"
        )
      )
    ).not.toContain(f.workspace.replaceAll("\\", "\\\\"))
    expect((await readBoundedProjectFiles(f.workspace, { guard: vi.fn() })).fingerprint).toBe(
      sourceBefore.fingerprint
    )
    expect((await snapshotDerivationSource(f.packageRoot)).digest).toBe(pluginBefore.digest)
    // The real original validation still rejects advancing without the removed specs deliverable.
    const validation = await execute(
      "python",
      [
        "-I",
        "-B",
        "-X",
        "utf8",
        join(f.packageRoot, "hooks/stage_gate.py"),
        "validate",
        "--stage",
        "dev.specs",
        "--workspace",
        receipt.workspace,
        "--feature",
        "alpha"
      ],
      {
        windowsHide: true,
        env: {
          ...process.env,
          PLUGIN_WORKSPACE: dirname(receipt.workspace),
          PROJECT_DIR: "workspace",
          FEATURE_ID: "alpha",
          PYTHONDONTWRITEBYTECODE: "1"
        }
      }
    ).then(
      (result) => result,
      (error) => error as { code: number; stdout: string; stderr: string }
    )
    expect("code" in validation && validation.code !== 0).toBe(true)
    expect(JSON.parse(validation.stdout).ok).toBe(false)
    expect(validation.stdout).toContain("proposal.md")
    await expect(
      f.service.apply({
        scope: f.scope,
        preparationId: prepared.id,
        expectedDigest: prepared.digest,
        allowNetworkSideEffects: true
      })
    ).rejects.toThrow("FRESH_APPROVAL_REQUIRED")
  },
  45_000
)

it.skipIf(!existsSync(original))(
  "blocks stale copies, old process approval, foreign scope and missing network consent without replay",
  async () => {
    const f = await fixture()
    await expect(
      f.service.prepare({ ...f.request, allowNetworkSideEffects: false as never })
    ).rejects.toThrow("NETWORK_APPROVAL_REQUIRED")
    expect(f.count()).toBe(0)
    const prepared = await f.service.prepare(f.request)
    const apply = {
      scope: f.scope,
      preparationId: prepared.id,
      expectedDigest: prepared.digest,
      allowNetworkSideEffects: true as const
    }
    await expect(
      f.service.apply({ ...apply, scope: { ...f.scope, threadId: "foreign" } })
    ).rejects.toThrow("SCOPE_CHANGED")
    await expect(new PluginStageRecoverySessions(f.deps).apply(apply)).rejects.toThrow(
      "FRESH_APPROVAL_REQUIRED"
    )
    await writeFile(join(f.workspace, "knowledge/domain.md"), "changed source")
    await expect(f.service.apply(apply)).rejects.toThrow("INPUT_CHANGED")
    expect(f.count()).toBe(1)
    expect(f.adopt).not.toHaveBeenCalled()
  },
  45_000
)

it.skipIf(!existsSync(original))(
  "rejects active worktree ownership and external repository mappings without changing the original",
  async () => {
    const f = await fixture()
    const active = join(f.workspace, ".autobizdevops/features/alpha/.parallel-runs/run-a")
    await mkdir(active, { recursive: true })
    await writeFile(
      join(active, "manifest.json"),
      JSON.stringify({ status: "running", lease: "live" })
    )
    const before = await readBoundedProjectFiles(f.workspace, { guard: vi.fn() })
    await expect(f.service.prepare(f.request)).rejects.toThrow("WORKTREE_REBIND_REQUIRED")
    expect((await readBoundedProjectFiles(f.workspace, { guard: vi.fn() })).fingerprint).toBe(
      before.fingerprint
    )
    expect(f.adopt).not.toHaveBeenCalled()
    const other = await fixture()
    await writeFile(
      join(other.workspace, "config.json"),
      JSON.stringify({ localRepoPath: original })
    )
    await expect(other.service.prepare(other.request)).rejects.toThrow(
      "EXTERNAL_REPOSITORY_REBIND_REQUIRED"
    )
  await writeFile(join(other.workspace, "config.json"), JSON.stringify({
    localRepoPath: "../../../../../outside-original-repository"
  }))
  await expect(other.service.prepare(other.request)).rejects.toThrow(
    "EXTERNAL_REPOSITORY_REBIND_REQUIRED"
  )
  },
  45_000
)

it.skipIf(
  process.platform !== "win32" ||
    !existsSync(original) ||
    !existsSync(resolve("resources/bin/win32/codex.exe"))
)(
  "uses the actual app-owned restricted sandbox and Job controller for the original CLI",
  async () => {
    const f = await fixture(true)
    const before = await readBoundedProjectFiles(f.workspace, { guard: vi.fn() })
    const prepared = await f.service.prepare(f.request)
    const result = await f.service.apply({
      scope: f.scope,
      preparationId: prepared.id,
      expectedDigest: prepared.digest,
      allowNetworkSideEffects: true
    })
    expect(result.preparation.phase).toBe("adopted")
    expect((await readBoundedProjectFiles(f.workspace, { guard: vi.fn() })).fingerprint).toBe(
      before.fingerprint
    )
  },
  120_000
)

it.skipIf(!existsSync(original))(
  "reconciles a lost native adoption reply after restart by verification only and fresh consent",
  async () => {
    const f = await fixture()
    const prepared = await f.service.prepare(f.request)
    f.adopt.mockImplementationOnce(async () => {
      throw Error("LOST_ADOPTION_REPLY")
    })
    await expect(
      f.service.apply({
        scope: f.scope,
        preparationId: prepared.id,
        expectedDigest: prepared.digest,
        allowNetworkSideEffects: true
      })
    ).rejects.toThrow("LOST_ADOPTION_REPLY")
    const cold = new PluginStageRecoverySessions({
      ...f.deps,
      adopt: async (_owner, receipt) => {
        cold.assertReceipt(receipt)
        return { trialId: "cold-trial", projectId: "cold-trial" }
      }
    })
    const input = { scope: f.scope, preparationId: prepared.id, expectedDigest: prepared.digest }
    expect(await cold.latest(f.scope, f.request.trialId)).toMatchObject({
      id: prepared.id,
      phase: "unknown"
    })
    expect((await cold.reconcile(input)).phase).toBe("unknown")
    expect(f.operations).toEqual(["plan", "apply", "verify"])
    const result = await cold.reconcile({ ...input, allowNetworkSideEffects: true })
    expect(result).toMatchObject({ phase: "adopted", recoveredTrialId: "cold-trial" })
    expect(f.operations).toEqual(["plan", "apply", "verify", "verify"])
  },
  45_000
)

it.skipIf(!existsSync(original))(
  "does not infer successful apply from business files when the physical exit is nonzero or uncertain",
  async () => {
    for (const uncertainty of [false, true]) {
      const f = await fixture()
      const originalCommand = f.deps.command!
      const service = new PluginStageRecoverySessions({
        ...f.deps,
        command: async (input) => {
          const result = await originalCommand(input)
          return input.request.operation === "apply"
            ? { ...result, code: 2, uncertain: uncertainty }
            : result
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
      const after = await service.reconcile({
        scope: f.scope,
        preparationId: prepared.id,
        expectedDigest: prepared.digest,
        allowNetworkSideEffects: true
      })
      expect(after.phase).toBe("unknown")
      expect(f.operations).toEqual(["plan", "apply"])
      expect(f.adopt).not.toHaveBeenCalled()
    }
  },
  60_000
)
