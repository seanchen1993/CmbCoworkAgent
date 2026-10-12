import {
  botPeerDispatchOptions,
  botPeerDispatchFingerprint,
  type BotPeerDispatchOptions
} from "../../shared/bot-peer-dispatch"
import { BotDomainError } from "../../shared/bot-types"
import {
  botPeerImageSelections,
  type BotPeerImageSelection,
  type BotPeerImageSource
} from "../../shared/bot-peer-images"
import type { BotRuntimeRequest } from "./host"
import type { ApproveLocalBotAction } from "./profile-tools"
import type { BotDocumentReader } from "./document-reader"
import type { BotArtifacts } from "./artifacts"
import { BOT_ATTACHMENT_COUNT } from "../../shared/bot-files"
import {
  botPeerFileSelections,
  type BotPeerFileSelection,
  type BotPeerFileSource
} from "../../shared/bot-peer-files"

/** Keep delivery, scoped image aliases and approval consumption in the original
 * synchronous receipt transaction. Hash locks never cover human review. */
export async function sendReviewedBotPeer(
  request: BotRuntimeRequest,
  input: {
    callId: string
    recipient: string
    text: string
    images?: BotPeerImageSelection[]
    files?: BotPeerFileSelection[]
  } & BotPeerDispatchOptions,
  check: () => void,
  approve: ApproveLocalBotAction,
  files?: BotArtifacts,
  reader?: Pick<BotDocumentReader, "image">
): Promise<string> {
  const { store, lease, run, bot } = request
  check()
  const options = botPeerDispatchOptions.parse({
    ...(input.intent ? { intent: input.intent } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.reply_to_run_id ? { reply_to_run_id: input.reply_to_run_id } : {})
  })
  const dispatch = botPeerDispatchFingerprint(options)
  const selections = botPeerImageSelections.parse(input.images ?? [])
  const fileSelections = botPeerFileSelections.parse(input.files ?? [])
  const selectedIds = [...selections, ...fileSelections].map((file) => file.artifact_id)
  if (selectedIds.length > BOT_ATTACHMENT_COUNT || new Set(selectedIds).size !== selectedIds.length)
    throw new BotDomainError("peer_attachment_selection", "协作附件数量超限或存在重复文件")
  const normalized = {
    callId: input.callId,
    recipient: input.recipient,
    text: input.text,
    ...dispatch,
    ...(selections.length ? { images: selections } : {}),
    ...(fileSelections.length ? { files: fileSelections } : {})
  }
  const nonce = `peer:${run.id}:${input.callId}`
  const prior = store.db.exec("SELECT 1 FROM bot_receipts WHERE nonce=?", [nonce])[0]?.values.length
  const reviewed =
    selections.length > 0 ||
    fileSelections.length > 0 ||
    Object.keys(dispatch).length > 0 ||
    store.autoReview.read(bot.id).isEnabled
  // A text-only legacy nonce retains its exact fingerprint and review behavior.
  if (
    !selections.length &&
    !fileSelections.length &&
    !Object.keys(dispatch).length &&
    (prior || !reviewed)
  )
    return JSON.stringify(
      store.sendPeer(lease, { nonce, recipient: input.recipient, text: input.text })
    )
  const target = store.toolOnce(lease, `${input.callId}:peer-plan`, normalized, () => {
    const recipient = store.getBot(input.recipient)
    const route = store.peerDispatch.resolve(store.assertDispatch(lease), recipient.id, options)
    return {
      dispatch: {
        intent: route.intent,
        priority: options.priority === true,
        replyToRunId: route.requester?.id ?? null,
        activationScopeRunId: route.activationScopeRunId,
        originalRequestId: route.originalRequest?.id ?? null,
        conversationId: route.conversationId,
        threadRootId: route.threadRootId ?? null
      },
      id: recipient.id,
      revision: recipient.revision,
      name: recipient.name,
      instructions: recipient.instructions,
      workspacePath: recipient.workspacePath,
      modelRef: recipient.modelRef,
      connectorIds: recipient.connectorIds ?? [],
      ...(selections.length ? { images: store.peerImageSources(lease, selections) } : {}),
      ...(fileSelections.length ? { files: store.peerFileSources(lease, fileSelections) } : {})
    }
  })
  const images: BotPeerImageSource[] = target.images ?? []
  const attachments: BotPeerFileSource[] = target.files ?? []
  const send = () =>
    JSON.stringify(
      store.sendPeer(lease, {
        nonce,
        recipient: input.recipient,
        text: input.text,
        ...dispatch,
        ...(images.length ? { images } : {}),
        ...(attachments.length ? { files: attachments } : {})
      })
    )
  // A lost delivery ACK must not re-read a now-deleted source or copy anything.
  if (prior) return send()
  if (images.length && (!files || !reader))
    throw new BotDomainError("files_unavailable", "文件服务未连接，未派发图片协作任务")
  if (attachments.length && !files)
    throw new BotDomainError("files_unavailable", "文件服务未连接，未派发文件协作任务")
  const validate = <T>(commit: () => T | Promise<T>, inspect?: (bytes: Buffer) => Promise<void>) =>
    attachments.length
      ? files!.withPeerFiles(lease, attachments, check, commit, images, inspect)
      : files!.withPeerImages(lease, images, check, commit, inspect)
  if (images.length || attachments.length)
    await validate(
      () => undefined,
      images.length
        ? async (bytes) => {
            // Decode under the existing disposable parser's pixel/memory/time budget.
            // MIME/extension/signature alone cannot prove this is a readable image.
            await reader!.image(bytes, undefined, request.signal)
            check()
          }
        : undefined
    )
  return approve(
    `peer-dispatch:${run.id}:${input.callId}`,
    {
      peer: {
        recipient: {
          id: target.id,
          revision: target.revision,
          name: target.name,
          instructions: target.instructions,
          workspacePath: target.workspacePath,
          modelRef: target.modelRef,
          connectorIds: target.connectorIds
        },
        message: input.text,
        dispatch: target.dispatch,
        ...(images.length ? { images } : {}),
        ...(attachments.length ? { files: attachments } : {})
      }
    },
    () => {
      check()
      if (store.getBot(target.id).revision !== target.revision)
        throw new BotDomainError("revision_conflict", "接收 Bot 的职责或权限已变化，请重新确认派发")
      const route = store.peerDispatch.resolve(store.assertDispatch(lease), target.id, options)
      const current = {
        intent: route.intent,
        priority: options.priority === true,
        replyToRunId: route.requester?.id ?? null,
        activationScopeRunId: route.activationScopeRunId,
        originalRequestId: route.originalRequest?.id ?? null,
        conversationId: route.conversationId,
        threadRootId: route.threadRootId ?? null
      }
      if (JSON.stringify(current) !== JSON.stringify(target.dispatch))
        throw new BotDomainError("peer_route_changed", "协作回复关联已变化，请重新确认")
      return send()
    },
    images.length || attachments.length ? (commit) => validate(commit) : undefined
  )
}
