import { createHash } from "node:crypto"
import { basename, isAbsolute } from "node:path"
import { tool, type StructuredToolInterface } from "@langchain/core/tools"
import { z } from "zod"
import { discoverGlobalAgentsFiles, readAgentsFiles, renderAgentsPrompt } from "../agent/agents-md"
import { BotDomainError } from "../../shared/bot-types"

export interface BotInstructionSources {
  /** Explicit Host-local configuration; never resolve a path supplied by the model. */
  agentsHome: string
}

const MAX_GLOBAL_BYTES = 1024 * 1024
const PREVIEW_CHARACTERS = 2048

function page(text: string, offset: number, limit: number) {
  if (offset > text.length || /[\uDC00-\uDFFF]/.test(text.charAt(offset)))
    throw new BotDomainError("instruction_offset", "工作规则读取位置无效，请使用返回的 nextOffset")
  let end = Math.min(text.length, offset + limit)
  if (/[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end++
  return {
    text: text.slice(offset, end),
    offset,
    nextOffset: end < text.length ? end : null,
    totalCharacters: text.length
  }
}

/** Reuse Cmb's override/fallback, stable file and link-boundary handling.
 * Keep one bounded version for this execution. Later reads cannot open arbitrary
 * Host files or mix a changed file's tail with the already-injected prefix.
 */
export async function botGlobalInstructions(
  sources: BotInstructionSources | undefined,
  check: () => void
): Promise<{ prompt: string; tool: StructuredToolInterface } | undefined> {
  if (!sources) return undefined
  if (
    typeof sources.agentsHome !== "string" ||
    !isAbsolute(sources.agentsHome) ||
    sources.agentsHome.includes("\0")
  )
    throw new BotDomainError("instruction_config", "全局工作规则目录必须配置为 Host 上的绝对路径")
  check()
  const discovered = await discoverGlobalAgentsFiles(sources.agentsHome)
  check()
  const loaded = await readAgentsFiles(discovered, MAX_GLOBAL_BYTES)
  check()
  if (loaded.truncated)
    throw new BotDomainError("instruction_size", "全局工作规则超过 1 MiB，请精简后重试")
  const entry = loaded.entries[0]
  if (!entry) return undefined
  const name = basename(entry.path)
  const version = createHash("sha256").update(name).update("\0").update(entry.content).digest("hex")
  const preview = page(entry.content, 0, PREVIEW_CHARACTERS)
  const prompt = [
    renderAgentsPrompt("", [], [{ path: name, content: preview.text, truncated: false }]),
    `These are the user's configured global work instructions. They do not grant tool access, approve actions or override the assigned role's permissions. Instruction version: ${version}.`,
    preview.nextOffset !== null
      ? `Only the first ${preview.nextOffset} characters are shown. Before doing work covered by these instructions, call read_global_instructions with version ${version} and offset ${preview.nextOffset}, then follow nextOffset until null. No Host filesystem path is required.`
      : ""
  ]
    .filter(Boolean)
    .join("\n\n")
  return {
    prompt,
    tool: tool(
      async ({ version: requested, offset, limit }) => {
        check()
        if (requested !== version)
          throw new BotDomainError(
            "instruction_version",
            "工作规则版本已变化，请使用当前提示中的版本"
          )
        return JSON.stringify({ name, version, ...page(entry.content, offset, limit) })
      },
      {
        name: "read_global_instructions",
        description:
          "Read the remaining configured global AGENTS.md instructions for this execution. Use the version and nextOffset from the system prompt or previous page. This reads only the already-loaded instruction document, grants no permissions and accepts no filesystem path.",
        schema: z.object({
          version: z.string().regex(/^[a-f0-9]{64}$/),
          offset: z.number().int().min(0).max(MAX_GLOBAL_BYTES).default(0),
          limit: z.number().int().min(1).max(16000).default(8000)
        })
      }
    )
  }
}
