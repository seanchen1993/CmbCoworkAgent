import { createHash, randomUUID } from "crypto"
import { AIMessage, ToolMessage, type BaseMessage, type ToolCall } from "@langchain/core/messages"
import { createMiddleware } from "langchain"

/**
 * Recovers from tool calls whose arguments the provider streamed as malformed /
 * truncated JSON. This is common with mid-tier OpenAI-compatible gateways
 * (deepseek et al.) and is the SAME problem Claude Code solves in
 * `normalizeContentFromAPI` + `filterUnresolvedToolUses`:
 *
 *   - LangChain's `defaultToolCallParser` puts an unparseable tool call into
 *     `invalid_tool_calls` (+ the raw provider copy in
 *     `additional_kwargs.tool_calls`) and leaves the normalized `tool_calls`
 *     array EMPTY.
 *   - Because normalized `tool_calls` is empty, the ReactAgent never routes to
 *     the tool node, so `toolErrorMiddleware` never fires and NO tool result is
 *     produced. The call dangles.
 *   - On the next request `convertMessagesToCompletionsMessageParams`
 *     (@langchain/openai) falls back to `additional_kwargs.tool_calls` for that
 *     assistant turn (it only prefers normalized `tool_calls` when non-empty),
 *     so it emits an assistant message carrying a tool call with no matching
 *     tool result → the OpenAI-compatible API rejects the whole request with a
 *     400 ("tool_calls must be followed by tool messages …").
 *   - deepagents' `patchToolCalls` cannot save us: it only pairs NORMALIZED
 *     `tool_calls`, never `additional_kwargs` / `invalid_tool_calls`.
 *   - STREAMED calls fail differently: `collapseToolCallChunks` parses the
 *     accumulated args with `parsePartialJson` (LENIENT), so truncation is
 *     silently "salvaged" into normalized `tool_calls` (args `{}` / half values)
 *     with `invalid_tool_calls` EMPTY — no 400, but the tool REALLY RUNS with
 *     wrong args. CC's final authority is a STRICT parse of the raw string, so
 *     we audit streamed calls against their raw `tool_call_chunks` args (see
 *     `recoverEmittedMalformedToolCalls` Phase A).
 *
 * Claude Code never drops the tool call and never rewrites history. It keeps the
 * tool_use, coerces malformed input toward `{}`, and lets input-schema
 * validation produce a PAIRED `is_error` result the model can read and retry
 * against. We mirror that with two middlewares (guard + recovery — split so the
 * guard can sit FIRST/outermost in the chain while the recovery sits late):
 *
 *   1. OUTPUT (after the model call) — promote each malformed `invalid_tool_call`
 *      into a real normalized `tool_call` so the ReactAgent routes it to the tool
 *      node (keeping the transcript paired), with the diagnosis embedded in the
 *      call's OWN args (a marker). But we do NOT run the tool: a `wrapToolCall`
 *      guard reads that marker and RETURNS an error ToolMessage targeted to the
 *      DETECTED cause (`classifyMalformedArgs`): a syntax error ("fix the
 *      escaping/punctuation") vs truncation ("too large — shrink or split").
 *      Running the tool with `{}` was wrong for tools that accept `{}` and
 *      validate internally (e.g. `workflow`, whose "one of `script`… required"
 *      reads like "you forgot the script", so the model re-sends the SAME broken
 *      args and loops forever). Telling the model the real problem (bad JSON, not
 *      a missing field) lets it fix the right thing. This also prevents any new
 *      poisoned checkpoint. The marker lives on the call itself (not a process
 *      map) so the guard still fires after a checkpoint/resume and under
 *      concurrent tool_call_id reuse across subagents.
 *      (The guard must RETURN rather than throw: the middleware composer wraps a
 *      throw in a MiddlewareError that toolErrorMiddleware treats as fatal.)
 *
 *   2. INPUT (before the model call) — for transcripts that were ALREADY
 *      poisoned (a prior turn wrote the dangling raw call before this fix
 *      existed, or a summarization/goal turn re-sends history), strip the raw
 *      tool-call artifact from the outgoing request so the API accepts it —
 *      unconditionally, paired or not (see sanitizeModelRequestMessages for why
 *      a pairing check is both unsafe under patchToolCalls and unsound). We keep
 *      the assistant's visible text; a fully-empty turn is dropped, matching
 *      Claude Code's `filterUnresolvedToolUses`. History on disk is left
 *      untouched — the sanitize happens only on the request payload, exactly
 *      like CC, so there is no fragile checkpoint rewrite.
 */

