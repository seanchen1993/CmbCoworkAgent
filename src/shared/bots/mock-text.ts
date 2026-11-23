import { BotError } from "./contracts"
import {
  isWorkflowPlumbingTranscriptContent,
  WORKFLOW_NOTIFICATION_TURN_TRIGGER
} from "../checkpoint-transcript"

/** Shared preflight and authoritative admission check; never infers a pending event's outcome. */
export function assertBotMockText(input: string): void {
  if (
    isWorkflowPlumbingTranscriptContent(input) ||
    input.trimStart().startsWith(WORKFLOW_NOTIFICATION_TURN_TRIGGER)
  )
    throw new BotError("INVALID_INPUT", "模拟渠道不支持保留的内部协议标记，请改用普通文字")
  // Transport markup is not an attachment/skill grant, including when pasted from the desktop.
  if (
    /<(?:attachment|user_attachment|attached_files?|file_attachment|skill|builtin_browser|bot-message-reply)\b|\[\[skill:|<\/?(?:cmb(?:devclaw)?|devclaw)[-_]/i.test(
      input
    )
  )
    throw new BotError("INVALID_INPUT", "模拟渠道仅支持普通文字，尚不支持附件、技能和本机资源引用")
}
