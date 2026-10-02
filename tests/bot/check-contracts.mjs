import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"

// Children use the same runtime, not whatever `node` happens to be on PATH.
if (Number(process.versions.node.split(".")[0]) !== 22)
  throw new Error("Frozen Bot contract check requires Node 22")
const root = fileURLToPath(new URL("../../", import.meta.url))
const specs = readdirSync(new URL("./", import.meta.url))
  .filter((name) => name.endsWith(".spec.mjs"))
  .sort()
  .map((name) => `tests/bot/${name}`)
for (const args of [
  ["scripts/generate-bot-contract-types.mjs", "--check"],
  ["--test", ...specs],
  [
    "node_modules/typescript/bin/tsc",
    "--noEmit",
    "--strict",
    "--skipLibCheck",
    "--target",
    "ES2022",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "tests/bot/types-consumption.ts"
  ]
]) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
console.log(
  "Bot v1: schema, offline refs, fixtures, generator drift, reference scenarios and generated-type consumption passed"
)
