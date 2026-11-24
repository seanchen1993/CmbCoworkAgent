import { randomUUID } from "node:crypto"
import { ToolMessage } from "@langchain/core/messages"
import { botToolControlReceipt } from "../../shared/bots/turn-feedback"

export function botToolControlMessage(reason: Parameters<typeof botToolControlReceipt>[0], call: { id?: string; name: string }) {
  return new ToolMessage({
    id: `bot-control-${randomUUID()}`, name: call.name, tool_call_id: call.id!, status: "error",
    content: botToolControlReceipt(reason, call)
  })
}

/** Per Bot tool set and runtime. Only the producer of a confirmed result can settle earlier attempts. */
export class BotToolRetries {
  private readonly pending = new Map<string, { id: string; failed: number; settled: number }>()

  begin(tool: string, args: unknown, callId: string) {
    // Most calls never need an identity. Compute it only on failure or when a retry is possible.
    let key: string | undefined
    const operationKey = () => key ??= JSON.stringify([tool, args], (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map(field => [field, value[field]]))
        : value)
    const earlier = this.pending.size ? this.pending.get(operationKey()) : undefined
    const through = earlier?.failed ?? 0
    return {
      failed: () => {
        const operation = this.pending.get(operationKey()) ?? { id: randomUUID(), failed: 0, settled: 0 }
        this.pending.set(operationKey(), operation)
        return `bot-attempt-${operation.id}-${++operation.failed}`
      },
      isRetry: Boolean(earlier),
      confirmed: (receipt: unknown) => {
        // Concurrent calls may finish out of order. A success covers only failures already
        // observed when this particular retry started.
        const content = JSON.stringify(receipt)
        if (!earlier || through <= earlier.settled) return content
        earlier.settled = through
        if (through === earlier.failed) this.pending.delete(operationKey())
        return new ToolMessage({
          id: `bot-recovery-${earlier.id}-${through}`, name: tool, tool_call_id: callId, status: "success", content
        })
      }
    }
  }
}
