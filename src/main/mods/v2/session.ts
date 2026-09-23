import type { FunctionSessionReadMethod } from "../../../shared/mods/v2/session"
import { ModFunctionError, isModObject } from "../../../shared/mods/v2/contracts"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import type { FunctionCommand } from "../../../shared/mods/v2/commands"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"
import { FunctionDispatcher, type FunctionPlugin } from "./dispatcher"
import { FunctionEngineNouns } from "./engine-nouns"
import { withFunctionBackgroundOwner } from "./background-owner"
import {
  basicSdkInput,
  runBasicSdk,
  SESSION_CAPABILITIES as BASIC_CAPABILITIES,
  validateBasicInput,
  validateBasicResult
} from "./basic-sdk"
import {
  FUNCTION_UI_CAPABILITIES,
  validateFunctionTree,
  validatePaneArgs
} from "../../../shared/mods/v2/ui"
import { FunctionPanes, type FunctionUiDispatch } from "./panes"
export const SESSION_CAPABILITIES = [
  ...BASIC_CAPABILITIES,
  ...FUNCTION_UI_CAPABILITIES,
  "tool.call",
  "tool.register",
  "tool.list",
  "tool.check",
  "mcp.call",
  "model.complete",
  "model.fork",
  "model.classify",
  "turn.abort"
]
import type { FunctionStateAccess } from "./state-store"
import { FILE_CAPABILITIES, type FunctionFileAccess } from "./file-access"
import { resolve } from "node:path"
import { FunctionClients } from "./clients"
import type { FunctionGuest, ModOrigin } from "../../../shared/mods/v2/contracts"
import { randomUUID } from "node:crypto"
import {
  parseCompletionGateDecision,
  type CompletionGateDecision
} from "../../agent/skill-lifecycle/completion-gate"
import {
  functionSdkToolInput,
  validateFunctionToolResult,
  validateModelToolInput
} from "./tool-sdk"
import { functionModelRequest, validateFunctionModelText } from "./model-sdk"
import { functionModelClassifyRequest, functionModelForkRequest } from "./model-operations"
import { FunctionToolRegistry, functionToolSpec } from "./tool-registry"
import type { FunctionToolInfo, RegisteredFunctionTool } from "../../../shared/mods/v2/tools"
import {
  functionMcpInput,
  functionRegisteredMcpResult,
  validateFunctionMcpResult,
  type FunctionMcpToolDispatch
} from "./mcp-sdk"
import { functionToolCheckInput, validateToolCheckResult } from "./tool-check"
import { constrainToolPermission, type ToolPermissionResult } from "../../../shared/tool-permission"
import { validateRegisteredToolInput } from "./tool-schema"
import { functionCallAgent, withFunctionAgentExecution } from "./host-call"
import { dispatchFunctionStream, type FunctionStreamOptions, type ModHookStream } from "./stream-dispatcher"
import { currentFunctionExecution, assertFunctionPublicationScope } from "./execution-context"
import { functionMcpToolName } from "./mcp-names"
import type {
  FunctionTurnStart,
  FunctionTurnComplete,
  FunctionTurnResult
} from "../../../shared/mods/v2/turn"
import {
  validateFunctionTurnInput,
  validateFunctionTurnResult,
  validateFunctionTurnStepInput
} from "./turn-contract"
import { FunctionTurnAbortBudget } from "./turn-lifecycle"
import {
  assertPinnedAgentOfferProvider,
  validateFunctionAgentOfferInput,
  validateFunctionAgentOfferResult
} from "../../../shared/mods/v2/agent"
import { validateClassicInput, validateClassicResult } from "../../../shared/mods/v2/classic"
import { parseCompletionPolicy, type CompletionPolicy } from "../../../shared/mods/v2/completion-policy"
import { CompletionBudget, withCompletionBudget } from "./completion-budget"

export interface FunctionSessionHost {
  threadId: string
  workspace: string
  cwd?(): string
  readSession?(
    method: FunctionSessionReadMethod,
    signal: AbortSignal,
    usageArgs?: import("../../../shared/mods/v2/session").FunctionSessionUsageArgs
  ): Promise<ModJson>
  compactSession?(instructions: string, signal: AbortSignal): Promise<ModJson>
  abortTurn?(plugin: FunctionPlugin, turnId: string, signal: AbortSignal): Promise<void>
  assertLive(plugin?: FunctionPlugin): void
  uiChanged?(): void
  loadClient?(plugin: string, module: string): Promise<FunctionGuest>
  callTool?(plugin: FunctionPlugin, input: ModObject, signal: AbortSignal): Promise<ModObject>
  callMcp?(
    plugin: FunctionPlugin,
    input: ModObject,
    signal: AbortSignal,
    dispatch: FunctionMcpToolDispatch
  ): Promise<ModObject>
  checkTool?(
    plugin: FunctionPlugin,
    input: ModObject,
    signal: AbortSignal,
    registered?: RegisteredFunctionTool
  ): Promise<ToolPermissionResult>
  listTools?(signal: AbortSignal): Promise<FunctionToolInfo[]>
  filterTools?(tools: FunctionToolInfo[]): FunctionToolInfo[]
  assertToolNameAvailable?(plugin: string, name: string): void
  registeredTool?(
    owner: FunctionPlugin,
    input: ModObject,
    origin: "model" | "mod",
    signal: AbortSignal,
    run: () => Promise<ModObject>,
    caller?: ModOrigin
  ): Promise<ModObject>
  completeModel?(plugin: FunctionPlugin, input: ModObject, signal: AbortSignal): Promise<string>
  scheduleCommand?(
    command: FunctionCommand,
    signal: AbortSignal,
    run: (signal: AbortSignal) => Promise<ModObject>
  ): Promise<ModObject>
  publish(value: ModJson, signal: AbortSignal): Promise<ModJson>
  state?(plugin: FunctionPlugin): FunctionStateAccess
  files?(plugin: FunctionPlugin): FunctionFileAccess
  capability?(
    plugin: FunctionPlugin,
    method: string,
    args: ModJson[],
    signal: AbortSignal
  ): Promise<ModJson | undefined>
}

