import { resolve } from "node:path"
import { executeBotBrowserMaintenance } from "./browser-maintenance"

async function main(): Promise<void> {
  const index = process.argv.indexOf("--data-dir")
  if (index === -1 || !process.argv[index + 1]) throw new Error("--data-dir is required")
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > 4096) throw new Error("浏览器维护请求过大")
    chunks.push(bytes)
  }
  const result = await executeBotBrowserMaintenance(
    resolve(process.argv[index + 1]),
    JSON.parse(Buffer.concat(chunks).toString())
  )
  process.stdout.write(JSON.stringify({ ok: true, result }))
}
void main().catch((error) => {
  process.stdout.write(
    JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "浏览器维护失败" })
  )
  process.exitCode = 1
})
