import type { BotTeachSession, BotTeachVideoChunk } from "../../../shared/bot-teach"
import { loadVerifiedBotBlob } from "./bot-binary-transfer"

/** RPC stays bounded; a video is only exposed after the complete saved hash
 * matches. Switching recordings or closing the dialog stops further reads. */
export async function loadBotTeachVideo(
  session: BotTeachSession,
  read: (input: { id: string; offset: number }) => Promise<BotTeachVideoChunk>,
  signal: AbortSignal,
  progress: (percent: number) => void
): Promise<Blob> {
  const video = session.video
  if (!video || video.size < 1 || video.size > 64 * 1024 * 1024) throw new Error("录像大小无效")
  return loadVerifiedBotBlob(video, (offset) => read({ id: session.id, offset }), signal, progress)
}