/** A session keeps registration state and VMs across turns; every call still has its own frame. */
export class FunctionSession {
  readonly panes: FunctionPanes
  readonly clients: FunctionClients
  private readonly controller = new AbortController()
  private readonly registry = new Map<string, FunctionCommand>()
  private readonly tools = new FunctionToolRegistry()
  private readonly dispatcher: FunctionDispatcher
  private readonly nouns: FunctionEngineNouns
  private starting?: Promise<void>
  private readonly abortBudget = new FunctionTurnAbortBudget()

  constructor(
    readonly plugins: readonly FunctionPlugin[],
    private readonly host: FunctionSessionHost
  ) {
    this.dispatcher = new FunctionDispatcher(plugins)
    this.nouns = new FunctionEngineNouns(plugins, (plugin) => this.assertLive(plugin))
    this.clients = new FunctionClients({
      assertLive: () => this.assertLive(),
      // Mounted surfaces outlive the event that created them. A host timer is a fresh
      // read-only entry; it never inherits a click's lease or user-write authority.
      background: (run) =>
        withFunctionAgentExecution(
          {
            workspace: host.workspace,
            threadId: host.threadId,
            userInitiated: false,
            leased: false,
            immediate: true
          },
          run
        ),
      changed: () => this.panes.notify(),
      publish: (value) => this.host.publish(value, this.controller.signal),
      load: (plugin, module) => {
        if (!this.host.loadClient) throw new ModFunctionError("MODS_CLIENT_UNAVAILABLE")
        return this.host.loadClient(plugin, module)
      },
      message: (plugin, input, signal) =>
        this.dispatch("ui.message", input, signal, undefined, 0, undefined, undefined, {
          onlyPlugin: plugin,
          origin: { plugin: "client", tier: "core" },
          core: async () => ({})
        }),
      control: (event, input, core, signal) =>
        this.dispatch(event, input, signal, undefined, 0, undefined, undefined, { core })
    })
    this.panes = new FunctionPanes({
      clients: this.clients,
      plugins,
      assertLive: () => this.assertLive(),
      changed: () => this.host.uiChanged?.(),
      publish: (value) => this.host.publish(value, this.controller.signal),
      dispatch: (event, input, presentation) =>
        this.dispatch(
          event,
          input,
          presentation.signal,
          undefined,
          0,
          undefined,
          undefined,
          presentation
        ),
      callback: async (plugin, event, input, callback, signal) => {
        this.assertLive(plugin)
        await plugin.guest.invoke(
          "callback",
          input,
          async (method, args, callSignal) => {
            if (!this.nouns.capabilities(plugin).includes(method))
              throw new ModFunctionError("MODS_CAPABILITY_DENIED")
            const value = await this.capability(
              plugin,
              method,
              args,
              callSignal,
              { event, registration: "callback" },
              0,
              undefined
            )
            return value === undefined ? {} : { value }
          },
          {
            event,
            timeoutMs: 120000,
            callback,
            signal,
            origin: { plugin: "engine", tier: "core" },
            capabilities: this.nouns.capabilities(plugin),
            plugin: { name: plugin.name, root: plugin.root }
          }
        )
        this.assertLive(plugin)
      }
    })
  }

  start(): Promise<void> {
    this.starting ??= this.nouns.build(this.controller.signal).then(() =>
      this.dispatch("session.start", {
        cwd: this.host.cwd?.() ?? this.host.workspace,
        surface: "desktop",
        isInteractive: true
      }).then(() => {})
    )
    return this.starting
  }

  private assertLive(plugin?: FunctionPlugin, publication = false): void {
    this.controller.signal.throwIfAborted()
    if (publication) assertFunctionPublicationScope(this.host.workspace, this.host.threadId)
    else currentFunctionExecution()
    this.host.assertLive(plugin)
    if (plugin?.guest.stats.disposed) throw new ModFunctionError("MODS_UNLOADED")
  }

  async commands(signal?: AbortSignal, includeHidden = false): Promise<FunctionCommand[]> {
    await this.start()
    const commands: FunctionCommand[] = []
    for (const registered of this.registry.values()) {
      const result = await this.dispatch(
        "command.describe",
        {
          command: registered.name,
          description: registered.description,
          isHidden: false,
          immediate: registered.immediate === true,
          provider: { plugin: registered.plugin, tier: "user" },
          ...(registered.argumentHint ? { argumentHint: registered.argumentHint } : {})
        },
        signal
      )
      if (
        !isModObject(result) ||
        typeof result.description !== "string" ||
        typeof result.isHidden !== "boolean"
      )
        throw new ModFunctionError("MODS_COMMAND_DESCRIPTION")
      if (result.isHidden && !includeHidden) continue
      commands.push({
        ...registered,
        ...(result.isHidden ? { isHidden: true } : {}),
        description: result.description,
        ...(typeof result.argumentHint === "string" ? { argumentHint: result.argumentHint } : {})
      })
    }
    return commands
  }

  async turnStart(input: FunctionTurnStart, signal?: AbortSignal): Promise<void> {
    await this.start()
    await this.dispatch("turn.start", { ...input }, signal, undefined, 0, undefined, "turn.start", {
      core: async (value) => ({ turnId: value.turnId })
    })
  }

  hasCompletionGate(): boolean {
    return this.plugins.some((plugin) =>
      plugin.guest.registrations.some((registration) => registration.pattern === "completion.check")
    )
  }

