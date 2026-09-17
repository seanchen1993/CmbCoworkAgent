import type { ModObject } from "../../../shared/mods/types"
import type { RegisteredFunctionTool } from "../../../shared/mods/v2/tools"
import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"
import { validateToolSchema, validateRegisteredToolInput } from "./tool-schema"

export function functionToolSpec(input: ModObject): ModObject {
  if (
    typeof input.name !== "string" ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(input.name) ||
    typeof input.description !== "string" ||
    input.description.length > 8000 ||
    Object.keys(input).some((key) => !["name", "description", "inputSchema"].includes(key))
  )
    throw new ModFunctionError("MODS_TOOL_SPEC")
  const inputSchema = input.inputSchema === undefined ? { type: "object" } : input.inputSchema
  if (!isModObject(inputSchema)) throw new ModFunctionError("MODS_TOOL_SCHEMA")
  validateToolSchema(inputSchema)
  return parseModJson(encodeModJson({ ...input, inputSchema })) as ModObject
}

export class FunctionToolRegistry {
  private readonly tools = new Map<string, RegisteredFunctionTool>()

  register(plugin: string, raw: ModObject): ModObject {
    const spec = functionToolSpec(raw)
    const name = `mcp__${plugin}__${spec.name}`
    if (name.length > 256) throw new ModFunctionError("MODS_TOOL_SPEC")
    const previous = this.tools.get(name)
    if (previous && previous.plugin !== plugin)
      throw new ModFunctionError("MODS_TOOL_NAME_COLLISION")
    if (
      !previous &&
      (this.tools.size >= 128 ||
        [...this.tools.values()].filter((t) => t.plugin === plugin).length >= 32)
    )
      throw new ModFunctionError("MODS_TOOL_REGISTRY_LIMIT")
    const tool: RegisteredFunctionTool = {
      name,
      plugin,
      description: spec.description as string,
      inputSchema: spec.inputSchema as ModObject,
      mcp: true
    }
    const totalChars = [...this.tools.values()]
      .filter((entry) => entry.name !== name)
      .reduce((size, entry) => size + JSON.stringify(entry).length, JSON.stringify(tool).length)
    if (totalChars > 256000) throw new ModFunctionError("MODS_TOOL_REGISTRY_LIMIT")
    this.tools.set(name, tool)
    return { tool: name }
  }

  get(name: string): RegisteredFunctionTool | undefined {
    return this.tools.get(name)
  }

  list(): RegisteredFunctionTool[] {
    return JSON.parse(JSON.stringify([...this.tools.values()])) as RegisteredFunctionTool[]
  }

  validate(input: ModObject): RegisteredFunctionTool | undefined {
    const tool = typeof input.tool === "string" ? this.tools.get(input.tool) : undefined
    if (!tool) return undefined
    const args = { ...input }
    delete args.tool
    delete args.tool_use_id
    delete args.agentId
    validateRegisteredToolInput(tool.inputSchema, args)
    return tool
  }

  clear(): void {
    this.tools.clear()
  }
}
