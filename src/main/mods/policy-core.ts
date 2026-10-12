import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import type { ModIdentity, ModJson, ModObject } from "../../shared/mods/types"
import { encodeModJson, parseModJson } from "../../shared/mods/validation"
import type { ModRuntimeClient } from "./runtime-client-core"
import { ModError, modErrorCode } from "./errors"
import { MANAGED_POLICY_SOURCE } from "./policy-program"
import { filterModData, mapModResult } from "./publication"
import type { ToolPermissionResult } from "../../shared/tool-permission"

export interface ManagedModDeployment {
  version: 1
  id: "cmb.baseline/v1"
  required: boolean
  denyTools: string[]
  redactLiterals: string[]
}

export const DEFAULT_MOD_POLICY: ManagedModDeployment = {
  version: 1,
  id: "cmb.baseline/v1",
  required: false,
  denyTools: [],
  redactLiterals: []
}

/** Application resource, never a workspace/plugin manifest or user-supplied executable. */
export function readManagedModDeployment(path: string): ManagedModDeployment {
  if (statSync(path).size > 32_768) throw new ModError("MODS_POLICY_CONFIG_SIZE")
  return parseManagedModDeployment(parseModJson(readFileSync(path, "utf8")))
}

export function parseManagedModDeployment(value: unknown): ManagedModDeployment {
  encodeModJson(value)
  const input = value as ManagedModDeployment
  if (
    !input ||
    input.version !== 1 ||
    input.id !== "cmb.baseline/v1" ||
    typeof input.required !== "boolean"
  )
    throw new ModError("MODS_POLICY_CONFIG_INVALID")
  for (const [key, max] of [
    ["denyTools", 160],
    ["redactLiterals", 256]
  ] as const) {
    const entries = input[key]
    if (
      !Array.isArray(entries) ||
      entries.length > 64 ||
      entries.some((text) => typeof text !== "string" || !text.length || text.length > max)
    )
      throw new ModError("MODS_POLICY_CONFIG_INVALID")
  }
  return {
    version: 1,
    id: input.id,
    required: input.required,
    denyTools: [...new Set(input.denyTools)],
    redactLiterals: [...new Set(input.redactLiterals)]
  }
}

export class ManagedModPolicy {
  readonly deployment: ManagedModDeployment
  readonly digest: string
  private loaded: Promise<void> | undefined
  private generation = -1
  private queue: Promise<void> = Promise.resolve()
  private waiting = 0
  private readonly cache = new Map<string, { value: ModJson; ruleIds: string[] }>()

  constructor(
    deployment: ManagedModDeployment,
    private readonly client: ModRuntimeClient
  ) {
    this.deployment = parseManagedModDeployment(deployment)
    this.digest = createHash("sha256")
      .update(MANAGED_POLICY_SOURCE)
      .update(encodeModJson(this.deployment))
      .digest("hex")
  }

  get required(): boolean {
    return this.deployment.required
  }
  get stats() {
    return this.client.stats
  }

  /** Declarative part of the same deployment used by admit; no policy worker is started. */
  query(toolId: string): ToolPermissionResult {
    return this.deployment.denyTools.includes(toolId)
      ? { decision: "deny", reason: "MODS_POLICY_TOOL_DENIED", rule: toolId }
      : { decision: "allow" }
  }

