import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import type { ModIdentity, ModJson, ModObject } from "../../shared/mods/types"
import { encodeModJson, parseModJson } from "../../shared/mods/validation"
import { ModRuntimeClient } from "./runtime-client"
import { ModError } from "./errors"
import { filterModData, mapModResult } from "./publication"

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

// Application-owned pure policy. Its source is part of the release digest; ordinary
// plugins cannot replace it, call next, invoke capabilities, or alter execution facts.
const POLICY_CODE = String.raw`
var __cmbMod={default:{register(on){
  on.command({id:"admit",command:"policy:admit"},async($,e)=>{
    if(e.deployment.denyTools.includes(e.toolId))return {allow:false,code:"TOOL_DENIED"};
    return {allow:true};
  });
  on.command({id:"filter",command:"policy:filter"},async($,e)=>{
    const rules=new Set();
    const visit=(v)=>{
      if(typeof v==="string"){
        let text=v.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16})\b/g,()=>{rules.add("credential-token");return "[REDACTED]"})
          .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,()=>{rules.add("bearer");return "Bearer [REDACTED]"});
        for(const literal of e.deployment.redactLiterals){
          if(text.includes(literal)){rules.add("deployment-literal");text=text.split(literal).join("[REDACTED]")}
        }
        return text;
      }
      if(Array.isArray(v))return v.map(visit);
      if(v&&typeof v==="object"){
        const out={};
        for(const key of Object.keys(v)){
          if(/^(authorization|password|secret|access_token|refresh_token|api[-_]?key|accountNumber|base64|dataUrl)$/i.test(key)){
            rules.add("credential-field");out[key]="[REDACTED]";
          }else out[key]=visit(v[key]);
        }
        return out;
      }
      return v;
    };
    return {allow:true,value:visit(e.value),ruleIds:[...rules]};
  });
}}};`

export class ManagedModPolicy {
  readonly deployment: ManagedModDeployment
  readonly digest: string
  private readonly client: ModRuntimeClient
  private loaded: Promise<void> | undefined
  private generation = -1
  private queue: Promise<void> = Promise.resolve()
  private waiting = 0
  private readonly cache = new Map<string, { value: ModJson; ruleIds: string[] }>()

  constructor(deployment = DEFAULT_MOD_POLICY, hostEntry?: string) {
    this.deployment = parseManagedModDeployment(deployment)
    this.digest = createHash("sha256")
      .update(POLICY_CODE)
      .update(encodeModJson(this.deployment))
      .digest("hex")
    this.client = new ModRuntimeClient(hostEntry)
  }

  get required(): boolean {
    return this.deployment.required
  }
  get stats() {
    return this.client.stats
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
      if (signal?.aborted) throw new ModError("MODS_CANCELLED")
      if (this.generation !== this.client.version) this.loaded = undefined
      if (!this.loaded) {
        this.loaded = this.client.load("managed-policy", POLICY_CODE).then(() => {
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
    } catch {
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