/** Only AIMessageChunk carries `tool_call_chunks`; a plain AIMessage does not.
 * We clear it (when present) so a collapsed malformed chunk can't resurrect the
 * raw call after we've promoted it. */
type WithToolCallChunks = { tool_call_chunks?: unknown[] }

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function clearToolCallChunks(message: AIMessage): void {
  if ("tool_call_chunks" in message) (message as WithToolCallChunks).tool_call_chunks = []
}

type MalformedCause = "truncated" | "format"

const MALFORMED_TRUNCATED_MESSAGE =
  "The arguments for this tool call were TRUNCATED — the JSON was cut off before it finished (a string or bracket was " +
  "left unclosed), so the tool was NOT run. This usually means the arguments were too large to send in one call " +
  "(common with a big `workflow` script). Do NOT resend the same arguments — make them substantially smaller or split " +
  "the work into multiple smaller steps / runs. If you cannot, tell the user the request is too large to execute in a " +
  "single tool call."

const MALFORMED_SYNTAX_MESSAGE =
  "The arguments for this tool call had a JSON SYNTAX ERROR (for example an unescaped quote or newline inside a string, " +
  "a trailing comma, or mismatched brackets/quotes), so the tool was NOT run. Fix the JSON syntax and re-issue the call. " +
  "The content you intended is probably fine — you most likely just need to correct the escaping or punctuation, not " +
  "shrink or change what you are trying to do."

/** Best-effort classification of WHY the args JSON failed to parse, so the model
 * gets targeted advice. Truncation (args cut off in transit — common with a big
 * workflow script) leaves the structure unfinished: still inside a string, or
 * brackets left open at the very end. A syntax/format error (bad escaping,
 * trailing comma, mismatched bracket) instead violates the grammar while the
 * structure is otherwise complete. We scan the raw string rather than match
 * `JSON.parse`'s error text, which varies across engines. Exported for testing. */
export function classifyMalformedArgs(raw: unknown): MalformedCause {
  if (typeof raw !== "string" || raw.trim() === "") return "format"
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (const ch of raw) {
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "{" || ch === "[") stack.push(ch)
    else if (ch === "}" || ch === "]") {
      const open = stack.pop()
      // A close with no/mismatched open is a structural syntax error, not a cutoff.
      if (open === undefined || (ch === "}" && open !== "{") || (ch === "]" && open !== "[")) {
        return "format"
      }
    }
  }
  // Ended mid-string or with brackets still open ⇒ the JSON was cut off.
  return inString || stack.length > 0 ? "truncated" : "format"
}

/** The raw parser complaint (V8's `JSON.parse` message — on modern V8 it quotes a
 * short snippet around the failure), shown to the model so it sees the
 * GROUND-TRUTH error, not just our category. Bounded so a huge script can't bloat
 * the result. Exported for testing. */
export function jsonParseErrorDetail(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") return ""
  try {
    JSON.parse(raw)
    return ""
  } catch (error) {
    return error instanceof Error ? error.message.slice(0, 200).trim() : ""
  }
}

interface MalformedDiagnosis {
  cause: MalformedCause
  /** Raw JSON.parse message, or "" if unavailable. */
  detail: string
  /** Bounded excerpt of the original broken args (see argsSnippet). */
  snippet: string
}

