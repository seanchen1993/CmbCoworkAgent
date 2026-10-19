import { createHash, randomUUID } from "node:crypto"
import type { FunctionConfigValue } from "../../../shared/mods/v2/config"
import type { FunctionUserConfigView } from "../../../shared/mods/v2/user-config-view"
import type { DevelopmentConfigurationRequest } from "../../../shared/mods/development"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { DevelopmentContext } from "./development-service"
import type { AuthoringAtomicSettings } from "./authoring-config-snapshot"

type Binding = { pluginId: string; digest: string; revision: number }
type ConfigOperation = (context: DevelopmentContext, pluginId: string,
  signal: AbortSignal, guard: () => void) => Promise<FunctionUserConfigView>

/** Coordinates the existing user-config store. Requests contain references, never credentials. */
export class CreatorUserConfigService {
  constructor(private readonly deps: {
    settings: AuthoringAtomicSettings
    context(threadId: string): DevelopmentContext
    normalizeWorkspace?(workspace: string): string
    read: ConfigOperation
    save(context: DevelopmentContext, binding: Binding, key: string, value: FunctionConfigValue,
      signal: AbortSignal, guard: () => void): Promise<FunctionUserConfigView>
    reset(context: DevelopmentContext, binding: Binding, key: string,
      signal: AbortSignal, guard: () => void): Promise<FunctionUserConfigView>
    apply(context: DevelopmentContext, binding: Binding,
      signal: AbortSignal, guard: () => void): Promise<FunctionUserConfigView>
    changed(threadId: string): void
  }) {}

  private access(threadId: string, workspace?: string, assertTurn: () => void = () => {}) {
    const context = this.deps.context(threadId)
    const guard = () => {
      context.assertCurrent()
      assertTurn()
      if (workspace !== undefined &&
        (this.deps.normalizeWorkspace?.(workspace) ?? workspace) !== context.scope.workspace)
        throw new ModFunctionError("MODS_CONFIG_SCOPE_CHANGED")
    }
    guard()
    return { context, guard }
  }

  private requestKey(context: DevelopmentContext) {
    return "creator-user-config-request:" + createHash("sha256")
      .update(JSON.stringify(context.scope)).digest("hex")
  }

  /** Rehydrating a native form grants no approval and never replays a save/apply operation. */
  status(threadId: string): DevelopmentConfigurationRequest | undefined {
    try {
      const { context, guard } = this.access(threadId)
      const raw = this.deps.settings.getSetting(this.requestKey(context), "")
      if (!raw) return undefined
      if (raw.length > 8192) return undefined
      const request = JSON.parse(raw) as DevelopmentConfigurationRequest
      if (typeof request.id !== "string" || request.id.length > 100 ||
        typeof request.pluginId !== "string" || request.pluginId.length > 256 ||
        typeof request.plugin !== "string" || request.plugin.length > 256 ||
        !/^[a-f0-9]{64}$/.test(request.digest) ||
        !Number.isSafeInteger(request.revision) || request.revision < 0 ||
        typeof request.key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(request.key) ||
        typeof request.label !== "string" || request.label.length > 256 ||
        typeof request.sensitive !== "boolean" ||
        !["string", "boolean", "number", "directory", "file"].includes(request.type) ||
        request.workspace !== context.scope.workspace)
        return undefined
      guard()
      return { id: request.id, workspace: request.workspace, pluginId: request.pluginId,
        plugin: request.plugin, digest: request.digest, revision: request.revision,
        key: request.key, label: request.label, sensitive: request.sensitive, type: request.type }
    } catch { return undefined }
  }

  private safe(view: FunctionUserConfigView): FunctionUserConfigView {
    return { ...view, fields: view.fields.map(field => {
      const result = { ...field }
      // A second defensive boundary prevents future manager changes leaking secret values.
      if (field.sensitive) {
        delete result.value
        delete result.effectiveValue
        delete result.options
      }
      return result
    }) }
  }

  async inspect(threadId: string, workspace: string, pluginId: string,
    signal: AbortSignal, assertTurn: () => void) {
    const { context, guard } = this.access(threadId, workspace, assertTurn)
    const view = await this.deps.read(context, pluginId, signal, guard)
    guard()
    const request = this.status(threadId)
    // A saved-revision change invalidates the old input request; inspect reports actual fields,
    // rather than treating the old card as proof that its particular field was configured.
    if (request?.pluginId === pluginId && request.digest === view.digest &&
      request.revision < view.savedRevision) {
      const settingKey = this.requestKey(context)
      const raw = this.deps.settings.getSetting(settingKey, "")
      guard()
      if (raw && JSON.parse(raw).id === request.id &&
        this.deps.settings.compareAndSetSetting(settingKey, raw, ""))
        this.deps.changed(threadId)
    }
    return this.safe(view)
  }

  async change(threadId: string, workspace: string, binding: Binding,
    action: "set" | "reset" | "request_input" | "apply", key: string | undefined,
    value: FunctionConfigValue | undefined, signal: AbortSignal, assertTurn: () => void) {
    const { context, guard } = this.access(threadId, workspace, assertTurn)
    const view = await this.deps.read(context, binding.pluginId, signal, guard)
    guard()
    if (view.workspace !== context.scope.workspace || view.digest !== binding.digest)
      throw new ModFunctionError("MODS_CONFIG_SOURCE_CHANGED")
    if (view.savedRevision !== binding.revision)
      throw new ModFunctionError("MODS_CONFIG_VALUE_CHANGED")
    if (action === "apply") {
      const result = await this.deps.apply(context, binding, signal, guard)
      guard()
      return this.safe(result)
    }
    const field = view.fields.find(item => item.key === key)
    if (!field || !field.supported) throw new ModFunctionError("MODS_USER_CONFIG_INVALID")
    if (action === "request_input") {
      const request: DevelopmentConfigurationRequest = {
        id: randomUUID(), workspace: context.scope.workspace, pluginId: view.pluginId, plugin: view.plugin,
        digest: view.digest, revision: view.savedRevision, key: field.key,
        label: field.label, sensitive: field.sensitive === true, type: field.type
      }
      const settingKey = this.requestKey(context)
      const absent = "\0creator-config-absent"
      const before = this.deps.settings.getSetting(settingKey, absent)
      guard()
      if (!this.deps.settings.compareAndSetSetting(settingKey, before === absent ? undefined : before,
        JSON.stringify(request))) throw new ModFunctionError("MODS_CONFIG_VALUE_CHANGED")
      this.deps.changed(threadId)
      return { state: "needs-input" as const, request }
    }
    // Paths must come from the native chooser/editor; secret values never enter tool arguments.
    if (field.sensitive || field.type === "file" || field.type === "directory")
      throw new ModFunctionError("MODS_USER_CONFIG_DIALOG_REQUIRED")
    const result = action === "reset"
      ? await this.deps.reset(context, binding, field.key, signal, guard)
      : value === undefined
        ? (() => { throw new ModFunctionError("MODS_CONFIG_ARGUMENTS") })()
        : await this.deps.save(context, binding, field.key, value, signal, guard)
    guard()
    return this.safe(result)
  }
}

let service: CreatorUserConfigService | undefined
export function setCreatorUserConfigService(value: CreatorUserConfigService | undefined) {
  service = value
}
export function getCreatorUserConfigService() { return service }
