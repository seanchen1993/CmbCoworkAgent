/**
 * Agent specification parser and template renderer.
 *
 * Used by harnessboard mode to load declarative system prompt templates
 * (YAML agent spec + Markdown system prompt) inspired by Kimi Code CLI.
 */

import { readFile } from "fs/promises"
import { dirname, isAbsolute, join } from "path"
import { parse as parseYaml } from "yaml"

export interface SubagentSpec {
  path: string
  description: string
}

export interface AgentSpec {
  version: number
  name: string
  system_prompt_path: string
  system_prompt_args: Record<string, string>
  tools?: string[]
  allowed_tools?: string[] | null
  exclude_tools?: string[]
  subagents?: Record<string, SubagentSpec>
}

export interface ResolvedAgentSpec {
  version: number
  name: string
  systemPromptPath: string
  systemPromptArgs: Record<string, string>
  tools: string[]
  allowedTools: string[] | null
  excludeTools: string[]
  subagents: Record<string, SubagentSpec>
}

export class AgentSpecError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AgentSpecError"
  }
}

export function resolveSystemPromptPath(baseDir: string, specPath: string): string {
  if (isAbsolute(specPath)) {
    return specPath
  }
  return join(baseDir, specPath)
}

/**
 * Render a template by replacing `${VAR_NAME}` placeholders with values from vars.
 * Unknown variables are replaced with an empty string and a warning is logged.
 */
export function renderTemplate(template: string, vars: Record<string, string | undefined>): string {
  return template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      const value = vars[name]
      return value === undefined ? "" : value
    }
    console.warn(`[AgentSpec] Unknown template variable: ${name}`)
    return ""
  })
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new AgentSpecError(`Agent spec field '${field}' must be a string`)
  }
  return value
}

function assertStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new AgentSpecError(`Agent spec field '${field}' must be an array of strings`)
  }
  return value
}

function assertRecordString(value: unknown, field: string): Record<string, string> {
  if (typeof value !== "object" || value === null) {
    throw new AgentSpecError(`Agent spec field '${field}' must be an object`)
  }
  const record = value as Record<string, unknown>
  for (const [key, val] of Object.entries(record)) {
    if (typeof val !== "string") {
      throw new AgentSpecError(`Agent spec field '${field}.${key}' must be a string`)
    }
  }
  return record as Record<string, string>
}

function parseAgentSpec(data: unknown): AgentSpec {
  if (typeof data !== "object" || data === null) {
    throw new AgentSpecError("Agent spec must be an object")
  }

  const root = data as Record<string, unknown>
  const version = root.version
  if (typeof version !== "number" || version !== 1) {
    throw new AgentSpecError(`Unsupported agent spec version: ${version}`)
  }

  const agent = root.agent
  if (typeof agent !== "object" || agent === null) {
    throw new AgentSpecError("Agent spec must contain an 'agent' object")
  }

  const agentObj = agent as Record<string, unknown>

  return {
    version,
    name: assertString(agentObj.name, "agent.name"),
    system_prompt_path: assertString(agentObj.system_prompt_path, "agent.system_prompt_path"),
    system_prompt_args: agentObj.system_prompt_args
      ? assertRecordString(agentObj.system_prompt_args, "agent.system_prompt_args")
      : {},
    tools: agentObj.tools ? assertStringArray(agentObj.tools, "agent.tools") : undefined,
    allowed_tools:
      agentObj.allowed_tools === null
        ? null
        : agentObj.allowed_tools
          ? assertStringArray(agentObj.allowed_tools, "agent.allowed_tools")
          : undefined,
    exclude_tools: agentObj.exclude_tools
      ? assertStringArray(agentObj.exclude_tools, "agent.exclude_tools")
      : undefined,
    subagents: agentObj.subagents
      ? parseSubagents(agentObj.subagents, "agent.subagents")
      : undefined
  }
}

function parseSubagents(value: unknown, field: string): Record<string, SubagentSpec> {
  if (typeof value !== "object" || value === null) {
    throw new AgentSpecError(`Agent spec field '${field}' must be an object`)
  }
  const result: Record<string, SubagentSpec> = {}
  for (const [key, spec] of Object.entries(value as Record<string, unknown>)) {
    if (typeof spec !== "object" || spec === null) {
      throw new AgentSpecError(`Agent spec subagent '${key}' must be an object`)
    }
    const specObj = spec as Record<string, unknown>
    result[key] = {
      path: assertString(specObj.path, `agent.subagents.${key}.path`),
      description: assertString(specObj.description, `agent.subagents.${key}.description`)
    }
  }
  return result
}

/**
 * Load and resolve an agent spec from a YAML file.
 */
export async function loadAgentSpec(agentFilePath: string): Promise<ResolvedAgentSpec> {
  const content = await readFile(agentFilePath, "utf-8")
  let data: unknown
  try {
    data = parseYaml(content)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new AgentSpecError(`Invalid YAML in agent spec file ${agentFilePath}: ${message}`)
  }

  const spec = parseAgentSpec(data)

  return {
    version: spec.version,
    name: spec.name,
    systemPromptPath: resolveSystemPromptPath(dirname(agentFilePath), spec.system_prompt_path),
    systemPromptArgs: spec.system_prompt_args,
    tools: spec.tools ?? [],
    allowedTools: spec.allowed_tools === undefined ? null : spec.allowed_tools,
    excludeTools: spec.exclude_tools ?? [],
    subagents: spec.subagents ?? {}
  }
}
