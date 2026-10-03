import { pathToFileURL } from "node:url"
import { hostState, vmStart, vmStop, daemon } from "./host.mjs"

export async function main(argv) {
  const [command, ...args] = argv
  if (args.length) throw new Error("B00_ARGUMENTS")
  const state = await hostState({ create: command === "vm-start" })
  if (command === "vm-start") return vmStart(state)
  if (command === "vm-stop") return vmStop(state)
  if (command === "vm-status") return daemon(state)
  throw new Error("B00_COMMAND")
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)))) }
  catch (error) {
    console.error(JSON.stringify({ status: "failed", reason: /^B00_[A-Z_]+$/.test(error.message) ? error.message : error.failureCode || "compatibility_or_io", ...(Number.isInteger(error.exitCode) ? { exitCode: error.exitCode } : {}) }))
    process.exitCode = 1
  }
}
