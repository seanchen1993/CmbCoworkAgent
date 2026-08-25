import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { describe, expect, it } from "vitest"
import {
  argsSnippet,
  classifyMalformedArgs,
  createMalformedToolCallRecoveryMiddleware,
  jsonParseErrorDetail,
  recoverEmittedMalformedToolCalls,
  rejectRecoveredMalformedToolCall,
  repairModelRequestToolCallParity,
  sanitizeModelRequestMessages
} from "./malformed-tool-call-recovery"

/** Build the exact poisoned shape deepseek produces: a raw provider tool call
 * with truncated/unparseable JSON args. The AIMessage constructor auto-parses
 * `additional_kwargs.tool_calls` (when no normalized `tool_calls` is given) into
 * `invalid_tool_calls`, leaving normalized `tool_calls` empty — the state that
 * later 400s the OpenAI-compatible API. */
function poisonedAssistant(content = "", id = "call_bad"): AIMessage {
  return new AIMessage({
    content,
    additional_kwargs: {
      tool_calls: [
        { id, type: "function", function: { name: "read_file", arguments: '{"file_path": "foo' } }
      ]
    }
  })
}

describe("round-local model-request tool parity", () => {
  it("repairs an interrupted reused id before an ordinary model request", async () => {
    const firstCall = new AIMessage({
      content: "first interrupted call",
      tool_calls: [{ id: "call_0", name: "read_file", args: {}, type: "tool_call" }]
    })
    const secondCall = new AIMessage({
      content: "second completed call",
      tool_calls: [{ id: "call_0", name: "read_file", args: {}, type: "tool_call" }]
    })
    const secondResult = new ToolMessage({
      content: "second result",
      name: "read_file",
      tool_call_id: "call_0"
    })
    const messages = [
      new HumanMessage("start"),
      firstCall,
      new HumanMessage("interrupt"),
      secondCall,
      secondResult,
      new HumanMessage("continue")
    ]
    const middleware = createMalformedToolCallRecoveryMiddleware()
    let requestMessages: unknown

    await middleware.wrapModelCall!({ messages } as never, async (request) => {
      requestMessages = request.messages
      return new AIMessage("handled")
    })

    const repaired = requestMessages as Array<AIMessage | HumanMessage | ToolMessage>
    const firstCallIndex = repaired.indexOf(firstCall)
    const cancellation = repaired[firstCallIndex + 1]
    expect(ToolMessage.isInstance(cancellation)).toBe(true)
    expect((cancellation as ToolMessage).tool_call_id).toBe("call_0")
    expect(repaired.indexOf(secondResult)).toBeGreaterThan(repaired.indexOf(secondCall))
    expect(messages).toHaveLength(6)
    expect(messages[firstCallIndex + 1]).toBeInstanceOf(HumanMessage)
  })

  it("preserves valid completed rounds when a provider reuses the same id", () => {
    const messages = [
      new HumanMessage("first"),
      new AIMessage({
        content: "",
        tool_calls: [{ id: "call_0", name: "read_file", args: {}, type: "tool_call" }]
      }),
      new ToolMessage({ content: "one", name: "read_file", tool_call_id: "call_0" }),
      new HumanMessage("second"),
      new AIMessage({
        content: "",
        tool_calls: [{ id: "call_0", name: "read_file", args: {}, type: "tool_call" }]
      }),
      new ToolMessage({ content: "two", name: "read_file", tool_call_id: "call_0" })
    ]

    expect(repairModelRequestToolCallParity(messages)).toBe(messages)
  })
})

