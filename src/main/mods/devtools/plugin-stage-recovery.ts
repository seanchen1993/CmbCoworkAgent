import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, writeFile, chmod } from "node:fs/promises"
import { dirname, join, relative, isAbsolute, sep } from "node:path"
import type {
  PluginStageRecoveryPreparation,
  PluginStageRecoveryRequest,
  PluginStageRecoveryScope
} from "../../../shared/mods/plugin-stage-recovery"
import type { AuthoringAtomicSettings } from "./authoring-config-snapshot"
import type { ModObject } from "../../../shared/mods/types"
import { readBoundedProjectFiles } from "../../harness-board/project-runtime/bounded-project-files"
import { capturePackageMetadataGuard } from "../../harness-board/project-runtime/package-snapshots"
import {
  runtimeDigest,
  runtimeDirectoryIdentity
} from "../../harness-board/project-runtime/safe-files"
import { StageRecoveryHookJournal } from "../../hooks/stage-recovery-journal"
import { prepareStageRecoveryCommand } from "../../hooks/stage-recovery-command"
import { startOwnedHookCommand } from "../../hooks/owned-command"
import { readPluginStageRecoveryAdapter } from "./plugin-stage-recovery-adapter"

export interface PluginStageRecoveryOwner {
  id: string
  scope: PluginStageRecoveryScope
  workspace: string
  packageRoot: string
  packageDigest: string
  featureId: string
  stages?: { id: string; title: string }[]
  inputsDigest?: string
  readOnlyRoots?: readonly string[]
  assertInputsCurrent?(): Promise<void>
  assertAdoptionAvailable?(preparationId: string, evidenceDigest: string): void
  providerInput?: { directory: string; knowledgeRoot?: string; configuration?: ModObject }
  /** Native ended-owner/package/configuration/physical-run guard. Never IPC data. */
  guard(): void
}
export interface PluginStageRecoveryReceipt {
  preparationId: string
  digest: string
  sourceId: string
  workspace: string
  packageRoot: string
  packageDigest: string
  featureId: string
  stageId: string
  stateMode: PluginStageRecoveryRequest["stateMode"]
  evidenceDigest: string
}
interface AdapterResult {
  apiVersion: "devclaw.plugin-stage-recovery-result/v1"
  ok: boolean
  summary: string
  affectedArtifacts: string[]
  diagnostics: string[]
  evidence: Record<string, unknown>
}
interface RecordState {
  schemaVersion: 1
  id: string
  scope: PluginStageRecoveryScope
  sourceId: string
  sourceFingerprint: string
  sourceWorkspace?: string
  workspace: string
  workspaceIdentity: string
  packageRoot: string
  packageDigest: string
  featureId: string
  stageId: string
  stateMode: PluginStageRecoveryRequest["stateMode"]
  adapterDigest: string
  inputsDigest: string
  nonce: string
  digest: string
  phase: PluginStageRecoveryPreparation["phase"]
  plan?: AdapterResult
  branchFingerprint?: string
  evidenceDigest?: string
  recoveredTrialId?: string
  recoveredProjectId?: string
  error?: string
}
type CommandInput = {
  owner: PluginStageRecoveryOwner
  operationRoot: string
  workspace: string
  entry: string
  request: Record<string, unknown>
  guard(): void
  beforeStart(): void
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const hash = /^[a-f0-9]{64}$/
const safeText = (value: unknown, maximum = 256): value is string =>
  typeof value === "string" &&
  !!value.trim() &&
  value.length <= maximum &&
  !Array.from(value).some((character) => character.charCodeAt(0) < 32)
const key = (id: string) => `plugin-stage-recovery-v1:${id}`
const ownerInputsDigest = (owner: PluginStageRecoveryOwner) =>
  owner.inputsDigest ??
  runtimeDigest(
    JSON.stringify([owner.id, owner.scope, owner.workspace, owner.packageDigest, owner.featureId])
  )
const fail = (code: string): never => {
  throw Error(`PLUGIN_STAGE_RECOVERY_${code}`)
}

/** A physical recovery journal over the existing plugin engine, not another workflow engine.
 * Commands operate on a complete bounded private copy. Only the native trial owner can adopt it.
 */
export class PluginStageRecoverySessions {
  private readonly nonce = randomUUID()
  private readonly journal: StageRecoveryHookJournal
  private readonly busy = new Set<string>()
  private readonly receipts = new WeakMap<PluginStageRecoveryReceipt, () => void>()
  private readonly commands = new Set<AbortController>()
  private closed = false
  constructor(
    private readonly deps: {
      /** Same native trial root accepted by CreatorBusinessTrials' strict workspace parser. */
      root: string
      settings: AuthoringAtomicSettings
      owner(scope: PluginStageRecoveryScope, id: string): Promise<PluginStageRecoveryOwner>
      adoptedOwner?(
        scope: PluginStageRecoveryScope,
        preparationId: string,
        targetId: string,
        evidenceDigest: string
      ): Promise<PluginStageRecoveryOwner>
      adoptionStatus?(
        scope: PluginStageRecoveryScope,
        preparationId: string,
        targetId: string,
        evidenceDigest: string
      ): { canResume: boolean; guard(): void }
      adopt(
        owner: PluginStageRecoveryOwner,
        receipt: PluginStageRecoveryReceipt
      ): Promise<{
        trialId: string
        projectId: string
      }>
      changed?(threadId: string): void
      /** Physical-command injection for bounded unit tests. Production leaves this unset. */
      command?(
        input: CommandInput
      ): Promise<{ code: number | null; stdout: string; uncertain?: boolean }>
    }
  ) {
    this.journal = new StageRecoveryHookJournal(deps.settings)
  }
  private read(id: string): { state: RecordState; raw: string } {
    if (!/^[a-f0-9-]{36}$/.test(id)) return fail("NOT_FOUND")
    const raw = this.deps.settings.getSetting(key(id), "")
    if (!raw || Buffer.byteLength(raw) > 512 * 1024) return fail("NOT_FOUND")
    let row: RecordState
    try {
      row = JSON.parse(raw)
    } catch {
      return fail("RECORD_INVALID")
    }
    const inside = relative(this.deps.root, row.workspace ?? "")
    if (
      row.schemaVersion !== 1 ||
      row.id !== id ||
      !safeText(row.sourceId) ||
      !row.scope ||
      !safeText(row.scope.threadId) ||
      !row.scope.incarnation ||
      typeof row.scope.workspace !== "string" ||
      !isAbsolute(row.scope.workspace) ||
      !Number.isSafeInteger(row.scope.incarnation.legacyCreatedAt) ||
      !(row.scope.incarnation.token === null || safeText(row.scope.incarnation.token)) ||
      !isAbsolute(row.workspace ?? "") ||
      isAbsolute(inside) ||
      inside === ".." ||
      inside.startsWith(`..${sep}`) ||
      !/^trial-[a-zA-Z0-9]{6}[\\/]workspace$/.test(inside) ||
      !safeText(row.workspaceIdentity, 32768 + 128) ||
      !isAbsolute(row.packageRoot ?? "") ||
      (row.sourceWorkspace !== undefined &&
        (!safeText(row.sourceWorkspace, 32768) || !isAbsolute(row.sourceWorkspace))) ||
      ![
        row.packageDigest,
        row.sourceFingerprint,
        row.adapterDigest,
        row.inputsDigest,
        row.digest
      ].every((item) => hash.test(item)) ||
      !safeText(row.featureId) ||
      !safeText(row.stageId) ||
      !["target_in_progress", "previous_done"].includes(row.stateMode) ||
      !["needs-confirmation", "applying", "verified", "adopted", "failed", "unknown"].includes(
        row.phase
      )
    )
      return fail("RECORD_INVALID")
    return { state: row, raw }
  }
  private save(state: RecordState, expected?: string) {
    if (!this.deps.settings.compareAndSetSetting(key(state.id), expected, JSON.stringify(state)))
      fail("VERSION_CHANGED")
    this.read(state.id)
    this.deps.changed?.(state.scope.threadId)
    return JSON.stringify(state)
  }
  private view(state: RecordState): PluginStageRecoveryPreparation {
    return {
      id: state.id,
      digest: state.digest,
      sourceId: state.sourceId,
      stageId: state.stageId,
      stateMode: state.stateMode,
      phase: state.phase,
      summary: state.plan?.summary ?? "插件恢复操作尚未确认完成",
      affectedArtifacts: state.plan?.affectedArtifacts ?? [],
      diagnostics: [
        ...(state.plan?.diagnostics ?? []),
        ...(state.error
          ? [
              state.error === "PLUGIN_STAGE_RECOVERY_FRESH_PLAN_REQUIRED"
                ? "原规划进程已确认正常结束，但方案未完成保存。请重新检查条件、准备新方案并重新确认；原操作不会重放。"
                : state.error
            ]
          : [])
      ],
      canApply:
        state.nonce === this.nonce && state.phase === "needs-confirmation" && !!state.plan?.ok,
      canReconcile:
        ["unknown", "applying", "verified"].includes(state.phase) ||
        (state.phase === "adopted" && state.nonce !== this.nonce),
      requiresNetworkApproval: true,
      ...(state.recoveredTrialId ? { recoveredTrialId: state.recoveredTrialId } : {}),
      ...(state.recoveredProjectId ? { recoveredProjectId: state.recoveredProjectId } : {})
    }
  }
  async status(scope: PluginStageRecoveryScope, id: string, callerGuard: () => void = () => {}) {
    callerGuard()
    const { state } = this.read(id)
    if (!same(scope, state.scope)) fail("SCOPE_CHANGED")
    if (
      state.phase === "adopted" &&
      this.deps.adoptionStatus &&
      state.recoveredTrialId &&
      state.evidenceDigest
    ) {
      const status = this.deps.adoptionStatus(
        scope,
        state.id,
        state.recoveredTrialId,
        state.evidenceDigest
      )
      status.guard()
      callerGuard()
      return { ...this.view(state), canReconcile: state.nonce !== this.nonce && status.canResume }
    }
    const owner =
      state.phase === "adopted" &&
      this.deps.adoptedOwner &&
      state.recoveredTrialId &&
      state.evidenceDigest
        ? await this.deps.adoptedOwner(
            scope,
            state.id,
            state.recoveredTrialId,
            state.evidenceDigest
          )
        : await this.deps.owner(scope, state.sourceId)
    callerGuard()
    owner.guard()
    return this.view(state)
  }
  async latest(
    scope: PluginStageRecoveryScope,
    sourceTrialId: string,
    callerGuard: () => void = () => {}
  ) {
    callerGuard()
    const id = this.deps.settings.getSetting(this.pointer(scope, sourceTrialId), "")
    if (!id) {
      const owner = await this.deps.owner(scope, sourceTrialId)
      callerGuard()
      owner.guard()
      return undefined
    }
    return this.status(scope, id, callerGuard)
  }
  private pointer(scope: PluginStageRecoveryScope, sourceTrialId: string) {
    return (
      "plugin-stage-recovery-latest-v1:" + runtimeDigest(JSON.stringify([scope, sourceTrialId]))
    )
  }
  /** Read exact native identities before the UI grants the first adapter command. */
  async inspect(
    scope: PluginStageRecoveryScope,
    sourceTrialId: string,
    callerGuard: () => void = () => {}
  ) {
    callerGuard()
    const owner = await this.deps.owner(scope, sourceTrialId)
    callerGuard()
    owner.guard()
    const adapter = readPluginStageRecoveryAdapter(owner.packageRoot)
    adapter.assertCurrent()
    owner.guard()
    return {
      sourceId: owner.id,
      packageDigest: owner.packageDigest,
      adapterDigest: adapter.digest,
      inputsDigest: ownerInputsDigest(owner),
      featureId: owner.featureId,
      ...(owner.stages ? { stages: owner.stages } : {}),
      requiresNetworkApproval: true as const
    }
  }
  private parseResult(text: string): AdapterResult {
    if (Buffer.byteLength(text) > 512 * 1024) fail("RESULT_LIMIT")
    let row: AdapterResult
    try {
      row = JSON.parse(text)
    } catch {
      return fail("RESULT_INVALID")
    }
    if (
      row.apiVersion !== "devclaw.plugin-stage-recovery-result/v1" ||
      typeof row.ok !== "boolean" ||
      !safeText(row.summary, 8192) ||
      !Array.isArray(row.affectedArtifacts) ||
      row.affectedArtifacts.length > 1024 ||
      row.affectedArtifacts.some((item) => !safeText(item, 1024)) ||
      !Array.isArray(row.diagnostics) ||
      row.diagnostics.length > 128 ||
      row.diagnostics.some((item) => !safeText(item, 8192)) ||
      !row.evidence ||
      typeof row.evidence !== "object" ||
      Array.isArray(row.evidence)
    )
      return fail("RESULT_INVALID")
    return row
  }
  private async command(input: CommandInput) {
    if (this.closed) fail("CLOSED")
    if (this.deps.command) {
      input.beforeStart()
      return this.deps.command(input)
    }
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name, value]) =>
          value !== undefined &&
          [
            "PATH",
            "PATHEXT",
            "SYSTEMROOT",
            "WINDIR",
            "COMSPEC",
            "LOCALAPPDATA",
            "APPDATA",
            "USERPROFILE"
          ].includes(name.toUpperCase())
      )
    ) as Record<string, string>
    const stdin = JSON.stringify(input.request)
    const controller = new AbortController()
    this.commands.add(controller)
    const timer = setTimeout(() => controller.abort(), 120_000)
    const authority = setInterval(() => {
      try {
        input.guard()
        if (this.closed) controller.abort()
      } catch {
        controller.abort()
      }
    }, 250)
    const command = await prepareStageRecoveryCommand({
      workspace: input.operationRoot,
      snapshotRoot: input.owner.packageRoot,
      policy: {
        readOnlyRoots: [
          input.owner.packageRoot,
          ...(input.owner.workspace === input.workspace ? [] : [input.owner.workspace]),
          ...(input.owner.readOnlyRoots ?? [])
        ],
        networkAccess: "explicitly-approved"
      },
      env: { ...env, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" },
      shell: "python",
      args: ["-I", "-B", "-X", "utf8", join(input.owner.packageRoot, input.entry)],
      stdin,
      commandCwd: input.workspace,
      guard: input.guard,
      signal: controller.signal
    }).catch((error) => {
      clearTimeout(timer)
      clearInterval(authority)
      this.commands.delete(controller)
      throw error
    })
    const output: Buffer[] = []
    let bytes = 0
    let physical = false
    let started = false
    try {
      await input.owner.assertInputsCurrent?.()
      input.guard()
      controller.signal.throwIfAborted()
      input.beforeStart()
      started = true
      const running = startOwnedHookCommand({
        ...command,
        stdin: "",
        signal: controller.signal,
        stdout: (chunk) => {
          bytes += chunk.length
          if (bytes > 512 * 1024) controller.abort()
          else output.push(chunk)
        },
        stderr: (chunk) => {
          bytes += chunk.length
          if (bytes > 512 * 1024) controller.abort()
        }
      })
      const result = await running.completion
      physical = true
      return {
        code: result.code,
        stdout: Buffer.concat(output).toString("utf8"),
        uncertain: !!result.error || controller.signal.aborted
      }
    } finally {
      clearTimeout(timer)
      clearInterval(authority)
      this.commands.delete(controller)
      if (physical || !started) await command.cleanup()
    }
  }
  private async execute(
    owner: PluginStageRecoveryOwner,
    state: RecordState,
    operation: "plan" | "apply" | "verify",
    guard: () => void
  ) {
    const adapter = readPluginStageRecoveryAdapter(owner.packageRoot)
    if (adapter.digest !== state.adapterDigest) fail("ADAPTER_CHANGED")
    const current = () => {
      if (this.closed) fail("CLOSED")
      guard()
      adapter.assertCurrent()
    }
    await owner.assertInputsCurrent?.()
    current()
    let settlement: ReturnType<StageRecoveryHookJournal["begin"]> | undefined
    const beforeStart = () => {
      if (settlement) fail("COMMAND_ALREADY_STARTED")
      settlement = this.journal.begin(
        {
          projectId: state.id,
          operationId: operation + ":" + randomUUID(),
          threadId: state.scope.threadId,
          baselineId: state.sourceFingerprint,
          packageDigest: state.packageDigest,
          stageId: state.stageId,
          policyDigest: state.adapterDigest,
          hookDigest: state.adapterDigest
        },
        current
      )
    }
    let result: Awaited<ReturnType<PluginStageRecoverySessions["command"]>>
    try {
      result = await this.command({
        owner,
        operationRoot: dirname(state.workspace),
        workspace: state.workspace,
        entry: adapter.declaration.entry,
        request: {
          apiVersion: "devclaw.plugin-stage-recovery-request/v1",
          operation,
          sourceWorkspace: state.sourceWorkspace ?? owner.workspace,
          workspace: state.workspace,
          featureId: state.featureId,
          stageId: state.stageId,
          stateMode: state.stateMode,
          codeSource: "keep",
          ...(owner.providerInput ? { nativeInputs: owner.providerInput } : {}),
          ...(state.plan ? { planEvidence: state.plan.evidence } : {})
        },
        guard: current,
        beforeStart
      })
    } catch (error) {
      settlement?.settle(null, true)
      throw error
    }
    if (!settlement) fail("COMMAND_NOT_STARTED")
    settlement!.settle(result.code, !!result.uncertain, runtimeDigest(result.stdout))
    if (result.uncertain) fail("OUTCOME_UNCONFIRMED")
    await owner.assertInputsCurrent?.()
    current()
    const parsed = this.parseResult(result.stdout)
    if (result.code !== 0 || !parsed.ok || parsed.diagnostics.length) {
      throw Error(parsed.diagnostics.join("; ") || "PLUGIN_STAGE_RECOVERY_ADAPTER_FAILED")
    }
    return parsed
  }
  async prepare(
    input: PluginStageRecoveryRequest,
    callerGuard: () => void = () => {}
  ): Promise<PluginStageRecoveryPreparation> {
    callerGuard()
    if (this.closed) fail("CLOSED")
    if (input.allowNetworkSideEffects !== true) fail("NETWORK_APPROVAL_REQUIRED")
    if (
      !safeText(input.stageId) ||
      !["target_in_progress", "previous_done"].includes(input.stateMode)
    )
      fail("REQUEST_INVALID")
    const owner = await this.deps.owner(input.scope, input.trialId)
    const ownerGuard = () => {
      callerGuard()
      owner.guard()
      callerGuard()
    }
    ownerGuard()
    if (!same(owner.scope, input.scope) || owner.id !== input.trialId) fail("SCOPE_CHANGED")
    if (this.busy.has(owner.id)) fail("BUSY")
    const previousId = this.deps.settings.getSetting(this.pointer(input.scope, owner.id), "")
    if (previousId) {
      const previous = this.read(previousId).state
      if (
        ["unknown", "applying", "verified"].includes(previous.phase) ||
        this.journal.hasUnresolved(previous.id)
      )
        fail("OUTCOME_UNCONFIRMED")
    }
    this.busy.add(owner.id)
    let state: RecordState | undefined, raw: string | undefined
    try {
      const adapter = readPluginStageRecoveryAdapter(owner.packageRoot)
      if (
        input.expectedPackageDigest !== owner.packageDigest ||
        input.expectedAdapterDigest !== adapter.digest ||
        input.expectedInputsDigest !== ownerInputsDigest(owner)
      )
        fail("FRESH_APPROVAL_REQUIRED")
      const source = await readBoundedProjectFiles(owner.workspace, {
        guard: ownerGuard,
        collect: true
      })
      if (source.directories.includes(".devclaw-stage-recovery-tmp")) fail("RESERVED_PATH")
      await mkdir(this.deps.root, { recursive: true })
      ownerGuard()
      const directory = await mkdtemp(join(this.deps.root, "trial-"))
      const workspace = join(directory, "workspace")
      await mkdir(workspace)
      for (const path of source.directories) await mkdir(join(workspace, path), { recursive: true })
      for (const file of source.files) {
        ownerGuard()
        const target = join(workspace, file.path)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, source.buffers.get(file.path)!, { flag: "wx", mode: 0o600 })
        if (file.executable) await chmod(target, 0o700)
      }
      await readBoundedProjectFiles(owner.workspace, { guard: ownerGuard, expected: source })
      adapter.assertCurrent()
      state = {
        schemaVersion: 1,
        id: randomUUID(),
        scope: structuredClone(input.scope),
        sourceId: owner.id,
        sourceFingerprint: source.fingerprint,
        sourceWorkspace: owner.workspace,
        workspace,
        workspaceIdentity: runtimeDirectoryIdentity(workspace),
        packageRoot: owner.packageRoot,
        packageDigest: owner.packageDigest,
        featureId: owner.featureId,
        stageId: input.stageId,
        stateMode: input.stateMode,
        adapterDigest: adapter.digest,
        inputsDigest: ownerInputsDigest(owner),
        nonce: this.nonce,
        digest: runtimeDigest(randomUUID()),
        phase: "unknown"
      }
      raw = this.save(state)
      const pointer = this.pointer(state.scope, state.sourceId)
      ownerGuard()
      if (!this.deps.settings.compareAndSetSetting(pointer, previousId || undefined, state.id))
        fail("VERSION_CHANGED")
      const guard = () => {
        ownerGuard()
        if (
          this.read(state!.id).raw !== raw ||
          this.deps.settings.getSetting(pointer, "") !== state!.id ||
          runtimeDirectoryIdentity(workspace) !== state!.workspaceIdentity
        )
          fail("VERSION_CHANGED")
      }
      state.plan = await this.execute(owner, state, "plan", guard)
      const branch = await readBoundedProjectFiles(workspace, { guard })
      state.branchFingerprint = branch.fingerprint
      state.digest = runtimeDigest(
        JSON.stringify([
          state.id,
          state.sourceFingerprint,
          state.branchFingerprint,
          state.adapterDigest,
          state.inputsDigest,
          state.stageId,
          state.stateMode,
          state.plan
        ])
      )
      state.phase = "needs-confirmation"
      guard()
      this.save(state, raw)
      return this.view(state)
    } catch (error) {
      if (state && raw && this.read(state.id).raw === raw) {
        state.phase = this.journal.hasUnresolved(state.id) ? "unknown" : "failed"
        state.error =
          error instanceof Error ? error.message.slice(0, 8192) : "PLUGIN_STAGE_RECOVERY_FAILED"
        this.save(state, raw)
      }
      throw error
    } finally {
      this.busy.delete(owner.id)
    }
  }
  async apply(
    input: {
      scope: PluginStageRecoveryScope
      preparationId: string
      expectedDigest: string
      allowNetworkSideEffects: true
    },
    callerGuard: () => void = () => {}
  ) {
    callerGuard()
    if (this.closed) fail("CLOSED")
    if (input.allowNetworkSideEffects !== true) fail("NETWORK_APPROVAL_REQUIRED")
    const { state, raw: before } = this.read(input.preparationId)
    if (!same(input.scope, state.scope)) fail("SCOPE_CHANGED")
    if (
      state.nonce !== this.nonce ||
      state.phase !== "needs-confirmation" ||
      state.digest !== input.expectedDigest ||
      !state.plan?.ok
    )
      fail("FRESH_APPROVAL_REQUIRED")
    const owner = await this.deps.owner(input.scope, state.sourceId)
    callerGuard()
    if (this.busy.has(owner.id)) fail("BUSY")
    this.busy.add(owner.id)
    let raw = before
    const guard = () => {
      callerGuard()
      owner.guard()
      if (
        this.read(state.id).raw !== raw ||
        this.deps.settings.getSetting(this.pointer(state.scope, state.sourceId), "") !== state.id ||
        owner.packageRoot !== state.packageRoot ||
        owner.packageDigest !== state.packageDigest ||
        ownerInputsDigest(owner) !== state.inputsDigest ||
        owner.featureId !== state.featureId ||
        runtimeDirectoryIdentity(state.workspace) !== state.workspaceIdentity
      )
        fail("VERSION_CHANGED")
    }
    try {
      guard()
      const source = await readBoundedProjectFiles(owner.workspace, { guard })
      const branch = await readBoundedProjectFiles(state.workspace, { guard })
      if (
        source.fingerprint !== state.sourceFingerprint ||
        branch.fingerprint !== state.branchFingerprint
      )
        fail("INPUT_CHANGED")
      state.phase = "applying"
      raw = this.save(state, raw)
      await this.execute(owner, state, "apply", guard)
      const result = await this.execute(owner, state, "verify", guard)
      const verifiedCopy = capturePackageMetadataGuard(state.workspace)
      const complete = await readBoundedProjectFiles(state.workspace, { guard })
      verifiedCopy()
      state.evidenceDigest = runtimeDigest(JSON.stringify([result, complete.fingerprint]))
      state.branchFingerprint = complete.fingerprint
      state.phase = "verified"
      raw = this.save(state, raw)
      const receipt: PluginStageRecoveryReceipt = {
        preparationId: state.id,
        digest: state.digest,
        sourceId: state.sourceId,
        workspace: state.workspace,
        packageRoot: state.packageRoot,
        packageDigest: state.packageDigest,
        featureId: state.featureId,
        stageId: state.stageId,
        stateMode: state.stateMode,
        evidenceDigest: state.evidenceDigest
      }
      this.receipts.set(receipt, verifiedCopy)
      guard()
      const adopted = await this.deps.adopt(owner, receipt)
      this.assertReceipt(receipt)
      guard()
      state.phase = "adopted"
      state.recoveredTrialId = adopted.trialId
      state.recoveredProjectId = adopted.projectId
      this.save(state, raw)
      return { ...adopted, preparation: this.view(state) }
    } catch (error) {
      if (this.read(state.id).raw === raw) {
        state.phase = this.journal
          .list(state.id)
          .some((entry) => entry.identity.operationId.startsWith("apply:"))
          ? "unknown"
          : "failed"
        state.error =
          error instanceof Error ? error.message.slice(0, 8192) : "PLUGIN_STAGE_RECOVERY_FAILED"
        this.save(state, raw)
      }
      throw error
    } finally {
      this.busy.delete(owner.id)
    }
  }
  /** Physical reconciliation never repeats apply. A new consent only permits verify/adopt. */
  async reconcile(
    input: {
      scope: PluginStageRecoveryScope
      preparationId: string
      expectedDigest: string
      allowNetworkSideEffects?: true
    },
    callerGuard: () => void = () => {}
  ) {
    callerGuard()
    if (this.closed) fail("CLOSED")
    const { state, raw: before } = this.read(input.preparationId)
    const resumingAdopted =
      state.phase === "adopted" &&
      state.nonce !== this.nonce &&
      input.allowNetworkSideEffects === true
    if (!same(input.scope, state.scope) || state.digest !== input.expectedDigest)
      fail("SCOPE_CHANGED")
    if (state.phase === "adopted" && !resumingAdopted)
      return this.status(input.scope, state.id, callerGuard)
    const owner =
      resumingAdopted && this.deps.adoptedOwner && state.recoveredTrialId && state.evidenceDigest
        ? await this.deps.adoptedOwner(
            input.scope,
            state.id,
            state.recoveredTrialId,
            state.evidenceDigest
          )
        : await this.deps.owner(input.scope, state.sourceId)
    callerGuard()
    if (this.busy.has(owner.id)) fail("BUSY")
    this.busy.add(owner.id)
    let raw = before
    const guard = () => {
      callerGuard()
      owner.guard()
      if (resumingAdopted) {
        const available = owner.assertAdoptionAvailable
        const evidence = state.evidenceDigest
        if (!available || !evidence) return fail("ADOPTION_REVIEW_REQUIRED")
        available(state.id, evidence)
      }
      if (
        this.read(state.id).raw !== raw ||
        owner.packageRoot !== state.packageRoot ||
        owner.packageDigest !== state.packageDigest ||
        ownerInputsDigest(owner) !== state.inputsDigest ||
        runtimeDirectoryIdentity(state.workspace) !== state.workspaceIdentity
      )
        fail("VERSION_CHANGED")
    }
    try {
      guard()
      if (state.phase === "adopted" && !resumingAdopted) return this.view(state)
      for (const intent of this.journal.list(state.id)) {
        if (["started", "unknown"].includes(intent.phase))
          await this.journal.reconcile(
            state.id,
            intent.id,
            async (row) => this.journal.inspectPhysical(row),
            guard
          )
      }
      guard()
      const entries = this.journal.list(state.id)
      const apply = entries.filter((entry) => entry.identity.operationId.startsWith("apply:"))
      // A crash after the physical plan receipt but before publishing its review must not
      // strand the conversation forever. This terminates that unreviewed plan only; it
      // never reconstructs an approval, infers an absent apply from files, or runs code.
      if (state.phase === "unknown" && !state.plan && entries.length === 1 && apply.length === 0) {
        const plan = entries[0]
        const physical = this.journal.inspectPhysical(plan)
        if (
          plan.identity.operationId.startsWith("plan:") &&
          ["settled", "reconciled"].includes(plan.phase) &&
          plan.exitCode === 0 &&
          physical.outcome === "confirmed-completed" &&
          physical.exitCode === 0 &&
          plan.identity.packageDigest === state.packageDigest &&
          plan.identity.baselineId === state.sourceFingerprint &&
          plan.identity.threadId === state.scope.threadId &&
          plan.identity.stageId === state.stageId &&
          plan.identity.policyDigest === state.adapterDigest &&
          plan.identity.hookDigest === state.adapterDigest
        ) {
          await owner.assertInputsCurrent?.()
          guard()
          const sourceGuard = capturePackageMetadataGuard(owner.workspace)
          const source = await readBoundedProjectFiles(owner.workspace, { guard })
          if (source.fingerprint !== state.sourceFingerprint) fail("INPUT_CHANGED")
          await owner.assertInputsCurrent?.()
          sourceGuard()
          physical.assertCurrent()
          guard()
          if (!same(entries, this.journal.list(state.id))) fail("VERSION_CHANGED")
          state.phase = "failed"
          state.error = "PLUGIN_STAGE_RECOVERY_FRESH_PLAN_REQUIRED"
          this.save(state, raw)
          return this.view(state)
        }
      }
      if (
        this.journal.hasUnresolved(state.id) ||
        apply.length !== 1 ||
        apply[0].exitCode !== 0 ||
        !["settled", "reconciled"].includes(apply[0].phase)
      )
        return this.view(state)
      // Reading journals restores no old approval. Verification is plugin code and needs new consent.
      if (input.allowNetworkSideEffects !== true) return this.view(state)
      if (!resumingAdopted) {
        const currentSource = await readBoundedProjectFiles(owner.workspace, { guard })
        if (currentSource.fingerprint !== state.sourceFingerprint) fail("INPUT_CHANGED")
      }
      const result = await this.execute(owner, state, "verify", guard)
      const verifiedCopy = capturePackageMetadataGuard(state.workspace)
      const complete = await readBoundedProjectFiles(state.workspace, { guard })
      verifiedCopy()
      const evidenceDigest = runtimeDigest(JSON.stringify([result, complete.fingerprint]))
      if (state.evidenceDigest && state.evidenceDigest !== evidenceDigest)
        fail("RECOVERED_COPY_CHANGED")
      state.evidenceDigest = evidenceDigest
      state.branchFingerprint = complete.fingerprint
      state.phase = "verified"
      delete state.error
      raw = this.save(state, raw)
      const receipt: PluginStageRecoveryReceipt = {
        preparationId: state.id,
        digest: state.digest,
        sourceId: state.sourceId,
        workspace: state.workspace,
        packageRoot: state.packageRoot,
        packageDigest: state.packageDigest,
        featureId: state.featureId,
        stageId: state.stageId,
        stateMode: state.stateMode,
        evidenceDigest
      }
      this.receipts.set(receipt, verifiedCopy)
      guard()
      const adopted = await this.deps.adopt(owner, receipt)
      this.assertReceipt(receipt)
      guard()
      state.phase = "adopted"
      state.nonce = this.nonce
      state.recoveredTrialId = adopted.trialId
      state.recoveredProjectId = adopted.projectId
      this.save(state, raw)
      return this.view(state)
    } catch (error) {
      if (this.read(state.id).raw === raw) {
        state.phase = state.phase === "adopted" ? "adopted" : "unknown"
        state.error =
          error instanceof Error
            ? error.message.slice(0, 8192)
            : "PLUGIN_STAGE_RECOVERY_OUTCOME_UNCONFIRMED"
        this.save(state, raw)
      }
      throw error
    } finally {
      this.busy.delete(owner.id)
    }
  }
  assertReceipt(receipt: PluginStageRecoveryReceipt): void {
    const guard = this.receipts.get(receipt)
    if (!guard) return fail("NATIVE_RECEIPT_REQUIRED")
    guard()
    const { state } = this.read(receipt.preparationId)
    if (
      state.phase !== "verified" ||
      state.digest !== receipt.digest ||
      state.evidenceDigest !== receipt.evidenceDigest ||
      state.workspace !== receipt.workspace ||
      state.sourceId !== receipt.sourceId ||
      state.packageRoot !== receipt.packageRoot ||
      state.packageDigest !== receipt.packageDigest ||
      state.featureId !== receipt.featureId ||
      state.stageId !== receipt.stageId ||
      state.stateMode !== receipt.stateMode
    )
      fail("NATIVE_RECEIPT_CHANGED")
  }
  close(): void {
    this.closed = true
    for (const controller of this.commands) controller.abort()
  }
}
