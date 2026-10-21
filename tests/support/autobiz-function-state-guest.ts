import { resolve } from "node:path"
import { randomUUID } from "node:crypto"
import type { ModObject } from "../../src/shared/mods/types"
import { compileFunctionPlugin, projectFunctionComponents } from "../../src/main/mods/v2/loader"
import { FunctionGuestRuntime } from "../../src/main/mods/v2/guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "../../src/main/mods/v2/session"
import { analyzeFunctionSdk } from "../../src/main/mods/devtools/sdk-usage"

/** Real guest/SDK/process chain. Authorizes only this fixture's selected plugin adapter.
 * This is a controlled main-process authorization fixture, not approval-UI acceptance.
 */
export async function createAutobizFunctionStateGuest(
  source: string,
  workspace: string,
  options: { designAnswer?: (question: ModObject) => string | Promise<string> } = {}
) {
  const compiled = await compileFunctionPlugin(source, { captureSources: true })
  const analysis = await analyzeFunctionSdk(compiled)
  if (!analysis.strictCompatible || analysis.diagnostics.length)
    throw Error("AUTOBIZ_STATE_SDK_UNVERIFIED:" + JSON.stringify(analysis.diagnostics))
  const projection = projectFunctionComponents(
    compiled,
    {
      mode: "selected",
      ids: ["autobiz.state-machine"],
      config: {}
    },
    "project"
  )
  if (projection.effectiveIds.join() !== "autobiz.state-machine")
    throw Error("AUTOBIZ_STATE_COMPONENT_NOT_SELECTED")
  const guest = await FunctionGuestRuntime.create(projection.code, projection.options)
  const processRequests: ModObject[] = []
  const questions: ModObject[] = []
  let closed = false
  const session = new FunctionSession(
    [
      {
        name: compiled.name,
        root: compiled.root,
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace,
      threadId: "actual-autobiz-function-guest",
      cwd: () => workspace,
      assertLive() {
        if (closed) throw Error("AUTOBIZ_FIXTURE_SESSION_CLOSED")
      },
      publish: async (value) => value,
      authorizeProcess: async (_plugin, request, signal) => {
        signal.throwIfAborted()
        if (
          request.argv[0] !== "python" ||
          resolve(request.argv.at(-1)!) !==
            resolve(compiled.root, "mods/business/autobiz.state-machine/adapter.py") ||
          resolve(request.cwd) !== resolve(workspace)
        )
          throw Error("AUTOBIZ_FIXTURE_PROCESS_SCOPE")
        processRequests.push({
          argv: [...request.argv],
          cwd: request.cwd,
          request: JSON.parse(request.input ?? "{}")
        })
      },
      callTool: async (_plugin, input) => {
        if (input.tool !== "request_user_input") throw Error("AUTOBIZ_FIXTURE_UNEXPECTED_TOOL")
        questions.push(input)
        const answer = (await options.designAnswer?.(input)) ?? "取消"
        return {
          result: JSON.stringify({
            status: "submitted",
            answers: {
              mod_question: { type: "option", label: answer }
            }
          })
        }
      }
    }
  )
  const signal = new AbortController().signal
  const registered = await session.registeredTools()
  const owned = registered.filter((tool) => tool.plugin === compiled.name)
  if (owned.length !== 4) {
    await session.close(true)
    throw Error("AUTOBIZ_STATE_TOOLS_NOT_REGISTERED:" + owned.map((tool) => tool.name).join(","))
  }
  return {
    digest: compiled.digest,
    session,
    processRequests,
    questions,
    async command(command: string, args: string): Promise<ModObject> {
      try {
        const result = await session.run(command, args, signal)
        if (typeof result.text !== "string") throw Error("AUTOBIZ_GUEST_COMMAND_OUTPUT_REQUIRED")
        return JSON.parse(result.text) as ModObject
      } catch (error) {
        const tools = await session.registeredTools()
        throw Error(
          JSON.stringify({
            command,
            args,
            tools: tools.map((tool) => tool.name),
            requests: processRequests.map((row) => row.request),
            error: String(error)
          })
        )
      }
    },
    async tool(operation: string, input: ModObject): Promise<ModObject> {
      const tool = "mcp__" + compiled.name.replace(/[^a-zA-Z0-9_-]/g, "_") + "__state_" + operation
      return session.interceptTool(
        { tool, tool_use_id: randomUUID(), ...input },
        signal,
        async () => {
          throw Error("AUTOBIZ_GUEST_TOOL_MUST_BE_REGISTERED")
        }
      )
    },
    async close() {
      if (closed) return
      await session.close(true)
      closed = true
      if (!guest.stats.disposed) throw Error("AUTOBIZ_GUEST_DID_NOT_DISPOSE")
    }
  }
}
