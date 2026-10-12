import { randomUUID } from "node:crypto"
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { BotDomainError } from "../../shared/bot-types"
import {
  botBrowserUploadCard,
  botBrowserUploadFiles,
  BOT_BROWSER_UPLOAD_COUNT
} from "../../shared/bot-browser-upload"
import type { BotRuntimeRequest } from "./host"
import type { BotArtifacts } from "./artifacts"
import type { LocalBotComputerProvider } from "./computer-provider"
import { prepareApprovedBotComputer } from "./computer-wait"
import { canonicalJson } from "./validation"

export function botBrowserFileUploadTool(input: {
  request: BotRuntimeRequest
  files: BotArtifacts
  computer: LocalBotComputerProvider
  taskRunId?: string
  check(): void
  approve(
    id: string,
    action: unknown,
    operation: () => Promise<string>,
    beforeStart?: () => Promise<void | string>
  ): Promise<string>
}) {
  const { request, files, computer, taskRunId, check, approve } = input
  const { store, run, lease, bot } = request
  return tool(
    async ({ ref, file_ids, purpose }, call) => {
      check()
      const id = `browser-upload:${run.id}:${call.toolCall?.id ?? randomUUID()}`
      const resolve = () =>
        botBrowserUploadFiles.parse(
          file_ids.map((fileId) => {
            const { id, name, mime, size, sha256 } = store.artifactForRun(run.id, fileId)
            return { id, name, mime, size, sha256 }
          })
        )
      const originals = resolve()
      const previous = store.effectResult(lease, id)
      if (previous?.status === "succeeded")
        return previous.result ?? "文件选择已完成，请核对网站结果"
      if (previous)
        throw new BotDomainError(
          "effect_requires_review",
          "上传已有未知或失败记录，请人工核对，不能自动重复"
        )
      const broker = await computer.get(),
        target = await broker.ensure(bot.id, taskRunId)
      const review = await broker.prepareUpload(target, ref, originals, check)
      const assertFiles = () => {
        check()
        if (canonicalJson(resolve()) !== canonicalJson(originals))
          throw new BotDomainError("artifact_changed", "上传原件或任务授权已变化")
      }
      const action = {
        browserUpload: botBrowserUploadCard.parse({
          version: 1,
          purpose,
          destination: review.destination,
          files: originals
        }),
        botId: bot.id,
        target,
        browserReview: review.context
      }
      const unperformed = "文件尚未选择：页面或输入框在审批期间变化，请重新观察并申请上传。"
      try {
        return await approve(
          id,
          action,
          async () => {
            try {
              return JSON.stringify(
                await broker.performUpload(
                  target,
                  review,
                  async () => {
                    // Called only after approval and admission to the exact page's
                    // serialized operation. No buffers accumulate behind queued input.
                    const payloads: { metadata: (typeof originals)[number]; bytes: Buffer }[] = []
                    try {
                      for (const metadata of originals) {
                        assertFiles()
                        const { bytes } = await files.read(metadata.id)
                        assertFiles()
                        payloads.push({ metadata, bytes })
                      }
                      return payloads
                    } catch (error) {
                      payloads.length = 0
                      throw error
                    }
                  },
                  assertFiles
                )
              )
            } catch (error) {
              if (error instanceof BotDomainError && error.code === "browser_upload_changed")
                return unperformed
              if (error instanceof BotDomainError && error.code === "browser_upload_limit")
                return "文件尚未选择：已有上传正在执行，请等待完成后重新观察页面，再申请上传。"
              throw error
            }
          },
          async () => {
            assertFiles()
            const stopped = await prepareApprovedBotComputer(request, computer, target)
            if (stopped) return stopped
            try {
              await broker.assertUpload(target, review, assertFiles)
            } catch (error) {
              if (error instanceof BotDomainError && error.code === "browser_upload_changed")
                return unperformed
              throw error
            }
            return undefined
          }
        )
      } finally {
        await review.dispose()
      }
    },
    {
      name: "upload_file",
      description:
        "Select original files in this Bot's exact website file input, after human approval. Use a fresh browser snapshot ref and file_ids from list_files or successful task file results; no host paths, URLs, directories or model-authored replacement bytes. Only current-task-visible originals or this task's own outputs are allowed, at most 8 files and 25 MiB total. Selection may immediately transfer the files to the website through page scripts, even without a Submit click. Approval binds the actual URL, title, DOM input and original file hashes. Success confirms native file selection only, not server acceptance; take a fresh snapshot to verify the site's result. Never retry an uncertain upload, bypass user takeover or use another task's artifact IDs.",
      schema: z
        .object({
          ref: z.string().min(1).max(100),
          file_ids: z.array(z.string().min(1).max(160)).min(1).max(BOT_BROWSER_UPLOAD_COUNT),
          purpose: z.string().min(1).max(500)
        })
        .strict()
    }
  )
}
