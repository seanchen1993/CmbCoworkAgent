import type {
  HarnessAgentmdLoadStatusItem,
  HarnessDeployUnitMapping,
  HarnessProjectModeSubagentConfig,
  HarnessRequestUserInputConfig,
  HarnessProjectMetadata
} from "../../shared/harness-board-types"
const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)
const normalizeText = (value: unknown): string => (typeof value === "string" ? value : "")
export interface HarnessFeatureAgentContext {
  systemPromptInject?: string
  enableAgentsPrompt?: boolean
  agentConfig?: HarnessAgentConfig
  harnessAgentsPrompt?: string
  additionalAgentsWorkspacePaths?: string[]
  additionalAgentsWorkspaceMappings?: HarnessDeployUnitMapping[]
  sessionContextInjectWarning?: string
  agentmdLoadStatus?: HarnessAgentmdLoadStatusItem[]
  pluginOutputDir?: string
  systemId?: string
  pluginRoot?: string
  pluginId?: string
  pluginName?: string
  pluginWorkspace?: string
  featureId?: string
  /** Harness project stable id (= properties.harnessProjectId on events). Exposed to hooks as HARNESS_PROJECT_ID. */
  harnessProjectId?: string
  /** Bound adapter name (= properties.harnessAdapterName on events). Exposed to hooks as HARNESS_ADAPTER_NAME. */
  harnessAdapterName?: string
  /** Bound adapter version (= properties.harnessAdapterVersion on events). Exposed to hooks as HARNESS_ADAPTER_VERSION. */
  harnessAdapterVersion?: string
  projectCode?: string
  projectDir?: string
}

export interface HarnessFeatureAgentContextOptions {
  workspacePath?: string
  /** Resolve tool policy from the plugin while a project feature session is created. */
  requestUserInputConfigSource?: "plugin" | "session_snapshot"
}

export function isHarnessSessionContextOk(value: unknown): boolean {
  return value === true
}

export type HarnessRuntimeAgentMode = "solo" | "multi" | "agent_team" | "workflow"

export interface HarnessAgentConfig {
  agentMode?: HarnessRuntimeAgentMode
  subagentConfig?: HarnessProjectModeSubagentConfig
  toolConfig?: {
    requestUserInput?: HarnessRequestUserInputConfig
  }
}

export const DEFAULT_HARNESS_REQUEST_USER_INPUT_CONFIG: HarnessRequestUserInputConfig = {
  allowAutoResolution: false,
  autoResolutionType: "select_first"
}

const REQUEST_USER_INPUT_TIMEOUT_MIN_MS = 30_000
const REQUEST_USER_INPUT_TIMEOUT_MAX_MS = 240_000
const REQUEST_USER_INPUT_TIMEOUT_MESSAGE_MAX_CHARS = 1_000

export function normalizeHarnessRequestUserInputConfig(
  value: unknown
): HarnessRequestUserInputConfig | undefined {
  if (!isObject(value)) return undefined

  if (value.allowAutoResolution !== true) {
    return { ...DEFAULT_HARNESS_REQUEST_USER_INPUT_CONFIG }
  }

  const defaultTimeoutMs =
    typeof value.defaultTimeoutMs === "number" &&
    Number.isInteger(value.defaultTimeoutMs) &&
    value.defaultTimeoutMs >= REQUEST_USER_INPUT_TIMEOUT_MIN_MS &&
    value.defaultTimeoutMs <= REQUEST_USER_INPUT_TIMEOUT_MAX_MS
      ? value.defaultTimeoutMs
      : undefined
  const userMessage = normalizeText(value.userMessage).trim()
  const autoResolutionType =
    value.autoResolutionType === "user_message" && userMessage ? "user_message" : "select_first"

  return {
    allowAutoResolution: true,
    ...(defaultTimeoutMs !== undefined ? { defaultTimeoutMs } : {}),
    autoResolutionType,
    ...(autoResolutionType === "user_message"
      ? { userMessage: userMessage.slice(0, REQUEST_USER_INPUT_TIMEOUT_MESSAGE_MAX_CHARS) }
      : {})
  }
}

export function resolveHarnessRequestUserInputConfig(
  value: unknown
): HarnessRequestUserInputConfig {
  const normalized = normalizeHarnessRequestUserInputConfig(value)
  return normalized ?? { ...DEFAULT_HARNESS_REQUEST_USER_INPUT_CONFIG }
}

