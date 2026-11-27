import { useEffect, useState } from "react"
import type { SlashCommandItem } from "./useSlashCommands"
import { stripUserInputTransportDecorations } from "../../../../shared/user-input-transport"
import { hasOrdinaryBotConversationShape } from "../../../../shared/ordinary-conversation"
import { isBtwThreadId } from "../../../../shared/btw-chat"

export function hasImageGenerationComposer(
  surface: string,
  threadId: string,
  metadata: Record<string, unknown> | null | undefined,
  managed: boolean | undefined
) {
  if (managed !== undefined) return managed && surface === "bot"
  return (
    surface === "default" &&
    !isBtwThreadId(threadId) &&
    Boolean(metadata && hasOrdinaryBotConversationShape(metadata))
  )
}

export const imageGenerationCommand: SlashCommandItem = {
  id: "generate-image",
  title: "生成图片",
  command: "/生成图片",
  usage: "/生成图片 <描述>",
  description: "根据描述生成一张图片",
  insertText: "/生成图片 ",
  keywords: ["画图", "生图", "image"]
}

/** Refill only a complete, plain user instruction. Never copy transport data or a model's tool prompt. */
export function generatedImageDraftText(content: unknown): string | undefined {
  if (typeof content !== "string") return
  const text = content
    .trim()
    .replace(/^\/生成图片(?:\s+|$)/u, "")
    .trim()
  if (
    !text ||
    text.startsWith("📎") ||
    /<(?:attachment\b|CMBDEVCLAW[-:])/i.test(text) ||
    stripUserInputTransportDecorations(text) !== text
  )
    return
  return imageGenerationCommand.insertText + text
}

export function useImageGenerationAvailability(enabled: boolean) {
  const [status, setStatus] = useState<{ available: boolean; reason?: string }>()
  useEffect(() => {
    if (!enabled) return
    const api = window.api?.generatedImages
    if (!api) return
    let current = true
    let revision = 0
    const update = () => {
      const request = ++revision
      void api.availability().then(
        (value) => {
          if (current && revision === request) setStatus(value)
        },
        () => {
          if (current && revision === request)
            setStatus({ available: false, reason: "无法读取生图服务配置" })
        }
      )
    }
    update()
    window.addEventListener("focus", update)
    return () => {
      current = false
      window.removeEventListener("focus", update)
    }
  }, [enabled])
  return enabled ? status : undefined
}