// Snippet bounds: small args (the common syntax-error case) are kept WHOLE so the
// model can repair its own escaping/punctuation from the original text instead of
// regenerating blind (the raw copy is stripped from the transcript — this snippet
// is the only surviving record). Large args (the truncation case) keep head+tail,
// enough to recall intent without re-shipping a huge broken script.
const SNIPPET_WHOLE_MAX_CHARS = 600
const SNIPPET_EDGE_CHARS = 300

/** Bounded excerpt of the raw args for the error message. Exported for testing. */
export function argsSnippet(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") return ""
  if (raw.length <= SNIPPET_WHOLE_MAX_CHARS) return raw
  const omitted = raw.length - 2 * SNIPPET_EDGE_CHARS
  return `${raw.slice(0, SNIPPET_EDGE_CHARS)}\n…[${omitted} characters omitted]…\n${raw.slice(-SNIPPET_EDGE_CHARS)}`
}

function diagnoseMalformedArgs(raw: unknown): MalformedDiagnosis {
  return {
    cause: classifyMalformedArgs(raw),
    detail: jsonParseErrorDetail(raw),
    snippet: argsSnippet(raw)
  }
}

// Marker embedded in a promoted tool_call's OWN args so the wrapToolCall guard
// recognises it and rejects it before the tool runs. Binding the diagnosis to the
// call itself (not a process-global map) fixes two holes:
//   - persistence: the marker is checkpointed with the call, so after an app
//     restart / resume between the model node and the tool node, the guard still
//     intercepts instead of executing the tool with placeholder args.
//   - concurrency: OpenAI-compatible gateways may reuse tool_call_ids (e.g.
//     `call_0`) across concurrent runs/subagents; a global id→diagnosis map would
//     let one call's diagnosis clobber another's and drop the second into the real
//     tool. Each call now carries its own marker, so there is no shared state.
const RECOVERED_MALFORMED_MARKER = "__cmbRecoveredMalformedToolCall__"

// Fallback name for a recovered call whose original name was lost (e.g. streamed
// truncation before the name completed, or a nameless provider quirk). The tool
// never runs — the guard rejects it by the args marker, not the name — but the
// call is still serialized into the NEXT request's history, and OpenAI-compatible
// APIs reject `function.name: ""` (the converter passes the name through
// verbatim). A valid placeholder keeps that request from 400ing, which is the
// whole point of this module. Matches OpenAI's function-name charset.
const RECOVERED_MALFORMED_TOOL_NAME = "malformed_tool_call"

