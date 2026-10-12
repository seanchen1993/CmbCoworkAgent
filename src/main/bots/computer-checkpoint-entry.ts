import { resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { serializeBotFailure } from "./error-diagnostic"
import { BotDomainError } from "../../shared/bot-types"
import {
  botComputerCheckpointRequest,
  botComputerCheckpointSelection
} from "../../shared/bot-computer-checkpoint"
import {
  executeBotComputerCheckpoint,
  deleteBotComputerRecoveryCopy,
  computerCheckpointTerminalCodes
} from "./computer-checkpoint-service"
import { ComputerCheckpointOutput } from "./computer-checkpoint-output"
const command = z.union([
  botComputerCheckpointRequest,
  z
    .object({ action: z.literal("delete-recovery"), recovery: botComputerCheckpointSelection })
    .strict()
])
const controller = new AbortController(),
  output = new ComputerCheckpointOutput(process.stdout, (error) => controller.abort(error))
async function main() {
  const index = process.argv.indexOf("--data-dir")
  if (index === -1 || !process.argv[index + 1]) throw new Error("--data-dir is required")
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > 4096)
      throw new BotDomainError("computer_checkpoint_rejected", "电脑维护请求超过长度上限")
    chunks.push(bytes)
  }
  let raw: unknown
  try {
    raw = JSON.parse(Buffer.concat(chunks).toString())
  } catch {
    throw new BotDomainError("computer_checkpoint_rejected", "电脑维护请求格式无效，尚未执行")
  }
  const parsed = command.safeParse(raw)
  if (!parsed.success)
    throw new BotDomainError("computer_checkpoint_rejected", "电脑维护请求格式无效，尚未执行")
  const input = parsed.data,
    directory = resolve(process.argv[index + 1])
  const abort = () => controller.abort(new Error("电脑维护已中止"))
  process.once("SIGTERM", abort)
  process.once("SIGINT", abort)
  const options = {
    signal: controller.signal,
    token: randomUUID(),
    progress: (value: unknown) => {
      output.progress(value)
    }
  }
  const result =
    input.action === "delete-recovery"
      ? await deleteBotComputerRecoveryCopy(directory, input.recovery, options)
      : await executeBotComputerCheckpoint(directory, input, options)
  await output.result({ type: "result", ok: true, result })
}
void main()
  .catch(async (error: unknown) => {
    const code = error instanceof BotDomainError ? error.code : "computer_checkpoint_incomplete"
    process.exitCode = 1
    await output.result({
      type: "result",
      ok: false,
      error: {
        code,
        definitive: computerCheckpointTerminalCodes.has(code),
        message: serializeBotFailure(error).message.slice(0, 2000)
      }
    })
  })
  .catch(() => {
    process.exitCode = 1
  })
