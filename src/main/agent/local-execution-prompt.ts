import type { SystemMessage } from "@langchain/core/messages"
import type { createFilesystemMiddleware } from "deepagents"
import type { getWindowsSandboxMode } from "../storage"

type WindowsSandboxMode = ReturnType<typeof getWindowsSandboxMode>
type FilesystemMiddleware = ReturnType<typeof createFilesystemMiddleware>

// deepagents appends this independently of its custom filesystem system prompt.
// Keep the exact upstream text so unrelated instructions are never rewritten.
const UPSTREAM_EXECUTION_PROMPT = `## Execute Tool \`execute\`

You have access to an \`execute\` tool for running shell commands in a sandboxed environment.
Use this tool to run commands, scripts, tests, builds, and other shell operations.

- execute: run a shell command in the sandbox (returns output and exit code)`

function executionEnvironment(mode: WindowsSandboxMode): string {
  const effectiveMode = process.platform === "win32" ? mode : "none"
  if (effectiveMode === "none") {
    return "Commands run directly on the local machine. OS sandboxing is disabled."
  }
  return (
    `Commands run on the local machine with Windows sandbox mode \`${effectiveMode}\`. ` +
    "The configured sandbox permissions apply to shell commands."
  )
}

function replaceAppendedExecutionPrompt(
  message: SystemMessage,
  originalMessage: SystemMessage,
  replacement: string
): SystemMessage {
  const content = message.content
  const originalContent = originalMessage.content
  let updatedContent: SystemMessage["content"]
  if (typeof content === "string") {
    if (
      typeof originalContent !== "string" ||
      !content.startsWith(originalContent) ||
      content.length - originalContent.length < UPSTREAM_EXECUTION_PROMPT.length ||
      !content.endsWith(UPSTREAM_EXECUTION_PROMPT)
    ) {
      return message
    }
    updatedContent = content.slice(0, -UPSTREAM_EXECUTION_PROMPT.length) + replacement
  } else {
    // SystemMessage.concat appends a text block (or a file/source_type=text
    // block for data content). Only inspect that new last block, never earlier
    // user text, images or provider-specific content blocks.
    if (!Array.isArray(originalContent) || content.length <= originalContent.length) {
      return message
    }
    const lastBlock = content.at(-1)
    if (
      !lastBlock ||
      typeof lastBlock.text !== "string" ||
      !lastBlock.text.endsWith(UPSTREAM_EXECUTION_PROMPT)
    ) {
      return message
    }
    updatedContent = [
      ...content.slice(0, -1),
      {
        ...lastBlock,
        text: lastBlock.text.slice(0, -UPSTREAM_EXECUTION_PROMPT.length) + replacement
      }
    ]
  }

  // Preserve the message prototype, metadata, and serialization mirror without
  // mutating the input message used by another model call or middleware.
  const clone = Object.assign(
    Object.create(Object.getPrototypeOf(message)),
    message
  ) as SystemMessage
  clone.content = updatedContent
  clone.lc_kwargs = { ...clone.lc_kwargs, content: updatedContent }
  return clone
}

/** Correct the upstream generic sandbox docs for a known LocalSandbox backend. */
export function patchLocalExecutionPrompt(
  middleware: FilesystemMiddleware,
  mode: WindowsSandboxMode
): void {
  const environment = executionEnvironment(mode)
  const fileAccess =
    "The shell uses the same local filesystem paths as the file tools and starts in the agent's " +
    "workspace directory unless cwd is provided."
  const executeTool = middleware.tools?.find((tool) => tool.name === "execute")
  if (executeTool) {
    executeTool.description = `Execute a shell command on the local machine.

${environment}
${fileAccess}
Use absolute paths, quote paths containing spaces, and follow the configured shell syntax.
Use file tools to check a script path when needed; report access failures from actual tool results.
Returns combined stdout/stderr and the exit code; large output may be truncated.`
  }

  const originalWrapModelCall = middleware.wrapModelCall
  if (!originalWrapModelCall) return
  const executionPrompt = `## Execute Tool \`execute\`

${environment}
${fileAccess}
Use execute to run commands, scripts, tests, builds, and other shell operations.
Check file availability with the file tools or execute instead of assuming a separate filesystem.

- execute: run a shell command (returns output and exit code)`
  middleware.wrapModelCall = (request, handler) =>
    originalWrapModelCall(request, (nextRequest) => {
      if (
        !nextRequest.systemMessage ||
        !nextRequest.tools.some((tool) => tool.name === "execute")
      ) {
        return handler(nextRequest)
      }
      return handler({
        ...nextRequest,
        systemMessage: replaceAppendedExecutionPrompt(
          nextRequest.systemMessage,
          request.systemMessage,
          executionPrompt
        )
      })
    })
}
