import type { HostFlowAuthority } from "../flow-authority"
import { createHash } from "node:crypto"
import type {
  ClawSourceEntry,
  ClawSourceReference,
  ClawSourceSelection
} from "../../../shared/mods/claw"
import type { FlowMcpToolDescriptor, FlowMcpToolIdentity } from "../../../shared/mods/flows/types"
import type { ModObject } from "../../../shared/mods/types"
import { clawActionObject } from "../../../shared/mods/claw-actions"
import { encodeModJson } from "../../../shared/mods/validation"
import type { McpCapabilityService, McpCapabilityTool } from "../../mcp/capability-types"
import { getGlobalMcpCapabilityService } from "../../mcp/capability-service"
import { createHookScope, resolveEnabledHooksForRun } from "../../hooks/scope"
import type { ModGrant } from "../control-store"
import type { ModsManager } from "../manager"
import { getModCallContext } from "../context"
import { readClawMcpSources, restrictClawMcpService } from "../claw-mcp"
import { ModError } from "../errors"
import { withFunctionCommandBinding } from "../v2/command-binding"
import { currentFunctionExecution } from "../v2/execution-context"
import { functionMcpToolFingerprint } from "../v2/mcp-sdk"
import { validateRegisteredToolInput, validateToolSchema } from "../v2/tool-schema"

