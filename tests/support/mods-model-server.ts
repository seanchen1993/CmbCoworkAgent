import { createServer } from "node:http"
import assert from "node:assert/strict"
import { COMPACTION_SUMMARY, isCompactionSummaryRequest } from "./mods-compaction-fixture"

/** Local protocol fixture; the application still uses production model settings and client. */
export async function startModsModelServer() {
  const requests: Array<{
    messages: Array<{ role: string; content: string }>
    [key: string]: unknown
  }> = []
  let closedStalls = 0
  let compactionOverflowSent = false
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    requests.push(body)
    // Each completion needs its own provider id; reusing one rewrites prior checkpoint messages.
    const responseId = `mods-model-fixture-${requests.length}`
    const prompt = String(body.messages?.at(-1)?.content)
    if (!isCompactionSummaryRequest(body) && !compactionOverflowSent &&
        prompt.includes("[mods-compaction-force-overflow]")) {
      compactionOverflowSent = true
      response.writeHead(400, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: {
        code: "context_length_exceeded", message: "maximum context length exceeded"
      } }))
      return
    }
    if (prompt.includes("[mods-stop-failure-task]")) {
      response.writeHead(400, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: "actual protocol request rejected" } }))
      return
    }
    if (prompt.includes("[error]")) {
      response.writeHead(500, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: "synthetic provider failure" } }))
      return
    }
    response.writeHead(200, { "content-type": "text/event-stream" })
    const event = (choices: unknown[], usage?: unknown) =>
      response.write(
        `data: ${JSON.stringify({
          id: responseId,
          object: "chat.completion.chunk",
          created: 1,
          model: "mods-model-fixture",
          choices,
          ...(usage ? { usage } : {})
        })}\n\n`
      )
    const userPrompt = JSON.stringify(
      body.messages?.findLast((message: { role: string }) => message.role === "user")?.content
    )
    const lifecyclePrompt = JSON.stringify(body.messages)
    if (userPrompt.includes("[mods-presentation-skill]")) {
      const afterRead = body.messages?.at(-1)?.role === "tool"
      const selected = body.messages?.findLast((message: { role: string }) => message.role === "user")
      const skillPath = String(selected?.content).match(/<path>([^<]+)<\/path>/)?.[1]
      if (!skillPath) throw Error("Presentation fixture requires an explicit installed Skill")
      event([
        {
          index: 0,
          delta: afterRead
            ? { role: "assistant", content: "PRESENTATION_SKILL_READ_DONE" }
            : {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "presentation-read",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: JSON.stringify({ file_path: skillPath })
                    }
                  }
                ]
              },
          finish_reason: afterRead ? "stop" : "tool_calls"
        }
      ])
      event([], { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 })
      response.end("data: [DONE]\n\n")
      return
    }
    if (userPrompt.includes("[mods-spawn-parent]")) {
      const launch = "mcp__spawn-e2e__launch"
      const names =
        body.tools?.map((tool: { function?: { name?: string } }) => tool.function?.name) ?? []
      const previous = body.messages?.at(-1)
      let call: { id: string; name: string; arguments: string } | undefined
      try {
        if (previous?.role !== "tool") {
          assert(names.includes("mods_tool_search"), "Actual deferred search must be published")
          assert(!names.includes(launch), "This fixture must exercise original deferred loading")
          const search = body.tools.find(
            (tool: { function?: { name?: string } }) => tool.function?.name === "mods_tool_search"
          )
          assert.equal(search.function.parameters.properties.query.type, "string")
          assert(search.function.parameters.required.includes("query"))
          call = {
            id: "spawn-search",
            name: "mods_tool_search",
            arguments: JSON.stringify({ query: launch })
          }
        } else if (previous.tool_call_id === "spawn-search") {
          const result = JSON.parse(previous.content)
          assert.deepEqual(result.loaded, [launch])
          assert.equal(result.nextStep, true)
          assert(names.includes(launch), "Real search result must publish the actual launch schema")
          call = { id: "spawn-launch", name: launch, arguments: "{}" }
        } else {
          assert.equal(previous.tool_call_id, "spawn-launch")
          const result = JSON.parse(previous.content)
          assert.equal(typeof result.started, "string")
          assert(result.started.length > 0, "Original native launch must really start a child")
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error("SDK_PARENT_FIXTURE_PROTOCOL", message)
        response.end(
          `data: ${JSON.stringify({ error: { message: "SDK_PARENT_FIXTURE_PROTOCOL: " + message } })}\n\n`
        )
        return
      }
      event([
        {
          index: 0,
          delta: call
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: call.id,
                    type: "function",
                    function: { name: call.name, arguments: call.arguments }
                  }
                ]
              }
            : { role: "assistant", content: "SPAWN_PARENT_DONE" },
          finish_reason: call ? "tool_calls" : "stop"
        }
      ])
      event([], { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 })
      response.end("data: [DONE]\n\n")
      return
    }
    if (userPrompt.includes("[mods-spawn-cold]")) {
      event([{ index: 0, delta: { role: "assistant", content: "SPAWN_COLD_DONE" }, finish_reason: "stop" }])
      response.end("data: [DONE]\n\n")
      return
    }
    if (userPrompt.includes("[mods-spawn-limit]")) {
      event([{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "limit-read", type: "function", function: { name: "read_file", arguments: JSON.stringify({ file_path: "notes.txt" }) } }] }, finish_reason: "tool_calls" }])
      response.end("data: [DONE]\n\n")
      return
    }
    if (userPrompt.includes("[mods-spawn-child]")) {
      const first = body.messages?.at(-1)?.role !== "tool"
      if (first) await new Promise((resolve) => setTimeout(resolve, 10000))
      const read = !first && !lifecyclePrompt.includes('spawn-read')
      event([{ index: 0, delta: first || read ? { role: "assistant", tool_calls: [{ index: 0, id: first ? "spawn-write" : "spawn-read", type: "function", function: { name: first ? "write_file" : "read_file", arguments: JSON.stringify(first ? { file_path: "unauthorized.txt", content: "must not write" } : { file_path: "notes.txt" }) } }] } : { role: "assistant", content: "SPAWN_CHILD_DONE" }, finish_reason: first || read ? "tool_calls" : "stop" }])
      event([], { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 })
      response.end("data: [DONE]\n\n")
      return
    }
    if (isCompactionSummaryRequest(body)) {
      event([{ index: 0, delta: { role: "assistant", content: COMPACTION_SUMMARY }, finish_reason: "stop" }])
      event([], { prompt_tokens: 4000, completion_tokens: 350, total_tokens: 4350 })
      response.end("data: [DONE]\n\n")
      return
    }
    if (lifecyclePrompt.includes("[lifecycle-fork]")) {
      event([
        { index: 0, delta: { role: "assistant", content: "LIFECYCLE_FORK" }, finish_reason: "stop" }
      ])
      event([], { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 })
      response.end("data: [DONE]\n\n")
      return
    }
    if (lifecyclePrompt.includes("[lifecycle-classify]")) {
      event([
        { index: 0, delta: { role: "assistant", content: "ready" }, finish_reason: "stop" }
      ])
      event([], { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 })
      response.end("data: [DONE]\n\n")
      return
    }
    if (Array.isArray(body.tools) && lifecyclePrompt.includes("[model-lifecycle]")) {
      const probe = "mcp__model-lifecycle__probe"
      const names = body.tools.map((tool: { function?: { name?: string } }) => tool.function?.name)
      const previous = body.messages?.at(-1)
      if (previous?.role === "tool" && previous.name === probe) {
        assert(String(previous.content).includes("LIFECYCLE_FORK"), "Lifecycle tool must finish its real fork")
        assert(String(previous.content).includes("ready"), "Lifecycle tool must finish its real classification")
        event([
          { index: 0, delta: { role: "assistant", content: "LIFECYCLE_RAW" }, finish_reason: "stop" }
        ])
      } else {
        const loaded = names.includes(probe)
        if (!loaded) assert(names.includes("mods_tool_search"), "Deferred lifecycle search must be published")
        if (previous?.role === "tool") {
          assert.equal(previous.name, "mods_tool_search")
          assert.deepEqual(JSON.parse(previous.content).loaded, [probe])
          assert(loaded, "Discovery must publish the exact callable probe schema on the next step")
        }
        event([
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: loaded ? "model-lifecycle-probe" : "model-lifecycle-search",
                  type: "function",
                  function: loaded
                    ? { name: probe, arguments: "{}" }
                    : { name: "mods_tool_search", arguments: JSON.stringify({ query: probe }) }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ])
      }
      event([], { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 })
      response.end("data: [DONE]\n\n")
      return
    }
    if (userPrompt?.includes("[mods-refusal]")) {
      const kind = userPrompt.includes("[content-filter]")
        ? "content_filter"
        : userPrompt.includes("[refusal-details]")
          ? "refusal"
          : "stop"
      event([
        {
          index: 0,
          delta: {
            role: "assistant",
            content: null,
            ...(kind === "stop" ? { refusal: "MODS_PROVIDER_REFUSED" } : {})
          },
          finish_reason: kind,
          ...(kind === "refusal"
            ? { stop_details: { category: "fixture", explanation: "MODS_PROVIDER_POLICY" } }
            : {})
        }
      ])
      event([], { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 })
      response.end("data: [DONE]\n\n")
      return
    }
    if (
      Array.isArray(body.tools) &&
      (userPrompt.includes("[mods-child]") ||
        userPrompt.includes("[mods-child-worker]") ||
        userPrompt.includes("[mods-foundation]") ||
        userPrompt.includes("[mods-registered"))
    ) {
      const names = body.tools.map((entry: { function?: { name?: string } }) => entry.function?.name)
      const previous = body.messages?.at(-1)
      type FixtureCall = { id: string; name: string; arguments: string }
      const replyText = () => {
        assert.equal(previous?.role, "tool")
        return typeof previous.content === "string"
          ? previous.content
          : JSON.stringify(previous.content)
      }
      const successfulReply = () => {
        const text = replyText()
        assert.notEqual(previous.status, "error", "A failed tool is not completion evidence")
        assert.doesNotMatch(
          text,
          /^\s*(?:ToolError\b|Error\b|MODS_(?:REGISTERED_TOOL_|TOOL_|RUNTIME_|PLUGIN_CHANGED|CANCELLED))/
        )
        let value
        try {
          value = JSON.parse(text)
        } catch {
          value = text
        }
        if (value && typeof value === "object") {
          assert.notEqual(value.isError, true)
          assert(!value.error && !value.deny)
        }
        return value
      }
      const deferredCall = (
        name: string,
        id: string,
        args: Record<string, unknown>,
        searchId: string
      ): FixtureCall => {
        if (previous?.role === "tool") {
          assert.equal(previous.tool_call_id, searchId, "Only the exact search may precede invocation")
          const result = successfulReply()
          assert.deepEqual(result.loaded, [name])
          assert.equal(result.nextStep, true)
          assert(names.includes(name), "Discovery must publish the callable schema on the next step")
        }
        if (!names.includes(name)) {
          assert(names.includes("mods_tool_search"), "Deferred registration requires native discovery")
          const search = body.tools.find(
            (entry: { function?: { name?: string } }) => entry.function?.name === "mods_tool_search"
          )
          assert.equal(search.function.parameters.properties.query.type, "string")
          assert(search.function.parameters.required.includes("query"))
          return { id: searchId, name: "mods_tool_search", arguments: JSON.stringify({ query: name }) }
        }
        return { id, name, arguments: JSON.stringify(args) }
      }
      let call: FixtureCall | undefined
      let answer: string | undefined
      try {
        if (userPrompt.includes("[mods-registered")) {
          const tool = "mcp__function-commands__project_brief"
          const removed = userPrompt.includes("[mods-registered-removed]")
          const invalid = userPrompt.includes("[mods-registered-invalid]")
          const denied = userPrompt.includes("[mods-registered-denied]")
          const id = invalid ? "registered-invalid" : denied ? "registered-denied" : "registered-model"
          if (removed) {
            assert(!names.includes(tool), "Revoked registration must not remain callable")
            if (previous?.role === "tool") {
              assert.equal(previous.tool_call_id, "registered-removed-search")
              const result = successfulReply()
              assert.deepEqual(result.loaded, [])
              assert.equal(result.nextStep, true)
              answer = "REGISTERED_TOOL_REMOVED_OK"
            } else if (names.includes("mods_tool_search")) {
              call = {
                id: "registered-removed-search",
                name: "mods_tool_search",
                arguments: JSON.stringify({ query: tool })
              }
            } else answer = "REGISTERED_TOOL_REMOVED_OK"
          } else if (previous?.role === "tool" && previous.tool_call_id === id) {
            if (invalid) {
              assert.match(replyText(), /MODS_REGISTERED_TOOL_INPUT/)
              answer = "REGISTERED_TOOL_INVALID_OK"
            } else if (denied) {
              assert.match(replyText(), /Permission fixture rejected registered tool/)
              assert.doesNotMatch(replyText(), /sk-permission-fixture/)
              answer = "REGISTERED_PERMISSION_DENIED_OK"
            } else {
              const result = successfulReply()
              assert(
                Array.isArray(result.files),
                "The registered handler must return real project files"
              )
              assert(result.files.length <= 5)
              assert.equal(typeof result.note, "string")
              answer = "REGISTERED_TOOL_OK"
            }
          } else {
            call = deferredCall(tool, id, { limit: invalid ? "bad" : denied ? 13 : 5 }, `${id}-search`)
            if (call.name === tool) {
              const advertised = body.tools.find(
                (entry: { function?: { name?: string } }) => entry.function?.name === tool
              )
              assert.deepEqual(advertised.function.parameters, {
                type: "object",
                properties: { limit: { type: "integer", minimum: 1, maximum: 20 } },
                additionalProperties: false
              })
            }
          }
        } else if (userPrompt.includes("[mods-foundation]")) {
          if (previous?.role === "tool" && previous.tool_call_id === "foundation-model") {
            const result = successfulReply()
            assert.equal(typeof result, "string")
            assert(
              result.startsWith("SDK_MODEL_OK"),
              "The registered tool must finish its nested model call"
            )
            answer = "HOST_FOUNDATION_OK"
          } else {
            call = deferredCall(
              "mcp__host-foundation__probe",
              "foundation-model",
              {},
              "foundation-search"
            )
          }
        } else {
          const child = userPrompt.includes("[mods-child-worker]")
          const agentList = userPrompt.includes("[mods-agent-list]")
          const nativeFallback = userPrompt.includes("[mods-agent-list-off]")
          if (nativeFallback) {
            assert(agentList, "Native off scenario must retain its agent-list identity")
            assert(
              !names.includes("mcp__agent-instances__probe"),
              "Mods off must not publish the revoked registered probe"
            )
          }
          if (!child) {
            if (previous?.role === "tool") {
              assert.equal(previous.tool_call_id, "mods-child-task")
              if (userPrompt.includes("[child-refusal]")) {
                // This scenario deliberately catches a real child refusal in an otherwise normal parent.
                assert.match(replyText(), /MODS_CHILD_REFUSED|ModelRefusalError|拒绝了本次请求/)
              } else {
                successfulReply()
                assert.match(replyText(), /MODS_CHILD_WORKER_OK/)
              }
              answer = "MODS_CHILD_OK"
            } else {
              assert(names.includes("task"), "Use the actual published native task tool")
              call = {
                id: "mods-child-task",
                name: "task",
                arguments: JSON.stringify({
                  subagent_type: "Explore",
                  description: `[mods-child-worker] ${agentList ? "[mods-agent-list] " : ""}${nativeFallback ? "[mods-agent-list-off] " : ""}${userPrompt.includes("[child-stall]") ? "[stall]" : ""} ${userPrompt.includes("[child-refusal]") ? "[child-refusal]" : ""} ${nativeFallback ? "Read claw-notes using the native read tool" : "Inspect using the registered probe"}`
                })
              }
            }
          } else {
            const tool = agentList ? "mcp__agent-instances__probe" : "mcp__host-foundation__probe"
            if (previous?.role === "tool" && previous.tool_call_id === "mods-child-inspect") {
              const result = successfulReply()
              if (nativeFallback) {
                assert.equal(typeof result, "string", "The native reader must return actual file text")
                assert.match(result, /AGENT_LIST_ORIGINAL_OFF_READ/)
              }
              else if (agentList) assert(Array.isArray(result.agents), "Read actual task instances")
              else {
                assert.match(result.agentId, /^mod-task:[0-9a-f-]{36}$/)
                assert.equal(typeof result.cwd, "string")
                assert.equal(result.readPermission?.decision, "allow")
                assert.equal(result.writePermission?.decision, "deny")
              }
              if (userPrompt.includes("[child-refusal]")) {
                event([
                  {
                    index: 0,
                    delta: { role: "assistant", refusal: "MODS_CHILD_REFUSED" },
                    finish_reason: "stop"
                  }
                ])
                event([], { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 })
                response.end("data: [DONE]\n\n")
                return
              }
              if (userPrompt.includes("[stall]")) {
                event([
                  {
                    index: 0,
                    delta: { role: "assistant", content: "MODS_CHILD_PARTIAL" },
                    finish_reason: null
                  }
                ])
                response.on("close", () => {
                  closedStalls++
                })
                return
              }
              answer = "MODS_CHILD_WORKER_OK"
            } else if (nativeFallback) {
              const read = ["Read", "read_file"].find((name) => names.includes(name))
              assert(read, "Mods off must retain the actual published native read tool")
              const advertised = body.tools.find(
                (entry: { function?: { name?: string } }) => entry.function?.name === read
              )
              assert.equal(advertised.function.parameters.type, "object")
              assert.equal(advertised.function.parameters.properties.file_path.type, "string")
              assert(advertised.function.parameters.required.includes("file_path"))
              call = {
                id: "mods-child-inspect",
                name: read,
                arguments: JSON.stringify({ file_path: "claw-notes" })
              }
            } else {
              call = deferredCall(
                tool,
                "mods-child-inspect",
                agentList ? {} : { mode: "child" },
                "mods-child-search"
              )
            }
          }
        }
      } catch (error) {
        // A mismatched search, schema or actual result fails the fixture instead of minting success.
        console.error("[mods-model-fixture] protocol failure", JSON.stringify({
          scenario: userPrompt.includes("[mods-child-worker]") ? "child" : "parent-or-tool",
          nativeOff: userPrompt.includes("[mods-agent-list-off]"),
          previousCallId: String(previous?.tool_call_id ?? "").slice(0, 96),
          tools: names.slice(0, 32).map((name: unknown) => String(name).slice(0, 120)),
          error: (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 240)
        }))
        answer = "MODS_REGISTERED_FIXTURE_PROTOCOL_ERROR"
        call = undefined
      }
      event([
        {
          index: 0,
          delta: call
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: call.id,
                    type: "function",
                    function: { name: call.name, arguments: call.arguments }
                  }
                ]
              }
            : { role: "assistant", content: answer },
          finish_reason: call ? "tool_calls" : "stop"
        }
      ])
      event([], { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 })
      response.end("data: [DONE]\n\n")
      return
    }
    if (Array.isArray(body.tools) && userPrompt?.includes("[mods-classic-mcp]")) {
      const tool = body.tools.find((entry: {function?:{name?:string}}) =>
        entry.function?.name?.includes("mods_error"))
      if (body.messages?.at(-1)?.role === "tool") {
        event([{index:0,delta:{role:"assistant",content:"MODEL_CLASSIC_MCP_OK"},finish_reason:"stop"}])
      } else if (tool) {
        event([{index:0,delta:{role:"assistant",tool_calls:[{index:0,id:"classic-mcp-error",
          type:"function",function:{name:tool.function.name,arguments:"{}"}}]},finish_reason:"tool_calls"}])
      } else {
        event([{index:0,delta:{role:"assistant",content:"MODEL_CLASSIC_MCP_MISSING"},finish_reason:"stop"}])
      }
      event([], {prompt_tokens:13,completion_tokens:7,total_tokens:20})
      response.end("data: [DONE]\n\n")
      return
    }
    if (Array.isArray(body.tools) && userPrompt?.includes("[mods-tool-batch]")) {
      const completed = body.messages?.at(-1)?.role === "tool"
      event([{index:0,delta:completed ? {role:"assistant",content:"TOOL_BATCH_OK"} : {
        role:"assistant",tool_calls:["batch-present.txt","batch-missing.txt"].map((file,index)=>({
          index,id:`batch-tool-${index}`,type:"function",function:{name:"read_file",arguments:JSON.stringify({file_path:file})}
        }))
      },finish_reason:completed?"stop":"tool_calls"}])
      event([], {prompt_tokens:12,completion_tokens:3,total_tokens:15})
      response.end("data: [DONE]\n\n")
      return
    }
    if (Array.isArray(body.tools) && userPrompt?.includes("[mods-native-question]")) {
      if (body.messages?.at(-1)?.role === "tool") {
        event([
          {
            index: 0,
            delta: { role: "assistant", content: "NATIVE_QUESTION_OK" },
            finish_reason: "stop"
          }
        ])
      } else {
        event([
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "native-question",
                  type: "function",
                  function: {
                    name: "request_user_input",
                    arguments: JSON.stringify({
                      questions: [
                        {
                          id: "native_choice",
                          header: "Native",
                          question: "ORIGINAL_NATIVE_QUESTION?",
                          options: [
                            { label: "Keep original", description: "Original behavior" },
                            { label: "Stop", description: "Stop" }
                          ]
                        }
                      ]
                    })
                  }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ])
      }
      event([], { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 })
      response.end("data: [DONE]\n\n")
      return
    }
    const modelToolMode =
      Array.isArray(body.tools) &&
      (userPrompt?.includes("[mods-tool-rewrite]") || userPrompt?.includes("[mods-tool-deny]"))
    if (modelToolMode) {
      const deny = userPrompt.includes("[mods-tool-deny]")
      if (body.messages?.at(-1)?.role === "tool") {
        event([
          {
            index: 0,
            delta: {
              role: "assistant",
              content: deny ? "MODEL_TOOL_DENIED_OK" : "MODEL_TOOL_HOOK_OK"
            },
            finish_reason: "stop"
          }
        ])
      } else {
        event([
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: deny ? "mods-model-deny" : "mods-model-read",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: JSON.stringify({
                      file_path: deny ? "claw-blocked" : "claw-notes"
                    })
                  }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ])
      }
      event([], { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 })
      response.end("data: [DONE]\n\n")
      return
    }
    event([
      { index: 0, delta: { role: "assistant", content: "SDK_MODEL_OK " }, finish_reason: null }
    ])
    if (prompt.includes("[stall]")) {
      response.on("close", () => {
        closedStalls++
      })
      return
    }
    event([{ index: 0, delta: { content: "sk-private-fixture-123456789" }, finish_reason: "stop" }])
    event([], { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 })
    response.end("data: [DONE]\n\n")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw Error("Missing model fixture endpoint")
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    closedStalls: () => closedStalls,
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
    }
  }
}
