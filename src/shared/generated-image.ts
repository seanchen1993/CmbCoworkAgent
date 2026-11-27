export interface GeneratedImageReceipt {
  kind: "generated-image"
  actionId: string
  userMessageId?: string
  width: number
  height: number
  mimeType: "image/png"
}

export interface GeneratedThreadImageSource {
  threadId: string
  messageId: string
  actionId: string
}

export interface GeneratedGroupImageSource {
  groupId: string
  messageId: string
  fileIndex: number
  actionId: string
}

export type GeneratedImageSource = GeneratedThreadImageSource | GeneratedGroupImageSource
export type GeneratedImageVariant = "thumbnail" | "original"
export type GeneratedImageLookup = Omit<GeneratedThreadImageSource, "actionId"> & { callId: string }

export interface GeneratedImagesApi {
  availability(): Promise<{ available: boolean; reason?: string }>
  lookup(source: GeneratedImageLookup): Promise<GeneratedImageReceipt | null>
  read(source: GeneratedImageSource, variant: GeneratedImageVariant): Promise<string>
  save(source: GeneratedImageSource): Promise<boolean>
}

export function isGeneratedImageId(id: unknown): id is string {
  return typeof id === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)
}

export function parseGeneratedImageReceipt(value: unknown): GeneratedImageReceipt | undefined {
  if (typeof value === "string") {
    if (value.length > 2048) return
    try {
      value = JSON.parse(value)
    } catch {
      return
    }
  }
  if (!value || typeof value !== "object") return
  const { kind, actionId, width, height, mimeType, userMessageId } =
    value as Partial<GeneratedImageReceipt>
  if (
    kind !== "generated-image" ||
    !isGeneratedImageId(actionId) ||
    mimeType !== "image/png" ||
    typeof width !== "number" ||
    !Number.isSafeInteger(width) ||
    width < 1 ||
    typeof height !== "number" ||
    !Number.isSafeInteger(height) ||
    height < 1
  )
    return
  return {
    kind,
    actionId,
    width,
    height,
    mimeType,
    ...(typeof userMessageId === "string" && userMessageId.length <= 1024 && { userMessageId })
  }
}