describe("recoverEmittedMalformedToolCalls (output repair)", () => {
  it("promotes a malformed tool call into a normalized tool_call the guard can reject", () => {
    const message = poisonedAssistant()
    // Precondition: this is the poisoned shape.
    expect(message.tool_calls).toEqual([])
    expect(message.invalid_tool_calls?.length).toBe(1)

    const changed = recoverEmittedMalformedToolCalls(message)

    expect(changed).toBe(true)
    expect(message.tool_calls).toHaveLength(1)
    const promoted = message.tool_calls![0]
    expect(promoted.id).toBe("call_bad")
    expect(promoted.name).toBe("read_file")
    expect(promoted.type).toBe("tool_call")
    expect(message.invalid_tool_calls).toEqual([])
    // Raw provider copy stripped so the converter uses our paired normalized call.
    expect(message.additional_kwargs.tool_calls).toBeUndefined()
    // The diagnosis rides on the call's OWN args → the guard rejects it (tool never runs).
    expect(rejectRecoveredMalformedToolCall(promoted)).toBeInstanceOf(ToolMessage)
  })

  it("is a no-op for a clean assistant message with valid tool calls", () => {
    const message = new AIMessage({
      content: "",
      tool_calls: [
        { id: "call_ok", name: "read_file", args: { file_path: "x" }, type: "tool_call" }
      ]
    })
    const changed = recoverEmittedMalformedToolCalls(message)
    expect(changed).toBe(false)
    expect(message.tool_calls).toEqual([
      { id: "call_ok", name: "read_file", args: { file_path: "x" }, type: "tool_call" }
    ])
    // A genuinely valid call carries no marker → the guard leaves it to run.
    expect(rejectRecoveredMalformedToolCall(message.tool_calls![0])).toBeNull()
  })

  it("preserves already-valid tool calls and appends the recovered one", () => {
    const message = new AIMessage({
      content: "",
      tool_calls: [{ id: "v1", name: "ls", args: {}, type: "tool_call" }],
      invalid_tool_calls: [
        { id: "m1", name: "read_file", args: '{"path": ', error: "Malformed args." }
      ]
    })
    const changed = recoverEmittedMalformedToolCalls(message)
    expect(changed).toBe(true)
    expect(message.tool_calls).toHaveLength(2)
    const [valid, recovered] = message.tool_calls!
    expect(valid).toEqual({ id: "v1", name: "ls", args: {}, type: "tool_call" })
    expect(recovered.id).toBe("m1")
    expect(message.invalid_tool_calls).toEqual([])
    // Only the recovered call is rejected; the valid one runs normally.
    expect(rejectRecoveredMalformedToolCall(recovered)).toBeInstanceOf(ToolMessage)
    expect(rejectRecoveredMalformedToolCall(valid)).toBeNull()
  })

  it("synthesizes an id when the malformed call has none", () => {
    const message = new AIMessage({
      content: "",
      invalid_tool_calls: [{ name: "read_file", args: '{"path": ', error: "Malformed args." }]
    })
    const changed = recoverEmittedMalformedToolCalls(message)
    expect(changed).toBe(true)
    expect(message.tool_calls).toHaveLength(1)
    expect(message.tool_calls?.[0]?.id).toMatch(/^malformed_/)
    expect(rejectRecoveredMalformedToolCall(message.tool_calls![0])).toBeInstanceOf(ToolMessage)
  })

  it("gives a valid placeholder name when the malformed call has none (avoids name:'' 400)", () => {
    // Phase B: an invalid_tool_call with no name. Empty name would serialize to
    // function.name:"" in the next request → OpenAI-compatible 400. The tool never
    // runs, so any valid non-empty name is fine.
    const message = new AIMessage({
      content: "",
      invalid_tool_calls: [{ args: '{"a": ', error: "Malformed args." }]
    })
    recoverEmittedMalformedToolCalls(message)
    const promoted = message.tool_calls![0]
    expect(promoted.name).toBe("malformed_tool_call")
    expect(promoted.name.length).toBeGreaterThan(0)
    expect(rejectRecoveredMalformedToolCall(promoted)).toBeInstanceOf(ToolMessage)
  })

  it("gives a valid placeholder name for a nameless STREAMED malformed call too (Phase A)", () => {
    // Phase A: a streamed call the lenient collapse salvaged, with no name and
    // truncated raw args → the audit must not leave name:''.
    const chunk = new AIMessageChunk({
      content: "",
      tool_call_chunks: [{ args: '{"script":', id: "call_noname", index: 0 }]
    })
    recoverEmittedMalformedToolCalls(chunk)
    const promoted = chunk.tool_calls![0]
    expect(promoted.name).toBe("malformed_tool_call")
    expect(rejectRecoveredMalformedToolCall(promoted)).toBeInstanceOf(ToolMessage)
  })

  it("clears tool_call_chunks when recovering a malformed chunk message", () => {
    // Note: AIMessageChunk uses a LENIENT partial-JSON parser that salvages
    // truncated args, so we assign the malformed buckets directly to exercise
    // the strict-parse poison shape (what reload / non-streaming produce).
    const chunk = new AIMessageChunk({ content: "" })
    chunk.invalid_tool_calls = [
      { name: "read_file", args: '{"file_path": "foo', id: "call_chunk", error: "Malformed args." }
    ]
    chunk.tool_call_chunks = [
      { name: "read_file", args: '{"file_path": "foo', id: "call_chunk", index: 0 }
    ]

    const changed = recoverEmittedMalformedToolCalls(chunk)
    expect(changed).toBe(true)
    expect(chunk.tool_calls).toHaveLength(1)
    expect(chunk.tool_calls?.[0]?.id).toBe("call_chunk")
    expect(chunk.invalid_tool_calls).toEqual([])
    expect(chunk.tool_call_chunks).toEqual([])
    expect(rejectRecoveredMalformedToolCall(chunk.tool_calls![0])).toBeInstanceOf(ToolMessage)
  })

  it("catches a STREAMED truncation the lenient collapse salvaged to {} (workflow loop shape)", () => {
    // Real streaming shape: collapseToolCallChunks parses '{"script":' with
    // parsePartialJson → salvages a NORMALIZED call with args {} and leaves
    // invalid_tool_calls EMPTY. Without the raw-args audit the workflow tool
    // would really run with {} and report "one of `script`… required".
    const chunk = new AIMessageChunk({
      content: "",
      tool_call_chunks: [{ name: "workflow", args: '{"script":', id: "call_x", index: 0 }]
    })
    // Precondition: the lenient salvage happened.
    expect(chunk.tool_calls).toEqual([
      { name: "workflow", args: {}, id: "call_x", type: "tool_call" }
    ])
    expect(chunk.invalid_tool_calls).toEqual([])

    const changed = recoverEmittedMalformedToolCalls(chunk)
    expect(changed).toBe(true)
    expect(chunk.tool_call_chunks).toEqual([]) // reload cannot re-collapse leniently
    const rejection = rejectRecoveredMalformedToolCall(chunk.tool_calls![0])
    expect(rejection).toBeInstanceOf(ToolMessage)
    expect(String(rejection?.content)).toMatch(/truncated/i)
    expect(String(rejection?.content)).toContain('{"script":')
  })

  it("catches a STREAMED mid-string truncation salvaged into half a value (write_file shape)", () => {
    // parsePartialJson turns '…"content":"half of the fi' into a WELL-FORMED
    // object with a truncated value — the tool would silently write half a file.
    const chunk = new AIMessageChunk({
      content: "",
      tool_call_chunks: [
        {
          name: "write_file",
          args: '{"path":"a.txt","content":"half of the fi',
          id: "call_y",
          index: 0
        }
      ]
    })
    expect(chunk.tool_calls?.[0]?.args).toEqual({ path: "a.txt", content: "half of the fi" })

    const changed = recoverEmittedMalformedToolCalls(chunk)
    expect(changed).toBe(true)
    const rejection = rejectRecoveredMalformedToolCall(chunk.tool_calls![0])
    expect(rejection).toBeInstanceOf(ToolMessage)
    expect(String(rejection?.content)).toMatch(/truncated/i)
  })

  it("leaves a healthy streamed call untouched (raw args strict-parse cleanly)", () => {
    const chunk = new AIMessageChunk({
      content: "",
      tool_call_chunks: [{ name: "ls", args: '{"dir":"/tmp"}', id: "call_ok", index: 0 }]
    })
    const changed = recoverEmittedMalformedToolCalls(chunk)
    expect(changed).toBe(false)
    expect(chunk.tool_calls).toEqual([
      { name: "ls", args: { dir: "/tmp" }, id: "call_ok", type: "tool_call" }
    ])
    expect(chunk.tool_call_chunks).toHaveLength(1) // untouched
    expect(rejectRecoveredMalformedToolCall(chunk.tool_calls![0])).toBeNull()
  })

  it("leaves a no-arg streamed call alone (empty raw args ⇒ {} like CC)", () => {
    const chunk = new AIMessageChunk({
      content: "",
      tool_call_chunks: [{ name: "list_tasks", args: "", id: "call_noargs", index: 0 }]
    })
    // collapse turns "" into args {} — a legitimate no-arg invocation.
    expect(chunk.tool_calls?.[0]?.args).toEqual({})
    expect(recoverEmittedMalformedToolCalls(chunk)).toBe(false)
    expect(rejectRecoveredMalformedToolCall(chunk.tool_calls![0])).toBeNull()
  })

  it("marker from a streamed audit survives a message-level checkpoint round-trip", () => {
    const chunk = new AIMessageChunk({
      content: "",
      tool_call_chunks: [{ name: "workflow", args: '{"script":', id: "call_rt", index: 0 }]
    })
    recoverEmittedMalformedToolCalls(chunk)
    // Serialize → restart → deserialize. JSON.stringify on a LangChain message
    // yields the LC envelope ({lc, type, id, kwargs}); the checkpoint revive path
    // feeds `kwargs` back into the constructor — mirror that. Chunks were cleared
    // by the audit, so the constructor cannot re-collapse leniently over our
    // marker (non-empty tool_call_chunks would REBUILD tool_calls from them).
    const envelope = JSON.parse(JSON.stringify(chunk)) as { kwargs: Record<string, unknown> }
    expect(envelope.kwargs.tool_call_chunks).toEqual([])
    const revived = new AIMessageChunk(
      envelope.kwargs as ConstructorParameters<typeof AIMessageChunk>[0]
    )
    const rejection = rejectRecoveredMalformedToolCall(revived.tool_calls![0])
    expect(rejection).toBeInstanceOf(ToolMessage)
    expect(String(rejection?.content)).toMatch(/truncated/i)
  })
})