  /** CMB extension: independent votes, never the optional-hook recovery chain. */
  async checkCompletion(
    input: ModObject,
    signal: AbortSignal,
    options: {
      policies?: ReadonlyMap<string, CompletionPolicy | undefined>
      budgets?: ReadonlyMap<string, CompletionBudget>
      evidence?(plugin: string, detail: ModObject): void
    } = {}
  ): Promise<CompletionGateDecision> {
    this.assertLive()
    const sessionSignal = AbortSignal.any([signal, this.controller.signal])
    const reasons: string[] = []
    let blocked = false
    for (const plugin of this.plugins) {
      let policy = options.policies?.get(plugin.name)
      if (!options.policies) {
        const raw = await this.host.state?.(plugin).get("completion-config", sessionSignal)
        if (raw !== undefined && raw !== null) policy = parseCompletionPolicy(raw)
      }
      if (policy?.mode === "off" || (policy && !policy.checks.includes("code-review"))) continue
      const budget = policy
        ? (options.budgets?.get(plugin.name) ??
          new CompletionBudget(policy.modelTokenBudget, policy.timeoutMs))
        : undefined
      let reviewed = false
      for (const registration of plugin.guest.registrations) {
        if (registration.pattern !== "completion.check") continue
        try {
          sessionSignal.throwIfAborted()
          this.assertLive(plugin)
          const timeoutMs = Math.min(120000, budget?.remainingMs() ?? 120000)
          const scoped = AbortSignal.any([sessionSignal, AbortSignal.timeout(timeoutMs)])
          const check = async (): Promise<CompletionGateDecision | undefined> => {
            if (!(await plugin.guest.matches(registration.id, input))) return undefined
            const answer = await plugin.guest.invoke(
              registration.id,
              {
                ...input,
                ...(policy
                  ? { completionPolicy: JSON.parse(JSON.stringify(policy)) as ModJson }
                  : {})
              },
              async (method, args, callSignal) => {
                this.assertLive(plugin)
                if (method === "next") return { value: { decision: "pass" } }
                if (!plugin.capabilities.includes(method))
                  throw new ModFunctionError("MODS_CAPABILITY_DENIED")
                const value = await this.capability(
                  plugin,
                  method,
                  args,
                  callSignal,
                  { event: "completion.check", registration: registration.id },
                  0,
                  "completion.check"
                )
                return value === undefined ? {} : { value }
              },
              {
                event: "completion.check",
                origin: { plugin: "engine", tier: "core" },
                capabilities: plugin.capabilities,
                plugin: { name: plugin.name, root: plugin.root },
                signal: scoped,
                timeoutMs
              }
            )
            scoped.throwIfAborted()
            this.assertLive(plugin)
            return parseCompletionGateDecision(answer.value)
          }
          const decision = budget ? await withCompletionBudget(budget, check) : await check()
          if (!decision) continue
          reviewed = true
          options.evidence?.(plugin.name, {
            ...decision,
            mode: policy?.mode ?? "legacy",
            check: "code-review",
            source: "guest-opinion",
            businessAccepted: false,
            ...(budget
              ? {
                  outputTokensReserved: budget.outputReserved,
                  modelTokenBudget: budget.tokenLimit,
                  inputTokens: budget.inputTokens,
                  outputTokens: budget.outputTokens
                }
              : {})
          })
          if (policy?.mode === "report" || decision.decision === "pass") continue
          const attempts = typeof input.revisionAttempts === "number" ? input.revisionAttempts : 0
          if (
            decision.decision === "block" ||
            (policy && (policy.mode !== "repair" || attempts >= policy.maxRepairs))
          )
            blocked = true
          reasons.push(`${plugin.name}: ${decision.reason}`)
        } catch (error) {
          sessionSignal.throwIfAborted()
          this.assertLive(plugin)
          if (!policy) throw error
          reviewed = true
          let reason = error instanceof Error ? error.message : "COMPLETION_CHECK_FAILED"
          try {
            budget?.assert()
          } catch (failure) {
            reason = failure instanceof Error ? failure.message : reason
          }
          options.evidence?.(plugin.name, {
            decision: "block",
            reason,
            mode: policy.mode,
            check: "code-review",
            source: "guest-error",
            businessAccepted: false,
            ...(budget
              ? {
                  outputTokensReserved: budget.outputReserved,
                  modelTokenBudget: budget.tokenLimit,
                  inputTokens: budget.inputTokens,
                  outputTokens: budget.outputTokens
                }
              : {})
          })
          if (policy.mode === "report") continue
          blocked = true
          reasons.push(`${plugin.name}: ${reason}`)
        }
      }
      if (policy && !reviewed) {
        const reason = `COMPLETION_CHECK_UNAVAILABLE: ${plugin.name}: code-review`
        options.evidence?.(plugin.name, {
          decision: "block",
          reason,
          mode: policy.mode,
          check: "code-review",
          source: "guest-unavailable",
          businessAccepted: false
        })
        if (policy.mode !== "report") {
          blocked = true
          reasons.push(reason)
        }
      }
    }
    sessionSignal.throwIfAborted()
    this.assertLive()
    const result: ModObject = reasons.length
      ? { decision: blocked ? "block" : "revise", reason: reasons.join("\n").slice(0, 8000) }
      : { decision: "pass" }
    const safe = await this.host.publish(result, sessionSignal)
    sessionSignal.throwIfAborted()
    this.assertLive(undefined, true)
    return parseCompletionGateDecision(safe)
  }

  async turnComplete(
    input: FunctionTurnComplete,
    signal?: AbortSignal
  ): Promise<FunctionTurnResult> {
    await this.start()
    return (await this.dispatch(
      "turn.complete",
      input as unknown as ModObject,
      signal,
      undefined,
      0,
      undefined,
      undefined,
      {
        core: async (value) => ({
          text: value.answer,
          ...(value.usage ? { usage: value.usage } : {})
        })
      }
    )) as unknown as FunctionTurnResult
  }

  /** The host-owned main-model boundary. Hooks only receive normalized, published chunks. */
  async turnStep(
    input: ModObject,
    core: FunctionStreamOptions["core"],
    signal?: AbortSignal
  ): Promise<ModHookStream> {
    await this.start()
    this.assertLive()
    const scoped = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal
    validateFunctionTurnStepInput(input)
    return dispatchFunctionStream(this.plugins, input, {
      signal: scoped,
      core,
      validateInput: validateFunctionTurnStepInput
    })
  }

