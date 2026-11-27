import { createHash } from "node:crypto"
import type { BotDeliveredFile } from "../../shared/bots/file-delivery"
import type { GeneratedGroupImageSource, GeneratedImageVariant } from "../../shared/generated-image"
import type { ImageGenerationTurn } from "../agent/image-generation-tool"

export const MAX_GROUP_IMAGE_BYTES = 12 * 1024 * 1024
const staged = new WeakMap<
  BotDeliveredFile,
  {
    group: NonNullable<ImageGenerationTurn["group"]>
    bytes: Buffer
    assertCurrent: () => void
  }
>()

/** Stage only in host memory. The logical file ID resolves through the public message receipt. */
export async function stageGeneratedGroupFile(
  turn: ImageGenerationTurn,
  actionId: string
): Promise<BotDeliveredFile> {
  if (!turn.group) throw new Error("生成图片缺少群消息来源")
  const { readGeneratedImageForDelivery } = await import("../generated-images")
  const { bytes, receipt } = await readGeneratedImageForDelivery(
    turn.threadId,
    actionId,
    turn.assertCurrent,
    turn.userMessageId
  )
  turn.assertCurrent()
  if (turn.signal.aborted || !bytes.length || bytes.length > MAX_GROUP_IMAGE_BYTES)
    throw new Error("群图片已取消或超出大小限制")
  const file = {
    filePath: "generated-image:" + receipt.actionId,
    name: "image-" + receipt.actionId + ".png",
    size: bytes.length,
    generatedImage: receipt
  }
  staged.set(file, {
    group: turn.group,
    bytes,
    assertCurrent() {
      turn.signal.throwIfAborted()
      turn.assertCurrent()
    }
  })
  return file
}

/** Consumed synchronously inside the same SQLite transaction as the formal group post. */
export function takeStagedGroupImage(file: BotDeliveredFile) {
  const snapshot = staged.get(file)
  if (!snapshot) throw new Error("群图片缺少宿主交付记录")
  staged.delete(file)
  snapshot.assertCurrent()
  if (
    file.size !== snapshot.bytes.length ||
    file.generatedImage?.userMessageId !== snapshot.group.messageId
  )
    throw new Error("群图片所属消息已变化")
  return snapshot
}

export async function readDeliveredGeneratedImage(
  source: GeneratedGroupImageSource,
  variant: GeneratedImageVariant,
  assertCurrent: () => void
) {
  const { withBotImagePreview } = await import("./image-import")
  return withBotImagePreview(async () => {
    assertCurrent()
    const { getLocalBotHost } = await import("./local-service")
    const host = getLocalBotHost()
    const { pixels, digest } = host.groupGeneratedImage(source, true)
    if (
      !(pixels instanceof Uint8Array) ||
      pixels.length > MAX_GROUP_IMAGE_BYTES ||
      createHash("sha256").update(pixels).digest("hex") !== digest
    )
      throw new Error("群图片快照无效")
    const bytes = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength)
    const result =
      variant === "original"
        ? { bytes, mimeType: "image/png" }
        : {
            bytes: await (await import("sharp"))
              .default(bytes, { limitInputPixels: 16_000_000 })
              .timeout({ seconds: 15 })
              .resize(512, 512, { fit: "inside", withoutEnlargement: true })
              .webp()
              .toBuffer(),
            mimeType: "image/webp"
          }
    const checkSource = () => {
      assertCurrent()
      if (host.groupGeneratedImage(source, false).digest !== digest) throw new Error("群图片已变化")
    }
    checkSource()
    return { ...result, assertCurrent: checkSource }
  })
}
