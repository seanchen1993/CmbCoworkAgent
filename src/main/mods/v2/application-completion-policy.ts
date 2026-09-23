import type { ModJson } from "../../../shared/mods/types"
import {
  DEFAULT_COMPLETION_POLICY,
  parseCompletionPolicy,
  type CompletionPolicy,
  type CompletionPolicyView
} from "../../../shared/mods/v2/completion-policy"
import type { ModControlStore } from "../control-store"

/** Only app settings may enable a checkpoint mutation; ordinary guest config is read-only here. */
function parseApplicationPolicy(input: unknown): CompletionPolicy {
  const policy = parseCompletionPolicy(input)
  const stage = (input as { autobizStartCheckpoint?: unknown }).autobizStartCheckpoint
  if (stage === undefined || policy.mode === "off") return policy
  if (
    typeof stage !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(stage) ||
    !["check", "repair"].includes(policy.mode) ||
    !policy.checks.includes("autobiz-validator") ||
    !policy.feature ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(policy.feature)
  )
    throw Error("MODS_AUTOBIZ_STAGE_CONFIG_INVALID")
  return { ...policy, autobizStartCheckpoint: stage }
}

/** Application settings live outside the guest state namespace. Only native settings IPC writes them. */
export class ApplicationCompletionPolicies {
  constructor(private readonly store: ModControlStore) {}

  private key(workspace: string, plugin: string): string {
    if (typeof plugin !== "string" || !plugin || plugin.length > 256)
      throw Error("MODS_COMPLETION_PLUGIN_INVALID")
    return JSON.stringify(["application-completion-policy", workspace, plugin])
  }

  hostValue(workspace: string, plugin: string): ModJson | undefined {
    const raw = this.store.getSetting(this.key(workspace, plugin), "")
    if (!raw) return undefined
    // Validate persisted data; corruption must not silently turn a gate off.
    return JSON.parse(JSON.stringify(parseApplicationPolicy(JSON.parse(raw)))) as ModJson
  }

  value(workspace: string, plugin: string): ModJson | undefined {
    return (
      this.hostValue(workspace, plugin) ??
      this.store.functionState.get(JSON.stringify([workspace, plugin]), "completion-config")
    )
  }

  view(workspace: string, plugin: string): CompletionPolicyView {
    const host = this.hostValue(workspace, plugin)
    const raw = host ?? this.value(workspace, plugin)
    return raw == null
      ? {
          source: "default",
          policy: { ...DEFAULT_COMPLETION_POLICY, scope: "diff", checks: ["code-review"] }
        }
      : {
          source: host === undefined ? "plugin" : "application",
          policy: host === undefined ? parseCompletionPolicy(raw) : parseApplicationPolicy(raw)
        }
  }

  save(workspace: string, plugin: string, value: unknown): CompletionPolicyView {
    const key = this.key(workspace, plugin)
    const policy = parseApplicationPolicy(value)
    if (
      policy.mode !== "off" &&
      ((policy.scope === "file" && !policy.target) ||
        (policy.scope === "feature" && !policy.feature))
    )
      throw Error("MODS_COMPLETION_SCOPE_REQUIRED")
    this.store.setSetting(key, JSON.stringify(policy))
    return { source: "application", policy }
  }

  assertGuestWritable(workspace: string, plugin: string, key: string): void {
    if (key === "completion-config" && this.hostValue(workspace, plugin) !== undefined)
      throw Error("MODS_COMPLETION_POLICY_HOST_OWNED")
  }
}
