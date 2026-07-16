import { parse } from "acorn"
import { tool } from "langchain"
import { z } from "zod"
import type { ApprovalDecision, ApprovalRequest } from "../../../types"
import type { BrowserPluginRuntime } from "../../../browser/browser-plugin"
import type { BrowserPerformanceBudget } from "../../../browser/browser-performance-budget"
import {
  bindOfficialBrowserRuntimeGlobals,
  setupOfficialBrowserRuntime
} from "../../../browser/official-browser-runtime-loader"
import {
  createBrowserRuntimeNodeReplHost,
  type BrowserRuntimeNodeReplHost
} from "./browser-runtime-host"

export const BROWSER_PLUGIN_NODE_REPL_TOOL_NAME = "mcp__node_repl__js"

const browserPluginJsSchema = z.object({
  code: z
    .string()
    .describe(
      "JavaScript to run in the official Browser plugin runtime. Use globalThis.* for values that should persist between calls, and use agent.browsers after setup."
    )
})

interface BrowserPluginToolContext {
  plugin: BrowserPluginRuntime
  requestApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>
  workspacePath: string
  threadId?: string
  budget?: BrowserPerformanceBudget
}

interface BrowserPluginRuntimeSession {
  host: BrowserRuntimeNodeReplHost
  setupPromise?: Promise<void>
}

const runtimeSessions = new Map<string, BrowserPluginRuntimeSession>()

function getRuntimeSessionKey(context: BrowserPluginToolContext): string {
  return `${context.threadId || "unbound"}:${context.plugin.clientPath}`
}

function addImplicitReturnForFinalExpression(code: string): string {
  try {
    const program = parse(code, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true
    }) as unknown as { body?: Array<Record<string, unknown>> }
    const body = Array.isArray(program.body) ? program.body : []
    const last = body[body.length - 1]
    const expression = last?.expression as Record<string, unknown> | undefined
    if (
      last?.type !== "ExpressionStatement" ||
      typeof last.start !== "number" ||
      typeof last.end !== "number" ||
      !expression ||
      typeof expression.start !== "number" ||
      typeof expression.end !== "number"
    ) {
      return code
    }
    return `${code.slice(0, last.start)}return ${code.slice(
      expression.start,
      expression.end
    )}${code.slice(last.end)}`
  } catch {
    return code
  }
}

function createRuntimeSession(context: BrowserPluginToolContext): BrowserPluginRuntimeSession {
  return {
    host: createBrowserRuntimeNodeReplHost({
      workspacePath: context.workspacePath,
      threadId: context.threadId,
      budget: context.budget,
      requestApproval: context.requestApproval
    })
  }
}

function getRuntimeSession(context: BrowserPluginToolContext): BrowserPluginRuntimeSession {
  const key = getRuntimeSessionKey(context)
  const existing = runtimeSessions.get(key)
  if (existing) return existing

  const session = createRuntimeSession(context)
  runtimeSessions.set(key, session)
  return session
}

async function ensureOfficialRuntime(
  context: BrowserPluginToolContext,
  session: BrowserPluginRuntimeSession
): Promise<void> {
  if (session.host.state.toolState.bootstrapState === "ready") return
  if (session.setupPromise) return session.setupPromise

  session.host.markBootstrapping()
  console.log(`[BrowserRuntime] official runtime bootstrapping for ${context.threadId ?? "unbound"}.`)
  session.setupPromise = setupOfficialBrowserRuntime({
    clientPath: context.plugin.clientPath,
    globals: session.host.globals,
    budget: session.host.budget
  })
    .then(() => {
      session.host.markReady()
      console.log(`[BrowserRuntime] official runtime ready for ${context.threadId ?? "unbound"}.`)
    })
    .catch((error) => {
      session.host.markBootstrapFailed(error)
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[BrowserRuntime] official runtime failed for ${context.threadId ?? "unbound"}: ${message}.`)
      throw error
    })
    .finally(() => {
      session.setupPromise = undefined
    })

  return session.setupPromise
}

function createAsyncRunner(
  code: string
): (globals: Record<string, unknown>) => Promise<unknown> {
  const AsyncFunction = Object.getPrototypeOf(async function asyncFunctionSource() {
    return undefined
  }).constructor as new (
    ...args: string[]
  ) => (globals: Record<string, unknown>) => Promise<unknown>

  return new AsyncFunction(
    "globals",
    `
      const globalThis = globals;
      with (globals) {
        return await (async () => {
          ${code}
        })();
      }
    `
  )
}

function renderToolResult(host: BrowserRuntimeNodeReplHost, result: unknown): string {
  const state = host.state
  const primary =
    state.lastWrite !== undefined
      ? state.lastWrite
      : result !== undefined
        ? result
        : state.lastMeta !== undefined
          ? state.toolState
          : undefined
  const output = host.formatOutput(primary)
  const logs = state.logs.length > 0 ? `\n\nconsole:\n${state.logs.join("\n")}` : ""
  return `${output}${logs}`.trim() || "undefined"
}

export function clearBrowserPluginRuntimeToolSessionsForTests(): void {
  for (const session of runtimeSessions.values()) {
    session.host.dispose()
  }
  runtimeSessions.clear()
}

export function createBrowserPluginRuntimeTool(context: BrowserPluginToolContext) {
  return tool(
    async ({ code }) => {
      const session = getRuntimeSession(context)
      const host = session.host
      host.resetTurnOutput()

      try {
        await ensureOfficialRuntime(context, session)
        bindOfficialBrowserRuntimeGlobals(host.globals)
        const runnableCode = addImplicitReturnForFinalExpression(code)
        const run = createAsyncRunner(runnableCode)
        const result = await run(host.globals)
        return renderToolResult(host, result)
      } catch (error) {
        return renderToolResult(host, error)
      }
    },
    {
      name: BROWSER_PLUGIN_NODE_REPL_TOOL_NAME,
      description:
        "Run JavaScript in the enabled official Browser plugin runtime. This lazily loads scripts/browser-client.mjs, exposes the host nodeRepl contract, and does not fall back to a local shim.",
      schema: browserPluginJsSchema
    }
  )
}
