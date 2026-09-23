import type { FunctionSessionReadMethod } from "../../../shared/mods/v2/session"
import type { CompletionGate } from "../../agent/skill-lifecycle/completion-gate"
import type {
  FunctionTurnStart,
  FunctionTurnComplete,
  FunctionTurnResult
} from "../../../shared/mods/v2/turn"
import { FunctionTurnNotices } from "./turn-notices"
import type { FunctionTurnNotice } from "../../../shared/mods/v2/turn"
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { createHash, randomInt, randomUUID } from "node:crypto"
import { parseCompletionPolicy } from "../../../shared/mods/v2/completion-policy"
import { CompletionBudget, bindCompletionGateBudget } from "./completion-budget"
import { ProjectFunctionFiles, type FunctionFileScope } from "./file-access"
import type { ModControlStore, ModGrant } from "../control-store"
import type { ModPluginSource } from "../manager"
import type {
  ModCommandDescriptor,
  ModJson,
  ModProjection,
  ModObject
} from "../../../shared/mods/types"
import type { FunctionPluginStatus } from "../../../shared/mods/v2/commands"
import {
  ModFunctionError,
  isModObject,
  matchesEventPattern,
  type FunctionGuest
} from "../../../shared/mods/v2/contracts"
import { FunctionRuntimeClient } from "./runtime-client"
import { compileFunctionPlugin, type CompiledFunctionPlugin } from "./loader"
import { FunctionSession, SESSION_CAPABILITIES, type FunctionSessionHost } from "./session"
import type { FunctionPlugin } from "./dispatcher"
import { normalizePluginRelativePath, readPluginManifest } from "../../plugins/manifest"
import { resolveModFile } from "../loader"
import type {
  FunctionPaneSnapshot,
  FunctionUiAction,
  FunctionClientAction
} from "../../../shared/mods/v2/ui"
import { functionUiSite, type FunctionUiSite } from "../../../shared/mods/v2/sites"
import { CLIENT_BOOTSTRAP } from "./client-bootstrap"
import type { FunctionToolInfo, RegisteredFunctionTool } from "../../../shared/mods/v2/tools"
import type { ToolPermissionResult } from "../../../shared/tool-permission"
import type { ModOrigin } from "../../../shared/mods/v2/contracts"
import {
  bindingFingerprint,
  captureCompletionBinding,
  sameCompletionBinding,
  type CompletionEvidenceBinding,
  type CompletionEvidenceRecord
} from "./completion-evidence"
import { advanceAutobizCheckpoint, runAutobizValidator } from "./autobiz-validation"
import { runProjectCheck, type ProjectCheckKind } from "./project-checks"
import { dispatchFunctionStream, type FunctionStreamOptions, type ModHookStream } from "./stream-dispatcher"

interface Snapshot {
  compiled: CompiledFunctionPlugin
  grant: ModGrant
}
interface FunctionConnection {
  load(code: string, options: CompiledFunctionPlugin["options"]): Promise<FunctionGuest>
  stop(): void
}
interface SessionEntry {
  completionProofs: Map<string, (signal: AbortSignal) => Promise<CompletionEvidenceBinding>>
  turnNotices: FunctionTurnNotices
  workspace: string
  threadId: string
  epoch: number
  generation: number
  client: FunctionConnection
  session?: FunctionSession
  loading: Promise<FunctionSession>
  snapshots: Map<string, Snapshot>
}
interface FunctionManagerHost {
  plugins(): ModPluginSource[]
  enabled(workspace: string): boolean
  publish(workspace: string, value: ModJson, signal: AbortSignal): Promise<ModJson>
  changed(threadId: string): void
  assertThread?(workspace: string, threadId: string): void
  abortTurn?(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    turnId: string,
    signal: AbortSignal
  ): Promise<void>
  readSession?(
    workspace: string,
    threadId: string,
    method: FunctionSessionReadMethod,
    signal: AbortSignal,
    usageArgs?: import("../../../shared/mods/v2/session").FunctionSessionUsageArgs
  ): Promise<ModJson>
  compactSession?(
    workspace: string,
    threadId: string,
    instructions: string,
    signal: AbortSignal
  ): Promise<ModJson>
  fileScope?(workspace: string, threadId: string): FunctionFileScope
  listTools?(workspace: string, threadId: string, signal: AbortSignal): Promise<FunctionToolInfo[]>
  filterTools?(workspace: string, threadId: string, tools: FunctionToolInfo[]): FunctionToolInfo[]
  assertToolNameAvailable?(workspace: string, threadId: string, plugin: string, name: string): void
  registeredTool?(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    input: ModObject,
    origin: "model" | "mod",
    signal: AbortSignal,
    run: () => Promise<ModObject>,
    caller?: ModOrigin
  ): Promise<ModObject>
  callTool?(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    input: ModObject,
    signal: AbortSignal
  ): Promise<ModObject>
  callMcp?(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    input: ModObject,
    signal: AbortSignal,
    dispatch: import("./mcp-sdk").FunctionMcpToolDispatch
  ): Promise<ModObject>
  checkTool?(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    input: ModObject,
    signal: AbortSignal,
    registered?: RegisteredFunctionTool
  ): Promise<ToolPermissionResult>
  completeModel?(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    input: ModObject,
    signal: AbortSignal
  ): Promise<string>
  capability?(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    method: "model.fork" | "model.classify",
    input: ModObject,
    signal: AbortSignal
  ): Promise<ModJson | undefined>
  scheduleCommand?(
    workspace: string,
    threadId: string,
    ...args: Parameters<NonNullable<FunctionSessionHost["scheduleCommand"]>>
  ): ReturnType<NonNullable<FunctionSessionHost["scheduleCommand"]>>
}

/** Grants bind a complete source snapshot; a live session never rereads mutable plugin source. */
export class FunctionModsManager {
  private readonly initialEpoch = randomInt(1, 2 ** 48)
  private readonly epochs = new Map<string, number>()
  private readonly sessions = new Map<string, SessionEntry>()
  private readonly pendingSiteMounts = new Set<{
    workspace: string
    threadId: string
    valid: boolean
  }>()
  private closed = false
  private sessionGeneration = this.initialEpoch

  constructor(
    private readonly store: ModControlStore,
    private readonly host: FunctionManagerHost,
    private readonly createClient: () => FunctionConnection = () =>
      new FunctionRuntimeClient(join(__dirname, "function-mod-host.js"))
  ) {}

  private epoch(workspace: string): number {
    return this.epochs.get(workspace) ?? this.initialEpoch
  }

