import type { McpInvocationResult } from "./capability-types"

export interface McpCallResultValue {
  ok: boolean
  data?: unknown
  error?: string
}

type McpTextContent = { type: "text"; text?: string }
type McpImageContent = { type: "image"; data?: string; mimeType?: string }
type McpAudioContent = { type: "audio"; data?: string; mimeType?: string }
type McpResourceContent = {
  type: "resource"
  blob?: string
  text?: string
  mimeType?: string
  uri?: string
}
type McpResourceLinkContent = {
  type: "resource_link"
  uri?: string
  name?: string
  mimeType?: string
}

function stringifyUnknown(value: unknown, seen = new WeakSet<object>()): string {
  if (value === undefined) return "undefined"
  try {
    return JSON.stringify(
      value,
      (_key, nested) => {
        if (typeof nested === "object" && nested !== null) {
          if (seen.has(nested)) return "[Circular]"
          seen.add(nested)
        }
        if (nested instanceof Error) {
          return {
            name: nested.name,
            message: nested.message,
            stack: nested.stack
          }
        }
        return nested
      },
      2
    )
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function toStandardContentBlock(content: unknown): unknown | null {
  if (!content || typeof content !== "object") return null

  const typed = content as Record<string, unknown>
  switch (typed.type) {
    case "text": {
      const block = typed as McpTextContent
      return block.text ? { type: "text", text: block.text } : null
    }
    case "image": {
      const block = typed as McpImageContent
      if (!block.data) return null
      return {
        type: "image",
        source_type: "base64",
        data: block.data,
        ...(block.mimeType ? { mime_type: block.mimeType } : {})
      }
    }
    case "audio": {
      const block = typed as McpAudioContent
      if (!block.data) return null
      return {
        type: "audio",
        source_type: "base64",
        data: block.data,
        ...(block.mimeType ? { mime_type: block.mimeType } : {})
      }
    }
    case "resource": {
      const block = typed as McpResourceContent
      if (block.blob) {
        return {
          type: "file",
          source_type: "base64",
          data: block.blob,
          ...(block.mimeType ? { mime_type: block.mimeType } : {}),
          ...(block.uri ? { metadata: { uri: block.uri } } : {})
        }
      }
      if (block.text) {
        return {
          type: "file",
          source_type: "text",
          text: block.text,
          ...(block.mimeType ? { mime_type: block.mimeType } : {}),
          ...(block.uri ? { metadata: { uri: block.uri } } : {})
        }
      }
      return null
    }
    case "resource_link": {
      const block = typed as McpResourceLinkContent
      if (!block.uri) return null
      return {
        type: "file",
        source_type: "url",
        url: block.uri,
        ...(block.mimeType ? { mime_type: block.mimeType } : {}),
        ...(block.name ? { metadata: { name: block.name } } : {})
      }
    }
    default:
      return null
  }
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  return content
    .map((item) => {
      if (!item || typeof item !== "object") return ""
      const block = item as Record<string, unknown>
      return block.type === "text" && typeof block.text === "string" ? block.text : ""
    })
    .filter(Boolean)
    .join("\n")
}

function extractContentBlocks(raw: unknown): unknown[] | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const maybeContent = (raw as { content?: unknown }).content
  if (!Array.isArray(maybeContent)) return undefined

  const blocks = maybeContent
    .map((item) => toStandardContentBlock(item))
    .filter((item): item is unknown => item != null)

  return blocks.length > 0 ? blocks : undefined
}

function tryParseJsonText(text: string): unknown | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return undefined

  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

export function normalizeMcpInvocationResult(
  capabilityId: string,
  raw: unknown
): McpInvocationResult {
  if (Array.isArray(raw) && raw.length === 2) {
    const [content] = raw
    return {
      capabilityId,
      raw,
      text: typeof content === "string" ? content : stringifyUnknown(content),
      contentBlocks: Array.isArray(content) ? content : undefined,
      isError: false
    }
  }

  const envelope = raw as {
    content?: unknown
    structuredContent?: unknown
    isError?: boolean
  }

  return {
    capabilityId,
    raw,
    text: extractText(envelope?.content),
    structuredContent: envelope?.structuredContent,
    contentBlocks: extractContentBlocks(raw),
    isError: envelope?.isError === true
  }
}

export function safeJsonStringify(value: unknown): string {
  return stringifyUnknown(value)
}

export function stringifyCodeExecOutput(value: unknown): string {
  if (typeof value === "string") return value
  return stringifyUnknown(value)
}

export function getMcpErrorMessage(result: McpInvocationResult): string {
  return result.text || stringifyUnknown(result.raw)
}

export function getUsefulMcpResultData(result: McpInvocationResult): unknown {
  if (result.structuredContent !== undefined) {
    return result.structuredContent
  }

  const parsedJson = tryParseJsonText(result.text)
  if (parsedJson !== undefined) {
    return parsedJson
  }

  if (result.text) {
    return result.text
  }

  if (result.contentBlocks && result.contentBlocks.length > 0) {
    return result.contentBlocks
  }

  return result.raw
}

export function toEagerToolResponse(result: McpInvocationResult): [string | unknown[], unknown[]] {
  if (result.isError) {
    const message = result.text || stringifyUnknown(result.raw)
    return [`MCP tool error: ${message}`, []]
  }

  if (result.contentBlocks && result.contentBlocks.length > 0) {
    const onlyTextBlocks = result.contentBlocks.every((block) => {
      return Boolean(
        block &&
        typeof block === "object" &&
        (block as Record<string, unknown>).type === "text" &&
        typeof (block as Record<string, unknown>).text === "string"
      )
    })

    if (onlyTextBlocks) {
      const text = result.contentBlocks
        .map((block) => String((block as Record<string, unknown>).text))
        .join("\n")
      return [text, []]
    }

    return [result.contentBlocks, []]
  }

  if (result.text) {
    return [result.text, []]
  }

  if (result.structuredContent !== undefined) {
    return [stringifyUnknown(result.structuredContent), []]
  }

  return [stringifyUnknown(result.raw), []]
}

export function toCallResult(result: McpInvocationResult): McpCallResultValue {
  if (result.isError) {
    return {
      ok: false,
      error: getMcpErrorMessage(result)
    }
  }

  return {
    ok: true,
    data: getUsefulMcpResultData(result)
  }
}
