import { HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { createMiddleware } from "langchain"
import { MAX_CHAT_IMAGES } from "../../shared/file-attachment"
import { chatImageMarker } from "../../shared/attachment-message-parts"
import type { SubmittedChatImage } from "../../shared/file-attachment"
import { boundChatImageReceipt, readChatImage } from "../chat-images"

type DesktopChatImageScope = "desktop" | { source: "desktop"; messageId?: string }
export type ChatImageMessageScope =
  | DesktopChatImageScope
  | { source?: "bot"; messageId?: string; validateAccess?: () => void }

export function isDesktopChatImageScope(
  scope: ChatImageMessageScope | undefined
): scope is DesktopChatImageScope {
  return scope === "desktop" || scope?.source === "desktop"
}

function unavailableHistory(text: string) {
  const replacement = text.replace(
    /<attachment filename="([^"]*)" media="image" slot="\d+" \/>/g,
    (_marker, filename: string) => filename + "（历史图片不可用）"
  )
  return replacement === text ? text + "\n（历史图片不可用）" : replacement
}

export async function materializeChatImages(
  threadId: string,
  original: BaseMessage[],
  scope?: ChatImageMessageScope
) {
  if (!scope) return original
  const desktop = isDesktopChatImageScope(scope)
  if (!desktop && !scope.messageId) return original
  const expectedSource = desktop ? undefined : "bot"
  const messages = [...original]
  let count = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!HumanMessage.isInstance(message)) continue
    if (desktop && message.additional_kwargs.cmb_chat_images_source === "bot") continue
    if (!desktop && message.id !== scope.messageId) continue
    const declared = message.additional_kwargs.cmb_chat_images as SubmittedChatImage[] | undefined
    const exact = scope !== "desktop" && Boolean(scope.messageId && message.id === scope.messageId)
    if (
      !exact &&
      !declared?.length &&
      !(typeof message.content === "string" && message.content.includes('media="image"'))
    )
      continue
    const receipt = message.id ? boundChatImageReceipt(threadId, message.id) : undefined
    const refs = receipt?.source === expectedSource ? (receipt?.images ?? []) : []
    const required = !desktop || scope === "desktop" || exact
    let text = typeof message.content === "string" ? message.content : message.text
    if (!refs.length) {
      if (exact || declared?.length) {
        if (required) throw new Error("本会话无法读取该图片，请重新添加")
        messages[index] = new HumanMessage({
          id: message.id,
          content: unavailableHistory(text),
          name: message.name
        })
      }
      continue
    }
    if (!desktop) scope.validateAccess?.()
    if (count + refs.length > MAX_CHAT_IMAGES) {
      if (required && (scope !== "desktop" || refs.length > MAX_CHAT_IMAGES))
        throw new Error("图片数量超限")
      // Keep the document text and labels when older pixels no longer fit this request.
      for (const ref of refs)
        text = text.replace(
          chatImageMarker(ref),
          () => ref.filename + "（历史图片未随本次请求发送）"
        )
      messages[index] = new HumanMessage({ id: message.id, content: text, name: message.name })
      count = MAX_CHAT_IMAGES
      continue
    }
    const parts: Array<string | Awaited<ReturnType<typeof readChatImage>>> = []
    let imageCount = 0
    const ordered = refs
      .map((ref) => ({ ref, marker: chatImageMarker(ref) }))
      .sort((a, b) => text.indexOf(a.marker) - text.indexOf(b.marker))
    for (const { ref, marker } of ordered) {
      const position = text.indexOf(marker)
      if (position < 0) {
        if (required) throw new Error("图片消息已改变，请重新添加图片")
        parts.push("\n" + ref.filename + "（历史图片标记不可用）\n")
        continue
      }
      const title = text.slice(0, position) + ref.filename
      try {
        const image = await readChatImage(threadId, ref.id)
        parts.push(title, image)
        imageCount++
      } catch (error) {
        if (required) throw new Error("本会话无法读取该图片，请重新添加", { cause: error })
        parts.push(title + "（历史图片不可用）")
      }
      text = text.slice(position + marker.length)
    }
    if (text) parts.push(text)
    if (!desktop) scope.validateAccess?.()
    count += imageCount
    const content = imageCount
      ? parts.map((part) =>
          typeof part === "string" ? { type: "text" as const, text: part } : part
        )
      : parts.join("")
    messages[index] = new HumanMessage({ id: message.id, content, name: message.name })
  }
  return messages
}

export function createChatImageMiddleware(threadId: string, scope?: ChatImageMessageScope) {
  return createMiddleware({
    name: "chatImageInput",
    wrapModelCall: async (request, handler) =>
      handler({
        ...request,
        messages: await materializeChatImages(threadId, request.messages, scope)
      })
  })
}