  private sources(): ModPluginSource[] {
    return this.host
      .plugins()
      .filter((plugin) => {
        const manifest = readPluginManifest(plugin.path)?.manifest
        const nativePath = manifest?.mods ?? "mods/manifest.json"
        if (existsSync(join(plugin.path, nativePath))) {
          try {
            const file = resolveModFile(
              plugin.path,
              normalizePluginRelativePath(nativePath) ?? nativePath
            )
            if (
              statSync(file).size <= 32768 &&
              JSON.parse(readFileSync(file, "utf8")).apiVersion === "cmb.mods/v2"
            )
              return true
          } catch {
            return true
          }
        }
        try {
          const hooksPath = manifest?.hooks ?? "hooks/hooks.json"
          if (!existsSync(join(plugin.path, hooksPath))) return false
          const hooks = resolveModFile(
            plugin.path,
            normalizePluginRelativePath(hooksPath) ?? hooksPath
          )
          return (
            existsSync(hooks) &&
            statSync(hooks).size <= 32768 &&
            Object.hasOwn(JSON.parse(readFileSync(hooks, "utf8")), "modules")
          )
        } catch {
          return false
        }
      })
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  async status(workspace: string): Promise<FunctionPluginStatus[]> {
    const result: FunctionPluginStatus[] = []
    for (const source of this.sources()) {
      try {
        const compiled = await compileFunctionPlugin(source.path)
        const grant = this.store.getGrant(workspace, `function:${compiled.name}`)
        result.push({
          pluginId: source.id,
          name: compiled.name,
          digest: compiled.digest,
          capabilities: [...SESSION_CAPABILITIES],
          state: !source.enabled
            ? "disabled"
            : grant?.enabled && grant.digest === compiled.digest
              ? "ready"
              : "needs-approval"
        })
      } catch (error) {
        result.push({
          pluginId: source.id,
          name: source.name,
          state: "invalid",
          capabilities: [],
          error: error instanceof Error ? error.message : "MODS_PLUGIN_INVALID"
        })
      }
    }
    for (const item of result)
      if (result.filter((candidate) => candidate.name === item.name).length > 1) {
        item.state = "invalid"
        item.error = "MODS_DUPLICATE_MOD_ID"
      }
    return result
  }

  async approve(workspace: string, pluginId: string, digest: string): Promise<void> {
    const epoch = this.epoch(workspace)
    const status = (await this.status(workspace)).find((entry) => entry.pluginId === pluginId)
    const source = this.sources().find((entry) => entry.id === pluginId)
    if (!status || !source?.enabled || status.state === "invalid" || status.digest !== digest)
      throw new ModFunctionError("MODS_APPROVAL_STALE")
    const compiled = await compileFunctionPlugin(source.path)
    if (compiled.digest !== digest) throw new ModFunctionError("MODS_APPROVAL_STALE")
    const client = this.createClient()
    try {
      const guest = await client.load(compiled.code, compiled.options)
      await guest.dispose()
    } finally {
      client.stop()
    }
    if (this.closed || epoch !== this.epoch(workspace))
      throw new ModFunctionError("MODS_APPROVAL_STALE")
    this.store.grant(workspace, `function:${compiled.name}`, digest, true)
    this.invalidate(workspace)
  }

  revoke(workspace: string, name: string): void {
    const key = `function:${name}`
    const grant = this.store.getGrant(workspace, key)
    if (grant) this.store.grant(workspace, key, grant.digest, false)
    this.invalidate(workspace)
  }

  invalidate(workspace: string): void {
    this.epochs.set(workspace, this.epoch(workspace) + 1)
    for (const request of this.pendingSiteMounts)
      if (request.workspace === workspace) request.valid = false
    for (const [key, entry] of this.sessions) {
      if (entry.workspace !== workspace) continue
      this.sessions.delete(key)
      void entry.session?.close()
      entry.client.stop()
      this.host.changed(entry.threadId)
    }
  }

  /** Stop every Function Mods session when the application-level switch changes. */
  invalidateAll(): void {
    const workspaces = new Set([
      ...[...this.sessions.values()].map((entry) => entry.workspace),
      ...[...this.pendingSiteMounts].map((request) => request.workspace)
    ])
    for (const workspace of workspaces) this.invalidate(workspace)
  }

  closeThread(threadId: string): void {
    for (const request of this.pendingSiteMounts)
      if (request.threadId === threadId) request.valid = false
    for (const [key, entry] of this.sessions) {
      if (entry.threadId !== threadId) continue
      this.sessions.delete(key)
      void entry.session?.close()
      entry.client.stop()
      this.host.changed(threadId)
    }
  }

  private async session(workspace: string, threadId: string): Promise<SessionEntry> {
    if (this.closed || !this.host.enabled(workspace)) throw new ModFunctionError("MODS_DISABLED")
    const key = JSON.stringify([workspace, threadId])
    let entry = this.sessions.get(key)
    if (entry) {
      await entry.loading
      if (entry.session!.plugins.every((plugin) => !plugin.guest.stats.disposed)) return entry
      // Only a later caller rebuilds the snapshot. Never replay the interrupted command.
      this.invalidate(workspace)
      entry = undefined
    }
    if (this.sessions.size >= 6) throw new ModFunctionError("MODS_SESSION_CAPACITY")
    entry = {
      completionProofs: new Map(),
      turnNotices: new FunctionTurnNotices(),
      workspace,
      threadId,
      epoch: this.epoch(workspace),
      generation: ++this.sessionGeneration,
      client: this.createClient(),
      snapshots: new Map(),
      loading: Promise.resolve(undefined as unknown as FunctionSession)
    }
    const current = entry
    this.sessions.set(key, current)
    const assertLive = (plugin?: FunctionPlugin): void => {
      this.host.assertThread?.(workspace, threadId)
      if (
        this.closed ||
        this.sessions.get(key) !== current ||
        !this.host.enabled(workspace) ||
        this.epoch(workspace) !== current.epoch
      )
        throw new ModFunctionError("MODS_SCOPE_CHANGED")
      if (plugin) {
        const snapshot = current.snapshots.get(plugin.name)
        if (!snapshot) throw new ModFunctionError("MODS_GRANT_MISSING")
        this.store.assertGrant(snapshot.grant)
      } else
        for (const snapshot of current.snapshots.values()) this.store.assertGrant(snapshot.grant)
      if (current.session?.plugins.some((loaded) => loaded.guest.stats.disposed))
        throw new ModFunctionError("MODS_RUNTIME_LOST")
    }
    current.loading = (async () => {
      try {
        const plugins: FunctionPlugin[] = []
        const ready = new Set(
          (await this.status(workspace)).filter((s) => s.state === "ready").map((s) => s.pluginId)
        )
        for (const source of this.sources()) {
          if (!ready.has(source.id)) continue
          if (!source.enabled) continue
          const compiled = await compileFunctionPlugin(source.path)
          const grant = this.store.getGrant(workspace, `function:${compiled.name}`)
          if (!grant?.enabled || grant.digest !== compiled.digest) continue
          if (current.snapshots.has(compiled.name))
            throw new ModFunctionError("MODS_DUPLICATE_MOD_ID")
          if (plugins.length >= 8) throw new ModFunctionError("MODS_CHAIN_CAPACITY")
          assertLive()
          const guest = await current.client.load(compiled.code, compiled.options)
          assertLive()
          current.snapshots.set(compiled.name, { compiled, grant })
          plugins.push({
            name: compiled.name,
            root: compiled.root,
            tier: "user",
            guest,
            capabilities: [...SESSION_CAPABILITIES]
          })
        }
        current.session = new FunctionSession(plugins, {
          workspace,
          threadId,
          cwd: () => this.host.fileScope?.(workspace, threadId).workspace ?? workspace,
          assertLive,
          abortTurn: async (plugin, turnId, signal) => {
            assertLive(plugin)
            if (!this.host.abortTurn) throw new ModFunctionError("MODS_TURN_UNAVAILABLE")
            await this.host.abortTurn(
              workspace,
              threadId,
              current.snapshots.get(plugin.name)!.grant,
              turnId,
              signal
            )
          },
          readSession: async (method, signal, usageArgs) => {
            assertLive()
            if (!this.host.readSession) throw new ModFunctionError("MODS_SESSION_UNAVAILABLE")
            const value = await this.host.readSession(
              workspace,
              threadId,
              method,
              signal,
              usageArgs
            )
            assertLive()
            const result = await this.host.publish(workspace, value, signal)
            assertLive()
            return result
          },
          compactSession: async (instructions, signal) => {
            assertLive()
            if (!this.host.compactSession) throw new ModFunctionError("MODS_SESSION_UNAVAILABLE")
            const value = await this.host.compactSession(workspace, threadId, instructions, signal)
            assertLive()
            const result = await this.host.publish(workspace, value, signal)
            assertLive()
            return result
          },
          listTools: this.host.listTools
            ? (signal) => this.host.listTools!(workspace, threadId, signal)
            : undefined,
          filterTools: this.host.filterTools
            ? (tools) => this.host.filterTools!(workspace, threadId, tools)
            : undefined,
          assertToolNameAvailable: (plugin, name) => {
            assertLive()
            this.host.assertToolNameAvailable?.(workspace, threadId, plugin, name)
          },
          registeredTool: async (owner, input, origin, signal, run, caller) => {
            assertLive(owner)
            if (!this.host.registeredTool)
              throw new ModFunctionError("MODS_REGISTERED_TOOL_UNAVAILABLE")
            const answer = await this.host.registeredTool(
              workspace,
              threadId,
              current.snapshots.get(owner.name)!.grant,
              input,
              origin,
              signal,
              run,
              caller
            )
            assertLive(owner)
            return answer
          },
          completeModel: async (plugin, input, signal) => {
            assertLive(plugin)
            if (!this.host.completeModel) throw new ModFunctionError("MODS_MODEL_UNAVAILABLE")
            const grant = current.snapshots.get(plugin.name)!.grant
            const result = await this.host.completeModel(workspace, threadId, grant, input, signal)
            assertLive(plugin)
            return result
          },
          capability: async (plugin, method, args, signal) => {
            assertLive(plugin)
            if (!this.host.capability)
              throw new ModFunctionError("MODS_MODEL_OPERATION_UNSUPPORTED")
            const grant = current.snapshots.get(plugin.name)!.grant
            const input = args[0]
            if (!isModObject(input)) throw new ModFunctionError("MODS_MODEL_ARGUMENTS")
            const result = await this.host.capability(
              workspace,
              threadId,
              grant,
              method as "model.fork" | "model.classify",
              input,
              signal
            )
            assertLive(plugin)
            return result
          },
          callTool: async (plugin, input, signal) => {
            assertLive(plugin)
            if (!this.host.callTool) throw new ModFunctionError("MODS_TOOL_UNAVAILABLE")
            const grant = current.snapshots.get(plugin.name)!.grant
            const result = await this.host.callTool(workspace, threadId, grant, input, signal)
            assertLive(plugin)
            return result
          },
          callMcp: async (plugin, input, signal, dispatch) => {
            assertLive(plugin)
            if (!this.host.callMcp) throw new ModFunctionError("MODS_MCP_UNAVAILABLE")
            const grant = current.snapshots.get(plugin.name)!.grant
            const result = await this.host.callMcp(
              workspace,
              threadId,
              grant,
              input,
              signal,
              dispatch
            )
            assertLive(plugin)
            return result
          },
          checkTool: async (plugin, input, signal, registered) => {
            assertLive(plugin)
            if (!this.host.checkTool) throw new ModFunctionError("MODS_TOOL_CHECK_UNAVAILABLE")
            const grant = current.snapshots.get(plugin.name)!.grant
            const result = await this.host.checkTool(
              workspace,
              threadId,
              grant,
              input,
              signal,
              registered
            )
            assertLive(plugin)
            return result
          },
          uiChanged: () => this.host.changed(threadId),
          loadClient: async (name, module) => {
            const snapshot = current.snapshots.get(name)
            if (!snapshot || !Object.hasOwn(snapshot.compiled.clients, module))
              throw new ModFunctionError("MODS_CLIENT_MODULE_UNAPPROVED")
            assertLive()
            const guest = await current.client.load(
              CLIENT_BOOTSTRAP + "\n" + snapshot.compiled.clients[module],
              { plugin: name }
            )
            try {
              assertLive()
              return guest
            } catch (error) {
              await guest.dispose()
              throw error
            }
          },
          scheduleCommand: this.host.scheduleCommand
            ? (command, signal, run) => {
                assertLive()
                return this.host.scheduleCommand!(
                  workspace,
                  threadId,
                  command,
                  signal,
                  async (s) => {
                    assertLive()
                    const result = await run(s)
                    assertLive()
                    return result
                  }
                )
              }
            : undefined,
          files: (plugin) => {
            const scope = this.host.fileScope?.(workspace, threadId)
            return new ProjectFunctionFiles(
              scope?.workspace ?? workspace,
              () => {
                assertLive(plugin)
                scope?.assertLive()
              },
              (value, signal) => this.host.publish(workspace, value, signal),
              scope?.queryTool
            )
          },
          state: (plugin) => {
            // Reloads keep state; project and plugin identity remain separate namespaces.
            const namespace = JSON.stringify([workspace, plugin.name])
            return {
              get: async (key, signal) => {
                assertLive(plugin)
                const value = this.store.functionState.get(namespace, key)
                const checked =
                  value === undefined
                    ? undefined
                    : await this.host.publish(workspace, value, signal)
                assertLive(plugin)
                return checked
              },
              keys: async (signal) => {
                assertLive(plugin)
                const checked = await this.host.publish(
                  workspace,
                  this.store.functionState.keys(namespace),
                  signal
                )
                assertLive(plugin)
                if (!Array.isArray(checked) || checked.some((key) => typeof key !== "string"))
                  throw new ModFunctionError("MODS_STORE_PUBLICATION")
                return checked as string[]
              },
              delete: (key) => {
                assertLive(plugin)
                this.store.functionState.delete(namespace, key)
              },
              set: async (key, value, signal) => {
                assertLive(plugin)
                const checked = await this.host.publish(workspace, value, signal)
                assertLive(plugin)
                signal.throwIfAborted()
                this.store.functionState.set(namespace, key, checked)
              }
            }
          },
          publish: (value, signal) => this.host.publish(workspace, value, signal)
        })
        await current.session.start()
        assertLive()
        return current.session
      } catch (error) {
        if (this.sessions.get(key) === current) this.sessions.delete(key)
        current.client.stop()
        throw error
      }
    })()
    await current.loading
    return current
  }

  async commands(workspace: string, threadId: string): Promise<ModCommandDescriptor[]> {
    if (!this.host.enabled(workspace) || this.sources().length === 0) return []
    if (
      !this.sessions.has(JSON.stringify([workspace, threadId])) &&
      !(await this.status(workspace)).some((item) => item.state === "ready")
    )
      return []
    const entry = await this.session(workspace, threadId)
    return (await entry.session!.commands(undefined, true)).map((command) => {
      const snapshot = entry.snapshots.get(command.plugin)!
      return {
        apiVersion: "cmb.mods/v2",
        modId: `function:${command.plugin}`,
        name: command.description,
        command: command.name,
        turnId: `functions:${threadId}`,
        digest: snapshot.compiled.digest,
        grantEpoch: snapshot.grant.epoch,
        workspaceEpoch: entry.generation,
        immediate: command.immediate,
        isHidden: command.isHidden,
        argumentHint: command.argumentHint
      }
    })
  }

  completionEvidence(workspace: string, threadId: string, limit = 100): CompletionEvidenceRecord[] {
    this.host.assertThread?.(workspace, threadId)
    if (!this.host.enabled(workspace)) return []
    return this.store.completionEvidence(workspace, threadId, limit)
  }

  async advanceAutobizCheckpoint(
    workspace: string,
    threadId: string,
    input: ModObject,
    signal: AbortSignal
  ): Promise<ModObject> {
    this.host.assertThread?.(workspace, threadId)
    const evidenceId = input.evidenceId
    const feature = input.feature
    const from = input.from
    const to = input.to
    const stateFingerprint = input.stateFingerprint
    const idempotencyKey = input.idempotencyKey
    if ([evidenceId, feature, from, to, stateFingerprint, idempotencyKey].some((value) => typeof value !== "string" || !value))
      throw new ModFunctionError("MODS_AUTOBIZ_TRANSITION_ARGUMENTS")
    const records = this.store.completionEvidence(workspace, threadId, 500)
    const prior = records.find((record) => record.phase === "state.transition" && record.status === "pass" &&
      isModObject(record.detail) && record.detail.evidenceId === evidenceId && record.detail.idempotencyKey === idempotencyKey)
    if (prior && this.host.enabled(workspace)) {
      this.host.assertThread?.(workspace, threadId)
      const detail = isModObject(prior.detail) ? prior.detail : undefined
      const targetFingerprint = detail && typeof detail.stateFingerprint === "string"
        ? detail.stateFingerprint : undefined
      const statePath = join(this.host.fileScope?.(workspace, threadId)?.workspace ?? workspace,
        ".autobizdevops", "state.json")
      if (targetFingerprint && existsSync(statePath)) {
        const currentFingerprint = createHash("sha256").update(readFileSync(statePath)).digest("hex")
        if (currentFingerprint !== targetFingerprint) throw new ModFunctionError("MODS_AUTOBIZ_VALIDATOR_STALE")
      }
      return { ...(prior.detail as ModObject), applied: false, duplicate: true }
    }
    const started = records.find((record) => record.phase === "check.started" && isModObject(record.detail) && record.detail.attempt === evidenceId)
    const validator = records.find((record) => {
      if (record.phase !== "validator.result" || record.status !== "pass" || !started) return false
      if (record.at < started.at || bindingFingerprint(record.binding) !== bindingFingerprint(started.binding)) return false
      return isModObject(record.detail) && record.detail.kind === "autobiz-validator" && record.detail.passed === true
    })
    if (!started || !validator) throw new ModFunctionError("MODS_AUTOBIZ_VALIDATOR_REQUIRED")
    if (validator.binding.stateFingerprint !== stateFingerprint ||
      (isModObject(validator.detail) && typeof validator.detail.feature === "string" && validator.detail.feature !== feature) ||
      records.some((record) => record.phase === "invalidated" && record.at >= validator.at && bindingFingerprint(record.binding) === bindingFingerprint(validator.binding)))
      throw new ModFunctionError("MODS_AUTOBIZ_VALIDATOR_STALE")
    const entry = this.sessions.get(JSON.stringify([workspace, threadId]))
    const capture = entry?.completionProofs.get(evidenceId as string)
    if (!entry || !capture || !this.host.enabled(workspace))
      throw new ModFunctionError("MODS_AUTOBIZ_VALIDATOR_STALE")
    const verifyEvidence = async () => {
      signal.throwIfAborted()
      if (!sameCompletionBinding(validator.binding, await capture(signal)))
        throw new ModFunctionError("MODS_AUTOBIZ_VALIDATOR_STALE")
    }
    await verifyEvidence()
    const scope = this.host.fileScope?.(workspace, threadId)
    scope?.assertLive()
    const result = await advanceAutobizCheckpoint({
      workspace: scope?.workspace ?? workspace,
      feature: feature as string,
      from: from as string,
      to: to as string,
      expectedStateFingerprint: stateFingerprint as string,
      idempotencyKey: idempotencyKey as string,
      signal,
      verifyEvidence
    })
    this.host.assertThread?.(workspace, threadId)
    for (const snapshot of (this.sessions.get(JSON.stringify([workspace, threadId]))?.snapshots.values() ?? [])) this.store.assertGrant(snapshot.grant)
    if (!result.applied && !result.duplicate)
      throw new ModFunctionError(result.reason || "MODS_AUTOBIZ_TRANSITION_FAILED")
    this.store.saveCompletionEvidence({
      ...started, id: randomUUID(), idempotencyKey: `transition:${idempotencyKey}`,
      phase: "state.transition", status: "pass", at: Date.now(),
      detail: { evidenceId, idempotencyKey, ...result } as ModObject
    })
    entry.completionProofs.delete(evidenceId as string)
    return result as unknown as ModObject
  }

  async interceptTool(
    workspace: string,
    threadId: string,
    input: ModObject,
    signal: AbortSignal | undefined,
    core: (input: ModObject, signal: AbortSignal) => Promise<ModObject>
  ): Promise<ModObject> {
    if (
      !this.host.enabled(workspace) ||
      this.sources().length === 0 ||
      (!this.sessions.has(JSON.stringify([workspace, threadId])) &&
        !(await this.status(workspace)).some((item) => item.state === "ready"))
    )
      return core(input, signal ?? new AbortController().signal)
    const entry = await this.session(workspace, threadId)
    return entry.session!.interceptTool(input, signal, core)
  }

  async offerAgent(
    workspace: string,
    threadId: string,
    input: ModObject,
    signal: AbortSignal,
    core: (input: ModObject, signal: AbortSignal) => Promise<ModJson> = async () => ({
      isOffered: true
    })
  ): Promise<ModObject> {
    if (
      !this.host.enabled(workspace) ||
      this.sources().length === 0 ||
      (!this.sessions.has(JSON.stringify([workspace, threadId])) &&
        !(await this.status(workspace)).some((item) => item.state === "ready"))
    )
      return (await core(input, signal)) as ModObject
    const entry = await this.session(workspace, threadId)
    if (!this.host.enabled(workspace) || this.sessions.get(JSON.stringify([workspace, threadId])) !== entry)
      throw new ModFunctionError("MODS_SCOPE_CHANGED")
    const safe = await this.host.publish(workspace, input, signal)
    const result = await entry.session!.offerAgent(safe as ModObject, signal, core)
    if (this.sessions.get(JSON.stringify([workspace, threadId])) !== entry)
      throw new ModFunctionError("MODS_SCOPE_CHANGED")
    return result
  }

  async classicEvent(
    workspace: string,
    threadId: string,
    event: string,
    input: ModObject,
    signal: AbortSignal,
    core: (input: ModObject, signal: AbortSignal) => Promise<ModObject> = async () => ({})
  ): Promise<ModObject> {
    const epoch = this.epoch(workspace)
    const assertCurrent = () => {
      signal.throwIfAborted()
      this.host.assertThread?.(workspace, threadId)
      if (this.closed || this.epoch(workspace) !== epoch)
        throw new ModFunctionError("MODS_SCOPE_CHANGED")
    }
    const runCore = async (input: ModObject, callSignal: AbortSignal) => {
      assertCurrent()
      callSignal.throwIfAborted()
      const result = await core(input, callSignal)
      callSignal.throwIfAborted()
      assertCurrent()
      return result
    }
    assertCurrent()
    if (!this.host.enabled(workspace) || this.sources().length === 0)
      return runCore(input, signal)
    const ready = this.sessions.has(JSON.stringify([workspace, threadId])) ||
      (await this.status(workspace)).some((item) => item.state === "ready")
    assertCurrent()
    if (!this.host.enabled(workspace)) throw new ModFunctionError("MODS_SCOPE_CHANGED")
    if (!ready) return runCore(input, signal)
    const entry = await this.session(workspace, threadId)
    assertCurrent()
    if (!this.host.enabled(workspace) || this.sessions.get(JSON.stringify([workspace, threadId])) !== entry)
      throw new ModFunctionError("MODS_SCOPE_CHANGED")
    const safe = await this.host.publish(workspace, input, signal)
    assertCurrent()
    const result = await entry.session!.classicEvent(event, safe as ModObject, signal, runCore)
    assertCurrent()
    if (this.sessions.get(JSON.stringify([workspace, threadId])) !== entry)
      throw new ModFunctionError("MODS_SCOPE_CHANGED")
    return result
  }

  async turnStart(
    workspace: string,
    threadId: string,
    input: FunctionTurnStart,
    signal: AbortSignal
  ): Promise<void> {
    if (!this.host.enabled(workspace) || this.sources().length === 0) return
    if (
      !this.sessions.has(JSON.stringify([workspace, threadId])) &&
      !(await this.status(workspace)).some((entry) => entry.state === "ready")
    )
      return
    const entry = await this.session(workspace, threadId)
    entry.completionProofs.clear()
    const safe = await this.host.publish(workspace, input as unknown as ModJson, signal)
    await entry.session!.turnStart(safe as unknown as FunctionTurnStart, signal)
  }

  async turnStep(
    workspace: string,
    threadId: string,
    input: ModObject,
    core: FunctionStreamOptions["core"],
    signal: AbortSignal
  ): Promise<ModHookStream> {
    if (!this.host.enabled(workspace) || this.sources().length === 0)
      return this.emptyStep(input, core, signal)
    const entry = await this.session(workspace, threadId)
    if (!this.host.enabled(workspace) || this.sessions.get(JSON.stringify([workspace, threadId])) !== entry)
      throw new ModFunctionError("MODS_SCOPE_CHANGED")
    const safe = await this.host.publish(workspace, input, signal)
    const publish = this.host.publish.bind(this.host)
    const assertEntry = (): void => {
      signal.throwIfAborted()
      this.host.assertThread?.(workspace, threadId)
      if (!this.host.enabled(workspace) || this.sessions.get(JSON.stringify([workspace, threadId])) !== entry)
        throw new ModFunctionError("MODS_SCOPE_CHANGED")
    }
    const protectedCore: FunctionStreamOptions["core"] = async function* (value, context) {
      assertEntry()
      const output = core(value, context)
      try {
        while (true) {
          const item = await output.next()
          if (item.done)
            return await publish(workspace, item.value ?? {}, context.signal)
          assertEntry()
          yield await publish(workspace, item.value, context.signal)
        }
      } finally {
        // Manual iteration must propagate consumer close and publication failure.
        // The model boundary owns provider cleanup and restoring its local selection.
        await output.return(null)
      }
    }
    return entry.session!.turnStep(safe as ModObject, protectedCore, signal)
  }

  private emptyStep(
    input: ModObject,
    core: FunctionStreamOptions["core"],
    signal: AbortSignal
  ): ModHookStream {
    return dispatchFunctionStream([], input, { signal, core })
  }

  async completionGate(
    workspace: string,
    threadId: string,
    context: () => ModObject
  ): Promise<CompletionGate | undefined> {
    const key = JSON.stringify([workspace, threadId])
    const entry = this.sessions.get(key)
    if (!entry || !this.host.enabled(workspace)) return undefined
    await entry.loading
    if (this.sessions.get(key) !== entry) throw new ModFunctionError("MODS_SCOPE_CHANGED")
    const completionProviders = new Set(
      entry
        .session!.plugins.filter((plugin) =>
          plugin.guest.registrations.some(
            (registration) => registration.pattern === "completion.check"
          )
        )
        .map((plugin) => plugin.name)
    )
    const first = context()
    const turnId = typeof first.turnId === "string" ? first.turnId : ""
    const runId = typeof first.runId === "string" ? first.runId : undefined
    const assertLive = (): void => {
      if (this.sessions.get(key) !== entry || !this.host.enabled(workspace))
        throw new ModFunctionError("MODS_SCOPE_CHANGED")
      this.host.assertThread?.(workspace, threadId)
      for (const snapshot of entry.snapshots.values()) this.store.assertGrant(snapshot.grant)
    }
    const configuration = (): ModObject =>
      Object.fromEntries(
        [...entry.snapshots.keys()].sort().map((name) => {
          const namespace = JSON.stringify([workspace, name])
          return [
            name,
            Object.fromEntries(
              ["review-mode", "review-target", "completion-config"].map((key) => [
                key,
                this.store.functionState.get(namespace, key) ?? null
              ])
            )
          ]
        })
      )
    const configured = new Map(
      [...entry.snapshots.keys()].map((name) => {
        const raw = this.store.functionState.get(
          JSON.stringify([workspace, name]),
          "completion-config"
        )
        if (raw === undefined || raw === null) return [name, undefined] as const
        try {
          return [name, parseCompletionPolicy(raw)] as const
        } catch {
          throw new ModFunctionError("MODS_COMPLETION_CONFIG_INVALID")
        }
      })
    )
    // An explicitly persisted off policy removes the gate. Legacy plugins without this
    // setting retain their existing completion hook behavior.
    const active = [...configured].filter(([name, policy]) =>
      policy ? policy.mode !== "off" : completionProviders.has(name)
    )
    if (active.length === 0) return undefined
    const policyFor = (name: string) => configured.get(name)
    const policies = active
      .map(([, policy]) => policy)
      .filter((policy): policy is NonNullable<typeof policy> => !!policy)
    const reportOnly = active.every(([, policy]) => policy?.mode === "report")
    const budgets = new Map<string, CompletionBudget>()
    const mandatory = policies.filter((policy) => policy.mode !== "report")
    const sharedBudget = mandatory.length
      ? new CompletionBudget(
          Math.min(...mandatory.map((policy) => policy.modelTokenBudget)),
          Math.min(...mandatory.map((policy) => policy.timeoutMs))
        )
      : undefined
    for (const [name, policy] of active)
      if (policy)
        budgets.set(
          name,
          policy.mode === "report"
            ? new CompletionBudget(policy.modelTokenBudget, policy.timeoutMs)
            : sharedBudget!
        )
    const initialConfig = JSON.stringify(configuration())
    const capture = async (signal: AbortSignal): Promise<CompletionEvidenceBinding> => {
      assertLive()
      const scope = this.host.fileScope?.(workspace, threadId)
      const pluginDigests: Record<string, string> = {}
      for (const [name, snapshot] of entry.snapshots) {
        const current = await compileFunctionPlugin(snapshot.compiled.root)
        if (current.digest !== snapshot.compiled.digest) throw Error("MODS_PLUGIN_CHANGED")
        pluginDigests[name] = current.digest
      }
      const config = configuration()
      if (JSON.stringify(config) !== initialConfig) throw Error("COMPLETION_CONFIG_CHANGED")
      const paths = [...entry.snapshots.keys()].flatMap((name) => {
        const policy = policyFor(name)
        if (!policy || policy.mode === "off") return []
        if (policy.scope === "file") return policy.target ? [policy.target] : []
        if (policy.scope === "feature")
          return [
            ...(policy.feature ? [`.autobizdevops/features/${policy.feature}`] : []),
            ...(policy.target ? [policy.target] : [])
          ]
        if (policy.scope === "project") return ["."]
        return []
      })
      return captureCompletionBinding({
        workspace: scope?.workspace ?? workspace,
        threadId,
        turnId,
        runId,
        pluginDigests,
        runtimeGeneration: entry.generation,
        config,
        paths,
        signal,
        excludePaths: this.store.evidenceExcludedPaths,
        assertLive: () => {
          assertLive()
          scope?.assertLive()
        }
      })
    }
    let pending: Promise<unknown> | undefined
    // No cached PASS is reused. Each revision and duplicate delivery gets a fresh binding.
    const gate: CompletionGate = (input) => {
      if (pending) return Promise.reject(Error("COMPLETION_CHECK_IN_PROGRESS"))
      const run = async () => {
        const { signal: originalSignal, revisionAttempts, maxRevisionAttempts } = input
        const deadline = new AbortController()
        const signal = AbortSignal.any([originalSignal, deadline.signal])
        let timer: ReturnType<typeof setTimeout> | undefined
        let binding: CompletionEvidenceBinding | undefined
        const attempt = randomUUID()
        const record = (
          phase: CompletionEvidenceRecord["phase"],
          status: CompletionEvidenceRecord["status"],
          detail?: ModJson
        ) => {
          if (!binding) return
          this.store.saveCompletionEvidence({
            id: randomUUID(),
            idempotencyKey: `${attempt}:${phase}:${status}:${randomUUID()}`,
            workspace,
            threadId,
            turnId,
            runId: binding.runId,
            phase,
            status,
            binding,
            ...(detail === undefined ? {} : { detail }),
            at: Date.now()
          })
          this.host.changed(threadId)
        }
        try {
          originalSignal.throwIfAborted()
          assertLive()
          if (sharedBudget) {
            timer = setTimeout(
              () => deadline.abort(new ModFunctionError("MODS_COMPLETION_TIMEOUT")),
              sharedBudget.remainingMs()
            )
            timer.unref()
          }
          binding = await capture(signal)
          signal.throwIfAborted()
          record("check.started", "running", {
            attempt,
            revisionAttempts,
            maxRevisionAttempts,
            rules: active.map(([plugin, policy]) => ({
              plugin,
              ...JSON.parse(JSON.stringify(policy ?? { mode: "legacy", checks: ["code-review"] }))
            }))
          })
          for (const [name, policy] of active) {
            if (!policy?.checks.includes("code-review") || completionProviders.has(name)) continue
            const reason = `COMPLETION_CHECK_UNAVAILABLE: ${name}: code-review`
            record("validator.result", "block", {
              plugin: name,
              kind: "code-review",
              reason,
              businessAccepted: false
            })
            if (policy.mode !== "report") {
              record("check.result", "block", { reason, businessAccepted: false })
              return { decision: "block", reason }
            }
          }
          const safe = await this.host.publish(
            workspace,
            {
              ...context(),
              revisionAttempts,
              maxRevisionAttempts,
              evidenceId: attempt,
              inputFingerprint: bindingFingerprint(binding),
              completionFiles: binding.files.map((file) => ({ ...file })),
              ...(binding.diffFiles ? { completionDiffFiles: binding.diffFiles } : {})
            },
            signal
          )
          const result = await entry.session!.checkCompletion(safe as ModObject, signal, {
            policies: configured,
            budgets,
            evidence: (plugin, detail) =>
              record("validator.result", detail.decision === "pass" ? "pass" : "block", {
                plugin,
                ...detail
              })
          })
          signal.throwIfAborted()
          assertLive()
          for (const kind of ["unit-test", "e2e"] as const) {
            const projectPolicies = policies.filter((policy) => policy.checks.includes(kind))
            if (!projectPolicies.length) continue
            const mandatoryPolicies = projectPolicies.filter((policy) => policy.mode !== "report")
            const selectedPolicies = mandatoryPolicies.length ? mandatoryPolicies : projectPolicies
            const remaining = Math.min(
              ...active
                .filter(([, policy]) => policy && selectedPolicies.includes(policy))
                .map(([name]) => budgets.get(name)!.deadline - Date.now())
            )
            if (remaining <= 0) {
              record("validator.result", "block", {
                kind,
                reason: "MODS_COMPLETION_TIMEOUT",
                businessAccepted: false
              })
              if (mandatoryPolicies.length) throw new ModFunctionError("MODS_COMPLETION_TIMEOUT")
              continue
            }
            const check = await runProjectCheck(
              this.host.fileScope?.(workspace, threadId)?.workspace ?? workspace,
              kind as ProjectCheckKind,
              signal,
              remaining
            )
            signal.throwIfAborted()
            sharedBudget?.assert()
            record("validator.result", check.passed ? "pass" : "block", {
              kind,
              passed: check.passed,
              exitCode: check.exitCode,
              outputFingerprint: check.outputFingerprint,
              ...(check.reason ? { reason: check.reason } : {})
            })
            if (
              !check.passed &&
              projectPolicies.some((policy) => policy.mode === "check" || policy.mode === "repair")
            ) {
              const mandatory = projectPolicies.filter((policy) => policy.mode !== "report")
              const repairing = mandatory.every((policy) => policy.mode === "repair")
              const decision =
                repairing &&
                revisionAttempts <
                  Math.min(maxRevisionAttempts, ...mandatory.map((policy) => policy.maxRepairs))
                  ? "revise"
                  : "block"
              record("check.result", decision, {
                reason: check.reason ?? `PROJECT_${kind.toUpperCase()}_FAILED`,
                source: "host-project-check",
                businessAccepted: false
              })
              return { decision, reason: check.reason ?? `PROJECT_${kind.toUpperCase()}_FAILED` }
            }
          }
          const validatorPolicies = policies.filter((policy) =>
            policy.checks.includes("autobiz-validator")
          )
          for (const feature of new Set(validatorPolicies.map((policy) => policy.feature))) {
            const selectedPolicies = validatorPolicies.filter(
              (policy) => policy.feature === feature
            )
            const mandatoryPolicies = selectedPolicies.filter((policy) => policy.mode !== "report")
            const timedPolicies = mandatoryPolicies.length ? mandatoryPolicies : selectedPolicies
            const remaining = Math.min(
              ...active
                .filter(([, policy]) => policy && timedPolicies.includes(policy))
                .map(([name]) => budgets.get(name)!.deadline - Date.now())
            )
            if (remaining <= 0) {
              record("validator.result", "block", {
                kind: "autobiz-validator",
                reason: "MODS_COMPLETION_TIMEOUT",
                businessAccepted: false
              })
              if (mandatoryPolicies.length) throw new ModFunctionError("MODS_COMPLETION_TIMEOUT")
              continue
            }
            const validator = await runAutobizValidator(
              this.host.fileScope?.(workspace, threadId)?.workspace ?? workspace,
              feature,
              signal,
              remaining
            )
            signal.throwIfAborted()
            sharedBudget?.assert()
            record("validator.result", validator.passed ? "pass" : "block", {
              ...validator,
              attempt
            } as unknown as ModJson)
            const mandatory = selectedPolicies.filter((policy) => policy.mode !== "report")
            if (!validator.passed && mandatory.length) {
              const repairing = mandatory.every((policy) => policy.mode === "repair")
              const decision =
                repairing &&
                revisionAttempts <
                  Math.min(maxRevisionAttempts, ...mandatory.map((p) => p.maxRepairs))
                  ? "revise"
                  : "block"
              record("check.result", decision, {
                reason: validator.reason,
                source: "host-autobiz-validator",
                businessAccepted: false
              })
              return { decision, reason: `AUTOBIZ_VALIDATOR_FAILED: ${validator.reason}` }
            }
          }
          if (!sameCompletionBinding(binding, await capture(signal))) {
            record("invalidated", "stale", { reason: "input-changed" })
            if (reportOnly) return { decision: "pass" }
            return { decision: "block", reason: "COMPLETION_EVIDENCE_STALE" }
          }
          signal.throwIfAborted()
          sharedBudget?.assertSettled()
          if (reportOnly) {
            record("check.result", "pass", {
              ...result,
              decision: "pass",
              source: "guest-opinion-report",
              businessAccepted: false,
              reportedDecision: result.decision
            })
            return { decision: "pass" }
          }
          record("check.result", result.decision, {
            ...result,
            source: "guest-opinion",
            businessAccepted: false
          })
          if (
            result.decision === "pass" &&
            validatorPolicies.some((policy) => policy.mode === "check" || policy.mode === "repair")
          ) {
            if (entry.completionProofs.size >= 32) entry.completionProofs.clear()
            entry.completionProofs.set(attempt, capture)
          }
          if (result.decision === "revise")
            record("repair.attempt", "revise", { revisionAttempts: revisionAttempts + 1 })
          return result
        } catch (error) {
          const reason = deadline.signal.aborted
            ? "MODS_COMPLETION_TIMEOUT"
            : error instanceof Error
              ? error.message.slice(0, 2048)
              : "COMPLETION_CHECK_FAILED"
          record("check.result", originalSignal.aborted ? "cancelled" : "error", { error: reason })
          originalSignal.throwIfAborted()
          assertLive()
          if (reason.startsWith("MODS_COMPLETION_"))
            return reportOnly ? { decision: "pass" } : { decision: "block", reason }
          throw error
        } finally {
          if (timer) clearTimeout(timer)
        }
      }
      pending = run().finally(() => {
        pending = undefined
      })
      return pending
    }
    if (sharedBudget) bindCompletionGateBudget(gate, sharedBudget)
    return gate
  }
  async turnComplete(
    workspace: string,
    threadId: string,
    input: FunctionTurnComplete,
    signal: AbortSignal,
    anchorMessageId?: string
  ): Promise<FunctionTurnResult> {
    // A terminal event belongs to the already loaded session; it must not start a new generation.
    const entry = this.sessions.get(JSON.stringify([workspace, threadId]))
    if (!entry || !this.host.enabled(workspace))
      return { text: input.answer, ...(input.usage ? { usage: input.usage } : {}) }
    await entry.loading
    if (this.sessions.get(JSON.stringify([workspace, threadId])) !== entry)
      throw new ModFunctionError("MODS_SCOPE_CHANGED")
    const safe = await this.host.publish(workspace, input as unknown as ModJson, signal)
    const result = await entry.session!.turnComplete(
      safe as unknown as FunctionTurnComplete,
      signal
    )
    if (this.sessions.get(JSON.stringify([workspace, threadId])) !== entry)
      throw new ModFunctionError("MODS_SCOPE_CHANGED")
    if (
      !input.agentId &&
      entry.turnNotices.append(
        input.turnId,
        (safe as unknown as FunctionTurnComplete).answer,
        result.text,
        anchorMessageId
      )
    )
      this.host.changed(threadId)
    return result
  }

  async turnNotices(workspace: string, threadId: string): Promise<FunctionTurnNotice[]> {
    this.host.assertThread?.(workspace, threadId)
    const entry = this.sessions.get(JSON.stringify([workspace, threadId]))
    if (!entry || !this.host.enabled(workspace)) return []
    for (const snapshot of entry.snapshots.values()) this.store.assertGrant(snapshot.grant)
    const published = await this.host.publish(
      workspace,
      entry.turnNotices.snapshot() as unknown as ModJson,
      new AbortController().signal
    )
    this.host.assertThread?.(workspace, threadId)
    if (this.sessions.get(JSON.stringify([workspace, threadId])) !== entry)
      throw new ModFunctionError("MODS_SCOPE_CHANGED")
    for (const snapshot of entry.snapshots.values()) this.store.assertGrant(snapshot.grant)
    return published as unknown as FunctionTurnNotice[]
  }

  async registeredTools(workspace: string, threadId: string): Promise<RegisteredFunctionTool[]> {
    if (
      !this.host.enabled(workspace) ||
      this.sources().length === 0 ||
      (!this.sessions.has(JSON.stringify([workspace, threadId])) &&
        !(await this.status(workspace)).some((item) => item.state === "ready"))
    )
      return []
    const entry = await this.session(workspace, threadId)
    return entry.session!.registeredTools()
  }

  async interceptToolCheck(
    workspace: string,
    threadId: string,
    input: ModObject,
    signal: AbortSignal | undefined,
    core: (input: ModObject, signal: AbortSignal) => Promise<ModObject>,
    origin?: ModOrigin
  ): Promise<ToolPermissionResult> {
    // A permission check must not start a session (whose startup hooks may perform work).
    const session = this.sessions.get(JSON.stringify([workspace, threadId]))?.session
    if (!session || !this.host.enabled(workspace))
      return (await core(input, signal ?? new AbortController().signal)) as ToolPermissionResult
    return session.checkTool(input, signal, core, origin)
  }

  hasToolCheck(workspace: string, threadId: string): boolean {
    const session = this.sessions.get(JSON.stringify([workspace, threadId]))?.session
    return !!session?.plugins.some((plugin) =>
      plugin.guest.registrations.some((registration) =>
        matchesEventPattern(registration.pattern, "tool.check")
      )
    )
  }

  async feedback(workspace: string, threadId: string): Promise<import("../../../shared/mods/v2/ui-feedback").FunctionFeedbackEntry[]> {
    this.host.assertThread?.(workspace, threadId)
    if (!this.host.enabled(workspace)) return []
    const entry = this.sessions.get(JSON.stringify([workspace, threadId]))
    if (!entry) return []
    await entry.loading
    const result = await entry.session!.feedbackSnapshot()
    this.host.assertThread?.(workspace, threadId)
    if (!this.host.enabled(workspace) || this.sessions.get(JSON.stringify([workspace, threadId])) !== entry)
      throw new ModFunctionError("MODS_SCOPE_CHANGED")
    return result
  }

  async panes(workspace: string, threadId: string): Promise<FunctionPaneSnapshot[]> {
    // Merely mounting the renderer must not allocate or restart a plugin session.
    if (!this.host.enabled(workspace)) return []
    const entry = this.sessions.get(JSON.stringify([workspace, threadId]))
    if (!entry) return []
    await entry.loading
    return entry.session!.panes.snapshot()
  }

  async act(
    workspace: string,
    threadId: string,
    action: FunctionUiAction
  ): Promise<void | import("../../../shared/mods/v2/ui").FunctionFocusResult> {
    const entry = this.sessions.get(JSON.stringify([workspace, threadId]))
    if (!entry || !this.host.enabled(workspace)) throw new ModFunctionError("MODS_UI_STALE_ACTION")
    await entry.loading
    return entry.session!.panes.act(action)
  }

  async siteMount(
    workspace: string,
    threadId: string,
    component: FunctionUiSite
  ): Promise<string | null> {
    if (this.closed || !this.host.enabled(workspace) || this.sources().length === 0) return null
    functionUiSite(component)
    this.host.assertThread?.(workspace, threadId)
    if (this.pendingSiteMounts.size >= 32) throw new ModFunctionError("MODS_UI_SITE_MOUNT_CAPACITY")
    const request = { workspace, threadId, valid: true }
    const current = (): boolean => request.valid && !this.closed && this.host.enabled(workspace)
    this.pendingSiteMounts.add(request)
    try {
      const key = JSON.stringify([workspace, threadId])
      // A visible site is an entry point: approved modules must start without a command warmup.
      // Inspect grants before allocating a runtime, and retain cancellation during discovery.
      if (
        !this.sessions.has(key) &&
        !(await this.status(workspace)).some((item) => item.state === "ready")
      )
        return null
      if (!current()) return null
      this.host.assertThread?.(workspace, threadId)
      const entry = await this.session(workspace, threadId)
      if (!current() || this.sessions.get(key) !== entry || entry.session!.plugins.length === 0)
        return null
      const owner = await entry.session!.sites.mount(component)
      return current() && this.sessions.get(key) === entry ? owner : null
    } finally {
      this.pendingSiteMounts.delete(request)
    }
  }

  async siteRender(
    workspace: string,
    threadId: string,
    owner: string,
    props: ModObject
  ): Promise<FunctionPaneSnapshot | null> {
    if (!this.host.enabled(workspace)) return null
    const entry = this.sessions.get(JSON.stringify([workspace, threadId]))
    if (!entry) return null
    await entry.loading
    return entry.session!.sites.render(owner, props)
  }

  async siteUnmount(workspace: string, threadId: string, owner: string): Promise<void> {
    const entry = this.sessions.get(JSON.stringify([workspace, threadId]))
    if (!entry || !this.host.enabled(workspace)) return
    await entry.loading
    await entry.session!.sites.unmount(owner)
  }

  async siteAct(
    workspace: string,
    threadId: string,
    owner: string,
    action: FunctionUiAction
  ): Promise<void | import("../../../shared/mods/v2/ui").FunctionFocusResult> {
    const entry = this.sessions.get(JSON.stringify([workspace, threadId]))
    if (!entry || !this.host.enabled(workspace)) throw new ModFunctionError("MODS_UI_SITE_CLOSED")
    await entry.loading
    return entry.session!.sites.act(owner, action)
  }

  async clientAct(
    workspace: string,
    threadId: string,
    action: FunctionClientAction
  ): Promise<void> {
    const entry = this.sessions.get(JSON.stringify([workspace, threadId]))
    if (!entry || !this.host.enabled(workspace)) throw new ModFunctionError("MODS_CLIENT_UNMOUNTED")
    await entry.loading
    await entry.session!.clients.act(action)
  }

  async runCommand(
    workspace: string,
    threadId: string,
    expected: ModCommandDescriptor,
    args: string,
    signal: AbortSignal
  ): Promise<ModProjection> {
    const entry = await this.session(workspace, threadId)
    const current = (await this.commands(workspace, threadId)).find(
      (c) => c.command === expected.command
    )
    if (
      !current ||
      current.digest !== expected.digest ||
      current.grantEpoch !== expected.grantEpoch ||
      current.workspaceEpoch !== expected.workspaceEpoch ||
      current.modId !== expected.modId
    )
      throw new ModFunctionError("MODS_COMMAND_STALE")
    const answer = await entry.session!.run(current.command, args, signal)
    return { text: typeof answer.text === "string" ? answer.text : "" }
  }

  close(): void {
    this.closed = true
    for (const workspace of new Set([...this.sessions.values()].map((entry) => entry.workspace)))
      this.invalidate(workspace)
  }
}