export function normalizeHarnessAgentConfig(value: unknown): HarnessAgentConfig | undefined {
  if (!isObject(value)) return undefined

  const agentMode =
    value.agentMode === "solo" ||
    value.agentMode === "multi" ||
    value.agentMode === "agent_team" ||
    value.agentMode === "workflow"
      ? value.agentMode
      : undefined
  const normalizeStringList = (input: unknown): string[] => {
    if (!Array.isArray(input)) return []
    return [
      ...new Set(
        input
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean)
      )
    ]
  }
  const subagentConfig = isObject(value.subagentConfig)
    ? {
        disabledBuiltinSubagents: normalizeStringList(
          value.subagentConfig.disabledBuiltinSubagents
        ),
        customSubagentFiles: normalizeStringList(value.subagentConfig.customSubagentFiles)
      }
    : undefined

  const requestUserInputConfig = isObject(value.toolConfig)
    ? normalizeHarnessRequestUserInputConfig(value.toolConfig.requestUserInput)
    : undefined

  if (!agentMode && !subagentConfig && !requestUserInputConfig) return undefined
  return {
    ...(agentMode ? { agentMode } : {}),
    ...(subagentConfig ? { subagentConfig } : {}),
    ...(requestUserInputConfig ? { toolConfig: { requestUserInput: requestUserInputConfig } } : {})
  }
}

export interface HarnessContextAssembly {
  identity: Pick<
    HarnessFeatureAgentContext,
    | "pluginOutputDir"
    | "systemId"
    | "pluginRoot"
    | "pluginId"
    | "pluginName"
    | "pluginWorkspace"
    | "featureId"
    | "harnessProjectId"
    | "harnessAdapterName"
    | "harnessAdapterVersion"
    | "projectCode"
    | "projectDir"
  >
  staticPrompt?: string
  session?: {
    prompt?: string
    warning?: string
    agentmdLoadStatus?: HarnessAgentmdLoadStatusItem[]
    agentConfig?: HarnessAgentConfig
  }
  mappings: HarnessDeployUnitMapping[]
  additionalRootsPrompt?: string
  requestUserInputConfig?: unknown
  requestUserInputConfigSource?: "plugin" | "session_snapshot"
}
/** Shared ordinary/Bot assembly. Inputs have already crossed their host's permission boundary. */
export function assembleHarnessFeatureAgentContext(
  input: HarnessContextAssembly
): HarnessFeatureAgentContext {
  const pluginAgentConfig = input.session?.agentConfig
  const requestUserInput =
    input.requestUserInputConfigSource === "plugin"
      ? resolveHarnessRequestUserInputConfig(pluginAgentConfig?.toolConfig?.requestUserInput)
      : resolveHarnessRequestUserInputConfig(input.requestUserInputConfig)
  const prompt = input.session?.prompt?.trim()
  const roots = input.mappings.map((mapping) => mapping.localRepoPath)
  return {
    ...input.identity,
    systemPromptInject:
      [input.staticPrompt, !prompt ? input.additionalRootsPrompt : undefined]
        .filter(Boolean)
        .join("\n\n") || undefined,
    enableAgentsPrompt: !prompt,
    agentConfig: { ...pluginAgentConfig, toolConfig: { requestUserInput } },
    ...(prompt ? { harnessAgentsPrompt: prompt } : {}),
    ...(!prompt && roots.length
      ? { additionalAgentsWorkspacePaths: roots, additionalAgentsWorkspaceMappings: input.mappings }
      : {}),
    ...(input.session?.warning ? { sessionContextInjectWarning: input.session.warning } : {}),
    ...(input.session?.agentmdLoadStatus
      ? { agentmdLoadStatus: input.session.agentmdLoadStatus }
      : {})
  }
}
/** Only runtime identity fields belong in Hook stdin/env; prompts and grants do not. */
export function harnessContextHookFields(context?: HarnessFeatureAgentContext) {
  return {
    pluginOutputDir: context?.pluginOutputDir,
    systemId: context?.systemId,
    pluginRoot: context?.pluginRoot,
    pluginId: context?.pluginId,
    pluginName: context?.pluginName,
    pluginWorkspace: context?.pluginWorkspace,
    featureId: context?.featureId,
    harnessProjectId: context?.harnessProjectId,
    harnessAdapterName: context?.harnessAdapterName,
    harnessAdapterVersion: context?.harnessAdapterVersion,
    projectCode: context?.projectCode,
    projectDir: context?.projectDir
  }
}

export interface HarnessCommandParseOptions {
  leanToken?: string
  feature?: string
  selectedDeployUnitsJson?: string
  sessionWorkspacePath?: string
  projectDirs?: string[]
  workflowTemplate?: string
  workflowNodes?: string
  nodeId?: string
  eventJson?: string
  preserveMissingPlaceholders?: boolean
}
export type HarnessInspectCommandName =
  | "project"
  | "run"
  | "createProject"
  | "createFeature"
  | "dynamicWorkflow"
  | "skipNode"
  | "sessionContext"
  | "pullKnowledge"

