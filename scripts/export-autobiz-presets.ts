import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { AUTOBIZ_PRESETS, createAutobizPreset } from "../src/shared/mods/flows/autobiz-presets"
import { parseFlowDefinition } from "../src/shared/mods/flows/schema"

const destination = resolve(process.argv[2])
mkdirSync(destination, { recursive: true })
for (const preset of AUTOBIZ_PRESETS) {
  const definition = parseFlowDefinition(createAutobizPreset(preset.id, `autobiz-${preset.id}`))
  writeFileSync(
    join(destination, `${preset.id}.json`),
    JSON.stringify(definition, null, 2) + "\n",
    { flag: "wx" }
  )
}
