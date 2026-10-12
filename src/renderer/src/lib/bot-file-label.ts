import type { BotArtifact } from "../../../shared/bot-types"
import { BOT_FILE_ORIGIN_LABELS } from "../../../shared/bot-file-lifecycle"
import { formatAttachmentBytes } from "../components/bots/upstream/grok-composer-draft"

/** Display label only; authorization remains the Host's artifact/conversation check. */
export function botFileLabel(file: BotArtifact): string {
  const source = file.origin
    ? BOT_FILE_ORIGIN_LABELS[file.origin]
    : /^(browser-download|download):/.test(file.id)
      ? "浏览器下载"
      : file.runId
        ? "Bot 成果"
        : "旧版文件"
  return `${formatAttachmentBytes(file.size)} · ${source}`
}
