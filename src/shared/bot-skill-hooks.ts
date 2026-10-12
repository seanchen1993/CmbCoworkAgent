/** Events wired into the Bot runtime. The importer reports this same contract. */
export const BOT_SUPPORTED_SKILL_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PreSkillUse",
  "PostSkillUse",
  "UserPromptSubmit",
  "Notification",
  "Setup",
  "SessionStart",
  "SessionEnd",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "StopFailure"
] as const
