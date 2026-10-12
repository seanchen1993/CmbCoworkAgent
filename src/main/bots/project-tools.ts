import { randomUUID } from "node:crypto"
import { basename } from "node:path"
import { tool, type StructuredToolInterface } from "@langchain/core/tools"
import { ToolMessage } from "@langchain/core/messages"
import { z } from "zod"
import type { BotRuntimeRequest } from "./host"
import { BotProjectFiles } from "./project-files"
import { botProjectChangeAction, commitBotProjectChange } from "./project-change"
import type { BotArtifacts } from "./artifacts"
import {
  DEFAULT_AGENTS_MAX_BYTES,
  discoverAgentsFiles,
  readAgentsFiles,
  renderAgentsPrompt
} from "../agent/agents-md"
import { BotDocumentReader } from "./document-reader"
import { botDocumentToolContent } from "./document-tool"
import { botImageRegion } from "./image-contract"
import { botPdfPage } from "./pdf-contract"
import { validateBotFileName } from "./artifact-validation"
import { BotDomainError } from "../../shared/bot-types"

/** Use Cmb's bounded, stable AGENTS loader within the Bot's authorized root.
 * A Bot configured for a subdirectory must not inherit access to its parent repo.
 */
export async function botProjectContext(
  root: string,
  deniedRoots: string[],
  maxBytes = DEFAULT_AGENTS_MAX_BYTES,
  requireComplete = false
): Promise<string> {
  const project = await BotProjectFiles.open(root, deniedRoots)
  const discovered = await discoverAgentsFiles(project.root, project.root)
  const loaded = await readAgentsFiles(project.root, discovered, maxBytes)
  if (requireComplete && loaded.truncated)
    throw new Error("项目指令超过本次读取限额，请精简 AGENTS.md 后重试；任务尚未开始")
  return renderAgentsPrompt(project.root, loaded.entries, []) ?? ""
}