interface CatalogDependencies {
  service?: McpCapabilityService
  readSources?: () => ClawSourceEntry[]
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

/** Stable saved identity excludes connection generations and includes both schema contracts. */
export function nativeMcpSchemaDigest(tool: McpCapabilityTool): string {
  const schemas = { input: tool.inputSchema ?? {}, output: tool.outputSchema ?? null }
  encodeModJson(schemas)
  return createHash("sha256").update(canonical(schemas)).digest("hex")
}

function checkedSchema(value: unknown): ModObject {
  const schema = clawActionObject(value)
  // A dialect declaration is metadata; it never enables external resolution.
  if (schema.$schema !== undefined) {
    if (typeof schema.$schema !== "string") throw new ModError("FLOW_MCP_SCHEMA_UNSUPPORTED")
    delete schema.$schema
  }
  validateToolSchema(schema, { allowReservedKeys: true })
  return schema
}

function descriptor(tool: McpCapabilityTool, provider: ClawSourceReference): FlowMcpToolDescriptor {
  const result: FlowMcpToolDescriptor = {
    provider: { id: provider.id, name: provider.name, digest: provider.digest },
    toolName: tool.toolName,
    schemaDigest: createHash("sha256").update("unsupported-mcp-schema").digest("hex"),
    ...(tool.description ? { description: tool.description.slice(0, 4000) } : {})
  }
  try {
    result.schemaDigest = nativeMcpSchemaDigest(tool)
    result.inputSchema = checkedSchema(tool.inputSchema ?? {})
    if (tool.outputSchema) checkedSchema(tool.outputSchema)
  } catch {
    result.unavailableReason =
      "该工具的参数或结果 schema 超出当前支持范围，请使用支持基础 JSON Schema 的工具。"
  }
  return result
}

/** Explicit user discovery only. This may initialize all globally enabled MCP connections. */
export async function listNativeMcpTools(
  selection?: ClawSourceSelection,
  dependencies: CatalogDependencies = {}
): Promise<FlowMcpToolDescriptor[]> {
  const readSources = dependencies.readSources ?? readClawMcpSources
  const sources = readSources()
  const byId = new Map(sources.map((entry) => [entry.id, entry]))
  if (selection?.mode === "selected")
    for (const source of selection.items)
      if (
        byId.get(source.id)?.digest !== source.digest ||
        byId.get(source.id)?.name !== source.name
      )
        throw new ModError("CLAW_MCP_SOURCE_CHANGED")
  const service = restrictClawMcpService(
    dependencies.service ?? getGlobalMcpCapabilityService(),
    selection,
    readSources
  )
  const tools = await service.listTools()
  const current = new Map(readSources().map((entry) => [entry.id, entry]))
  return tools.map((tool) => {
    const source = byId.get(tool.providerKey)
    const actual = source && current.get(source.id)
    if (!source || actual?.digest !== source.digest || actual.name !== source.name)
      throw new ModError("CLAW_MCP_SOURCE_CHANGED")
    return descriptor(tool, source)
  })
}

export interface NativeMcpStepOptions extends CatalogDependencies {
  manager: ModsManager
  workspace: string
  threadId: string
  turnId: string
  selection?: ClawSourceSelection
  provider: ClawSourceReference
  toolName: string
  schemaDigest: string
  signal: AbortSignal
  assertLive(): void
  withOwnerGrant?<T>(run: (grant: ModGrant) => Promise<T>): Promise<T>
  /** Host-only getter: authority is minted after preparation, never serialized by a caller. */
  hostAuthority?: () => HostFlowAuthority
}

/** Pins provider, schema and connection; execution needs a live plugin grant or host authority. */
export async function prepareNativeMcpStep(options: NativeMcpStepOptions) {
  if (!!options.withOwnerGrant === !!options.hostAuthority)
    throw new ModError("FLOW_EXECUTION_PRINCIPAL_REQUIRED")
  const provider = structuredClone(options.provider)
  const readSources = options.readSources ?? readClawMcpSources
  const raw = options.service ?? getGlobalMcpCapabilityService()
  const service = restrictClawMcpService(raw, options.selection, readSources)
  const assertSource = () => {
    options.signal.throwIfAborted()
    options.assertLive()
    const actual = readSources().find((entry) => entry.id === provider.id)
    if (actual?.digest !== provider.digest || actual.name !== provider.name)
      throw new ModError("CLAW_MCP_SOURCE_CHANGED")
    if (
      options.selection?.mode === "selected" &&
      !options.selection.items.some(
        (item) =>
          item.id === provider.id && item.name === provider.name && item.digest === provider.digest
      )
    )
      throw new ModError("CLAW_MCP_TOOL_NOT_SELECTED")
  }
  assertSource()
  const matches = (await service.listTools()).filter(
    (tool) => tool.providerKey === provider.id && tool.toolName === options.toolName
  )
  assertSource()
  if (matches.length !== 1) throw new ModError("FLOW_MCP_TOOL_UNAVAILABLE")
  const tool = structuredClone(matches[0])
  const description = descriptor(tool, provider)
  if (description.schemaDigest !== options.schemaDigest)
    throw new ModError("FLOW_MCP_SCHEMA_CHANGED")
  if (description.unavailableReason) throw new ModError("FLOW_MCP_SCHEMA_UNSUPPORTED")
  const inputSchema = checkedSchema(tool.inputSchema ?? {})
  const outputSchema = tool.outputSchema && checkedSchema(tool.outputSchema)
  const fingerprint = functionMcpToolFingerprint(tool)
  const assertCurrent = () => {
    assertSource()
    const actual = service.peekTools?.()?.find((item) => item.capabilityId === tool.capabilityId)
    if (
      !actual ||
      functionMcpToolFingerprint(actual) !== fingerprint ||
      nativeMcpSchemaDigest(actual) !== description.schemaDigest
    )
      throw new ModError("FLOW_MCP_CONNECTION_CHANGED")
  }
  assertCurrent()
  let attempted = false
  return {
    descriptor: description,
    plan: {
      provider: structuredClone(description.provider),
      toolName: description.toolName,
      schemaDigest: description.schemaDigest,
      ...(tool.connectionGeneration ? { connectionGeneration: tool.connectionGeneration } : {})
    } satisfies FlowMcpToolIdentity & { connectionGeneration?: string },
    assertCurrent,
    invoke: async (input: ModObject, signal: AbortSignal = options.signal): Promise<ModObject> => {
      const combined = AbortSignal.any([options.signal, signal])
      const assertOperation = () => {
        combined.throwIfAborted()
        assertCurrent()
      }
      assertOperation()
      if (attempted) throw new ModError("FLOW_MCP_ALREADY_ATTEMPTED")
      attempted = true
      const args = clawActionObject(input)
      validateRegisteredToolInput(inputSchema, args)
      let transported = false
      const exact: McpCapabilityService = {
        configuredServerNames: () => [provider.name],
        listTools: async () => {
          assertOperation()
          return [structuredClone(tool)]
        },
        peekTools: () => {
          assertOperation()
          return [structuredClone(tool)]
        },
        getTool: async (id) => {
          assertOperation()
          return [tool.capabilityId, tool.toolId, tool.canonicalToolId].includes(id)
            ? structuredClone(tool)
            : null
        },
        invoke: async (id, effectiveArgs) => {
          assertOperation()
          // This must be the audited/authorized production ModCallContext, not FunctionExecution alone.
          if (!getModCallContext() || id !== tool.capabilityId || transported)
            throw new ModError("FLOW_MCP_EXACT_INVOCATION_REQUIRED")
          validateRegisteredToolInput(inputSchema, clawActionObject(effectiveArgs))
          transported = true
          const result = await service.invoke(id, effectiveArgs, assertOperation)
          assertOperation()
          return result
        },
        invalidate: async () => {},
        close: async () => {}
      }
      return withFunctionCommandBinding(
        "mcp",
        options.workspace,
        options.threadId,
        combined,
        async () => {
          assertOperation()
          const execution = currentFunctionExecution()
          if (
            !execution ||
            execution.workspace !== options.workspace ||
            execution.threadId !== options.threadId ||
            execution.turnId !== options.turnId
          )
            throw new ModError("MODS_CALL_SCOPE_CHANGED")
          const { createScopedMcpCapabilityService } = await import("../../agent/runtime")
          assertOperation()
          const scope = createHookScope()
          let release = () => {}
          createScopedMcpCapabilityService(
            exact,
            scope,
            (event, context) => resolveEnabledHooksForRun(options.workspace, event, context, scope),
            undefined,
            undefined,
            {
              workspacePath: options.workspace,
              threadId: options.threadId,
              turnId: options.turnId,
              agentId: execution.agentId,
              runtimeAuthority: execution.runtimeAuthority,
              signal: combined,
              readOnly: false,
              directMcpInvocation: true,
              onModBinding: (dispose) => {
                release = dispose
              }
            }
          )
          return release
        },
        async () => {
          assertOperation()
          const input = { server: tool.providerAlias, tool: tool.toolName, args }
          const result = options.hostAuthority
            ? await options.manager.invokeHostFlowMcp(
                options.hostAuthority(),
                input,
                combined,
                fingerprint
              )
            : await options.withOwnerGrant!((grant) =>
                options.manager.invokeFunctionMcp(
                  options.workspace,
                  options.threadId,
                  grant,
                  input,
                  combined,
                  false,
                  true,
                  fingerprint
                )
              )
          assertOperation()
          if (outputSchema && result.isError !== true)
            validateRegisteredToolInput(outputSchema, clawActionObject(result.structuredContent))
          // Result is already protected by the normal SDK publication path. Never parse text as JSON.
          return clawActionObject({
            isError: result.isError === true,
            ...(result.structuredContent === undefined
              ? {}
              : { structuredContent: result.structuredContent }),
            text: (result.content as ModObject[])
              .filter((block) => block.type === "text" && typeof block.text === "string")
              .map((block) => block.text)
              .join("\n")
          })
        }
      )
    }
  }
}
