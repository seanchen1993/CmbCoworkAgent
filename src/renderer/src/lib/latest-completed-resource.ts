import { getFileType } from "./file-types"

export interface ResourceToolCall {
  id?: string
  name: string
  args?: Record<string, unknown>
}

export interface ResourceMessage {
  id?: string
  role?: string
  type?: string
  tool_call_id?: string
  tool_calls?: ResourceToolCall[]
}

export interface PreviewEvent {
  path: string
  key: string
  codeDiff?: {
    oldValue: string
    newValue: string
  }
}

export interface CompletedResourceProjection {
  latestResourceEvent: (PreviewEvent & { source: "persisted" | "streaming" }) | null
  latestCompletedLlmBatch: { batchKey: string; files: string[] } | null
}

const RESOURCE_PREVIEW_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "pdf",
  "doc",
  "docx",
  "md",
  "markdown",
  "mdx",
  "html",
  "htm"
])

export function getPathExtension(filePath: string): string {
  const fileName = filePath.split(/[\\/]/).pop() || filePath
  const ext = fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase() : ""
  return ext || ""
}

function getToolCallFilePath(toolCall: ResourceToolCall): string | null {
  if (toolCall.name !== "write_file" && toolCall.name !== "edit_file") return null
  const raw = toolCall.args?.path ?? toolCall.args?.file_path
  if (typeof raw !== "string" || !raw.trim()) return null
  return raw
}

function buildPreviewEvent(
  toolCall: ResourceToolCall,
  messageId: string,
  toolIndex: number
): PreviewEvent | null {
  const filePath = getToolCallFilePath(toolCall)
  if (!filePath) return null

  const ext = getPathExtension(filePath).toLowerCase()
  const markdownLike = ext === "md" || ext === "markdown" || ext === "mdx"
  const htmlLike = ext === "html" || ext === "htm"
  const typeInfo = getFileType(filePath.split(/[\\/]/).pop() || filePath)
  const codeLike = typeInfo.type === "code" && !markdownLike && !htmlLike
  if (!RESOURCE_PREVIEW_EXTENSIONS.has(ext) && !codeLike) return null

  const key = `${messageId}:${toolCall.id ?? `t-${toolIndex}`}:${filePath}`
  if (!codeLike) return { path: filePath, key }

  const args = toolCall.args || {}
  const oldValue = ((args.old_string ?? args.old_str) as string | undefined) || ""
  const newValue =
    ((args.new_string ?? args.new_str ?? args.content) as string | undefined) || ""
  return {
    path: filePath,
    key,
    codeDiff:
      toolCall.name === "write_file"
        ? { oldValue: "", newValue }
        : { oldValue, newValue }
  }
}

interface ResourceMessageStructure {
  id: string | undefined
  role: string | undefined
  toolCallId: string | undefined
  toolCalls: ResourceToolCall[]
}

function projectMessageStructure(message: ResourceMessage): ResourceMessageStructure {
  return {
    id: message.id,
    role: message.role ?? message.type,
    toolCallId: message.tool_call_id,
    toolCalls: (message.tool_calls ?? []).map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      args: toolCall.args
    }))
  }
}

function resourceToolCallsEqual(left: ResourceToolCall, right: ResourceToolCall): boolean {
  const leftArgs = left.args
  const rightArgs = right.args
  return (
    left.id === right.id &&
    left.name === right.name &&
    leftArgs?.path === rightArgs?.path &&
    leftArgs?.file_path === rightArgs?.file_path &&
    leftArgs?.old_string === rightArgs?.old_string &&
    leftArgs?.old_str === rightArgs?.old_str &&
    leftArgs?.new_string === rightArgs?.new_string &&
    leftArgs?.new_str === rightArgs?.new_str &&
    leftArgs?.content === rightArgs?.content
  )
}

function resourceMessageStructuresEqual(
  left: ResourceMessageStructure,
  right: ResourceMessageStructure
): boolean {
  return (
    left.id === right.id &&
    left.role === right.role &&
    left.toolCallId === right.toolCallId &&
    left.toolCalls.length === right.toolCalls.length &&
    left.toolCalls.every((toolCall, index) =>
      resourceToolCallsEqual(toolCall, right.toolCalls[index])
    )
  )
}

