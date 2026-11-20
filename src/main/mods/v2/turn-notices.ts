import { randomUUID } from "node:crypto"
import type { FunctionTurnNotice } from "../../../shared/mods/v2/turn"
import { MODS_MAX_BYTES } from "../../../shared/mods/validation"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"

/** Session-local presentation, separate from model messages and durable execution facts. */
export class FunctionTurnNotices {
  private readonly entries: FunctionTurnNotice[] = []
  private bytes = 2

  append(turnId: string, answer: string, text: string): boolean {
    if (!text.trim() || text === answer) return false
    const entry = { id: randomUUID(), turnId, text }
    const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1
    if (bytes + 2 > MODS_MAX_BYTES) throw new ModFunctionError("MODS_JSON_SIZE")
    this.entries.push(entry)
    this.bytes += bytes
    while (this.entries.length > 64 || this.bytes > MODS_MAX_BYTES)
      this.bytes -= Buffer.byteLength(JSON.stringify(this.entries.shift()!)) + 1
    return true
  }

  snapshot(): FunctionTurnNotice[] {
    return this.entries.map((entry) => ({ ...entry }))
  }
}