export async function botProjectTools(
  request: BotRuntimeRequest,
  files: BotArtifacts,
  check: () => void,
  approve: (id: string, action: unknown, operation: () => Promise<string>) => Promise<string>,
  deniedRoots: string[],
  pinnedProject?: BotProjectFiles,
  reader = new BotDocumentReader()
): Promise<StructuredToolInterface[]> {
  if (!request.bot.workspacePath) return []
  const project =
    pinnedProject ?? (await BotProjectFiles.open(request.bot.workspacePath, deniedRoots))
  return [
    tool(
      async ({ path, offset, limit, pdf_page, image_region }, call) => {
        check()
        const file = await project.readArtifact(path)
        check()
        return botDocumentToolContent(
          reader,
          {
            name: basename(path.replaceAll("\\", "/")),
            bytes: file.bytes,
            offset,
            limit,
            pdfPage: pdf_page,
            imageRegion: image_region,
            callId: call.toolCall?.id ?? ""
          },
          request.signal,
          check
        )
      },
      {
        name: "project_view",
        description:
          "Read an authorized project document (PDF/Word/Excel/PowerPoint/text) or raster image up to 25 MiB without publishing it. Use project_read for source code and edit hashes. offset/limit paginate extracted text. For PDF scans/charts/layout set pdf_page (1-based, at most 1000) to view that page with a vision-capable model. image_region crops original image pixels or rotated PDF page pixels at 96 dpi; view metadata provides dimensions. Views are bounded to 2048 pixels/1 MiB. Paths are project-relative; links, Git internals and Host private data are excluded. This does not run scripts or change files.",
        schema: z.object({
          path: z.string().min(1).max(4096),
          offset: z.number().int().nonnegative().default(0),
          limit: z.number().int().min(1).max(32000).default(16000),
          pdf_page: botPdfPage.optional(),
          image_region: botImageRegion.optional()
        })
      }
    ),
    tool(
      async ({ path, name }, call) => {
        check()
        const id = `project-publish:${request.run.id}:${call.toolCall?.id ?? randomUUID()}`
        const previous = request.store.effectResult(request.lease, id)
        if (previous?.status === "succeeded") return previous.result ?? "文件已交付"
        if (previous) throw new Error("交付已有失败或未知记录，需人工核对")
        let filename: string
        try {
          filename = validateBotFileName(name ?? basename(path.replaceAll("\\", "/")))
        } catch (error) {
          if (
            !(error instanceof BotDomainError) ||
            !["invalid_filename", "invalid_input"].includes(error.code)
          )
            throw error
          return new ToolMessage({
            tool_call_id: call.toolCall?.id ?? "",
            status: "error",
            content: JSON.stringify({
              error: "invalid_filename",
              message:
                "交付文件名必须是单个文件名，不含目录或系统保留名称。path 保留项目相对路径；省略 name 会使用原文件的基本名称。尚未请求审批或执行交付。"
            })
          })
        }
        const prepared = await project.readArtifact(path)
        return approve(
          id,
          {
            publish: {
              path,
              name: filename,
              sha256: prepared.sha256,
              size: prepared.bytes.length,
              conversationId: request.run.conversationId
            }
          },
          async () => {
            const current = await project.readArtifact(path)
            if (current.sha256 !== prepared.sha256)
              throw new Error("审批期间文件已变化，请重新交付")
            check()
            const artifact = await files.publish(
              {
                id,
                conversationId: request.run.conversationId,
                runId: request.run.id,
                name: filename,
                mime: "application/octet-stream",
                origin: "project"
              },
              current.bytes,
              request.lease,
              undefined,
              {
                kind: "delivery",
                nonce: `file-delivery:${id}`,
                botId: request.run.botId,
                ...(request.run.threadRootId ? { threadRootId: request.run.threadRootId } : {}),
                text: `已交付：${filename}`
              }
            )
            return JSON.stringify(artifact)
          }
        )
      },
      {
        name: "project_publish",
        description:
          "Publish an existing project file (including binary PDF/Office/image output) as a downloadable immutable conversation artifact, up to 25 MiB. path is project-relative. Optional name is a single file name, never a path; omit it to preserve the source basename. Requires approval of the exact SHA-256; rejects file changes while waiting. Links, Git internal files and Bot credentials remain inaccessible. This does not upload to an external system.",
        schema: z.object({
          path: z.string().max(4096),
          name: z.string().min(1).max(200).optional()
        })
      }
    ),
    tool(
      async ({ path, offset }) => {
        check()
        return JSON.stringify(await project.list(path, offset))
      },
      {
        name: "project_list",
        description:
          "List a directory in the configured project, 200 entries per page. Paths are relative to the project; symlinks and Git internal files are unavailable.",
        schema: z.object({
          path: z.string().default("."),
          offset: z.number().int().min(0).default(0)
        })
      }
    ),
    tool(
      async ({ pattern, path, offset, limit }) => {
        check()
        const matches = await project.glob(pattern, path, check)
        check()
        const paths: string[] = []
        let size = 0
        for (const match of matches.slice(offset, offset + limit)) {
          if (size + match.length > 24000) break
          paths.push(match)
          size += match.length
        }
        const next = offset + paths.length
        return JSON.stringify({
          paths,
          total: matches.length,
          nextOffset: next < matches.length ? next : null
        })
      },
      {
        name: "project_glob",
        description:
          "Find files by glob within the authorized project using Cmb's bounded traversal. The optional path is a project-relative subdirectory; returned paths are relative to the project root. Results are sorted and paginated. Links, Git internals and Host private data are excluded. Narrow the pattern if the traversal limit is exceeded. This searches file names, not content.",
        schema: z.object({
          pattern: z.string().min(1).max(4096),
          path: z.string().max(4096).default("."),
          offset: z.number().int().min(0).max(100000).default(0),
          limit: z.number().int().min(1).max(100).default(50)
        })
      }
    ),
    tool(
      async ({ pattern, path, glob }) =>
        JSON.stringify(await project.search(pattern, path, glob, check)),
      {
        name: "project_grep",
        description:
          "Find exact, case-sensitive text in authorized project files using Cmb's encoding-aware search. Returns project-relative paths, 1-based lines and bounded snippets. path selects a file or directory; glob filters file names. No regular expressions. Each scan is limited to 1000 files, 2 MiB per file, 16 MiB total, 10 seconds and 200 matches/24000 characters. Incomplete scans or skipped binary/large/unreadable files are explicitly reported: narrow the scope, never claim a whole-project absence from a partial scan. Links, Git internals, dependencies and Host private data are excluded.",
        schema: z.object({
          pattern: z.string().min(1).max(2000),
          path: z.string().max(4096).default("."),
          glob: z.string().min(1).max(4096).default("**/*")
        })
      }
    ),
    tool(
      async ({ path, offset, limit }) => {
        check()
        const file = await project.read(path)
        return JSON.stringify({
          path,
          sha256: file.sha256,
          text: file.text.slice(offset, offset + limit),
          totalCharacters: file.text.length,
          nextOffset: offset + limit < file.text.length ? offset + limit : null
        })
      },
      {
        name: "project_read",
        description:
          "Read a UTF-8 project file in bounded character pages. Returns its SHA-256, required for any edit. Read applicable AGENTS.md instructions before changing code.",
        schema: z.object({
          path: z.string().max(4096),
          offset: z.number().int().min(0).default(0),
          limit: z.number().int().min(1).max(32000).default(16000)
        })
      }
    ),
    tool(
      async (input, call) => {
        check()
        const id = `project:${request.run.id}:${call.toolCall?.id ?? randomUUID()}`
        const previous = request.store.effectResult(request.lease, id)
        if (previous) {
          if (previous.status === "succeeded") return previous.result ?? "修改已完成"
          throw new Error("修改已有失败或未知记录，需人工核对，不能自动重复")
        }
        if ((input.content !== undefined) === (input.old_text !== undefined))
          throw new Error("请选择完整内容或局部替换其中一种修改方式")
        const change = await project.prepare({
          path: input.path,
          expectedHash: input.expected_sha256,
          content: input.content,
          oldText: input.old_text,
          newText: input.new_text,
          replaceAll: input.replace_all
        })
        return approve(id, botProjectChangeAction(project.root, change), () =>
          commitBotProjectChange(request, files, project, change, id, check)
        )
      },
      {
        name: "project_edit",
        description:
          "Propose a project file change for explicit user approval. Supply the SHA-256 from project_read (null only for a new file in an existing directory). Use content for a full write OR old_text/new_text for a precise replacement. Existing Cmb edit matching rejects ambiguous changes. Changes are backed up and rechecked after approval; concurrent edits are not overwritten. This tool does not run tests.",
        schema: z.object({
          path: z.string().max(4096),
          expected_sha256: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .nullable(),
          content: z.string().max(128000).optional(),
          old_text: z.string().min(1).max(64000).optional(),
          new_text: z.string().max(64000).optional(),
          replace_all: z.boolean().default(false)
        })
      }
    )
  ]
}