function recoveredToolName(name: unknown): string {
  return isNonEmptyString(name) ? name : RECOVERED_MALFORMED_TOOL_NAME
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** The args we place on a promoted malformed tool_call: the marker + diagnosis
 * (+ bounded snippet of the original broken text). The guard intercepts before
 * the tool runs, so these never reach the tool. */
function recoveredMalformedArgs(diagnosis: MalformedDiagnosis): Record<string, unknown> {
  return {
    [RECOVERED_MALFORMED_MARKER]: {
      cause: diagnosis.cause,
      detail: diagnosis.detail,
      snippet: diagnosis.snippet
    }
  }
}

/** If this tool call is one we promoted from malformed args (identified by the
 * marker in its own args — survives checkpoint/resume and is per-call, so no
 * shared-state races), return a paired error ToolMessage targeted to the detected
 * cause, carrying the raw parser complaint and a bounded excerpt of the original
 * broken args (the raw copy is stripped from the transcript, so this excerpt is
 * what lets the model FIX its text rather than regenerate blind). The tool never
 * runs with the unparseable args. Otherwise null. Exported for testing. */
export function rejectRecoveredMalformedToolCall(
  toolCall: { id?: unknown; name?: unknown; args?: unknown } | undefined
): ToolMessage | null {
  const id = toolCall?.id
  if (!isNonEmptyString(id)) return null
  const args = toolCall?.args
  const marker = isPlainRecord(args) ? args[RECOVERED_MALFORMED_MARKER] : undefined
  if (!isPlainRecord(marker)) return null
  const cause: MalformedCause = marker.cause === "truncated" ? "truncated" : "format"
  const detail = typeof marker.detail === "string" ? marker.detail : ""
  const snippet = typeof marker.snippet === "string" ? marker.snippet : ""
  const parts = [cause === "truncated" ? MALFORMED_TRUNCATED_MESSAGE : MALFORMED_SYNTAX_MESSAGE]
  if (detail) parts.push(`(The JSON parser reported: ${detail})`)
  if (snippet) parts.push(`Your original (broken) arguments, for reference:\n${snippet}`)
  return new ToolMessage({
    content: parts.join("\n\n"),
    tool_call_id: id,
    ...(isNonEmptyString(toolCall?.name) ? { name: toolCall.name } : {}),
    status: "error"
  })
}

function contentPartHasText(part: unknown): boolean {
  if (typeof part === "string") return part.trim().length > 0
  if (part && typeof part === "object" && "text" in part) {
    return isNonEmptyString((part as { text?: unknown }).text)
  }
  return false
}

function hasVisibleContent(message: BaseMessage): boolean {
  const content = message.content as unknown
  if (typeof content === "string") return content.trim().length > 0
  if (!Array.isArray(content)) return false
  return content.some(contentPartHasText)
}

function rawAdditionalKwargsToolCalls(message: AIMessage): unknown[] {
  const raw = message.additional_kwargs?.tool_calls
  return Array.isArray(raw) ? raw : []
}

/** Shallow, prototype-preserving clone with the unpaired raw tool-call artifact
 * removed. Preserving the prototype keeps `AIMessage.isInstance` true so the
 * OpenAI converter still treats it as an assistant message; we only ever hand
 * this clone to the request payload, never persist it. */
function cloneWithoutRawToolCalls(message: AIMessage): AIMessage {
  const clone = Object.assign(Object.create(Object.getPrototypeOf(message)), message) as AIMessage
  const nextKwargs = { ...(message.additional_kwargs ?? {}) }
  delete (nextKwargs as { tool_calls?: unknown }).tool_calls
  clone.additional_kwargs = nextKwargs
  clone.invalid_tool_calls = []
  clearToolCallChunks(clone)
  return clone
}

function toolCallHasRecoveryMarker(call: unknown): boolean {
  return (
    isPlainRecord(call) &&
    isPlainRecord(call.args) &&
    RECOVERED_MALFORMED_MARKER in (call.args as Record<string, unknown>)
  )
}

/** If any normalized tool_call on this message carries our recovery marker, return
 * a clone whose marker args are blanked to `{}` — otherwise the SAME message. The
 * marker is an internal sentinel the guard already consumed on the turn it was
 * created; by the time it re-appears in a request it is paired with its error
 * ToolMessage (which carries the real cause/detail/snippet). We blank it so the
 * MODEL never sees the `__cmbRecoveredMalformedToolCall__` blob in its own history
 * (which could nudge a weaker model's schema inference). The on-disk checkpoint
 * keeps the marker (the guard/restart-recovery reads state, not this request
 * clone). */
function redactRecoveryMarkersForRequest(message: AIMessage): AIMessage {
  const calls = message.tool_calls
  if (!Array.isArray(calls) || !calls.some(toolCallHasRecoveryMarker)) return message
  const clone = Object.assign(Object.create(Object.getPrototypeOf(message)), message) as AIMessage
  clone.tool_calls = calls.map((call) =>
    toolCallHasRecoveryMarker(call) ? { ...call, args: {} } : call
  )
  return clone
}

const LARGE_FILE_TOOL_ARGUMENT_BYTES = 32 * 1024
const LARGE_FILE_TOOL_ARGUMENT_PREVIEW_LENGTH = 160
const LARGE_FILE_TOOL_NAMES = new Set(["write_file", "edit_file"])

function fileToolPath(args: Record<string, unknown>): string | undefined {
  for (const key of ["file_path", "filePath", "path"]) {
    if (typeof args[key] === "string") return args[key] as string
  }
  return undefined
}

function largeArgumentPlaceholder(
  toolName: string,
  field: string,
  value: string,
  filePath: string | undefined
): string {
  const length = Buffer.byteLength(value, "utf8")
  const sha256 = createHash("sha256").update(value).digest("hex")
  const previewLength = Math.floor(LARGE_FILE_TOOL_ARGUMENT_PREVIEW_LENGTH / 2)
  const preview =
    value.length > LARGE_FILE_TOOL_ARGUMENT_PREVIEW_LENGTH
      ? `${value.slice(0, previewLength)}...${value.slice(-previewLength)}`
      : value
  const path = filePath ? `; file_path=${filePath}` : ""
  return `[large ${toolName}.${field} omitted after successful execution${path}; bytes=${length}; sha256=${sha256}; preview=${JSON.stringify(preview)}]`
}

function toolMessageIsError(message: ToolMessage): boolean {
  const record = message as ToolMessage & { is_error?: unknown }
  return (
    message.status === "error" ||
    record.is_error === true ||
    message.additional_kwargs?.is_error === true
  )
}

function fileToolMessageIsSuccessful(message: ToolMessage, toolName: string): boolean {
  if (toolMessageIsError(message) || typeof message.content !== "string") return false
  const content = message.content.trim()

  // deepagents returns backend errors as plain strings. ToolNode then assigns
  // status="success", so only its explicit success receipts prove mutation.
  if (toolName === "write_file") return /^Successfully wrote to '.+'$/s.test(content)
  if (toolName === "edit_file") {
    return /^Successfully replaced \d+ occurrence\(s\) in '.+'$/s.test(content)
  }
  return false
}

function successfulToolCallIdsAfter(
  messages: BaseMessage[],
  assistantIndex: number,
  calls: ToolCall[]
): Set<string> {
  const ids = new Set<string>()
  const fileToolNamesById = new Map<string, string>()
  for (const call of calls) {
    if (isNonEmptyString(call.id) && LARGE_FILE_TOOL_NAMES.has(call.name)) {
      fileToolNamesById.set(call.id, call.name)
    }
  }

  for (let index = assistantIndex + 1; index < messages.length; index++) {
    const message = messages[index]
    if (!ToolMessage.isInstance(message)) break
    const toolName = fileToolNamesById.get(message.tool_call_id)
    if (toolName && fileToolMessageIsSuccessful(message, toolName)) {
      ids.add(message.tool_call_id)
    }
  }
  return ids
}

/**
 * Clone only completed large file-edit arguments needed to keep future model
 * requests small. The persisted transcript retains the exact original values.
 */
function elideLargeFileToolArgsForRequest(
  message: AIMessage,
  successfulToolCallIds: Set<string>
): AIMessage {
  const calls = message.tool_calls
  if (!Array.isArray(calls) || calls.length === 0) return message

  let changed = false
  const nextCalls = calls.map((call) => {
    if (
      !isNonEmptyString(call.id) ||
      !successfulToolCallIds.has(call.id) ||
      !LARGE_FILE_TOOL_NAMES.has(call.name) ||
      !isPlainRecord(call.args)
    ) {
      return call
    }

    const args = call.args as Record<string, unknown>
    const fields =
      call.name === "write_file"
        ? ["content"]
        : ["old_string", "new_string", "oldString", "newString"]
    const filePath = fileToolPath(args)
    let nextArgs: Record<string, unknown> | null = null

    for (const field of fields) {
      const value = args[field]
      if (
        typeof value !== "string" ||
        Buffer.byteLength(value, "utf8") <= LARGE_FILE_TOOL_ARGUMENT_BYTES
      ) {
        continue
      }
      nextArgs ??= { ...args }
      nextArgs[field] = largeArgumentPlaceholder(call.name, field, value, filePath)
    }

    if (!nextArgs) return call
    changed = true
    return { ...call, args: nextArgs }
  })

  if (!changed) return message
  const clone = Object.assign(Object.create(Object.getPrototypeOf(message)), message) as AIMessage
  clone.tool_calls = nextCalls
  return clone
}

/** Accumulated RAW streamed args per tool_call id, read from the aggregated
 * message's `tool_call_chunks` (each surviving entry holds the full concatenated
 * args string; concat again by id to be safe, mirroring collapseToolCallChunks'
 * grouping). Entries without an id never reach normalized `tool_calls` (the
 * collapse routes them to `invalid_tool_calls`), so id-keyed is sufficient. */
function rawStreamedArgsById(message: AIMessage): Map<string, string> {
  const chunks = (message as WithToolCallChunks).tool_call_chunks
  const map = new Map<string, string>()
  if (!Array.isArray(chunks)) return map
  for (const chunk of chunks) {
    if (!isPlainRecord(chunk)) continue
    const id = chunk.id
    if (!isNonEmptyString(id)) continue
    const args = typeof chunk.args === "string" ? chunk.args : ""
    map.set(id, (map.get(id) ?? "") + args)
  }
  return map
}

/**
 * OUTPUT repair, two phases. Mutates in place — the message is the live instance
 * the framework will append to state, so mutating preserves serialization
 * fidelity. Returns true when it changed anything.
 *
 * Phase A — strict-authority audit of STREAMED calls. LangChain's
 * `collapseToolCallChunks` parses the accumulated args with `parsePartialJson`
 * (LENIENT), so truncated args are silently "salvaged" into normalized
 * `tool_calls` — `{"script":` becomes `args: {}` and a mid-string cutoff becomes
 * a half value — with `invalid_tool_calls` EMPTY. The tool would then really run
 * with wrong args (`workflow` loops on "one of `script`… required"; `write_file`
 * would silently write half a file). Claude Code's final authority is a STRICT
 * parse of the accumulated raw string (`normalizeContentFromAPI` →
 * `safeParseJSON` → `{}` → validation error), so we mirror that: re-check each
 * normalized call's RAW `tool_call_chunks` args with strict `JSON.parse`, and on
 * failure replace the salvaged args with the recovery marker so the guard
 * rejects it. An empty raw string is left alone (a no-arg call streams as "" —
 * CC also treats that as `{}` silently).
 *
 * Phase B — promote strict-parse failures. Calls whose args already failed the
 * strict parse (non-streaming path, or streamed without an id) sit in
 * `invalid_tool_calls`; promote each into a normalized, marker-carrying
 * `tool_call` so the transcript stays paired and the guard rejects it.
 */
export function recoverEmittedMalformedToolCalls(message: AIMessage): boolean {
  let changed = false

  // ── Phase A: audit lenient-salvaged streamed calls against their raw args ──
  const rawArgsById = rawStreamedArgsById(message)
  const current = Array.isArray(message.tool_calls) ? message.tool_calls : []
  if (rawArgsById.size > 0 && current.length > 0) {
    let audited = false
    const next = current.map((call) => {
      const id = call?.id
      if (!isNonEmptyString(id)) return call
      const raw = rawArgsById.get(id)
      if (raw === undefined || raw.trim() === "") return call
      if (isPlainRecord(call.args) && RECOVERED_MALFORMED_MARKER in call.args) return call
      try {
        JSON.parse(raw)
        return call
      } catch {
        audited = true
        return {
          ...call,
          name: recoveredToolName(call.name),
          args: recoveredMalformedArgs(diagnoseMalformedArgs(raw))
        }
      }
    })
    if (audited) {
      message.tool_calls = next
      changed = true
    }
  }

  // ── Phase B: promote invalid_tool_calls into marker-carrying tool_calls ──
  const invalid = Array.isArray(message.invalid_tool_calls) ? message.invalid_tool_calls : []
  if (invalid.length > 0) {
    const existing = Array.isArray(message.tool_calls) ? message.tool_calls : []
    const seenIds = new Set(existing.map((call) => call?.id).filter(isNonEmptyString))
    const recovered: ToolCall[] = []

    for (const bad of invalid) {
      const id = isNonEmptyString(bad?.id) ? bad.id : `malformed_${randomUUID()}`
      if (seenIds.has(id)) continue
      seenIds.add(id)
      // Embed the diagnosis in the promoted call's OWN args (not shared process
      // state): the wrapToolCall guard reads it back to reject the call before
      // the tool runs — surviving checkpoint/resume and safe under id reuse.
      recovered.push({
        name: recoveredToolName(bad?.name),
        args: recoveredMalformedArgs(diagnoseMalformedArgs(bad?.args)),
        id,
        type: "tool_call"
      })
    }

    // Clear the malformed bucket either way so the raw copy can't re-serialize
    // and 400 later (even when everything was a duplicate id — nothing usable).
    message.invalid_tool_calls = []
    clearToolCallChunks(message)
    if (recovered.length > 0) {
      message.tool_calls = [...existing, ...recovered]
      changed = true
    }
  }

  if (changed) {
    // Clear the chunks so a checkpoint reload can't re-collapse them LENIENTLY
    // over our marker (the AIMessageChunk constructor rebuilds tool_calls from
    // tool_call_chunks whenever they are non-empty), and drop the raw provider
    // copy so the OpenAI converter uses our normalized, about-to-be-paired
    // tool_calls rather than the malformed raw arguments.
    clearToolCallChunks(message)
    if (message.additional_kwargs && "tool_calls" in message.additional_kwargs) {
      message.additional_kwargs = { ...message.additional_kwargs }
      delete (message.additional_kwargs as { tool_calls?: unknown }).tool_calls
    }
  }
  return changed
}

/**
 * INPUT sanitize. Return a request-message list in which no assistant turn
 * carries a raw tool call the API would 400 on. `tool_calls` is LangChain's
 * canonical parsed representation; `additional_kwargs.tool_calls` is only the
 * provider-wire copy. We ALWAYS strip that raw artifact when present, including
 * mixed turns that have valid normalized calls plus one malformed raw call. Two
 * reasons this must be unconditional:
 *   - normalized parity repair builds its keep-set from NORMALIZED tool_calls
 *     only, so it would orphan-drop any ToolMessage paired to a raw call and
 *     leave the raw call dangling → 400. Passing a "paired" raw turn through is
 *     therefore never safe.
 *   - a pairing check keyed on a global set of ToolMessage ids is unsound anyway:
 *     ids can repeat across turns/gateways, so an old same-id ToolMessage would
 *     make a later raw call look falsely paired.
 * After we strip, the request-level parity repair below removes any now-orphaned
 * ToolMessage and closes normalized dangling calls at API-round boundaries.
 * DeepAgents' patchToolCalls remains an additional downstream safeguard. Returns
 * the original array (same reference) when unchanged.
 *
 * We ALSO blank the `__cmbRecoveredMalformedToolCall__` marker and elide completed
 * large write/edit arguments before they reach the model. Both are request-only:
 * the history/checkpoint message remains unchanged.
 */
export function sanitizeModelRequestMessages(messages: BaseMessage[]): BaseMessage[] {
  let changed = false
  const out: BaseMessage[] = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (!AIMessage.isInstance(message)) {
      out.push(message)
      continue
    }
    // Blank internal markers and large completed file arguments from model history.
    const deMarked = redactRecoveryMarkersForRequest(message)
    const sanitized = elideLargeFileToolArgsForRequest(
      deMarked,
      successfulToolCallIdsAfter(messages, index, deMarked.tool_calls ?? [])
    )
    if (sanitized !== message) changed = true
    const normalized = Array.isArray(sanitized.tool_calls) ? sanitized.tool_calls : []
    const rawToolCalls = rawAdditionalKwargsToolCalls(sanitized)
    if (rawToolCalls.length === 0) {
      out.push(sanitized)
      continue
    }

    changed = true
    const cleaned = cloneWithoutRawToolCalls(sanitized)
    // Keep the assistant's visible text (e.g. its <think> block); drop a turn
    // that was nothing but the broken tool call — Claude Code's
    // filterUnresolvedToolUses parity.
    if (normalized.length > 0 || hasVisibleContent(cleaned)) out.push(cleaned)
  }

  return changed ? out : messages
}

