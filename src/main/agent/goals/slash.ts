export type GoalSlashCommand =
  | { type: "none" }
  | { type: "set"; text: string }
  | { type: "status" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "clear" }

function stripTransportPayload(input: string): string {
  let text = input.trim()
  const skillOpen = text.lastIndexOf("<CMBDEVCLAW-SKILL-USE-V1>")
  const skillClose = text.lastIndexOf("</CMBDEVCLAW-SKILL-USE-V1>")
  if (
    skillOpen >= 0 &&
    skillClose > skillOpen &&
    text.slice(skillClose + "</CMBDEVCLAW-SKILL-USE-V1>".length).trim() === ""
  ) {
    text = text.slice(0, skillOpen).trimEnd()
  }

  const attachmentStart = text.search(/\n\s*<attachment\b/i)
  if (attachmentStart >= 0) text = text.slice(0, attachmentStart).trimEnd()
  return text
}

export function parseGoalSlashCommand(input: string): GoalSlashCommand {
  const trimmed = stripTransportPayload(input)
  if (!/^\/goal(?:\s|$)/i.test(trimmed)) return { type: "none" }

  const afterCommand = trimmed.slice("/goal".length)

  const arg = afterCommand.trim()
  const lower = arg.toLowerCase()
  if (!arg || lower === "status") return { type: "status" }

  if (lower === "pause") return { type: "pause" }
  if (lower === "resume") return { type: "resume" }
  if (
    lower === "clear" ||
    lower === "stop" ||
    lower === "done" ||
    lower === "off" ||
    lower === "reset" ||
    lower === "none" ||
    lower === "cancel"
  )
    return { type: "clear" }

  return { type: "set", text: arg }
}