describe("classifyMalformedArgs (real-cause detection)", () => {
  it("classifies cut-off JSON as truncated", () => {
    expect(classifyMalformedArgs('{"script": "console.lo')).toBe("truncated") // unterminated string
    expect(classifyMalformedArgs('{"a": 1, "b": [1, 2,')).toBe("truncated") // brackets left open
    expect(classifyMalformedArgs('{"a": {"b":')).toBe("truncated")
  })

  it("classifies grammatically-broken-but-complete JSON as a syntax error", () => {
    expect(classifyMalformedArgs('{"a": 1,}')).toBe("format") // trailing comma, balanced
    expect(classifyMalformedArgs('{"a": [1, 2}')).toBe("format") // mismatched bracket type
    expect(classifyMalformedArgs('{"msg": "he said "hi""}')).toBe("format") // unescaped quotes
    expect(classifyMalformedArgs("")).toBe("format") // nothing usable → generic fix-the-JSON
  })

  it("treats escaped quotes inside strings correctly", () => {
    // The \" does not close the string, so this is genuinely cut off.
    expect(classifyMalformedArgs('{"a": "he said \\"hi')).toBe("truncated")
  })
})

describe("jsonParseErrorDetail (ground-truth parser message)", () => {
  it("returns the parser complaint for broken JSON and empty for valid/absent", () => {
    expect(jsonParseErrorDetail('{"a": "co')).not.toBe("") // real V8 parse error
    expect(jsonParseErrorDetail('{"a": 1}')).toBe("") // valid → nothing to report
    expect(jsonParseErrorDetail("")).toBe("")
    expect(jsonParseErrorDetail(undefined)).toBe("")
  })
})

