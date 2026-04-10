import type { CodeExecHelperRequest, CodeExecHelperResult } from "./types"
import { runCodeExecScript } from "./script-runtime"

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  return Buffer.concat(chunks).toString("utf-8")
}

async function main(): Promise<void> {
  let result: CodeExecHelperResult

  try {
    const raw = await readStdin()
    const request = JSON.parse(raw) as CodeExecHelperRequest
    result = await runCodeExecScript(request)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    result = {
      ok: false,
      output: JSON.stringify({ stage: "bootstrap", error: message, logs: [] }, null, 2),
      logs: [],
      stage: "bootstrap",
      error: message
    }
  }

  process.stdout.write(JSON.stringify(result))
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(message)
  process.exitCode = 1
})
