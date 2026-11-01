import type { ModObject } from "../types"
import { encodeModJson } from "../validation"
import { isModObject, MOD_TIERS, ModFunctionError, type ModTier } from "./contracts"

export type FunctionPluginRegisterStateRef = { plugin: string; key: string }
export type FunctionPluginRegisterUses = {
  events: string[]
  calls: string[]
  env?: { reads: string[]; writes: string[] }
  state?: {
    reads: FunctionPluginRegisterStateRef[]
    writes: FunctionPluginRegisterStateRef[]
  }
}
/** Every field comes from the pinned manifest and per-entry static source scan. */
export type FunctionPluginRegisterInput = {
  name: string
  tier: Exclude<ModTier, "core">
  root: string
  version?: string
  provenance: string
  uses: FunctionPluginRegisterUses
}
export type FunctionPluginRegisterResult = { allow: true } | { refuse: string }

function fail(kind: "INPUT" | "RESULT"): never {
  throw new ModFunctionError(`MODS_PLUGIN_REGISTER_${kind}`)
}

function text(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !value.includes("\0")
  )
}

function fields(value: ModObject, names: readonly string[]): boolean {
  return Object.keys(value).every((key) => names.includes(key))
}

function strings(value: unknown, maximum: number, length: number): value is string[] {
  if (!Array.isArray(value) || value.length > maximum) return false
  for (let index = 0; index < value.length; index++)
    if (!Object.hasOwn(value, index) || !text(value[index], length)) return false
  return new Set(value).size === value.length
}

function stateRefs(value: unknown): value is FunctionPluginRegisterStateRef[] {
  if (!Array.isArray(value) || value.length > 128) return false
  const keys = new Set<string>()
  for (let index = 0; index < value.length; index++) {
    const ref = value[index]
    if (
      !Object.hasOwn(value, index) ||
      !isModObject(ref) ||
      !fields(ref, ["plugin", "key"]) ||
      !text(ref.plugin, 128) ||
      !text(ref.key, 128)
    )
      return false
    const key = JSON.stringify([ref.plugin, ref.key])
    if (keys.has(key)) return false
    keys.add(key)
  }
  return true
}

export function validateFunctionPluginRegisterInput(
  value: unknown
): asserts value is FunctionPluginRegisterInput {
  let encoded: string
  try {
    encoded = encodeModJson(value)
  } catch {
    fail("INPUT")
  }
  if (
    new TextEncoder().encode(encoded).byteLength > 65536 ||
    !isModObject(value) ||
    !fields(value, ["name", "tier", "root", "version", "provenance", "uses"]) ||
    typeof value.name !== "string" ||
    !/^[a-zA-Z0-9][\w.-]{0,99}$/.test(value.name) ||
    !MOD_TIERS.some((tier) => tier !== "core" && tier === value.tier) ||
    !text(value.root, 32768) ||
    !/^(?:[A-Za-z]:[\\/]|[\\/]{2}|\/)/.test(value.root) ||
    !text(value.provenance, 256) ||
    (Object.hasOwn(value, "version") && !text(value.version, 128)) ||
    !isModObject(value.uses)
  )
    fail("INPUT")
  const uses = value.uses
  if (
    !fields(uses, ["events", "calls", "env", "state"]) ||
    !strings(uses.events, 256, 256) ||
    !strings(uses.calls, 256, 161) ||
    uses.calls.some((call) => !/^[A-Za-z][\w-]{0,79}\.[A-Za-z][\w-]{0,79}$/.test(call))
  )
    fail("INPUT")
  if (Object.hasOwn(uses, "env")) {
    const env = uses.env
    if (
      !isModObject(env) ||
      !fields(env, ["reads", "writes"]) ||
      !strings(env.reads, 128, 128) ||
      !strings(env.writes, 128, 128) ||
      env.reads.length + env.writes.length > 128 ||
      [...env.reads, ...env.writes].some((name) => /[=\0]/.test(name))
    )
      fail("INPUT")
  }
  if (Object.hasOwn(uses, "state")) {
    const state = uses.state
    if (
      !isModObject(state) ||
      !fields(state, ["reads", "writes"]) ||
      !stateRefs(state.reads) ||
      !stateRefs(state.writes)
    )
      fail("INPUT")
  }
}

export function validateFunctionPluginRegisterResult(
  value: unknown
): asserts value is FunctionPluginRegisterResult {
  try {
    encodeModJson(value)
  } catch {
    fail("RESULT")
  }
  if (
    !isModObject(value) ||
    Object.keys(value).length !== 1 ||
    !(value.allow === true || (text(value.refuse, 4096) && value.refuse.trim().length > 0))
  )
    fail("RESULT")
}