interface ResourceSequenceIndex {
  structures: ResourceMessageStructure[]
}

function createResourceSequenceProjector(): (
  messages: readonly ResourceMessage[]
) => ResourceSequenceIndex {
  let previousMessages: readonly ResourceMessage[] | undefined
  let sourceMessages: readonly ResourceMessage[] = []
  let index: ResourceSequenceIndex = { structures: [] }

  return (messages) => {
    if (messages === previousMessages) return index
    if (messages.length === sourceMessages.length) {
      let reusable = true
      for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
        const message = messages[messageIndex]
        if (message === sourceMessages[messageIndex]) continue
        if (
          !resourceMessageStructuresEqual(
            projectMessageStructure(message),
            index.structures[messageIndex]
          )
        ) {
          reusable = false
          break
        }
      }
      if (reusable) {
        previousMessages = messages
        sourceMessages = messages
        return index
      }
    }

    index = { structures: messages.map(projectMessageStructure) }
    previousMessages = messages
    sourceMessages = messages
    return index
  }
}

function buildCompletedResourceProjection(
  persisted: ResourceSequenceIndex,
  streaming: ResourceSequenceIndex
): CompletedResourceProjection {
  const all = [
    ...persisted.structures.map((message) => ({ source: "persisted" as const, message })),
    ...streaming.structures.map((message) => ({ source: "streaming" as const, message }))
  ]
  const completedToolCallIds = new Set<string>()
  for (const item of all) {
    if (item.message.role === "tool" && item.message.toolCallId) {
      completedToolCallIds.add(item.message.toolCallId)
    }
  }

  let latestResourceEvent: CompletedResourceProjection["latestResourceEvent"] = null
  let latestCompletedLlmBatch: CompletedResourceProjection["latestCompletedLlmBatch"] = null
  for (let messageIndex = all.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const current = all[messageIndex]
    const files = new Set<string>()
    const toolIds: string[] = []
    for (let toolIndex = current.message.toolCalls.length - 1; toolIndex >= 0; toolIndex -= 1) {
      const toolCall = current.message.toolCalls[toolIndex]
      if (!toolCall.id || !completedToolCallIds.has(toolCall.id)) continue
      const event = buildPreviewEvent(
        toolCall,
        current.message.id ?? `m-${messageIndex}`,
        toolIndex
      )
      if (!event) continue
      if (!latestResourceEvent) latestResourceEvent = { ...event, source: current.source }
      const filePath = getToolCallFilePath(toolCall)
      if (filePath) {
        files.add(filePath)
        toolIds.push(toolCall.id)
      }
    }
    if (!latestCompletedLlmBatch && files.size > 0) {
      latestCompletedLlmBatch = {
        batchKey: `${current.message.id ?? `m-${messageIndex}`}:${toolIds.sort().join(",")}`,
        files: Array.from(files)
      }
    }
    if (latestResourceEvent && latestCompletedLlmBatch) break
  }
  return { latestResourceEvent, latestCompletedLlmBatch }
}

export function createCompletedResourceProjector(): (
  persistedMessages: readonly ResourceMessage[],
  streamingMessages: readonly ResourceMessage[]
) => CompletedResourceProjection {
  const projectPersisted = createResourceSequenceProjector()
  const projectStreaming = createResourceSequenceProjector()
  let previousPersisted: ResourceSequenceIndex | undefined
  let previousStreaming: ResourceSequenceIndex | undefined
  let previousResult: CompletedResourceProjection = {
    latestResourceEvent: null,
    latestCompletedLlmBatch: null
  }

  return (persistedMessages, streamingMessages) => {
    const persisted = projectPersisted(persistedMessages)
    const streaming = projectStreaming(streamingMessages)
    if (persisted === previousPersisted && streaming === previousStreaming) return previousResult
    previousPersisted = persisted
    previousStreaming = streaming
    previousResult = buildCompletedResourceProjection(persisted, streaming)
    return previousResult
  }
}
