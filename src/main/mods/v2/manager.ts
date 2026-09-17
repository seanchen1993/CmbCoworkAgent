import type { FunctionSessionReadMethod } from "../../../shared/mods/v2/session"
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { randomInt } from "node:crypto"
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
import { CLIENT_BOOTSTRAP } from "./client-bootstrap"
import type { FunctionToolInfo, RegisteredFunctionTool } from "../../../shared/mods/v2/tools"
import type { ToolPermissionResult } from "../../../shared/tool-permission"
import type { ModOrigin } from "../../../shared/mods/v2/contracts"

interface Snapshot {
  compiled: CompiledFunctionPlugin
  grant: ModGrant
}
interface FunctionConnection {
  load(code: string, options: CompiledFunctionPlugin["options"]): Promise<FunctionGuest>
  stop(): void
}
interface SessionEntry {
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
  readSession?(
    workspace: string,
    threadId: string,
    method: FunctionSessionReadMethod,
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
    for (const [key, entry] of this.sessions) {
      if (entry.workspace !== workspace) continue
      this.sessions.delete(key)
      void entry.session?.close()
      entry.client.stop()
      this.host.changed(entry.threadId)
    }
  }

  closeThread(threadId: string): void {
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
          readSession: async (method, signal) => {
            assertLive()
            if (!this.host.readSession) throw new ModFunctionError("MODS_SESSION_UNAVAILABLE")
            const value = await this.host.readSession(workspace, threadId, method, signal)
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

  async panes(workspace: string, threadId: string): Promise<FunctionPaneSnapshot[]> {
    // Merely mounting the renderer must not allocate or restart a plugin session.
    if (!this.host.enabled(workspace)) return []
    const entry = this.sessions.get(JSON.stringify([workspace, threadId]))
    if (!entry) return []
    await entry.loading
    return entry.session!.panes.snapshot()
  }

  async act(workspace: string, threadId: string, action: FunctionUiAction): Promise<void> {
    const entry = this.sessions.get(JSON.stringify([workspace, threadId]))
    if (!entry || !this.host.enabled(workspace)) throw new ModFunctionError("MODS_UI_STALE_ACTION")
    await entry.loading
    await entry.session!.panes.act(action)
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
