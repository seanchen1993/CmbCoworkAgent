import { useContext, useEffect, useState } from "react"
import {
  parseGeneratedImageReceipt,
  type GeneratedImageReceipt,
  type GeneratedImageSource
} from "../../../../shared/generated-image"
import { MessageImageGallery } from "./MessageImageGallery"
import { ChatImageRegenerationContext } from "./chat-presentation-context"

export function GeneratedImagePreview({
  image,
  source,
  regenerate
}: {
  image: Pick<GeneratedImageReceipt, "width" | "height" | "mimeType">
  source: GeneratedImageSource
  regenerate?: () => void
}) {
  const api = window.api.generatedImages
  const filename = "生成图片." + image.mimeType.slice("image/".length)
  return (
    <MessageImageGallery
      sourceKey={JSON.stringify(source)}
      read={async () => [{ filename, url: await api.read(source, "thumbnail") }]}
      original={{
        width: image.width,
        height: image.height,
        regenerate,
        read: () => api.read(source, "original"),
        save: () => api.save(source)
      }}
    />
  )
}

/** A streamed tool result can be lost even though its image was committed before shutdown. */
export function GeneratedImageToolResult({
  threadId,
  messageId,
  callId,
  result,
  running
}: {
  threadId: string
  messageId: string
  callId: string
  result?: { content: unknown; is_error?: boolean }
  running: boolean
}) {
  const receipt = result && !result.is_error ? parseGeneratedImageReceipt(result.content) : null
  const findRegeneration = useContext(ChatImageRegenerationContext)
  const [recovered, setRecovered] = useState<GeneratedImageReceipt | null>(null)
  const [unavailable, setUnavailable] = useState("")
  const [attempt, setAttempt] = useState(0)
  const shouldRecover = !receipt && !running && !result?.is_error
  useEffect(() => {
    if (!shouldRecover) return
    let current = true
    void window.api.generatedImages.lookup({ threadId, messageId, callId }).then(
      (value) => {
        if (!current) return
        setRecovered(value)
        setUnavailable("")
      },
      (error: unknown) => {
        if (!current) return
        setRecovered(null)
        const message = error instanceof Error ? error.message : ""
        setUnavailable(
          ["生图结果待确认，请勿重复提交", "生成图片结果无法取回"].find((status) =>
            message.endsWith(status)
          ) ?? "暂时无法读取生成结果"
        )
      }
    )
    return () => {
      current = false
    }
  }, [threadId, messageId, callId, shouldRecover, attempt])
  const image = receipt || (shouldRecover ? recovered : null)
  if (image)
    return (
      <GeneratedImagePreview
        image={image}
        regenerate={image.userMessageId ? findRegeneration?.(image.userMessageId) : undefined}
        source={{ threadId, messageId, actionId: image.actionId }}
      />
    )
  if (running && !result)
    return (
      <p role="status" className="text-sm">
        正在生成图片…
      </p>
    )
  if (result?.is_error)
    return (
      <p role="status" className="text-sm">
        {typeof result.content === "string" ? result.content : "图片生成失败"}
      </p>
    )
  return (
    <div className="space-y-1 text-sm">
      {unavailable && <p role="status">{unavailable}</p>}
      <button
        type="button"
        className="text-muted-foreground underline"
        onClick={() => setAttempt((value) => value + 1)}
      >
        重新读取生成结果
      </button>
    </div>
  )
}
