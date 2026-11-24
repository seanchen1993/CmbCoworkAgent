import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { parse } from "dotenv"

/** Opt-in, read-only access to one existing custom model. Never log the returned config. */
export async function selectedBotRoutingModel() {
  const profile = process.env.BOT_ROUTING_MODEL_PROFILE
  const id = process.env.BOT_ROUTING_MODEL_ID
  assert.ok(profile && id, "Select an existing custom model/profile explicitly")
  const configs = JSON.parse(await readFile(join(profile, "custom-models.json"), "utf8"))
  const config = configs.find((m: { id: string }) => m.id === id)
  assert.ok(config, "Selected model is not configured")
  const env = parse(await readFile(join(profile, ".env")))
  const apiKey =
    env["CUSTOM_API_KEY__" + createHash("sha256").update(id).digest("hex").slice(0, 12)]
  assert.ok(apiKey, "Selected model credential is unavailable")
  return { ...config, apiKey }
}