  async run(command: string, args: string, signal?: AbortSignal): Promise<ModObject> {
    await this.start()
    this.assertLive()
    if (!this.registry.has(command)) throw new ModFunctionError("MODS_COMMAND_MISSING")
    if (typeof args !== "string" || args.length > 32000)
      throw new ModFunctionError("MODS_COMMAND_ARGS")
    const value = await withFunctionBackgroundOwner(signal ?? this.controller.signal, () =>
      this.dispatch(
        "command.run",
        {
          command,
          args,
          origin: { kind: "composer" },
          presentation: { isFullscreen: false, columns: 80 }
        },
        signal
      )
    )
    if (!isModObject(value) || (value.text !== undefined && typeof value.text !== "string"))
      throw new ModFunctionError("MODS_COMMAND_RESULT")
    return value
  }

  async interceptTool(
    input: ModObject,
    signal: AbortSignal | undefined,
    core: (input: ModObject, signal: AbortSignal) => Promise<ModObject>
  ): Promise<ModObject> {
    await this.start()
    if (this.tools.get(String(input.tool)))
      return this.runRegisteredTool(input, signal, undefined, 0, "tool.call")
    return (await this.dispatch("tool.call", input, signal, undefined, 0, undefined, "tool.call", {
      core,
      modelTool: true
    })) as ModObject
  }

  async offerAgent(
    input: ModObject,
    signal?: AbortSignal,
    core: (input: ModObject, signal: AbortSignal) => Promise<ModJson> = async () => ({
      isOffered: true
    })
  ): Promise<ModObject> {
    await this.start()
    validateFunctionAgentOfferInput(input)
    const provider = input.provider as ModObject
    const value = await this.dispatch(
      "agent.offer",
      input,
      signal,
      undefined,
      0,
      undefined,
      undefined,
      {
        core: async (received, callSignal) => {
          validateFunctionAgentOfferInput(received)
          assertPinnedAgentOfferProvider(received, provider)
          return core(received, callSignal)
        }
      }
    )
    if (!isModObject(value)) throw new ModFunctionError("MODS_AGENT_OFFER_RESULT")
    validateFunctionAgentOfferResult(value)
    return value
  }

  async classicEvent(
    event: string,
    input: ModObject,
    signal?: AbortSignal,
    core: (input: ModObject, signal: AbortSignal) => Promise<ModJson> = async () => ({})
  ): Promise<ModObject> {
    await this.start()
    if (!event.startsWith("classic.")) throw new ModFunctionError("MODS_CLASSIC_EVENT_INVALID")
    const value = await this.dispatch(
      event,
      input,
      signal,
      undefined,
      0,
      undefined,
      undefined,
      { core }
    )
    if (!isModObject(value)) throw new ModFunctionError("MODS_CLASSIC_RESULT")
    return value
  }

  async registeredTools(): Promise<RegisteredFunctionTool[]> {
    await this.start()
    this.assertLive()
    const tools = this.tools.list()
    for (const tool of tools) this.host.assertToolNameAvailable?.(tool.plugin, tool.name)
    return tools
  }

  async checkTool(
    input: ModObject,
    signal: AbortSignal | undefined,
    core: (input: ModObject, signal: AbortSignal) => Promise<ModObject>,
    origin?: import("../../../shared/mods/v2/contracts").ModOrigin
  ): Promise<ToolPermissionResult> {
    const value = await this.dispatch(
      "tool.check",
      functionToolCheckInput(input, true),
      signal,
      undefined,
      0,
      undefined,
      undefined,
      { core, origin }
    )
    validateToolCheckResult(value)
    return value
  }

  private async runRegisteredTool(
    input: ModObject,
    signal: AbortSignal | undefined,
    skip: { plugin: string; registration: string } | undefined,
    depth: number,
    held?: string
  ): Promise<ModObject> {
    const tool = this.tools.validate(input)
    const owner = this.plugins.find((plugin) => plugin.name === tool?.plugin)
    if (!tool || !owner) throw new ModFunctionError("MODS_TOOL_UNAVAILABLE")
    const assertRegistered = () => {
      this.assertLive(owner)
      if (this.tools.get(tool.name) !== tool) throw new ModFunctionError("MODS_TOOL_CHANGED")
      this.host.assertToolNameAvailable?.(tool.plugin, tool.name)
    }
    assertRegistered()
    const scoped = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal
    const run = async (): Promise<ModObject> => {
      assertRegistered()
      const result = (await this.dispatch(
        "tool.call",
        input as unknown as ModObject,
        scoped,
        skip,
        depth,
        undefined,
        held,
        {
          modelTool: true,
          core: async () => {
            throw new ModFunctionError(
              "MODS_REGISTERED_TOOL_UNHANDLED",
              "MODS_REGISTERED_TOOL_UNHANDLED",
              true
            )
          }
        }
      )) as ModObject
      if (result.ref !== undefined) throw new ModFunctionError("MODS_TOOL_RESULT_REF")
      assertRegistered()
      return result
    }
    const caller = skip && this.plugins.find((plugin) => plugin.name === skip.plugin)
    const answer = await (this.host.registeredTool
      ? this.host.registeredTool(
          owner,
          input,
          skip ? "mod" : "model",
          scoped,
          run,
          caller ? { plugin: caller.name, tier: caller.tier } : { plugin: "engine", tier: "core" }
        )
      : run())
    assertRegistered()
    return answer
  }

