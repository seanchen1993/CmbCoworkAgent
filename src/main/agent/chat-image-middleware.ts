import { HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { createMiddleware } from "langchain"
import { MAX_CHAT_IMAGES } from "../../shared/file-attachment"
import { chatImageMarker } from "../../shared/attachment-message-parts"
import type { SubmittedChatImage } from "../../shared/file-attachment"
import { boundChatImageReceipt, readChatImage } from "../chat-images"

export type ChatImageMessageScope = "desktop" | { messageId?: string; validateAccess?: () => void }

export async function materializeChatImages(
  threadId: string,
  original: BaseMessage[],
  scope?: ChatImageMessageScope
) {
  if (!scope || (scope !== "desktop" && !scope.messageId)) return original
  const expectedSource = scope === "desktop" ? undefined : "bot"
  const messages = [...original]
  let count = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!HumanMessage.isInstance(message)) continue
    if (scope === "desktop" && message.additional_kwargs.cmb_chat_images_source === "bot") continue
    if (scope !== "desktop" && message.id !== scope.messageId) continue
    const declared = message.additional_kwargs.cmb_chat_images as SubmittedChatImage[] | undefined
    if (!declared?.length && !(typeof message.content === "string" && message.content.includes('media="image"'))) continue
    const receipt = message.id ? boundChatImageReceipt(threadId, message.id) : undefined
    if (receipt && receipt.source !== expectedSource) continue
    const refs = receipt?.images ?? []
    if (!refs.length) {
      if (declared?.length) throw new Error("本会话无法读取该图片，请重新添加")
      continue
    }
    if (scope !== "desktop") scope.validateAccess?.()
    if (refs.length > MAX_CHAT_IMAGES) throw new Error("图片数量超限")
    let text = typeof message.content === "string" ? message.content : message.text
    if (count + refs.length > MAX_CHAT_IMAGES) {
      // Keep the document text and labels when older pixels no longer fit this request.
      for (const ref of refs) text = text.replace(chatImageMarker(ref),
        () => ref.filename + "（历史图片未随本次请求发送）")
      messages[index] = new HumanMessage({ id: message.id, content: text, name: message.name })
      count = MAX_CHAT_IMAGES
      continue
    }
    count += refs.length
    const blocks: Exclude<HumanMessage["content"], string> = []
    const ordered = refs.map(ref => ({ ref, marker: chatImageMarker(ref) }))
      .sort((a, b) => text.indexOf(a.marker) - text.indexOf(b.marker))
    for (const { ref, marker } of ordered) {
      const position = text.indexOf(marker)
      if (position < 0) throw new Error("图片消息已改变，请重新添加图片")
      blocks.push({ type: "text" as const, text: text.slice(0, position) + ref.filename })
      blocks.push(await readChatImage(threadId, ref.id))
      text = text.slice(position + marker.length)
    }
    if (text) blocks.push({ type: "text" as const, text })
    if (scope !== "desktop") scope.validateAccess?.()
    messages[index] = new HumanMessage({ id: message.id, content: blocks, name: message.name })
  }
  return messages
}

export function createChatImageMiddleware(threadId: string, scope?: ChatImageMessageScope) {
  return createMiddleware({
    name: "chatImageInput",
    wrapModelCall: async (request, handler) => handler({
      ...request, messages: await materializeChatImages(threadId, request.messages, scope)
    })
  })
}