describe("argsSnippet (bounded original-text excerpt)", () => {
  it("keeps small args whole so the model can fix its own text", () => {
    const raw = '{"path": "a",}'
    expect(argsSnippet(raw)).toBe(raw)
  })

  it("bounds huge args to head + tail with an omission note", () => {
    const raw = `{"script": "${"x".repeat(5000)}`
    const snippet = argsSnippet(raw)
    expect(snippet.length).toBeLessThan(700)
    expect(snippet.startsWith('{"script": "xxx')).toBe(true)
    expect(snippet).toMatch(/characters omitted/)
    expect(snippet.endsWith("x".repeat(10))).toBe(true)
  })

  it("returns empty for non-string/blank input", () => {
    expect(argsSnippet(undefined)).toBe("")
    expect(argsSnippet("   ")).toBe("")
  })
})

/** Promote a single malformed invalid_tool_call and return the resulting normalized call. */
function promoteOne(args: string, opts: { id?: string; name?: string } = {}) {
  const message = new AIMessage({
    content: "",
    invalid_tool_calls: [
      { id: opts.id ?? "call_x", name: opts.name ?? "workflow", args, error: "Malformed args." }
    ]
  })
  recoverEmittedMalformedToolCalls(message)
  return message.tool_calls![0]
}

describe("rejectRecoveredMalformedToolCall (wrapToolCall guard)", () => {
  it("gives TRUNCATION advice for a cut-off call", () => {
    const rejection = rejectRecoveredMalformedToolCall(
      promoteOne('{"script": "co', { id: "call_trunc" })
    )
    expect(rejection).toBeInstanceOf(ToolMessage)
    expect(rejection?.status).toBe("error")
    expect(rejection?.tool_call_id).toBe("call_trunc")
    expect(String(rejection?.content)).toMatch(/truncated/i)
    expect(String(rejection?.content)).toMatch(/smaller|too large/i)
    // Carries the ground-truth parser complaint, not just our category.
    expect(String(rejection?.content)).toMatch(/JSON parser reported/i)
  })

  it("gives SYNTAX advice for a grammatically-broken call (do not tell it to shrink)", () => {
    const rejection = rejectRecoveredMalformedToolCall(
      promoteOne('{"path": "a",}', { id: "call_syntax", name: "read_file" })
    )
    expect(String(rejection?.content)).toMatch(/syntax error/i)
    expect(String(rejection?.content)).not.toMatch(/truncated/i)
    expect(String(rejection?.content)).toMatch(/fix the JSON/i)
    // Carries the ORIGINAL broken text so the model can repair its escaping/
    // punctuation instead of regenerating blind (the raw copy is stripped from
    // the transcript — this excerpt is the only surviving record).
    expect(String(rejection?.content)).toContain('{"path": "a",}')
  })

  it("survives a checkpoint round-trip — the marker rides on the call, not process memory", () => {
    const promoted = promoteOne('{"a": [1,', { id: "call_persist" })
    // Serialize → (app restart) → deserialize: a plain object with no in-memory map.
    const roundTripped = JSON.parse(JSON.stringify(promoted))
    const rejection = rejectRecoveredMalformedToolCall(roundTripped)
    expect(rejection).toBeInstanceOf(ToolMessage)
    expect(String(rejection?.content)).toMatch(/truncated/i)
  })

  it("keeps two concurrent SAME-id calls independent (no shared-state collision)", () => {
    // Gateways can reuse ids like `call_0` across concurrent subagents. Each call
    // carries its own diagnosis, so neither clobbers the other into the real tool.
    const truncated = promoteOne('{"x": [1,', { id: "call_0", name: "workflow" })
    const syntax = promoteOne('{"p": 1,}', { id: "call_0", name: "read_file" })
    expect(String(rejectRecoveredMalformedToolCall(truncated)?.content)).toMatch(/truncated/i)
    expect(String(rejectRecoveredMalformedToolCall(syntax)?.content)).toMatch(/syntax error/i)
  })

  it("passes through a normal (non-recovered) tool call — no marker, no rejection", () => {
    expect(
      rejectRecoveredMalformedToolCall({ id: "call_ok", name: "read_file", args: { path: "x" } })
    ).toBeNull()
    expect(rejectRecoveredMalformedToolCall({ id: "call_ok" })).toBeNull()
    expect(rejectRecoveredMalformedToolCall(undefined)).toBeNull()
  })
})

