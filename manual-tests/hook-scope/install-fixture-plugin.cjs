const fs = require("fs")
const os = require("os")
const path = require("path")

const sourceDir = path.join(__dirname, "plugin-hook-scope-demo")
const manifestPath = path.join(sourceDir, "plugin.json")
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))

const openworkDir = path.join(os.homedir(), ".cmbcoworkagent")
const pluginsDir = path.join(openworkDir, "plugins")
const pluginsFile = path.join(openworkDir, "plugins.json")
const destDir = path.join(pluginsDir, "Hook-Scope-Demo")

function readPlugins() {
  if (!fs.existsSync(pluginsFile)) return []
  try {
    const parsed = JSON.parse(fs.readFileSync(pluginsFile, "utf8"))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function formatAuthor(author) {
  if (!author) return ""
  if (typeof author === "string") return author
  return author.name || ""
}

fs.mkdirSync(pluginsDir, { recursive: true })
fs.rmSync(destDir, { recursive: true, force: true })
fs.cpSync(sourceDir, destDir, { recursive: true })
fs.copyFileSync(path.join(__dirname, "hook-recorder.cjs"), path.join(destDir, "hook-recorder.cjs"))

const plugins = readPlugins()
const author = formatAuthor(manifest.author)
const existingIndex = plugins.findIndex(
  (plugin) => plugin && plugin.name === manifest.name && plugin.author === author,
)
const existing = existingIndex >= 0 ? plugins[existingIndex] : null
const now = new Date().toISOString()

const metadata = {
  id: existing?.id || "hook-scope-demo-manual",
  name: manifest.name,
  version: manifest.version || "1.0.0",
  description: manifest.description || "",
  author,
  path: destDir,
  enabled: true,
  skillCount: 1,
  mcpServerCount: 1,
  hookCount: 4,
  hookPath: manifest.hooks || "hooks/hooks.json",
  createdAt: existing?.createdAt || now,
  updatedAt: now,
}

if (existingIndex >= 0) {
  plugins[existingIndex] = metadata
} else {
  plugins.push(metadata)
}

fs.mkdirSync(openworkDir, { recursive: true })
fs.writeFileSync(pluginsFile, `${JSON.stringify(plugins, null, 2)}\n`, "utf8")

console.log(`Installed ${metadata.name}`)
console.log(`Plugin id: ${metadata.id}`)
console.log(`Plugin dir: ${destDir}`)
console.log(`MCP tool id should be: mcp__scopeDemoMcp__scope_echo`)