/**
 * Repair normalized tool-call parity at API-round boundaries for an outgoing
 * model request. DeepAgents' upstream helper searches globally by tool-call id,
 * but OpenAI-compatible providers can reuse ids such as `call_0` in later
 * rounds. A later result must therefore never satisfy an earlier interrupted
 * call. This is request-only: checkpoint and archive history remain lossless.
 */
export function repairModelRequestToolCallParity(messages: BaseMessage[]): BaseMessage[] {
  let changed = false
  const repaired: BaseMessage[] = []

  let pendingCalls: Array<{ id: string; name: string }> = []
  let completedCallIds = new Set<string>()

  const closePendingRound = (): void => {
    for (const toolCall of pendingCalls) {
      if (completedCallIds.has(toolCall.id)) continue
      changed = true
      repaired.push(
        new ToolMessage({
          content: `Tool call ${toolCall.name} with id ${toolCall.id} was cancelled - another message came in before it could be completed.`,
          name: toolCall.name,
          tool_call_id: toolCall.id
        })
      )
    }
    pendingCalls = []
    completedCallIds = new Set<string>()
  }

  for (const message of messages) {
    if (ToolMessage.isInstance(message)) {
      const belongsToPendingRound = pendingCalls.some(
        (toolCall) => toolCall.id === message.tool_call_id
      )
      if (!belongsToPendingRound || completedCallIds.has(message.tool_call_id)) {
        changed = true
        continue
      }

      repaired.push(message)
      completedCallIds.add(message.tool_call_id)
      continue
    }

    closePendingRound()
    repaired.push(message)

    if (!AIMessage.isInstance(message)) continue
    pendingCalls = (message.tool_calls ?? []).flatMap((toolCall) =>
      toolCall.id ? [{ id: toolCall.id, name: toolCall.name }] : []
    )
  }

  closePendingRound()
  return changed ? repaired : messages
}

