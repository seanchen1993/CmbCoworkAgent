import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { installLangchainNativeFoundationBatch } from "./langchain-native-foundation-batch.mjs"

export async function installLangchainNativeFoundations(options = {}) {
  return installLangchainNativeFoundationBatch(options)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await installLangchainNativeFoundations({
    checkOnly: process.argv.includes("--check")
  })
  process.stdout.write(`langchain native foundations: ${result.status} ${result.targets}\n`)
}