describe("sanitizeModelRequestMessages (input sanitize)", () => {
  it("strips an unpaired raw tool call so the request no longer 400s, keeping text", () => {
    const messages = [
      new HumanMessage("read foo"),
      poisonedAssistant("Let me read that file."),
      new HumanMessage("actually, hello")
    ]
    const out = sanitizeModelRequestMessages(messages)

    expect(out).not.toBe(messages)
    expect(out).toHaveLength(3)
    const cleaned = out[1] as AIMessage
    expect(cleaned.content).toBe("Let me read that file.")
    expect(cleaned.tool_calls ?? []).toEqual([])
    expect(cleaned.additional_kwargs.tool_calls).toBeUndefined()
  })

  it("drops a contentless poisoned turn entirely (filterUnresolvedToolUses parity)", () => {
    const messages = [
      new HumanMessage("read foo"),
      poisonedAssistant(""),
      new HumanMessage("hello")
    ]
    const out = sanitizeModelRequestMessages(messages)
    expect(out).toHaveLength(2)
    expect(out.every((m) => !AIMessage.isInstance(m) || (m.tool_calls ?? []).length === 0)).toBe(
      true
    )
  })

  it("strips the raw artifact EVEN when a ToolMessage is present (patchToolCalls would orphan it → 400)", () => {
    // The earlier code passed this through; then patchToolCalls (normalized-only)
    // drops the ToolMessage as an orphan, re-dangling the raw call → 400.
    const messages = [
      poisonedAssistant("thinking"),
      new ToolMessage({ content: "ok", tool_call_id: "call_bad", name: "read_file" })
    ]
    const out = sanitizeModelRequestMessages(messages)
    expect(out).not.toBe(messages)
    const cleaned = out[0] as AIMessage
    expect(cleaned.content).toBe("thinking")
    expect(cleaned.additional_kwargs.tool_calls).toBeUndefined()
  })

  it("keeps valid normalized calls while stripping a mixed raw provider copy", () => {
    const mixed = new AIMessage({
      content: "I will inspect both files.",
      tool_calls: [
        { id: "call_good", name: "read_file", args: { file_path: "good.ts" }, type: "tool_call" }
      ],
      additional_kwargs: {
        tool_calls: [
          {
            id: "call_good",
            type: "function",
            function: { name: "read_file", arguments: '{"file_path":"good.ts"}' }
          },
          {
            id: "call_bad",
            type: "function",
            function: { name: "read_file", arguments: '{"file_path":' }
          }
        ]
      }
    })

    const out = sanitizeModelRequestMessages([mixed])
    const cleaned = out[0] as AIMessage
    expect(cleaned.tool_calls).toEqual(mixed.tool_calls)
    expect(cleaned.invalid_tool_calls).toEqual([])
    expect(cleaned.additional_kwargs.tool_calls).toBeUndefined()
    expect(mixed.additional_kwargs.tool_calls).toHaveLength(2)
  })

  it("strips a later raw call even if an OLDER turn has a ToolMessage with the same id", () => {
    // call_0 is legitimately used+answered earlier, then reused by a later
    // malformed emission. A global id set would falsely treat the later raw call
    // as paired and leave it in → 400. Always-strip avoids that.
    const messages = [
      new AIMessage({
        content: "",
        tool_calls: [{ id: "call_0", name: "ls", args: {}, type: "tool_call" }]
      }),
      new ToolMessage({ content: "done", tool_call_id: "call_0", name: "ls" }),
      new HumanMessage("more"),
      poisonedAssistant("later thinking", "call_0")
    ]
    const out = sanitizeModelRequestMessages(messages)
    const later = out[out.length - 1] as AIMessage
    expect(later.additional_kwargs.tool_calls).toBeUndefined() // stripped despite the same-id older ToolMessage
    expect((out[0] as AIMessage).tool_calls).toHaveLength(1) // earlier legit turn untouched
  })

  it("strips a redundant raw provider copy while preserving normalized tool calls", () => {
    const withNormalized = new AIMessage({
      content: "",
      tool_calls: [
        { id: "call_ok", name: "read_file", args: { file_path: "x" }, type: "tool_call" }
      ],
      additional_kwargs: {
        tool_calls: [
          {
            id: "call_ok",
            type: "function",
            function: { name: "read_file", arguments: '{"file_path":"x"}' }
          }
        ]
      }
    })
    const messages = [new HumanMessage("go"), withNormalized]
    const out = sanitizeModelRequestMessages(messages)
    const cleaned = out[1] as AIMessage
    expect(cleaned.tool_calls).toEqual(withNormalized.tool_calls)
    expect(cleaned.additional_kwargs.tool_calls).toBeUndefined()
    expect(withNormalized.additional_kwargs.tool_calls).toHaveLength(1)
  })

  it("elides a completed large write_file argument only in the outgoing request", () => {
    const content = "x".repeat(32 * 1024 + 1)
    const assistant = new AIMessage({
      content: "Wrote the report.",
      tool_calls: [
        {
          id: "call_large_write",
          name: "write_file",
          args: { file_path: "/tmp/report.md", content },
          type: "tool_call"
        }
      ]
    })
    const result = new ToolMessage({
      content: "Successfully wrote to '/tmp/report.md'",
      tool_call_id: "call_large_write",
      name: "write_file"
    })
    const messages = [assistant, result, new HumanMessage("continue")]

    const out = sanitizeModelRequestMessages(messages)

    const sent = out[0] as AIMessage
    const sentArgs = sent.tool_calls![0].args as Record<string, unknown>
    expect(out).not.toBe(messages)
    expect(sent.tool_calls![0].id).toBe("call_large_write")
    expect(sentArgs.file_path).toBe("/tmp/report.md")
    expect(String(sentArgs.content)).toContain("bytes=32769")
    expect(String(sentArgs.content)).toMatch(/sha256=[a-f0-9]{64}/)
    expect(sentArgs.content).not.toBe(content)
    expect((assistant.tool_calls![0].args as Record<string, unknown>).content).toBe(content)
    expect(out[1]).toBe(result)
  })

  it("elides both large edit_file strings while retaining the tool-call pairing", () => {
    const oldString = "o".repeat(32 * 1024 + 1)
    const newString = "n".repeat(32 * 1024 + 1)
    const assistant = new AIMessage({
      content: "Updated the report.",
      tool_calls: [
        {
          id: "call_large_edit",
          name: "edit_file",
          args: { filePath: "/tmp/report.md", oldString, newString },
          type: "tool_call"
        }
      ]
    })
    const result = new ToolMessage({
      content: "Successfully replaced 1 occurrence(s) in '/tmp/report.md'",
      tool_call_id: "call_large_edit",
      name: "edit_file"
    })
    const messages = [assistant, result, new HumanMessage("continue")]

    const out = sanitizeModelRequestMessages(messages)

    const sentArgs = (out[0] as AIMessage).tool_calls![0].args as Record<string, unknown>
    expect(String(sentArgs.oldString)).toContain("large edit_file.oldString omitted")
    expect(String(sentArgs.newString)).toContain("large edit_file.newString omitted")
    expect(String(sentArgs.oldString)).toContain("file_path=/tmp/report.md")
    expect((assistant.tool_calls![0].args as Record<string, unknown>).oldString).toBe(oldString)
    expect((assistant.tool_calls![0].args as Record<string, unknown>).newString).toBe(newString)
  })

  it("keeps large arguments when the matching tool execution failed", () => {
    const content = "x".repeat(32 * 1024 + 1)
    const assistant = new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "call_failed_write",
          name: "write_file",
          args: { file_path: "/tmp/report.md", content },
          type: "tool_call"
        }
      ]
    })
    const result = new ToolMessage({
      content: "permission denied",
      tool_call_id: "call_failed_write",
      name: "write_file",
      status: "error"
    })
    const messages = [assistant, result, new HumanMessage("continue")]

    expect(sanitizeModelRequestMessages(messages)).toBe(messages)
    expect((assistant.tool_calls![0].args as Record<string, unknown>).content).toBe(content)
  })

  it("keeps large arguments when ToolNode labels a returned file error as success", () => {
    const content = "x".repeat(32 * 1024 + 1)
    const assistant = new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "call_string_error",
          name: "write_file",
          args: { file_path: "/tmp/report.md", content },
          type: "tool_call"
        }
      ]
    })
    const result = new ToolMessage({
      content: "Access denied",
      tool_call_id: "call_string_error",
      name: "write_file",
      status: "success"
    })
    const messages = [assistant, result, new HumanMessage("continue")]

    expect(sanitizeModelRequestMessages(messages)).toBe(messages)
    expect((assistant.tool_calls![0].args as Record<string, unknown>).content).toBe(content)
  })

  it("keeps large arguments when a status-less result contains structured error output", () => {
    const content = "x".repeat(32 * 1024 + 1)
    const assistant = new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "call_json_error",
          name: "write_file",
          args: { file_path: "/tmp/report.md", content },
          type: "tool_call"
        }
      ]
    })
    const result = new ToolMessage({
      content: JSON.stringify({ error: "permission denied" }),
      tool_call_id: "call_json_error",
      name: "write_file"
    })
    const messages = [assistant, result, new HumanMessage("continue")]

    expect(sanitizeModelRequestMessages(messages)).toBe(messages)
    expect((assistant.tool_calls![0].args as Record<string, unknown>).content).toBe(content)
  })

  it("keeps large arguments when the tool call has no paired result yet", () => {
    const content = "x".repeat(32 * 1024 + 1)
    const assistant = new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "call_pending_write",
          name: "write_file",
          args: { file_path: "/tmp/report.md", content },
          type: "tool_call"
        }
      ]
    })
    const messages = [assistant, new HumanMessage("continue")]

    expect(sanitizeModelRequestMessages(messages)).toBe(messages)
    expect((assistant.tool_calls![0].args as Record<string, unknown>).content).toBe(content)
  })

  it("returns the same array reference when nothing is poisoned", () => {
    const messages = [new HumanMessage("hi"), new AIMessage({ content: "hello" })]
    expect(sanitizeModelRequestMessages(messages)).toBe(messages)
  })

  it("blanks the recovery marker from history so the MODEL never sees it (state keeps it)", () => {
    // A prior turn's recovered call: promoted (marker in args) + paired error result.
    const promoted = promoteOne('{"path": "a",}', { id: "call_m", name: "read_file" })
    const assistant = new AIMessage({ content: "let me read", tool_calls: [promoted] })
    const messages = [
      new HumanMessage("read a"),
      assistant,
      new ToolMessage({ content: "syntax error", tool_call_id: "call_m", status: "error" }),
      new HumanMessage("continue")
    ]

    const out = sanitizeModelRequestMessages(messages)

    // Model-facing request: marker is gone, args blanked to {}.
    const sent = out[1] as AIMessage
    const sentArgs = sent.tool_calls![0].args as Record<string, unknown>
    expect(Object.keys(sentArgs)).toEqual([]) // no __cmbRecoveredMalformedToolCall__
    // The on-disk / state message is UNTOUCHED — the guard + restart recovery need it.
    expect(assistant).toBe(messages[1])
    expect(rejectRecoveredMalformedToolCall(assistant.tool_calls![0])).toBeInstanceOf(ToolMessage)
    // Everything else passed through.
    expect(out).toHaveLength(4)
  })
})
