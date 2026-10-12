import { z } from "zod"
import { botErrorDiagnosticIdSchema } from "../../shared/bot-error-diagnostic"
import {
  botComputerMaintenanceProgress,
  BOT_COMPUTER_MAINTENANCE_FRAME_BYTES
} from "../../shared/bot-computer-maintenance-progress"

const result = z.discriminatedUnion("ok", [
  z.object({ type: z.literal("result"), ok: z.literal(true), result: z.unknown() }).strict(),
  z
    .object({
      type: z.literal("result"),
      ok: z.literal(false),
      error: z
        .object({
          code: botErrorDiagnosticIdSchema,
          definitive: z.boolean(),
          message: z.string().min(1).max(2000)
        })
        .strict()
    })
    .strict()
])
export const computerMaintenanceFrame = z.union([
  z.object({ type: z.literal("owner"), pid: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("progress"), value: botComputerMaintenanceProgress }).strict(),
  result
])
export type ComputerMaintenanceResultFrame = z.infer<typeof result>

/** Per-frame cap rather than a total-output cap: a 20 GiB operation can emit
 * many small progress frames without retaining their complete output history. */
export class ComputerMaintenanceFrames {
  private pending = Buffer.alloc(0)
  private ended = false
  private result?: ComputerMaintenanceResultFrame
  private started = false
  constructor(
    private readonly progress: (value: z.infer<typeof botComputerMaintenanceProgress>) => void,
    private readonly owner?: (pid: number) => void
  ) {}
  push(bytes: Buffer): void {
    let offset = 0
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset)
      const end = newline === -1 ? bytes.length : newline
      const part = bytes.subarray(offset, end)
      if (this.pending.length + part.length > BOT_COMPUTER_MAINTENANCE_FRAME_BYTES)
        throw new Error("电脑维护响应超过长度上限")
      this.pending = Buffer.concat([this.pending, part])
      if (newline === -1) return
      const line = this.pending.toString("utf8")
      this.pending = Buffer.alloc(0)
      if (line.trim()) {
        if (this.ended) throw new Error("电脑维护返回了重复或迟到的结果")
        const frame = computerMaintenanceFrame.parse(JSON.parse(line))
        if (frame.type === "owner") {
          if (this.started || !this.owner) throw new Error("电脑维护返回了重复或无效的进程归属")
          this.owner(frame.pid)
        } else if (frame.type === "progress") this.progress(frame.value)
        else {
          this.ended = true
          this.result = frame
        }
        this.started = true
      }
      offset = newline + 1
    }
  }
  finish(): ComputerMaintenanceResultFrame {
    if (this.pending.length || !this.result) throw new Error("电脑维护意外退出，操作未确认完成")
    return this.result
  }
}
