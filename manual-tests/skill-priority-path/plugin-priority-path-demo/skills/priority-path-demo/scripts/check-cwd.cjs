const fs = require("fs")
const path = require("path")

const outputPath = process.argv[2] ? path.resolve(process.argv[2]) : ""
let template = ""
let relativeReadOk = false

try {
  template = fs.readFileSync(path.join(process.cwd(), "templates", "message.txt"), "utf8").trim()
  relativeReadOk = template === "plugin template loaded"
} catch (error) {
  template = `read failed: ${error instanceof Error ? error.message : String(error)}`
}

const payload = {
  source: "plugin-skill",
  cwd: process.cwd(),
  cwdBasename: path.basename(process.cwd()),
  scriptDir: __dirname,
  relativeReadOk,
  template,
  outputPath: outputPath || null
}

if (outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2))
}

console.log(JSON.stringify(payload, null, 2))
