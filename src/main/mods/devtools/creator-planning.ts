import { createHash } from "node:crypto"
import type {
  CreatorPlanningCatalog,
  CreatorPlanningReference,
  CreatorPlanningStatus
} from "../../../shared/mods/creator-planning"
import type { FunctionPluginStatus } from "../../../shared/mods/v2/commands"
import type { AuthoringAtomicSettings } from "./authoring-config-snapshot"
import type { DevelopmentContext } from "./development-service"

type RecordValue = { revision: number; selected?: CreatorPlanningReference }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const key = (context: DevelopmentContext) =>
  "creator:planning:" + createHash("sha256").update(JSON.stringify(context.scope)).digest("hex")
const fallback =
  "选中的规划策略当前未通过核对，已使用原生创造者。停止、安装核对和恢复入口仍可使用；如需再次使用策略，请重新验证。"
export class CreatorPlanningService {
  private readonly diagnostics = new Map<string, string>()
  private readonly pending = new Set<string>()
  private rememberFallback(scopeKey: string): void {
    this.diagnostics.delete(scopeKey)
    this.diagnostics.set(scopeKey, fallback)
    if (this.diagnostics.size > 64) this.diagnostics.delete(this.diagnostics.keys().next().value!)
  }
  constructor(
    private readonly deps: {
      settings: AuthoringAtomicSettings
      current(threadId: string, workspace?: string): DevelopmentContext
      catalog(workspace: string): Promise<FunctionPluginStatus[]>
      invoke(
        workspace: string,
        selected: CreatorPlanningReference,
        signal: AbortSignal,
        guard: () => void
      ): Promise<string>
      changed(threadId: string): void
    }
  ) {}
  private read(context: DevelopmentContext): { raw: string; record: RecordValue } {
    const raw = this.deps.settings.getSetting(key(context), "")
    if (!raw) return { raw, record: { revision: 0 } }
    try {
      if (raw.length > 2048) throw Error("size")
      const record = JSON.parse(raw) as RecordValue
      if (
        !record ||
        typeof record !== "object" ||
        Array.isArray(record) ||
        Object.keys(record).some((field) => field !== "revision" && field !== "selected") ||
        !Number.isSafeInteger(record.revision) ||
        record.revision < 0 ||
        (record.selected !== undefined &&
          (!record.selected ||
            typeof record.selected !== "object" ||
            Array.isArray(record.selected) ||
            Object.keys(record.selected).some(
              (field) => !["pluginId", "name", "digest"].includes(field)
            ) ||
            !/^[a-f0-9]{64}$/.test(record.selected.digest) ||
            typeof record.selected.pluginId !== "string" ||
            typeof record.selected.name !== "string"))
      )
        throw Error("shape")
      return { raw, record }
    } catch {
      this.rememberFallback(key(context))
      return { raw, record: { revision: 0 } }
    }
  }
  private async available(context: DevelopmentContext, selected: CreatorPlanningReference) {
    const list = await this.deps.catalog(context.scope.workspace)
    context.assertCurrent()
    return list.some(
      (item) =>
        item.pluginId === selected.pluginId &&
        item.name === selected.name &&
        item.digest === selected.digest &&
        item.state === "ready"
    )
  }
  observed(context: DevelopmentContext): CreatorPlanningStatus {
    const { record } = this.read(context),
      diagnostic = this.diagnostics.get(key(context))
    return {
      revision: record.revision,
      state: diagnostic ? "fallback" : record.selected ? "ready" : "native",
      ...(record.selected ? { selected: record.selected } : {}),
      ...(diagnostic ? { diagnostic } : {})
    }
  }
  async catalog(threadId: string, workspace?: string): Promise<CreatorPlanningCatalog> {
    const context = this.deps.current(threadId, workspace)
    const { record } = this.read(context)
    let candidates: CreatorPlanningCatalog["candidates"] = []
    try {
      candidates = (await this.deps.catalog(context.scope.workspace))
        .filter((item) => !!item.digest)
        .map((item) => ({
          pluginId: item.pluginId,
          name: item.name,
          digest: item.digest!,
          state: item.state
        }))
      context.assertCurrent()
    } catch {
      context.assertCurrent()
    }
    const usable =
      record.selected &&
      candidates.some(
        (item) =>
          same(
            { pluginId: item.pluginId, name: item.name, digest: item.digest },
            record.selected
          ) && item.state === "ready"
      )
    const diagnostic =
      this.diagnostics.get(key(context)) ?? (record.selected && !usable ? fallback : undefined)
    if (diagnostic) this.rememberFallback(key(context))
    const status: CreatorPlanningStatus = {
      revision: record.revision,
      state: diagnostic ? "fallback" : record.selected ? "ready" : "native",
      ...(record.selected ? { selected: record.selected } : {}),
      ...(diagnostic ? { diagnostic } : {})
    }
    return { status, candidates }
  }
  async select(
    threadId: string,
    workspace: string,
    expectedRevision: number,
    selected: CreatorPlanningReference | null
  ): Promise<CreatorPlanningCatalog> {
    const context = this.deps.current(threadId, workspace),
      scopeKey = key(context)
    const { raw, record } = this.read(context)
    if (this.pending.has(scopeKey)) throw Error("CREATOR_PLANNING_BUSY")
    if (record.revision !== expectedRevision) throw Error("CREATOR_PLANNING_REVISION_CHANGED")
    this.pending.add(scopeKey)
    try {
      if (selected) {
        if (!(await this.available(context, selected)))
          throw Error("CREATOR_PLANNING_SOURCE_UNAVAILABLE")
        await this.deps.invoke(
          context.scope.workspace,
          selected,
          new AbortController().signal,
          context.assertCurrent
        )
        if (!(await this.available(context, selected)))
          throw Error("CREATOR_PLANNING_SOURCE_UNAVAILABLE")
      }
      context.assertCurrent()
      if (
        !this.deps.settings.compareAndSetSetting(
          scopeKey,
          raw || undefined,
          JSON.stringify({ revision: record.revision + 1, ...(selected ? { selected } : {}) })
        )
      )
        throw Error("CREATOR_PLANNING_REVISION_CHANGED")
      this.diagnostics.delete(scopeKey)
      this.deps.changed(threadId)
      return this.catalog(threadId, workspace)
    } finally {
      this.pending.delete(scopeKey)
    }
  }
  /** Advice is optional. Failure never removes native tools, permissions or recovery controls. */
  async prompt(threadId: string, workspace: string, signal: AbortSignal): Promise<string | null> {
    const context = this.deps.current(threadId, workspace),
      scopeKey = key(context)
    const { raw, record } = this.read(context)
    if (!record.selected) return null
    // Do not retry a failed optional planner on every request. Explicit native selection
    // validates it again; ordinary creation and recovery remain available immediately.
    if (this.diagnostics.has(scopeKey)) return null
    try {
      if (!(await this.available(context, record.selected)))
        throw Error("CREATOR_PLANNING_SOURCE_UNAVAILABLE")
      const guard = () => {
        context.assertCurrent()
        signal.throwIfAborted()
        if (this.deps.settings.getSetting(scopeKey, "") !== raw)
          throw Error("CREATOR_PLANNING_SELECTION_CHANGED")
      }
      const text = await this.deps.invoke(workspace, record.selected, signal, guard)
      guard()
      if (!(await this.available(context, record.selected)))
        throw Error("CREATOR_PLANNING_SOURCE_UNAVAILABLE")
      guard()
      this.diagnostics.delete(scopeKey)
      return `\n\n## 用户选择的可选规划建议\n以下仅调整规划建议；原生工具、权限、预算、必需检查和真实安装结果继续由宿主控制。\n${text}`
    } catch {
      context.assertCurrent()
      signal.throwIfAborted()
      this.rememberFallback(scopeKey)
      this.deps.changed(threadId)
      return null
    }
  }
}
