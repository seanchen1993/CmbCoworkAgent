import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { ModControlStore, ModGrant } from "../control-store"
import type { ModPluginSource } from "../manager"
import type { ModCommandDescriptor, ModJson, ModProjection } from "../../../shared/mods/types"
import type { FunctionPluginStatus } from "../../../shared/mods/v2/commands"
import { ModFunctionError, type FunctionGuest } from "../../../shared/mods/v2/contracts"
import { FunctionRuntimeClient } from "./runtime-client"
import { compileFunctionPlugin, type CompiledFunctionPlugin } from "./loader"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import type { FunctionPlugin } from "./dispatcher"
import { normalizePluginRelativePath, readPluginManifest } from "../../plugins/manifest"
import { resolveModFile } from "../loader"

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
}

/** Grants bind a complete source snapshot; a live session never rereads mutable plugin source. */
export class FunctionModsManager {
  private readonly epochs = new Map<string, number>()
  private readonly sessions = new Map<string, SessionEntry>()
  private closed = false

  constructor(
    private readonly store: ModControlStore,
    private readonly host: FunctionManagerHost,
    private readonly createClient: () => FunctionConnection = () =>
      new FunctionRuntimeClient(join(__dirname, "function-mod-host.js"))
  ) {}

  private epoch(workspace: string): number {
    return this.epochs.get(workspace) ?? 0
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
      client: this.createClient(),
      snapshots: new Map(),
      loading: Promise.resolve(undefined as unknown as FunctionSession)
    }
    const current = entry
    this.sessions.set(key, current)
    const assertLive = (plugin?: FunctionPlugin): void => {
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
          assertLive,
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
        workspaceEpoch: entry.epoch,
        immediate: command.immediate,
        isHidden: command.isHidden,
        argumentHint: command.argumentHint
      }
    })
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
