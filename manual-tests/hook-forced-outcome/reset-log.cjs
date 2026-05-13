const fs = require("fs")
const path = require("path")

const workspace =
  process.argv[2] ||
  process.env.WORKSPACE_PATH ||
  process.env.CLAUDE_PROJECT_DIR ||
  "C:/360Downloads"
const logDir = path.join(workspace, ".hook-forced-outcome-log")

fs.rmSync(logDir, { recursive: true, force: true })
console.log(`Removed ${logDir}`)
