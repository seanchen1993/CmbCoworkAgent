import { basename } from "node:path"
import { tool, type StructuredToolInterface } from "@langchain/core/tools"
import { z } from "zod"
import type { BotRuntimeRequest } from "./host"
import type { BotArtifacts } from "./artifacts"
import { BotProjectFiles } from "./project-files"
import { botProjectChangeAction, commitBotProjectChange } from "./project-change"
import { readSkillResource } from "./skill-resource-files"
import { BotDocumentReader } from "./document-reader"
import { botDocumentToolContent } from "./document-tool"
import { botImageRegion } from "./image-contract"
import { botPdfPage } from "./pdf-contract"
import type { BotSkillLifecycle } from "./skill-lifecycle"

export function botSkillResourceTools(
  request: BotRuntimeRequest,
  check: () => void,
  reader: BotDocumentReader,
  copy?: {
    files: BotArtifacts
    deniedRoots: string[]
    approve: (id: string, action: unknown, operation: () => Promise<string>) => Promise<string>
  },
  lifecycle?: BotSkillLifecycle
): StructuredToolInterface[] {
  const { store, bot, run, lease, signal } = request
  const source = (id: string) => {
    check()
    const skill = store.skillLibrary.readForRun(run.id, id)
    if (skill.scope !== "desktop") throw new Error("此技能没有安装目录，请使用 read_skill 阅读步骤")
    return store.externalSkills.source(bot.id, id, skill.version)
  }
  const activate = async (id: string, callId: string | undefined, toolName: string) => {
    if (!callId) throw new Error("技能文件操作缺少稳定执行标识")
    const skill = store.skillLibrary.readForRun(run.id, id)
    const hookContext = await lifecycle?.activate(id, skill.version, callId, toolName)
    return { skill: source(id), hookContext }
  }
  const tools: StructuredToolInterface[] = [
    tool(
      async ({ id, offset }, call) => {
        const { skill, hookContext } = await activate(id, call.toolCall?.id, "list_skill_files"),
          files = skill.resources.filter((item) => item.kind === "file")
        return JSON.stringify({
          id,
          ...(hookContext ? { hookContext } : {}),
          items: files.slice(offset, offset + 40).map(({ path, size }) => ({ path, size })),
          nextOffset: offset + 40 < files.length ? offset + 40 : null
        })
      },
      {
        name: "list_skill_files",
        description:
          "List files bundled with an installed Cmb skill, including scripts, reference documents and templates. Uses the exact enabled skill version. Paths are relative to that skill; its installed directory is read-only. Files do not authorize commands or external actions.",
        schema: z.object({ id: z.string(), offset: z.number().int().nonnegative().default(0) })
      }
    ),
    tool(
      async ({ id, path, offset, limit, image_region, pdf_page }, call) => {
        const { skill } = await activate(id, call.toolCall?.id, "read_skill_file"),
          { bytes } = await readSkillResource(skill, path)
        check()
        return botDocumentToolContent(
          reader,
          {
            name: basename(path),
            bytes,
            offset,
            limit,
            imageRegion: image_region,
            pdfPage: pdf_page,
            callId: call.toolCall?.id ?? ""
          },
          signal,
          check
        )
      },
      {
        name: "read_skill_file",
        description:
          "Read a file listed by list_skill_files: UTF-8 scripts/text, PDF text, Office documents or PNG/JPEG/WebP/GIF still images. Maximum 25 MiB. offset/limit count characters; follow hasMore/nextOffset. For PDF scans, charts or layout set pdf_page (1-based, at most 1000) to view one page using a vision-capable model. image_region uses original image pixels or rotated PDF page pixels at 96 dpi; dimensions are returned. Views are at most 2048 pixels/1 MiB. Does not execute scripts; video/other binary formats are unsupported. Source changes invalidate this task's skill version.",
        schema: z.object({
          id: z.string(),
          path: z.string().min(1).max(4096),
          offset: z.number().int().nonnegative().default(0),
          limit: z.number().int().min(1).max(32000).default(16000),
          image_region: botImageRegion.optional(),
          pdf_page: botPdfPage.optional()
        })
      }
    )
  ]
  if (copy && bot.workspacePath)
    tools.push(
      tool(
        async ({ id, path, destination, expected_sha256 }, call) => {
          check()
          if (!call.toolCall?.id) throw new Error("技能复制缺少稳定执行标识")
          store.toolOnce(
            lease,
            call.toolCall.id,
            { tool: "copy_skill_file", id, path, destination, expected_sha256 },
            () => true
          )
          const effectId = `skill-copy:${run.id}:${call.toolCall.id}`,
            previous = store.effectResult(lease, effectId)
          if (previous?.status === "succeeded") return previous.result ?? "技能文件已复制"
          if (previous) throw new Error("复制已有失败或未知记录，需人工核对")
          const { skill } = await activate(id, call.toolCall.id, "copy_skill_file"),
            file = await readSkillResource(skill, path)
          const project = await BotProjectFiles.open(bot.workspacePath!, copy.deniedRoots)
          let content: string | undefined
          if (file.bytes.length <= 2 * 1024 * 1024 && !file.bytes.includes(0)) {
            try {
              content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
                file.bytes
              )
            } catch {
              /* Preserve non-UTF-8 templates as binary bytes. */
            }
          }
          if (content === undefined) {
            if (expected_sha256 !== null)
              throw new Error("二进制或大型模板只能复制为新文件，请选择新文件名")
            await project.assertNewArtifact(destination)
            check()
            return copy.approve(
              effectId,
              {
                skillImport: {
                  id,
                  name: skill.name,
                  path,
                  destination,
                  root: project.root,
                  sha256: file.sha256,
                  size: file.bytes.length
                }
              },
              async () => {
                source(id)
                const original = await copy.files.publish(
                  {
                    id: `${effectId}:source`,
                    conversationId: run.conversationId,
                    runId: run.id,
                    name: basename(path),
                    mime: "application/octet-stream",
                    origin: "skill"
                  },
                  file.bytes,
                  lease
                )
                const result = await project.createArtifact(destination, file.bytes, () => {
                  store.localTools.assertStartedEffect(lease, effectId)
                  check()
                })
                return JSON.stringify({ ...result, sourceArtifactId: original.id })
              }
            )
          }
          const change = await project.prepare({
            path: destination,
            expectedHash: expected_sha256,
            content,
            format: "verbatim"
          })
          check()
          return copy.approve(
            effectId,
            {
              ...botProjectChangeAction(project.root, change),
              skillFile: { id, name: skill.name, path, sha256: file.sha256 }
            },
            async () => {
              source(id)
              check()
              return commitBotProjectChange(request, copy.files, project, change, effectId, check)
            }
          )
        },
        {
          name: "copy_skill_file",
          description:
            "Copy an installed skill file unchanged into an existing project directory, after approval. UTF-8 text up to 2 MiB uses a reviewed diff and target SHA-256 (null for a new file), preserving backups. Binary/larger templates up to 25 MiB require a new filename and null expected_sha256; they never overwrite existing files. Source changes invalidate approval. This copies only; use the separately approved execute tool to run scripts. Read script, skill compatibility/dependency notes and project instructions before proposing execution.",
          schema: z.object({
            id: z.string(),
            path: z.string().min(1).max(4096),
            destination: z.string().min(1).max(4096),
            expected_sha256: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .nullable()
          })
        }
      )
    )
  return tools
}
