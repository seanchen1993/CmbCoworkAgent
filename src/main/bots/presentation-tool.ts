import type { BotArtifact } from "../../shared/bot-types"
import { presentationSelectionIdentity } from "./presentation-choice"
import { randomUUID } from "node:crypto"
import { tool } from "@langchain/core/tools"
import {
  botPresentationInput,
  BOT_PRESENTATION_LABELS,
  BOT_PRESENTATION_STYLES,
  type BotPresentationStyle
} from "../../shared/bot-presentation"
import type { BotArtifacts } from "./artifacts"
import type { BotRuntimeRequest } from "./host"
import type { BotDocumentReader } from "./document-reader"
import { BotPresentationInputError, botPresentationDrafts } from "./presentation-contract"
import {
  presentationHash,
  presentationManifest,
  presentationManifestCall,
  readPresentationManifest
} from "./presentation-record"
import { botQuestionsSchema, validateBotQuestionAnswer } from "../../shared/bot-questions"
import { BOT_SCHEMA_VERSION } from "./schema"
import type { BotPeerMessageImage } from "../../shared/bot-peer-images"

export function botPresentationTool(
  request: BotRuntimeRequest,
  files: BotArtifacts,
  reader: BotDocumentReader,
  check: () => void,
  wait: (id: string) => Promise<string>
) {
  const { store, lease, run, signal } = request
  const active = new Map<string, { hash: string; promise: Promise<string> }>()
  const execute = async (raw: unknown, callId: string): Promise<string> => {
    check()
    if (BOT_SCHEMA_VERSION < 69) throw new Error("演示文稿存储版本尚未升级，请更新后台后重试")
    const input = botPresentationInput.parse(raw),
      inputSha256 = presentationHash(input)
    const publicationId = `presentation:${presentationHash([run.id, callId])}`
    const { intent } = presentationSelectionIdentity(run.id, callId, inputSha256)
    store.toolOnce(lease, callId, intent, () => intent)
    const complete = (
      artifact: BotArtifact,
      manifest: NonNullable<ReturnType<typeof readPresentationManifest>>
    ) => {
      if (manifest.inputSha256 !== inputSha256) throw new Error("已保存演示文稿与原请求内容不一致")
      const delivered = store.deliverExistingArtifact(lease, `${callId}:return`, artifact.id)
      return JSON.stringify({
        ...delivered,
        status: "generated",
        generated: true,
        pages: manifest.layout.pages.length,
        style: manifest.layout.style,
        preview: "saved_layout",
        editable: true,
        selectionCompleted: true,
        selectionSource: input.style === undefined ? "user_card" : "provided_style",
        attachment: { status: "delivered", sourceArtifactId: delivered.id },
        nextAction:
          "This call has completed style selection and attached the editable original. No further style confirmation or deliver_file call is needed for this result. Continue any remaining requested work and honor later user requests."
      })
    }
    // An already published original is authoritative. Never regenerate bytes after a lost ACK.
    let original
    try {
      original = store.getArtifact(publicationId)
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "not_found"))
        throw error
    }
    if (
      original &&
      (original.runId !== run.id ||
        original.conversationId !== run.conversationId ||
        original.name !== input.name ||
        original.mime !==
          "application/vnd.openxmlformats-officedocument.presentationml.presentation")
    )
      throw new Error("已生成演示文稿的身份与原请求不一致")
    if (original) {
      const manifest = readPresentationManifest(store, original)
      if (manifest) return complete(original, manifest)
    }
    let drafts
    let preparedPreviews: string[] | undefined
    const draftCall = `presentation-layout:${presentationHash(callId)}`
    if (store.hasToolResult(lease, draftCall)) {
      drafts = botPresentationDrafts.omit({ previews: true }).parse(
        store.toolOnce(lease, draftCall, intent, () => {
          throw new Error("已保存布局缺失")
        })
      )
    } else {
      const prepared = await reader.presentationDrafts(input, signal)
      check()
      preparedPreviews = prepared.previews
      drafts = store.toolOnce(lease, draftCall, intent, () => ({ layouts: prepared.layouts }))
    }
    const selectedCall = `presentation-selected:${presentationHash(callId)}`
    const previousSelection = store.hasToolResult(lease, selectedCall)
      ? store.toolOnce<{ style: BotPresentationStyle; layoutSha256: string }>(
          lease,
          selectedCall,
          intent,
          () => {
            throw new Error("已选择的版式记录缺失")
          }
        )
      : undefined
    let selected: BotPresentationStyle | undefined = previousSelection?.style ?? input.style
    if (!selected) {
      const images: BotPeerMessageImage[] = []
      for (const [index, style] of BOT_PRESENTATION_STYLES.entries()) {
        const sampleId = `${publicationId}:${style}`,
          name = `${BOT_PRESENTATION_LABELS[style]}-样稿.png`
        let artifact
        try {
          artifact = store.getArtifact(sampleId)
        } catch (error) {
          if (
            !(error && typeof error === "object" && "code" in error && error.code === "not_found")
          )
            throw error
          const base64 =
            preparedPreviews?.[index] ??
            (
              await reader.presentationPage(
                drafts.layouts[index],
                Math.min(1, input.slides.length - 1),
                signal
              )
            ).base64
          check()
          artifact = await files.publish(
            {
              id: sampleId,
              name,
              mime: "image/png",
              conversationId: run.conversationId,
              runId: run.id
            },
            Buffer.from(base64, "base64"),
            lease
          )
        }
        images.push({
          id: artifact.id,
          sourceId: artifact.id,
          sourceConversationId: run.conversationId,
          sha256: artifact.sha256,
          name: artifact.name,
          mime: artifact.mime,
          size: artifact.size,
          alt: `${BOT_PRESENTATION_LABELS[style]}样稿`
        })
      }
      // Samples are now immutable artifacts; do not retain image payloads while a user is away.
      preparedPreviews = undefined
      const questions = botQuestionsSchema.parse({
        questions: [
          {
            id: "presentation_style",
            header: "版式",
            question: "选择演示文稿的版式",
            options: BOT_PRESENTATION_STYLES.map((style) => ({
              label: BOT_PRESENTATION_LABELS[style],
              description:
                style === "minimal"
                  ? "留白充足，适合技术与产品说明"
                  : style === "executive"
                    ? "深色背景，适合成果展示"
                    : "柔和纸色，适合内容与故事讲述"
            }))
          }
        ]
      })
      const epoch = store.dataEpoch(),
        questionCall = `presentation-question:${presentationHash([callId, epoch, lease.fence])}`
      const interaction = store.toolOnce(lease, questionCall, { ...intent, epoch }, () =>
        store.requestPresentationInteraction(lease, {
          questions,
          presentation: {
            version: 1,
            dataEpoch: epoch,
            conversationId: run.conversationId,
            runId: run.id,
            inputSha256,
            callId,
            layoutHashes: drafts.layouts.map(presentationHash),
            images
          }
        })
      )
      const answer = JSON.parse(validateBotQuestionAnswer(questions, await wait(interaction.id)))
      check()
      if (store.dataEpoch() !== epoch) throw new Error("工作区版本已变化，请重新选择版式")
      if (answer.status === "cancelled")
        return JSON.stringify({ status: "cancelled", generated: false })
      const value = answer.answers.presentation_style
      if (value.type !== "option" || value.additionalText)
        return JSON.stringify({
          status: "not_generated",
          reason: "用户补充了版式要求，请据此调整内容并重新提供样稿",
          userAnswer: answer
        })
      selected = BOT_PRESENTATION_STYLES[value.optionIndex]
    }
    const layout = drafts.layouts[BOT_PRESENTATION_STYLES.indexOf(selected!)]
    if (!layout) throw new Error("所选版式不存在")
    const selection = store.toolOnce(lease, selectedCall, intent, () => ({
      style: selected,
      layoutSha256: presentationHash(layout)
    }))
    if (selection.style !== selected || selection.layoutSha256 !== presentationHash(layout))
      throw new Error("已选择的版式与当前请求不一致")
    if (!original) {
      const generated = await reader.presentationWrite(layout, signal)
      check()
      original = await files.publish(
        {
          id: publicationId,
          conversationId: run.conversationId,
          runId: run.id,
          name: input.name,
          mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        },
        Buffer.from(generated.bytes),
        lease
      )
    }
    check()
    store.toolOnce(lease, presentationManifestCall(publicationId), intent, () =>
      presentationManifest.parse({
        version: 1,
        artifactId: original.id,
        artifactSha256: original.sha256,
        conversationId: run.conversationId,
        runId: run.id,
        inputSha256,
        layout
      })
    )
    const manifest = readPresentationManifest(store, original)
    if (!manifest) throw new Error("已生成演示文稿缺少保存布局，暂不能交付")
    return complete(original, manifest)
  }
  return tool(
    async (input, call) => {
      const callId = call.toolCall?.id ?? randomUUID(),
        hash = presentationHash(input)
      const existing = active.get(callId)
      if (existing) {
        if (existing.hash !== hash) throw new Error("同一演示文稿调用的内容发生变化")
        return existing.promise
      }
      if (active.size >= 4) throw new Error("演示文稿生成繁忙，请等待当前任务")
      const promise = execute(input, callId)
        .catch((error) => {
          if (error instanceof BotPresentationInputError)
            return JSON.stringify({
              status: "not_generated",
              code: error.code,
              reason: error.message
            })
          throw error
        })
        .finally(() => active.delete(callId))
      active.set(callId, { hash, promise })
      return promise
    },
    {
      name: "create_presentation",
      schema: botPresentationInput,
      description:
        "Create a real editable PowerPoint .pptx with 1–20 slides, using title, content or two-column layouts. Supply complete grounded text; do not fabricate data. One call handles the complete draft-selection-generation-delivery lifecycle. Leave style unset: this tool shows three visual drafts, waits for the user's choice internally, then resumes and attaches the selected editable original. Only provide an explicit style when already specified by the user; a provided_style result records the supplied parameter, not an independently verified user answer. Text is measured and overflow rejects generation with actionable feedback. Supports text and shapes, not charts, uploaded template editing, arbitrary images or Google Slides. A generated result means style selection is complete and the original is already attached. Do not ask the same style question again or call deliver_file for it. Reference the returned original artifact ID and continue any other requested work; a later user request may change the style. Saved-layout previews are not an Office rendering. Never create a .pptx by writing UTF-8 text with deliver_file."
    }
  )
}
