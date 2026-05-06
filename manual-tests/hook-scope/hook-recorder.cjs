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
      raw,
    }
  }
}

function sanitizeName(value) {
  return String(value || "hook")
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .replace(/-+/g, "-")
}

function pickWorkspace(input) {
  const fixtureWorkspace = "C:/ai/CmbCoworkAgent"
  return (
    input.workspace_path ||
    process.env.WORKSPACE_PATH ||
    process.env.CLAUDE_PROJECT_DIR ||
    (fs.existsSync(fixtureWorkspace) ? fixtureWorkspace : "") ||
    input.cwd ||
    process.cwd()
  )
}

async function main() {
  const label = process.argv[2] || "hook"
  const raw = await readStdin()
  const input = safeJsonParse(raw)
  const workspace = pickWorkspace(input)
  const logDir = path.join(workspace, ".hook-scope-log")
  fs.mkdirSync(logDir, { recursive: true })

  const record = {
    timestamp: new Date().toISOString(),
    label,
    hook_event_name: input.hook_event_name || input.event || "",
    tool_name: input.tool_name || input.tool || "",
    skill_name: input.skill_name || input.skill || "",
    skill_path: input.skill_path || "",
    plugin_id: input.plugin_id || "",
    plugin_name: input.plugin_name || "",
    cwd: workspace,
    input,
  }

  fs.appendFileSync(
    path.join(logDir, "events.jsonl"),
    `${JSON.stringify(record)}\n`,
    "utf8",
  )
  fs.writeFileSync(
    path.join(logDir, `${sanitizeName(label)}.last.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  )

  const target =
    record.tool_name ||
    record.skill_name ||
    record.plugin_name ||
    record.hook_event_name ||
    "unknown"

  process.stdout.write(
    JSON.stringify({
      systemMessage: `HOOK_SCOPE_TEST ${label} fired`,
      additionalContext: `HOOK_SCOPE_TEST ${label} fired for ${target}. This text comes from hook-recorder.cjs and is not part of any SKILL.md content.`,
    }),
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error)
  process.exit(1)
})
