import vm from "node:vm"
import type { McpCapabilityTool, McpInvocationResult } from "../mcp/capability-types"
import { createServerProxy } from "../mcp/server-proxy"
import { safeJsonStringify, stringifyCodeExecOutput } from "../mcp/result-utils"
import type {
  CodeExecHelperRequest,
  CodeExecHelperResult,
  CodeExecInvokeResponse,
  CodeExecMetaResponse,
  CodeExecMcpCall
} from "./types"

type CodeExecStage = "compile" | "bootstrap" | "invoke" | "runtime"

class CodeExecStageError extends Error {
  constructor(
    readonly stage: CodeExecStage,
    message: string
  ) {
    super(message)
    this.name = "CodeExecStageError"
  }
}

function formatLogValue(value: unknown): string {
  if (typeof value === "string") return value
  return safeJsonStringify(value)
}

function createConsole(logs: string[]): Console {
  const append = (level: string, values: unknown[]): void => {
    logs.push(`[${level}] ${values.map((value) => formatLogValue(value)).join(" ")}`)
  }

  return {
    log: (...values: unknown[]) => append("log", values),
    info: (...values: unknown[]) => append("info", values),
    warn: (...values: unknown[]) => append("warn", values),
    error: (...values: unknown[]) => append("error", values),
    debug: (...values: unknown[]) => append("debug", values),
    trace: (...values: unknown[]) => append("trace", values),
    dir: (value: unknown) => append("dir", [value]),
    assert: (condition?: boolean, ...values: unknown[]) => {
      if (!condition) append("assert", values)
    },
    clear: () => undefined,
    count: () => undefined,
    countReset: () => undefined,
    group: (...values: unknown[]) => append("group", values),
    groupCollapsed: (...values: unknown[]) => append("group", values),
    groupEnd: () => undefined,
    table: (value: unknown) => append("table", [value]),
    time: () => undefined,
    timeEnd: () => undefined,
    timeLog: (...values: unknown[]) => append("time", values),
    profile: () => undefined,
    profileEnd: () => undefined,
    timeStamp: () => undefined
  } as Console
}

async function postJson<TResponse>(
  url: string,
  token: string,
  payload: unknown,
  stage: CodeExecStage,
  signal?: AbortSignal
): Promise<TResponse> {
  let response: Response

  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(payload),
      signal
    })
  } catch (error) {
    if (signal?.aborted) {
      throw new CodeExecStageError("runtime", signal.reason ? String(signal.reason) : "Code execution aborted")
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new CodeExecStageError(stage, message)
  }

  const data = await response.json() as { error?: string } & TResponse
  if (!response.ok) {
    throw new CodeExecStageError(stage, data.error || `HTTP ${response.status}`)
  }

  return data
}

async function loadTools(
  request: CodeExecHelperRequest,
  signal: AbortSignal
): Promise<McpCapabilityTool[]> {
  const response = await postJson<CodeExecMetaResponse>(
    `${request.bridgeUrl}/meta`,
    request.token,
    {},
    "bootstrap",
    signal
  )
  return response.tools
}

function createWrappedFunction(code: string): string {
  return `(async function __run(__api) {
  const { params, mcp, console, signal, setTimeout, clearTimeout } = __api
${code}
})`
}

async function executeUserCode(
  request: CodeExecHelperRequest,
  tools: McpCapabilityTool[],
  signal: AbortSignal,
  logs: string[],
  mcpCalls: CodeExecMcpCall[]
): Promise<unknown> {
  const sandboxConsole = createConsole(logs)

  const invoke = async (
    idOrAlias: string,
    args: Record<string, unknown>
  ): Promise<McpInvocationResult> => {
    mcpCalls.push({
      toolId: idOrAlias,
      args
    })

    const response = await postJson<CodeExecInvokeResponse>(
      `${request.bridgeUrl}/call`,
      request.token,
      {
        idOrAlias,
        args
      },
      "invoke",
      signal
    )

    return response.result as McpInvocationResult
  }

  const mcp = createServerProxy(tools, invoke)

  let compiled: vm.Script
  try {
    compiled = new vm.Script(createWrappedFunction(request.code), {
      filename: "code_exec.js"
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new CodeExecStageError("compile", message)
  }

  const contextGlobals = Object.assign(Object.create(null), {
    process: undefined,
    require: undefined,
    module: undefined,
    exports: undefined,
    Buffer: undefined,
    global: undefined
  })

  const context = vm.createContext(contextGlobals, {
    codeGeneration: {
      strings: false,
      wasm: false
    }
  })

  let runnable: (api: {
    params: Record<string, unknown>
    mcp: ReturnType<typeof createServerProxy>
    console: Console
    signal: AbortSignal
    setTimeout: typeof setTimeout
    clearTimeout: typeof clearTimeout
  }) => Promise<unknown>

  try {
    runnable = compiled.runInContext(context) as typeof runnable
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new CodeExecStageError("compile", message)
  }

  return runnable({
    params: request.params ?? {},
    mcp,
    console: sandboxConsole,
    signal,
    setTimeout,
    clearTimeout
  })
}

export async function runCodeExecScript(
  request: CodeExecHelperRequest
): Promise<CodeExecHelperResult> {
  const logs: string[] = []
  const mcpCalls: CodeExecMcpCall[] = []
  const controller = new AbortController()
  const timeoutMessage = `Code execution timed out after ${request.timeoutMs}ms`
  const timeoutId = setTimeout(() => {
    controller.abort(timeoutMessage)
  }, request.timeoutMs)

  try {
    const tools = await loadTools(request, controller.signal)
    const execution = executeUserCode(request, tools, controller.signal, logs, mcpCalls)
    const result = await Promise.race([
      execution,
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new CodeExecStageError("runtime", timeoutMessage)),
          { once: true }
        )
      })
    ])

    return {
      ok: true,
      output: stringifyCodeExecOutput(result),
      logs,
      meta: {
        mcpCalls
      }
    }
  } catch (error) {
    if (error instanceof CodeExecStageError) {
      return {
        ok: false,
        output: stringifyCodeExecOutput({ stage: error.stage, error: error.message, logs }),
        logs,
        stage: error.stage,
        error: error.message,
        meta: {
          mcpCalls
        }
      }
    }

    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      output: stringifyCodeExecOutput({ stage: "runtime", error: message, logs }),
      logs,
      stage: "runtime",
      error: message,
      meta: {
        mcpCalls
      }
    }
  } finally {
    clearTimeout(timeoutId)
  }
}
