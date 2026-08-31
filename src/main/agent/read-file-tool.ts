import { getCurrentTaskInput } from "@langchain/langgraph"
import { tool as lcTool } from "langchain"
import { z, type ZodTypeAny } from "zod"
import { getCurrentHookAgentId, getHookAgentIdFromRequest } from "../hooks/execution-context"
import type { TraceContext } from "./trace/types"
import {
  getReadFileOutputCharLimit,
  READ_FILE_DEFAULT_LIMIT,
  READ_FILE_MAX_LIMIT,
  trimReadFileOutputLines,
  truncateReadFileOutputByChars
} from "./read-file-output"

const DEFAULT_TOOL_TOKEN_LIMIT_BEFORE_EVICT = 20_000

export type ReadableFilesystemBackend = {
  read(
    filePath: string,
    offset?: number,
    limit?: number,
    options?: {
      maxFormattedContentChars?: number
      includeLookahead?: boolean
      traceContext?: TraceContext
    }
  ): Promise<string> | string
}

export type ReadFileTraceContextResolver = (agentId: string) => TraceContext | undefined

type RuntimeTool = {
  name?: string
  description?: string
  schema?: {
    extend(shape: Record<string, ZodTypeAny>): ZodTypeAny
    shape?: Record<string, unknown>
  }
  invoke?(input: unknown, config?: unknown): unknown
}

type LangGraphToolConfig = Parameters<typeof getCurrentTaskInput>[0]

function getToolRuntimeStore(config: unknown): unknown {
  return typeof config === "object" && config !== null && "store" in config
    ? (config as { store?: unknown }).store
    : undefined
}

export function resolveReadFileTraceContext(
  config: unknown,
  resolver?: ReadFileTraceContextResolver
): TraceContext | undefined {
  if (!resolver) return undefined
  const ownerId = getHookAgentIdFromRequest(config) ?? getCurrentHookAgentId()
  return ownerId ? resolver(ownerId) : undefined
}

function createReadFileDescription(): string {
  return `Reads a file from the filesystem.

Assume this tool is able to read all files. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- By default, it reads up to ${READ_FILE_DEFAULT_LIMIT} lines starting from the beginning of the file
- Use pagination with offset and limit parameters for very large files or targeted codebase exploration
- Specify a smaller limit for quick scans, for example read_file(file_path=path, limit=200)
- Read more sections with read_file(file_path=path, offset=${READ_FILE_DEFAULT_LIMIT}, limit=${READ_FILE_DEFAULT_LIMIT})
- Results are returned using cat -n format, with line numbers starting at 1
- Lines longer than 10,000 characters will be split into multiple lines with continuation markers (e.g., 5.1, 5.2, etc.). When you specify a limit, these continuation lines count towards the limit.
- A pagination header may appear before the content and does not count towards the line limit.
- If output is truncated by size limits, the pagination header is adjusted to the last visible source line when possible.
- You have the capability to call multiple tools in a single response. It is always better to speculatively read multiple files as a batch that are potentially useful.
- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.
- You should ALWAYS make sure a file has been read before editing it.`
}

export function patchRuntimeReadFileTool(params: {
  middleware: { tools?: RuntimeTool[] }
  filesystemBackend:
    | ReadableFilesystemBackend
    | ((config: { state: unknown; store?: unknown }) => ReadableFilesystemBackend)
  toolTokenLimitBeforeEvict?: number
  resolveTraceContextForAgent?: ReadFileTraceContextResolver
}): void {
  const {
    middleware,
    filesystemBackend,
    toolTokenLimitBeforeEvict = DEFAULT_TOOL_TOKEN_LIMIT_BEFORE_EVICT,
    resolveTraceContextForAgent
  } = params
  const middlewareTools = middleware.tools
  const readFileIdx = middlewareTools?.findIndex((t) => t.name === "read_file") ?? -1
  const oldReadFileTool = readFileIdx >= 0 ? middlewareTools?.[readFileIdx] : undefined
  if (!oldReadFileTool?.schema) {
    throw new Error("[Runtime] read_file tool patch failed: tool not found or schema unavailable")
  }

  const readFileSchema = oldReadFileTool.schema.extend({
    offset: z.coerce
      .number()
      .int()
      .nonnegative()
      .optional()
      .default(0)
      .describe("Line offset to start reading from (0-indexed)"),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(READ_FILE_MAX_LIMIT)
      .optional()
      .default(READ_FILE_DEFAULT_LIMIT)
      .describe(`Maximum number of lines to read (max ${READ_FILE_MAX_LIMIT})`)
  })

  const customReadFile = lcTool(
    async (input: { file_path: string; offset?: number; limit?: number }, config?: unknown) => {
      const resolvedBackend =
        typeof filesystemBackend === "function"
          ? filesystemBackend({
              state: getCurrentTaskInput(config as LangGraphToolConfig),
              store: getToolRuntimeStore(config)
            })
          : filesystemBackend
      const { file_path, offset = 0, limit = READ_FILE_DEFAULT_LIMIT } = input
      const traceContext = resolveReadFileTraceContext(config, resolveTraceContextForAgent)
      let result = await resolvedBackend.read(file_path, offset, limit, {
        maxFormattedContentChars: getReadFileOutputCharLimit(toolTokenLimitBeforeEvict),
        includeLookahead: true,
        ...(traceContext ? { traceContext } : {})
      })
      result = trimReadFileOutputLines(result, limit)
      return truncateReadFileOutputByChars(result, file_path, toolTokenLimitBeforeEvict)
    },
    {
      name: "read_file",
      description: createReadFileDescription(),
      schema: readFileSchema
    }
  )
  middlewareTools![readFileIdx] = customReadFile as unknown as RuntimeTool
  console.log(`[Runtime] read_file tool patched: default limit=${READ_FILE_DEFAULT_LIMIT}`)
}