  private async dispatch(
    event: string,
    input: ModObject,
    signal?: AbortSignal,
    skip?: { plugin: string; registration: string },
    depth = 0,
    operation?: {
      plugin: FunctionPlugin
      core(input: ModObject, signal: AbortSignal): Promise<ModJson | undefined>
    },
    held?: string,
    presentation?: FunctionUiDispatch & { modelTool?: boolean }
  ): Promise<ModJson> {
    if (depth > 16) throw new ModFunctionError("MODS_DISPATCH_DEPTH")
    this.assertLive()
    const turnHeld = held ?? (event === "command.run" ? "command.run" : undefined)
    const isOperation = !!operation || presentation?.operation === true
    const scopedSignal = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal
    const result = await this.dispatcher.dispatch(event, input, {
      capabilities: (plugin) => this.nouns.capabilities(plugin),
      skip,
      onlyPlugin: presentation?.onlyPlugin,
      signal: scopedSignal,
      operation: isOperation,
      ...(event === "command.run" ||
      event === "tool.call" ||
      event === "model.complete" ||
      event === "model.classify" ||
      event === "model.fork" ||
      event === "mcp.call" ||
      ["ui.press", "ui.input", "ui.select", "ui.focus", "ui.scroll", "ui.message"].includes(event)
        ? { timeoutMs: 120000 }
        : {}),
      ...(presentation?.generation ? { uiGeneration: presentation.generation } : {}),
      normalizeInput: (name, value) =>
        name === "tool.register"
          ? functionToolSpec(value)
          : FILE_CAPABILITIES.some((method) => method === name) &&
              typeof value.path === "string" &&
              value.path !== ""
            ? { ...value, path: resolve(this.host.cwd?.() ?? this.host.workspace, value.path) }
            : value,
      validateInput: (name, value) => {
        validateClassicInput(name, value)
        validateBasicInput(name, value)
        validateFunctionTurnInput(name, value)
        if (name === "tool.register") functionToolSpec(value)
        if (name === "tool.call") {
          if (presentation?.modelTool) {
            validateModelToolInput(value)
            this.tools.validate(value)
          } else functionSdkToolInput(value)
        }
        if (name === "model.complete") functionModelRequest(value)
        if (name === "model.classify") functionModelClassifyRequest(value)
        if (name === "model.fork") functionModelForkRequest(value)
        if (name === "agent.offer") validateFunctionAgentOfferInput(value)
        if (name === "mcp.call") functionMcpInput(value)
        if (name === "tool.check") functionToolCheckInput(value, true)
        if (name === "ui.open") validatePaneArgs(value)
        if (
          (name === "ui.input" || name === "ui.select") &&
          (typeof value.value !== "string" || value.value.length > 10000)
        )
          throw new ModFunctionError("MODS_UI_ACTION_INVALID")
        if (
          name === "ui.focus" &&
          (typeof value.focused !== "boolean" ||
            Object.keys(value).some(
              (key) =>
                ![
                  "surface",
                  "component",
                  "requestId",
                  "plugin",
                  "element",
                  "focused",
                  "origin"
                ].includes(key)
            ))
        )
          throw new ModFunctionError("MODS_UI_ACTION_INVALID")
        if (
          name === "ui.scroll" &&
          (!isModObject(value.value) ||
            Object.keys(value.value).some(
              (key) => !["deltaX", "deltaY", "top", "left"].includes(key)
            ) ||
            [value.value.deltaX, value.value.deltaY, value.value.top, value.value.left].some(
              (number) =>
                typeof number !== "number" || !Number.isFinite(number) || Math.abs(number) > 100000
            ))
        )
          throw new ModFunctionError("MODS_UI_ACTION_INVALID")
        if (name === "command.run" && (typeof value.args !== "string" || value.args.length > 32000))
          throw new ModFunctionError("MODS_COMMAND_ARGS")
      },
      validateResult: (name, value) => {
        validateClassicResult(name, value)
        validateFunctionTurnResult(name, value)
        if (name === "tool.check") return validateToolCheckResult(value)
        if (name === "tool.call") return validateFunctionToolResult(value)
        if (name === "ui.render") return validateFunctionTree(value)
        if (name === "agent.offer") validateFunctionAgentOfferResult(value as ModObject)
        if (isOperation) {
          if (!isModObject(value)) throw new ModFunctionError("MODS_OPERATION_RESULT")
          if (typeof value.deny === "string") return
          if (name === "model.complete") return validateFunctionModelText(value.value)
          if (
            name === "model.classify" &&
            value.value !== null &&
            value.value !== undefined &&
            typeof value.value !== "string"
          )
            throw new ModFunctionError("MODS_MODEL_RESULT_LIMIT")
          if (
            name === "model.fork" &&
            value.value !== null &&
            (!isModObject(value.value) || typeof value.value.text !== "string")
          )
            throw new ModFunctionError("MODS_MODEL_RESULT_LIMIT")
          if (name === "mcp.call") return validateFunctionMcpResult(value.value)
          if (
            name === "tool.register" &&
            (!isModObject(value.value) || typeof value.value.tool !== "string")
          )
            throw new ModFunctionError("MODS_TOOL_REGISTER_RESULT")
          if (
            name === "tool.list" &&
            (!Array.isArray(value.value) ||
              value.value.some(
                (tool) =>
                  !isModObject(tool) ||
                  typeof tool.name !== "string" ||
                  typeof tool.description !== "string" ||
                  typeof tool.mcp !== "boolean"
              ))
          )
            throw new ModFunctionError("MODS_TOOL_LIST_RESULT")
          return validateBasicResult(name, value.value)
        }
        if (!isModObject(value)) throw new ModFunctionError("MODS_EVENT_RESULT")
        if (
          name === "ui.focus" &&
          (Object.keys(value).length === 0 || typeof value.deny === "string")
        )
          return
        if (
          ["ui.press", "ui.input", "ui.select", "ui.focus", "ui.scroll"].includes(name) &&
          (typeof value.element !== "string" ||
            (["ui.input", "ui.select"].includes(name) &&
              (typeof value.value !== "string" || value.value.length > 10000)) ||
            (["ui.focus", "ui.scroll"].includes(name) && !Object.hasOwn(value, "value")))
        )
          throw new ModFunctionError("MODS_UI_ACTION_RESULT")
        if (name === "command.run" && value.text !== undefined && typeof value.text !== "string")
          throw new ModFunctionError("MODS_COMMAND_RESULT")
        if (
          name === "command.describe" &&
          (typeof value.description !== "string" || typeof value.isHidden !== "boolean")
        )
          throw new ModFunctionError("MODS_COMMAND_DESCRIPTION")
        if (name === "session.start" && typeof value.cwd !== "string")
          throw new ModFunctionError("MODS_SESSION_START_RESULT")
      },
      origin:
        presentation?.origin ??
        (skip ? { plugin: skip.plugin, tier: "user" } : { plugin: "engine", tier: "core" }),
      core: async (_, e): Promise<ModJson> => {
        this.assertLive(operation?.plugin)
        if (presentation?.core) return presentation.core(e, scopedSignal)
        if (operation) {
          const value = await operation.core(e, scopedSignal)
          // Only the wire omits the undefined field; the guest restores { value: undefined }.
          return value === undefined ? {} : { value }
        }
        if (event === "session.start") return { cwd: this.host.cwd?.() ?? this.host.workspace }
        if (event === "command.run") return {}
        if (event === "command.describe")
          return {
            description: e.description,
            isHidden: e.isHidden,
            ...(e.argumentHint === undefined ? {} : { argumentHint: e.argumentHint })
          }
        throw new ModFunctionError("MODS_EVENT_UNAVAILABLE")
      },
      capability: (plugin, method, raw, callSignal, source) =>
        this.capability(plugin, method, raw, callSignal, source, depth, turnHeld)
    })
    // Policy sees short-circuit results as well as results that passed through core.
    this.assertLive(undefined, true)
    const published = await this.host.publish(result.value, scopedSignal)
    this.assertLive(undefined, true)
    return parseModJson(encodeModJson(published)) as ModJson
  }

