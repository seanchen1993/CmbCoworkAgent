import { isDeepStrictEqual } from "node:util"
import type { ModObject } from "../../../shared/mods/types"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"

export interface RegisteredFunctionAgent {
  name: string
  plugin: string
  spec: ModObject
}

export function functionAgentToolName(name: string): string {
  const aliases: Record<string, string> = {
    Read: "read_file",
    Write: "write_file",
    Edit: "edit_file",
    Bash: "execute",
    Glob: "glob",
    Grep: "grep",
    LS: "ls",
    TodoWrite: "write_todos",
    Agent: "task"
  }
  return aliases[name] ?? name
}

const fields = new Set([
  "name",
  "description",
  "prompt",
  "tools",
  "disallowedTools",
  "model",
  "maxTurns",
  "background",
  "omitClaudeMd",
  "permissionMode"
])

export function functionAgentSpec(input: ModObject): ModObject {
  if (Object.keys(input).some((key) => !fields.has(key)))
    throw new ModFunctionError("MODS_AGENT_SPEC_FIELD_UNSUPPORTED")
  if (
    typeof input.name !== "string" ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(input.name) ||
    typeof input.description !== "string" ||
    input.description.length > 8000 ||
    typeof input.prompt !== "string" ||
    !input.prompt.trim() ||
    Buffer.byteLength(input.prompt) > 64 * 1024
  )
    throw new ModFunctionError("MODS_AGENT_SPEC")
  for (const field of ["tools", "disallowedTools"])
    if (
      input[field] !== undefined &&
      (!Array.isArray(input[field]) ||
        input[field].length > 256 ||
        !input[field].every(
          (value) => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,256}$/.test(value)
        ))
    )
      throw new ModFunctionError("MODS_AGENT_SPEC_TOOLS")
  if (
    input.model !== undefined &&
    (typeof input.model !== "string" || !input.model || input.model.length > 256)
  )
    throw new ModFunctionError("MODS_AGENT_SPEC_MODEL")
  if (
    input.maxTurns !== undefined &&
    (!Number.isSafeInteger(input.maxTurns) ||
      Number(input.maxTurns) < 1 ||
      Number(input.maxTurns) > 100)
  )
    throw new ModFunctionError("MODS_AGENT_SPEC_MAX_TURNS")
  if (
    (input.background !== undefined && input.background !== true) ||
    (input.omitClaudeMd !== undefined && input.omitClaudeMd !== true) ||
    (input.permissionMode !== undefined &&
      !["default", "plan"].includes(String(input.permissionMode)))
  )
    throw new ModFunctionError("MODS_AGENT_SPEC_MODE_UNSUPPORTED")
  return structuredClone(input)
}

/** Session-owned definitions. A spawn takes a copy before requesting native approval. */
export class FunctionAgentRegistry {
  private readonly agents = new Map<string, RegisteredFunctionAgent>()

  register(plugin: string, input: ModObject): ModObject {
    const spec = functionAgentSpec(input)
    const name = `${plugin}:${spec.name}`
    if (name.length > 256) throw new ModFunctionError("MODS_AGENT_SPEC")
    const value = { name, plugin, spec }
    const previous = this.agents.get(name)
    if (previous && isDeepStrictEqual(previous, value)) return { agent: name }
    const remaining = [...this.agents.values()].filter((entry) => entry.name !== name)
    if (
      (!previous &&
        (remaining.length >= 128 ||
          remaining.filter((entry) => entry.plugin === plugin).length >= 32)) ||
      remaining.reduce(
        (bytes, entry) => bytes + Buffer.byteLength(JSON.stringify(entry)),
        Buffer.byteLength(JSON.stringify(value))
      ) >
        256 * 1024
    )
      throw new ModFunctionError("MODS_AGENT_REGISTRY_LIMIT")
    this.agents.set(name, value)
    return { agent: name }
  }

  get(name: string): RegisteredFunctionAgent | undefined {
    const value = this.agents.get(name)
    return value && structuredClone(value)
  }

  clear(): void {
    this.agents.clear()
  }
}
