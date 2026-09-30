import fs from "node:fs"
import path from "node:path"

const srcRoot = process.argv[2]
const outRoot = process.argv[3] ?? path.resolve("design-systems")

if (!srcRoot) {
  console.error("Usage: node scripts/import-awesome-design-md.mjs <awesome-design-md/design-md> [outRoot]")
  process.exit(1)
}

const categories = {
  "AI & LLM Platforms": [
    "claude", "cohere", "elevenlabs", "minimax", "mistral.ai", "ollama", "opencode.ai",
    "replicate", "runwayml", "together.ai", "x.ai",
  ],
  "Developer Tools & IDEs": [
    "cursor", "expo", "lovable", "raycast", "superhuman", "vercel", "warp",
  ],
  "Backend, Database & DevOps": [
    "clickhouse", "composio", "hashicorp", "mongodb", "posthog", "sanity", "sentry", "supabase",
  ],
  "Productivity & SaaS": [
    "cal", "intercom", "linear.app", "mintlify", "notion", "resend", "zapier",
  ],
  "Design & Creative Tools": [
    "airtable", "clay", "figma", "framer", "miro", "webflow",
  ],
  "Fintech & Crypto": [
    "binance", "coinbase", "kraken", "mastercard", "revolut", "stripe", "wise",
  ],
  "E-commerce & Retail": [
    "airbnb", "meta", "nike", "shopify", "starbucks",
  ],
  "Media & Consumer Tech": [
    "apple", "hp", "ibm", "nvidia", "pinterest", "playstation", "spacex", "spotify",
    "theverge", "uber", "vodafone", "wired",
  ],
  "Automotive": [
    "bmw", "bmw-m", "bugatti", "ferrari", "lamborghini", "renault", "tesla",
  ],
}

const categoryById = new Map()
for (const [category, ids] of Object.entries(categories)) {
  for (const id of ids) categoryById.set(id, category)
}

function titleCase(value) {
  return value
    .replace(/\.app$|\.ai$/g, "")
    .replace(/[-.]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .replace(/\bAi\b/g, "AI")
    .replace(/\bBmw\b/g, "BMW")
}

function frontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  return match?.[1] ?? ""
}

function scalar(fm, key) {
  const match = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))
  if (!match) return null
  return match[1].trim().replace(/^['"]|['"]$/g, "")
}

const entries = fs.readdirSync(srcRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((entry) => categoryById.has(entry))
  .sort()

for (const sourceId of entries) {
  const designPath = path.join(srcRoot, sourceId, "DESIGN.md")
  if (!fs.existsSync(designPath)) continue
  const content = fs.readFileSync(designPath, "utf-8")
  const fm = frontmatter(content)
  const nameRaw = scalar(fm, "name") || titleCase(sourceId)
  const name = nameRaw
    .replace(/-Inspired-design-analysis$/i, "")
    .replace(/-design-analysis$/i, "")
    .replace(/ Inspired$/i, "")
    .replace(/\.app$/i, "")
  const outId = `brand-${sourceId.replace(/[^a-zA-Z0-9_-]/g, "-")}`
  const outDir = path.join(outRoot, outId)
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, "DESIGN.md"), content, "utf-8")
  fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify({
    name,
    description: scalar(fm, "description") || `${name} inspired brand design system imported from awesome-design-md.`,
    category: categoryById.get(sourceId) || "Brand",
    source: "awesome-design-md",
    origin: `https://github.com/VoltAgent/awesome-design-md/tree/main/design-md/${sourceId}`,
    license: "MIT",
  }, null, 2), "utf-8")
}

console.log(`Imported ${entries.length} design systems into ${outRoot}`)