/**
 * GUARD half (wrapToolCall only). MUST be registered FIRST in the middleware
 * array — i.e. OUTERMOST in the wrapToolCall chain — so a recovered malformed
 * call is rejected before ANY tool lifecycle runs: no PreToolUse hook can block
 * or rewrite it (a hook block would REPLACE our diagnosis with "blocked by
 * hook" — a misleading message, the exact failure mode this module exists to
 * kill), no failure-fuse counting, no task-mmd recording, no concurrency queue
 * slot — for a tool that never runs. This matches Claude Code, which validates
 * input BEFORE permissions/hooks (toolExecution.ts) and returns the
 * InputValidationError result immediately.
 *
 * The rejection must RETURN a ToolMessage, not throw — the middleware composer
 * wraps any throw in a MiddlewareError that toolErrorMiddleware treats as
 * non-recoverable and rethrows.
 */
export function createMalformedToolCallGuardMiddleware(): ReturnType<typeof createMiddleware> {
  return createMiddleware({
    name: "malformedToolCallGuard",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapToolCall: (request: any, handler: any) => {
      const rejection = rejectRecoveredMalformedToolCall(request?.toolCall)
      return rejection ?? handler(request)
    }
  })
}

/**
 * RECOVERY half (wrapModelCall only): input sanitize, round-local normalized
 * parity repair, and output promotion. DeepAgents' downstream patchToolCalls
 * remains a final safeguard. Kept late (inner) so the repair sees the final
 * request message list (after summarization etc.) right before it is sent.
 */
export function createMalformedToolCallRecoveryMiddleware(): ReturnType<typeof createMiddleware> {
  return createMiddleware({
    name: "malformedToolCallRecovery",
    wrapModelCall: async (request, handler) => {
      const sanitized = sanitizeModelRequestMessages(request.messages)
      const repaired = repairModelRequestToolCallParity(sanitized)
      const response = await handler(
        repaired === request.messages ? request : { ...request, messages: repaired }
      )
      if (AIMessage.isInstance(response)) {
        recoverEmittedMalformedToolCalls(response)
      }
      return response
    }
  })
}
