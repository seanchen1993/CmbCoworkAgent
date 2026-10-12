import { createHash } from "node:crypto"
import { filterScopedHooks, type HookScopeController } from "../hooks/scope-core"
import type { HookContext } from "../hooks/runner-core"
import type { HookEvent } from "../hooks/types"
import { BOT_SUPPORTED_SKILL_HOOK_EVENTS } from "../../shared/bot-skill-hooks"
import { BotDomainError } from "../../shared/bot-types"
import type { BotRuntimeRequest } from "./host"
import type { BotModelSnapshot } from "./model-config"
import {
  assertBotRuntimeHookCatalog,
  readBotRuntimeHookCatalog,
  type BotConfiguredHook,
  type BotRuntimeHookCatalog
} from "./runtime-hook-source"
import { canonicalJson } from "./validation"

export type BotRuntimeOwnedHook = BotConfiguredHook & {
  configured: true
  // Keep the existing receipt field names so installed-skill receipts remain compatible.
  skillId: string
  skillVersion: string
  skillName: string
}

/** Per-run configuration pin. Only digests enter receipts; command bodies and
 * HTTP credentials stay in the user's source configuration. */
export class BotRuntimeHooks {
  private catalog?: BotRuntimeHookCatalog
  private hooks: BotRuntimeOwnedHook[] = []
  constructor(
    private readonly request: BotRuntimeRequest,
    private readonly snapshot: BotModelSnapshot
  ) {}

  async refresh(): Promise<void> {
    if (!this.snapshot.hookSources) return
    if (this.catalog) {
      assertBotRuntimeHookCatalog(this.catalog)
      return
    }
    const { store, lease, bot, worktree, signal } = this.request
    const catalog = await readBotRuntimeHookCatalog(
      this.snapshot.hookSources,
      worktree?.sourceWorkspacePath ?? bot.workspacePath,
      signal
    )
    store.assertLease(lease)
    const version = createHash("sha256")
      .update(
        canonicalJson({ files: catalog.files, roots: catalog.roots, directory: catalog.directory })
      )
      .digest("hex")
    try {
      store.toolOnce(lease, "runtime-hook-configuration", { version }, () => true)
    } catch (error) {
      if (error instanceof BotDomainError && error.code === "nonce_conflict")
        throw new BotDomainError(
          "hook_configuration_changed",
          "Hook 配置与任务开始时不一致，请重新发起任务"
        )
      throw error
    }
    this.hooks = catalog.hooks.map((hook) => ({
      ...hook,
      configured: true,
      skillId: `configured:${hook.ownerId}`,
      skillVersion: version,
      skillName: hook.ownerName
    }))
    this.catalog = catalog
  }

  assertCurrent(): void {
    if (this.catalog) assertBotRuntimeHookCatalog(this.catalog)
  }

  pluginIds(): string[] {
    return [...new Set(this.hooks.flatMap((hook) => (hook.pluginId ? [hook.pluginId] : [])))]
  }

  candidates(context: HookContext, scope: HookScopeController): BotRuntimeOwnedHook[] {
    const selected = filterScopedHooks(
      {
        baseHooks: this.hooks.filter((hook) => hook.owner !== "plugin"),
        pluginHooks: this.hooks.filter((hook) => hook.owner === "plugin"),
        skillHooks: []
      },
      context,
      scope
    ) as BotRuntimeOwnedHook[]
    const supported = new Set<HookEvent>(BOT_SUPPORTED_SKILL_HOOK_EVENTS)
    const unsupported = selected.find((hook) => !supported.has(hook.event))
    if (unsupported)
      throw new BotDomainError(
        "hook_event_unavailable",
        `${unsupported.skillName} 需要 ${unsupported.event} 检查，Bot 尚未接通该事件，任务已停止`
      )
    return selected
  }
}