function tokenizeInspectCommand(command: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: '"' | "'" | null = null

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]
    if (!ch) continue

    if (!quote) {
      if (ch === "\\") {
        const next = command[i + 1]
        if (next && (/\s/.test(next) || next === '"' || next === "'" || next === "\\")) {
          current += next
          i += 1
          continue
        }
        current += ch
        continue
      }
      if (ch === '"' || ch === "'") {
        quote = ch
        continue
      }
      if (/\s/.test(ch)) {
        if (current) {
          tokens.push(current)
          current = ""
        }
        continue
      }
      current += ch
      continue
    }

    if (quote === '"' && ch === "\\") {
      const next = command[i + 1]
      if (next === '"' || next === "\\") {
        current += next
        i += 1
        continue
      }
    }

    if (ch === quote) {
      quote = null
      continue
    }

    current += ch
  }

  if (quote) {
    throw new Error("Inspect adapter command parse failed: quote is not closed")
  }
  if (current) {
    tokens.push(current)
  }
  return tokens
}

export function replaceHarnessConfigPlaceholders(
  value: string,
  project: HarnessProjectMetadata,
  mode: HarnessInspectCommandName,
  cwd: string,
  options: HarnessCommandParseOptions = {}
): string {
  const projectDir = project.projectDir.trim() || project.projectCode.trim()
  const leanToken = options.leanToken ?? ""
  const replacements: Record<string, string | undefined> = {
    pluginWorkspace: project.workspacePath,
    project: projectDir,
    projectDir,
    projectCode: project.projectCode,
    leanToken,
    feature: options.feature ?? "",
    selectedDeployUnits: options.selectedDeployUnitsJson ?? "",
    sessionWorkspacePath: options.sessionWorkspacePath ?? "",
    pluginPath: cwd,
    mode,
    workflowTemplate: options.workflowTemplate ?? "",
    workflowNodes: options.workflowNodes ?? "",
    nodeId: options.nodeId ?? "",
    eventJson: options.eventJson ?? ""
  }
  return value.replace(
    /\$\{(pluginWorkspace|project|projectDir|projectCode|leanToken|feature|selectedDeployUnits|sessionWorkspacePath|pluginPath|mode|workflowTemplate|workflowNodes|nodeId|eventJson)\}/g,
    (placeholder: string, key: string) => {
      const replacement = replacements[key]
      if (replacement) return replacement
      return options.preserveMissingPlaceholders ? placeholder : ""
    }
  )
}

export function parseInspectCommand(
  command: string,
  project: HarnessProjectMetadata,
  mode: HarnessInspectCommandName,
  cwd: string,
  options: HarnessCommandParseOptions = {}
): { executable: string; args: string[]; sensitiveValues?: readonly string[] } {
  const args: string[] = []
  const optionalCommandArgs: Array<{
    key: keyof Pick<
      HarnessCommandParseOptions,
      "workflowTemplate" | "workflowNodes" | "selectedDeployUnitsJson"
    >
    placeholder: string
    flag: string
  }> = [
    { key: "workflowTemplate", placeholder: "${workflowTemplate}", flag: "--workflow-template" },
    { key: "workflowNodes", placeholder: "${workflowNodes}", flag: "--workflow-nodes" },
    {
      key: "selectedDeployUnitsJson",
      placeholder: "${selectedDeployUnits}",
      flag: "--selected-deployUnit"
    }
  ]
  const tokens = tokenizeInspectCommand(command.trim())
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if ((token === "${projectCodes...}" || token === "${projectDirs...}") && options.projectDirs) {
      args.push(...options.projectDirs)
      continue
    }
    const optionalArg = optionalCommandArgs.find(
      (item) =>
        !options[item.key] &&
        (token === item.placeholder ||
          token === `${item.flag}=${item.placeholder}` ||
          (token === item.flag && tokens[index + 1] === item.placeholder))
    )
    if (optionalArg) {
      if (token === optionalArg.flag) index += 1
      continue
    }
    args.push(replaceHarnessConfigPlaceholders(token, project, mode, cwd, options))
  }
  const [executable, ...restArgs] = args
  if (!executable) {
    throw new Error("Inspect adapter command is empty")
  }
  const result = { executable, args: restArgs }
  if (options.leanToken)
    Object.defineProperty(result, "sensitiveValues", {
      value: [options.leanToken],
      enumerable: false
    })
  return result
}

/** In-memory invocation credentials are never copied into serializable diagnostics. */
export function redactHarnessText(
  text: string,
  invocation: { sensitiveValues?: readonly string[] }
): string {
  for (const value of invocation.sensitiveValues ?? []) {
    if (!value) continue
    text = text
      .replaceAll(value, "[已隐藏凭据]")
      .replaceAll(JSON.stringify(value).slice(1, -1), "[已隐藏凭据]")
  }
  return text
}
export function redactHarnessValue(
  value: unknown,
  invocation: { sensitiveValues?: readonly string[] },
  depth = 0
): unknown {
  if (depth > 32) throw new Error("项目上下文嵌套过深")
  if (typeof value === "string") return redactHarnessText(value, invocation)
  if (Array.isArray(value))
    return value.map((item) => redactHarnessValue(item, invocation, depth + 1))
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactHarnessText(key, invocation),
        redactHarnessValue(item, invocation, depth + 1)
      ])
    )
  return value
}