  private async capability(
    plugin: FunctionPlugin,
    method: string,
    raw: ModJson,
    callSignal: AbortSignal,
    source: { event: string; registration: string },
    depth = 0,
    turnHeld?: string
  ): Promise<ModJson | undefined> {
    this.assertLive(plugin)
    this.nouns.assertAccess(plugin, method)
    if (!Array.isArray(raw)) throw new ModFunctionError("MODS_SDK_ARGUMENTS")
    const args = raw
    if (this.nouns.provider(method)) {
      if (args.length !== 1 || !isModObject(args[0]))
        throw new ModFunctionError("MODS_ENGINE_METHOD_ARGUMENTS")
      return this.nouns.delegated(plugin, async () => {
        const result = await this.dispatch(
          method,
          args[0] as ModObject,
          callSignal,
          { plugin: plugin.name, registration: source.registration },
          depth + 1,
          {
            plugin,
            core: (input, signal) =>
              this.nouns.invoke(plugin, method, input, signal, (owner, nested, raw, nestedSignal) =>
                this.capability(
                  owner,
                  nested,
                  raw,
                  nestedSignal,
                  { event: method, registration: "provider" },
                  depth + 1,
                  turnHeld
                )
              )
          },
          turnHeld
        )
        if (!isModObject(result)) throw new ModFunctionError("MODS_OPERATION_RESULT")
        if (typeof result.deny === "string")
          throw new ModFunctionError("MODS_OPERATION_DENIED", result.deny, true)
        return result.value
      })
    }
    if (method === "turn.abort") {
      if (args.length !== 1 || !isModObject(args[0]))
        throw new ModFunctionError("MODS_TURN_ABORT_ARGUMENTS")
      validateFunctionTurnInput(method, args[0])
      const result = await this.dispatch(
        method,
        args[0],
        callSignal,
        { plugin: plugin.name, registration: source.registration },
        depth + 1,
        {
          plugin,
          core: async (input, signal) => {
            this.abortBudget.take(plugin.name)
            if (!this.host.abortTurn) throw new ModFunctionError("MODS_TURN_UNAVAILABLE")
            await this.host.abortTurn(plugin, String(input.turnId), signal)
            return undefined
          }
        },
        turnHeld
      )
      if (!isModObject(result)) throw new ModFunctionError("MODS_OPERATION_RESULT")
      if (typeof result.deny === "string")
        throw new ModFunctionError("MODS_OPERATION_DENIED", result.deny)
      return undefined
    }
    if (method === "tool.check") {
      if (args.length !== 1) throw new ModFunctionError("MODS_TOOL_CHECK_ARGUMENTS")
      const input = functionToolCheckInput(args[0])
      const query = async (signal: AbortSignal): Promise<ToolPermissionResult> => {
        this.assertLive(plugin)
        const registered = this.tools.get(String(input.tool))
        const owner = registered
          ? this.plugins.find((p) => p.name === registered.plugin)
          : undefined
        if (registered) {
          if (!owner) throw new ModFunctionError("MODS_TOOL_UNAVAILABLE")
          this.assertLive(owner)
          this.host.assertToolNameAvailable?.(registered.plugin, registered.name)
          if (!isModObject(input.input)) return { decision: "deny", reason: "MODS_TOOL_ARGUMENTS" }
          validateRegisteredToolInput(registered.inputSchema, input.input)
        }
        if (!this.host.checkTool) throw new ModFunctionError("MODS_TOOL_CHECK_UNAVAILABLE")
        const value = await this.host.checkTool(plugin, input, signal, registered)
        this.assertLive(plugin)
        if (owner) this.assertLive(owner)
        if (this.tools.get(String(input.tool)) !== registered)
          throw new ModFunctionError("MODS_TOOL_CHANGED")
        if (registered) this.host.assertToolNameAvailable?.(registered.plugin, registered.name)
        validateToolCheckResult(value)
        return value
      }
      const proposed = await this.dispatch(
        method,
        input,
        callSignal,
        { plugin: plugin.name, registration: source.registration },
        depth + 1,
        undefined,
        turnHeld,
        { core: (_, signal) => query(signal) }
      )
      validateToolCheckResult(proposed)
      // A short-circuit allow cannot bypass the current host's mandatory permission decision.
      const checked = constrainToolPermission(proposed, await query(callSignal))
      const published = await this.host.publish(checked, callSignal)
      this.assertLive(plugin)
      validateToolCheckResult(published)
      return published
    }
    if (method === "mcp.call") {
      if (args.length < 2 || args.length > 3) throw new ModFunctionError("MODS_MCP_ARGUMENTS")
      const input = functionMcpInput({ server: args[0], tool: args[1], args: args[2] ?? {} })
      const result = await this.dispatch(
        method,
        input as unknown as ModObject,
        callSignal,
        { plugin: plugin.name, registration: source.registration },
        depth + 1,
        {
          plugin,
          core: async (value, signal) => {
            this.assertLive(plugin)
            const registered = this.tools.resolveMcp(String(value.server), String(value.tool))
            if (registered) {
              const agentId = functionCallAgent(this.host.workspace, this.host.threadId)
              const input: ModObject = {
                ...(value.args as ModObject),
                tool: registered.name,
                tool_use_id: randomUUID()
              }
              delete input.agentId
              if (agentId !== "main") input.agentId = agentId
              return functionRegisteredMcpResult(
                await this.runRegisteredTool(
                  input,
                  signal,
                  { plugin: plugin.name, registration: source.registration },
                  depth + 2,
                  turnHeld ?? "tool.call"
                )
              )
            }
            if (!this.host.callMcp) throw new ModFunctionError("MODS_MCP_UNAVAILABLE")
            return this.host.callMcp(
              plugin,
              value,
              signal,
              (toolInput, toolSignal, core) =>
                this.dispatch(
                  "tool.call",
                  {
                    ...toolInput,
                    ...(functionCallAgent(this.host.workspace, this.host.threadId) !== "main"
                      ? { agentId: functionCallAgent(this.host.workspace, this.host.threadId) }
                      : {})
                  },
                  toolSignal,
                  { plugin: plugin.name, registration: source.registration },
                  depth + 2,
                  undefined,
                  turnHeld ?? "tool.call",
                  { core }
                ) as Promise<ModObject>
            )
          }
        },
        turnHeld
      )
      if (!isModObject(result)) throw new ModFunctionError("MODS_OPERATION_RESULT")
      if (typeof result.deny === "string")
        throw new ModFunctionError("MODS_OPERATION_DENIED", result.deny)
      validateFunctionMcpResult(result.value)
      return result.value
    }
    if (method === "tool.register" || method === "tool.list") {
      if (
        (method === "tool.register" && (args.length !== 1 || !isModObject(args[0]))) ||
        (method === "tool.list" && args.length !== 0)
      )
        throw new ModFunctionError("MODS_TOOL_ARGUMENTS")
      const input = method === "tool.register" ? functionToolSpec(args[0] as ModObject) : {}
      const result = await this.dispatch(
        method,
        input as unknown as ModObject,
        callSignal,
        { plugin: plugin.name, registration: source.registration },
        depth + 1,
        {
          plugin,
          core: async (value, signal) => {
            this.assertLive(plugin)
            if (method === "tool.register") {
              this.host.assertToolNameAvailable?.(
                plugin.name,
                functionMcpToolName(plugin.name, String(value.name))
              )
              return this.tools.register(plugin.name, value)
            }
            const native = (await this.host.listTools?.(signal)) ?? []
            const registered = this.tools.list()
            for (const tool of registered)
              this.host.assertToolNameAvailable?.(tool.plugin, tool.name)
            if (registered.some((tool) => native.some((entry) => entry.name === tool.name)))
              throw new ModFunctionError("MODS_TOOL_NAME_COLLISION")
            const tools = [
              ...native,
              ...registered.map(({ name, description, mcp }) => ({ name, description, mcp }))
            ]
            return (this.host.filterTools?.(tools) ?? tools) as unknown as ModJson
          }
        },
        turnHeld
      )
      if (!isModObject(result)) throw new ModFunctionError("MODS_OPERATION_RESULT")
      if (typeof result.deny === "string")
        throw new ModFunctionError("MODS_OPERATION_DENIED", result.deny)
      return result.value
    }
    if (method === "model.fork" || method === "model.classify") {
      const input =
        method === "model.fork"
          ? args.length === 1 && isModObject(args[0])
            ? functionModelForkRequest(args[0])
            : (() => {
                throw new ModFunctionError("MODS_MODEL_ARGUMENTS")
              })()
          : (() => {
              if (
                args.length < 2 ||
                args.length > 3 ||
                typeof args[0] !== "string" ||
                !Array.isArray(args[1]) ||
                (args[2] !== undefined && !isModObject(args[2]))
              )
                throw new ModFunctionError("MODS_MODEL_ARGUMENTS")
              return functionModelClassifyRequest({
                text: args[0],
                labels: args[1],
                ...(args[2] === undefined ? {} : { options: args[2] })
              })
            })()
      const result = await this.dispatch(
        method,
        input as unknown as ModObject,
        callSignal,
        { plugin: plugin.name, registration: source.registration },
        depth + 1,
        {
          plugin,
          core: async (input, signal) => {
            this.assertLive(plugin)
            if (!this.host.capability) throw new ModFunctionError("MODS_MODEL_OPERATION_UNSUPPORTED")
            const value = await this.host.capability(plugin, method, [input], signal)
            if (value === undefined && method === "model.classify") return null
            if (value === undefined) throw new ModFunctionError("MODS_MODEL_OPERATION_UNSUPPORTED")
            return value
          }
        },
        turnHeld
      )
      if (!isModObject(result)) throw new ModFunctionError("MODS_OPERATION_RESULT")
      if (typeof result.deny === "string") throw new ModFunctionError("MODS_OPERATION_DENIED", result.deny)
      return method === "model.classify" && result.value === null ? undefined : result.value
    }
    if (method === "model.complete") {
      if (args.length !== 1 || !isModObject(args[0]))
        throw new ModFunctionError("MODS_MODEL_ARGUMENTS")
      functionModelRequest(args[0])
      const result = await this.dispatch(
        method,
        args[0],
        callSignal,
        { plugin: plugin.name, registration: source.registration },
        depth + 1,
        {
          plugin,
          core: (input, signal) => {
            this.assertLive(plugin)
            if (!this.host.completeModel) throw new ModFunctionError("MODS_MODEL_UNAVAILABLE")
            return this.host.completeModel(plugin, input, signal)
          }
        },
        turnHeld
      )
      if (!isModObject(result)) throw new ModFunctionError("MODS_OPERATION_RESULT")
      if (typeof result.deny === "string")
        throw new ModFunctionError("MODS_OPERATION_DENIED", result.deny)
      validateFunctionModelText(result.value)
      return result.value
    }
    if (method === "tool.call") {
      if (!isModObject(args[0]) || args.length !== 1)
        throw new ModFunctionError("MODS_TOOL_ARGUMENTS")
      const input = { ...args[0] }
      delete input.tool_use_id
      delete input.agentId
      const agentId = functionCallAgent(this.host.workspace, this.host.threadId)
      if (agentId !== "main") input.agentId = agentId
      if (this.tools.get(String(input.tool)))
        return this.runRegisteredTool(
          { ...input, tool_use_id: randomUUID() },
          callSignal,
          { plugin: plugin.name, registration: source.registration },
          depth + 1,
          turnHeld ?? "tool.call"
        )
      functionSdkToolInput(input)
      const result = await this.dispatch(
        "tool.call",
        { ...input, tool_use_id: randomUUID() },
        callSignal,
        { plugin: plugin.name, registration: source.registration },
        depth + 1,
        undefined,
        turnHeld ?? "tool.call",
        {
          core: (e, signal) => {
            this.assertLive(plugin)
            if (!this.host.callTool) throw new ModFunctionError("MODS_TOOL_UNAVAILABLE")
            return withFunctionBackgroundOwner(this.controller.signal, () =>
              this.host.callTool!(plugin, e, signal)
            )
          }
        }
      )
      return result
    }
    if (method === "ui.invalidate") {
      if (args[0] !== "ui.render") throw new ModFunctionError("MODS_UI_INVALIDATE_UNAVAILABLE")
      this.panes.invalidate()
      return undefined
    }
    if (method === "ui.open" || method === "ui.close") {
      if (!isModObject(args[0])) throw new ModFunctionError("MODS_UI_PANE_ARGUMENTS")
      validatePaneArgs(args[0])
      const input =
        method === "ui.close"
          ? { id: args[0].id, origin: { kind: "plugin", name: plugin.name } }
          : args[0]
      const answer = await this.dispatch(
        method,
        input,
        callSignal,
        { plugin: plugin.name, registration: source.registration },
        depth + 1,
        {
          plugin,
          core: async (e) => {
            this.assertLive(plugin)
            if (method === "ui.open") this.panes.open(plugin.name, e)
            else await this.panes.closePane(plugin.name, e.id as string, false)
            return undefined
          }
        },
        turnHeld
      )
      if (!isModObject(answer)) throw new ModFunctionError("MODS_OPERATION_RESULT")
      if (typeof answer.deny === "string")
        throw new ModFunctionError("MODS_OPERATION_DENIED", answer.deny)
      return answer.value
    }
    if (method !== "command.run" && BASIC_CAPABILITIES.some((name) => name === method)) {
      const answer = await this.dispatch(
        method,
        basicSdkInput(method, args),
        callSignal,
        { plugin: plugin.name, registration: source.registration },
        depth + 1,
        {
          plugin,
          core: (input, signal) =>
            runBasicSdk(method, input, {
              ...this.host,
              workspace:
                method === "session.cwd"
                  ? (this.host.cwd?.() ?? this.host.workspace)
                  : this.host.workspace,
              plugin: plugin.name,
              registry: this.registry,
              state: this.host.state?.(plugin),
              files: FILE_CAPABILITIES.some((name) => name === method)
                ? this.host.files?.(plugin)
                : undefined,
              signal
            })
        },
        turnHeld
      )
      if (!isModObject(answer)) throw new ModFunctionError("MODS_OPERATION_RESULT")
      if (typeof answer.deny === "string")
        throw new ModFunctionError("MODS_OPERATION_DENIED", answer.deny)
      return answer.value
    }
    if (method === "command.run") {
      if (turnHeld)
        throw new ModFunctionError(
          "MODS_COMMAND_TURN_HELD",
          `MODS_COMMAND_TURN_HELD: $.command.run cannot wait inside ${turnHeld}`,
          true
        )
      const command = args[0]
      if (
        !isModObject(command) ||
        typeof command.command !== "string" ||
        !this.registry.has(command.command) ||
        (command.args !== undefined && typeof command.args !== "string")
      )
        throw new ModFunctionError("MODS_COMMAND_ARGS")
      const run = async (signal: AbortSignal): Promise<ModObject> => {
        this.assertLive(plugin)
        signal.throwIfAborted()
        return (await this.dispatch(
          "command.run",
          {
            command: command.command,
            args: command.args ?? "",
            origin: { kind: "plugin", name: plugin.name },
            presentation: { isFullscreen: false, columns: 80 }
          },
          signal,
          { plugin: plugin.name, registration: source.registration },
          depth + 1
        )) as ModObject
      }
      return this.host.scheduleCommand
        ? this.host.scheduleCommand(this.registry.get(command.command)!, callSignal, run)
        : run(callSignal)
    }
    if (!this.host.capability) throw new ModFunctionError("MODS_CAPABILITY_UNAVAILABLE")
    const value = await this.host.capability(plugin, method, args, callSignal)
    this.assertLive(plugin)
    return value
  }

  async close(): Promise<void> {
    this.controller.abort(new ModFunctionError("MODS_SESSION_CLOSED"))
    this.panes.close()
    this.clients.close()
    this.registry.clear()
    this.tools.clear()
    await Promise.allSettled(this.plugins.map((plugin) => plugin.guest.dispose()))
  }
}
