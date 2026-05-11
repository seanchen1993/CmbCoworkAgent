const fs = require("fs")
const path = require("path")

function readStdin() {
  return new Promise((resolve) => {
    let raw = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk) => {
      raw += chunk
    })
    process.stdin.on("end", () => resolve(raw))
  })
}

function safeJsonParse(raw) {
  if (!raw || !raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch (error) {
    return {
      parse_error: error instanceof Error ? error.message : String(error),
      raw
    }
  }
}

function sanitizeName(value) {
  return String(value || "hook")
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .replace(/-+/g, "-")
}

function pickWorkspace(input) {
  const fixtureWorkspace = "C:/360Downloads"
  return (
    input.workspace_path ||
    process.env.WORKSPACE_PATH ||
    process.env.CLAUDE_PROJECT_DIR ||
    (fs.existsSync(fixtureWorkspace) ? fixtureWorkspace : "") ||
    process.cwd()
  )
}

function outputFor(label, input) {
  if (label === "session-start-halt") {
    return {
      decision: "block",
      reason: "SCRIPT_SESSION_START_DECISION_BLOCK",
      systemMessage: "SCRIPT_SESSION_START_SYSTEM_MESSAGE",
      additionalContext: "SCRIPT_SESSION_START_ADDITIONAL_CONTEXT"
    }
  }
  if (label === "notification-revise") {
    return {
      continue: false,
      stopReason: "SCRIPT_NOTIFICATION_CONTINUE_FALSE",
      systemMessage: "SCRIPT_NOTIFICATION_SYSTEM_MESSAGE",
      additionalContext: "SCRIPT_NOTIFICATION_ADDITIONAL_CONTEXT"
    }
  }
  if (label === "direct-prompt-stop") {
    const prompt = String(input.prompt || process.env.USER_PROMPT || "")
    if (!prompt.includes("DIRECT_STOP_TEST")) {
      return {}
    }
    return {
      continue: false,
      stopReason: "DIRECT_STOP_USER_PROMPT",
      systemMessage: "DIRECT_STOP_USER_PROMPT_SYSTEM_MESSAGE",
      additionalContext: "DIRECT_STOP_USER_PROMPT_ADDITIONAL_CONTEXT"
    }
  }
  return {
    systemMessage: `SCRIPT_${label}_SYSTEM_MESSAGE`,
    additionalContext: `SCRIPT_${label}_ADDITIONAL_CONTEXT`
  }
}

async function main() {
  const label = process.argv[2] || "forced-outcome"
  const raw = await readStdin()
  const input = safeJsonParse(raw)
  const workspace = pickWorkspace(input)
  const stdoutPayload = outputFor(label, input)
  const logDir = path.join(workspace, ".hook-forced-outcome-log")
  fs.mkdirSync(logDir, { recursive: true })

  const record = {
    timestamp: new Date().toISOString(),
    label,
    cwd: process.cwd(),
    workspace,
    env: {
      HOOK_EVENT: process.env.HOOK_EVENT || "",
      HOOK_SOURCE_TYPE: process.env.HOOK_SOURCE_TYPE || "",
      HOOK_SOURCE_ROOT: process.env.HOOK_SOURCE_ROOT || "",
      WORKSPACE_PATH: process.env.WORKSPACE_PATH || "",
      CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR || "",
      SESSION_ID: process.env.SESSION_ID || "",
      TOOL_NAME: process.env.TOOL_NAME || ""
    },
    input,
    stdoutPayload
  }

  fs.appendFileSync(path.join(logDir, "events.jsonl"), `${JSON.stringify(record)}\n`, "utf8")
  fs.writeFileSync(
    path.join(logDir, `${sanitizeName(label)}.last.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8"
  )

  process.stdout.write(JSON.stringify(stdoutPayload))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error)
  process.exit(1)
})