  /** Conservative synchronous mirror for diagnostics emitted before async publication. */
  observer<T>(value: T): T {
    const visit = (value: ModJson): ModJson => {
      if (typeof value === "string") {
        for (const literal of this.deployment.redactLiterals)
          value = value.split(literal).join("[REDACTED]")
        return value
      }
      if (Array.isArray(value)) return value.map(visit)
      if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, visit(entry)]))
      return value
    }
    return visit(filterModData(value, true)) as T
  }

  private async invoke(method: string, event: ModObject, signal?: AbortSignal): Promise<ModObject> {
    if (this.waiting >= 32) throw new ModError("MODS_POLICY_CAPACITY")
    this.waiting++
    const prior = this.queue
    let release = (): void => {}
    this.queue = new Promise<void>((resolve) => {
      release = resolve
    })
    await prior
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          if (signal?.aborted) throw new ModError("MODS_CANCELLED")
          if (this.generation !== this.client.version) this.loaded = undefined
          if (!this.loaded) {
            this.loaded = this.client.load("managed-policy", MANAGED_POLICY_SOURCE).then(() => {
              this.generation = this.client.version
            })
          }
          await this.loaded
          const result = await this.client.invoke(
            "managed-policy",
            method,
            { ...event, deployment: this.deployment as unknown as ModObject },
            async () => {
              throw new ModError("MODS_POLICY_IO_DENIED")
            },
            signal
          )
          if (!result || typeof result !== "object" || Array.isArray(result))
            throw new ModError("MODS_POLICY_RESULT")
          return result
        } catch (error) {
          // This release-owned policy is pure and has no host capabilities. A
          // scheduling stall can exhaust a QuickJS slice; retry its calculation
          // once in a fresh worker, never the tool that produced the result.
          if (
            attempt !== 0 ||
            signal?.aborted ||
            !(error instanceof ModError) ||
            !["MODS_GUEST_ERROR", "MODS_BUDGET_EXCEEDED"].includes(error.code)
          )
            throw error
          this.loaded = undefined
          this.client.stop("MODS_POLICY_RETRY")
        }
      }
    } catch (error) {
      // Diagnostic codes only: raw policy inputs/results and exception messages
      // can contain exactly the data that publication was meant to protect.
      console.warn("[Mods] Managed policy computation failed", {
        method,
        code: modErrorCode(error)
      })
      this.loaded = undefined
      this.client.stop("MODS_POLICY_FAILURE")
      throw new ModError(signal?.aborted ? "MODS_CANCELLED" : "MODS_POLICY_UNAVAILABLE")
    } finally {
      this.waiting--
      release()
    }
  }

  async admit(
    identity: ModIdentity,
    toolId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<void> {
    const result = await this.invoke(
      "admit",
      {
        identity: identity as unknown as ModObject,
        toolId,
        args: filterModData(args, false)
      },
      signal
    )
    if (result.allow !== true) throw new ModError("MODS_POLICY_TOOL_DENIED")
  }

  async filter(
    value: unknown,
    signal?: AbortSignal
  ): Promise<{ value: ModJson; ruleIds: string[] }> {
    // Host preflight bounds/non-text rejection runs before entering the policy VM.
    if (signal?.aborted) throw new ModError("MODS_CANCELLED")
    const data = filterModData(value, true)
    const key = createHash("sha256").update(encodeModJson(data)).digest("hex")
    const cached = this.cache.get(key)
    if (cached && this.generation === this.client.version) return structuredClone(cached)
    const result = await this.invoke("filter", { value: data }, signal)
    if (
      result.allow !== true ||
      result.value === undefined ||
      !Array.isArray(result.ruleIds) ||
      result.ruleIds.some((rule) => typeof rule !== "string" || !/^[a-z-]{1,80}$/.test(rule))
    )
      throw new ModError("MODS_POLICY_RESULT")
    const published = {
      value: result.value,
      ruleIds: ["baseline-v1", ...(result.ruleIds as string[])]
    }
    if (encodeModJson(published).length <= 32_768) {
      if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!)
      this.cache.set(key, published)
    }
    return structuredClone(published)
  }

  async publish<T>(
    value: T,
    toolCallId?: string,
    signal?: AbortSignal,
    record?: (digest: string, rules: string[]) => void
  ): Promise<T> {
    const rules = new Set<string>()
    const result = await mapModResult(
      value,
      async (data) => {
        const filtered = await this.filter(data, signal)
        filtered.ruleIds.forEach((rule) => rules.add(rule))
        return filtered.value
      },
      toolCallId
    )
    record?.(this.digest, [...rules])
    return result
  }

  stop(): void {
    this.loaded = undefined
    this.cache.clear()
    this.client.stop()
  }
}
