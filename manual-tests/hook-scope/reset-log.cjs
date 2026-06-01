const fs = require("fs")
const path = require("path")

const workspace = process.env.WORKSPACE_PATH || process.env.CLAUDE_PROJECT_DIR || process.cwd()
const logDir = path.join(workspace, ".hook-scope-log")

fs.rmSync(logDir, { recursive: true, force: true })

console.log(`Removed ${logDir}`)
