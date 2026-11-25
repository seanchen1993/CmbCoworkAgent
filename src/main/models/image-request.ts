/** Enforce the final payload limit after history, tools and retries have shaped it. */
export function imageRequestRejection(body: BodyInit | null | undefined, allowed: boolean) {
  if (typeof body !== "string" || !body.includes('"image_url"')) return
  const payload = JSON.parse(body)
  const images = (Array.isArray(payload.messages) ? payload.messages : []).flatMap(
    (message: { content?: unknown }) => Array.isArray(message?.content)
      ? message.content.filter(block => block?.type === "image_url") : []
  )
  if (!images.length) return
  const imageBytes = images.reduce((sum: number, block: { image_url?: { url?: unknown } }) => {
    const url = block.image_url?.url
    if (typeof url !== "string" || !url.startsWith("data:image/")) return sum
    const comma = url.indexOf(",")
    return sum + Buffer.byteLength(url.slice(comma + 1), "base64")
  }, 0)
  const error = !allowed ? "当前模型不支持图片输入，请切换视觉模型" :
    images.length > 3 || imageBytes > 6 * 1024 * 1024 || Buffer.byteLength(body) > 12 * 1024 * 1024 ? "本次请求的图片或总大小超限" :
    undefined
  if (error) return Response.json({ error: { message: error, type: "invalid_request_error" } },
    { status: 400 })
  return undefined
}
