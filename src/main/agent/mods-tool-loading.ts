import type { ModObject } from "../../shared/mods/types"
import type { RegisteredFunctionTool } from "../../shared/mods/v2/tools"

export const MODS_TOOL_SEARCH = "mods_tool_search"
const presented = new WeakSet<object>()

/** A host-only marker prevents applying description hooks twice at the provider boundary. */
export function hasModToolPresentation(tool: object): boolean {
  return presented.has(tool)
}

function schema(tool: RegisteredFunctionTool) {
  const value = {
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
  }
  presented.add(value)
  presented.add(value.function)
  return value
}

export const modsToolSearchSchema = {
  type: "function" as const,
  function: {
    name: MODS_TOOL_SEARCH,
    description: "Find and load deferred Mods tools by name or description. Their schemas become callable on the next model step. This only loads tools; it does not execute them.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", minLength: 1, maxLength: 512 } },
      required: ["query"],
      additionalProperties: false
    }
  }
}
presented.add(modsToolSearchSchema)
presented.add(modsToolSearchSchema.function)

const fingerprint = (tool: RegisteredFunctionTool) => JSON.stringify(tool)
// Presentation text can change each model step without replacing an authorized registration.
// Keep placement and the executable/schema identity pinned when carrying a prior load forward.
const loadIdentity = (tool: RegisteredFunctionTool) => JSON.stringify({
  name: tool.name,
  plugin: tool.plugin,
  registrationId: tool.registrationId ?? fingerprint(tool),
  inputSchema: tool.inputSchema,
  isDeferred: tool.isDeferred !== false
})

/** One instance belongs to one host runtime/turn. Loading never changes authorization. */
export class ModToolLoading {
  private loaded = new Map<string, string>()
  private published = new Map<string, string>()
  private catalogue: RegisteredFunctionTool[] = []
  private guard?: () => void
  private searchAvailable = false

  ownsSearch(): boolean {
    return this.searchAvailable
  }

  has(name: string): boolean {
    return this.catalogue.some(tool => tool.name === name)
  }

  clear(): void {
    this.loaded.clear()
    this.published.clear()
    this.catalogue = []
    this.guard = undefined
    this.searchAvailable = false
  }

  prepare(tools: RegisteredFunctionTool[], guard: () => void) {
    try { this.guard?.() } catch { this.clear() }
    guard()
    this.guard = guard
    this.catalogue = tools
    const current = new Map(tools.map(tool => [tool.name, loadIdentity(tool)]))
    for (const [name, version] of this.loaded)
      if (current.get(name) !== version) this.loaded.delete(name)
    const visible = tools.filter(tool => tool.isDeferred === false ||
      this.loaded.get(tool.name) === loadIdentity(tool))
    this.published = new Map(visible.map(tool => [tool.name, fingerprint(tool)]))
    const deferred = tools.filter(tool => !this.published.has(tool.name))
    this.searchAvailable = deferred.length > 0
    return {
      tools: [...visible.map(schema), ...(deferred.length ? [modsToolSearchSchema] : [])],
      context: deferred.length
        ? `Deferred Mods tool names (use ${MODS_TOOL_SEARCH} to load before calling):\n${deferred.map(tool => tool.name).join("\n")}`
        : ""
    }
  }

  search(input: unknown, current: RegisteredFunctionTool[], signal?: AbortSignal): ModObject {
    signal?.throwIfAborted()
    this.guard?.()
    if (!this.guard || !this.searchAvailable) throw Error("MODS_TOOL_SEARCH_NOT_AVAILABLE")
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some(key => key !== "query")) throw Error("MODS_TOOL_SEARCH_INPUT")
    const query = (input as { query?: unknown }).query
    if (typeof query !== "string" || !query.trim() || query.length > 512)
      throw Error("MODS_TOOL_SEARCH_INPUT")
    const terms = query.toLowerCase().trim().split(/\s+/)
    const live = new Map(current.map(tool => [tool.name, tool]))
    const matches = this.catalogue.filter(tool => {
      const definition = live.get(tool.name)
      // Compare source identity/schema, retaining the presentation override from this model step.
      return definition && this.sameDefinition(tool, definition) &&
        terms.every(term => `${tool.name} ${tool.description}`.toLowerCase().includes(term))
    }).slice(0, 16)
    signal?.throwIfAborted()
    this.guard()
    for (const tool of matches) this.loaded.set(tool.name, loadIdentity(tool))
    return { loaded: matches.map(tool => tool.name), nextStep: true }
  }

  private sameDefinition(presentedTool: RegisteredFunctionTool, current: RegisteredFunctionTool) {
    return (presentedTool.registrationId ?? fingerprint(presentedTool)) ===
      (current.registrationId ?? fingerprint(current)) &&
      presentedTool.plugin === current.plugin &&
      JSON.stringify(presentedTool.inputSchema) === JSON.stringify(current.inputSchema)
  }

  assertCallable(name: string, current: RegisteredFunctionTool[], signal?: AbortSignal): void {
    signal?.throwIfAborted()
    this.guard?.()
    const shown = this.catalogue.find(tool => tool.name === name)
    const live = current.find(tool => tool.name === name)
    if (!this.guard || !shown || !live || !this.sameDefinition(shown, live) ||
        this.published.get(name) !== fingerprint(shown))
      throw Error("MODS_TOOL_NOT_LOADED")
  }
}
