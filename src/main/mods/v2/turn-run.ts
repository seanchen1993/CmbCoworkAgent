import { assertLocalThreadRunLease, type LocalThreadRunOwner } from "../../agent/thread-run-lease"
import { childTurnStreamOwner, isMainTurnMessageStream } from "../../agent/main-turn-stream"
import { streamPayloadContentMode } from "../../ipc/stream-transcript-payload"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { getModsManager, type ModsManager } from "../manager"
import type { FunctionTurnBinding } from "./turn-lifecycle"

/** A transport owns its lease/controller; this bridge observes that exact physical run. */
export class FunctionTurnRun {
  private manager?: ModsManager
  private ended = false
  private readonly binding: FunctionTurnBinding

  constructor(input: Omit<FunctionTurnBinding, "assertCurrent"> & { owner: LocalThreadRunOwner }) {
    const { threadId, owner, runId, signal } = input
    this.binding = {
      ...input,
      assertCurrent: () => {
        signal.throwIfAborted()
        assertLocalThreadRunLease(threadId, owner, runId)
      }
    }
  }

  async start(): Promise<void> {
    if (this.ended) throw new ModFunctionError("MODS_TURN_ENDING")
    this.manager ??= getModsManager()
    await this.manager?.startFunctionTurn(this.binding)
  }

  observeStream(mode: string, payload: unknown): void {
    if (this.ended || !this.manager) return
    const child = childTurnStreamOwner(mode, payload)
    if (child)
      this.manager.functionTurns.observeChildStream(
        this.binding.threadId,
        this.binding.runId,
        child,
        payload,
        streamPayloadContentMode(payload)
      )
    if (!isMainTurnMessageStream(mode, payload, this.binding.threadId)) return
    this.manager.functionTurns.observeStream(
      this.binding.threadId,
      this.binding.runId,
      payload,
      streamPayloadContentMode(payload)
    )
  }

  /** Observation cleanup must never keep the transport's physical lease held. */
  finish(reason: "answer" | "error"): void {
    if (this.ended) return
    this.ended = true
    for (const settle of [
      () =>
        this.manager?.functionTurns.finish(this.binding.threadId, this.binding.runId, { reason }),
      () => this.manager?.releaseExpiredRuntimeBindings(this.binding.threadId)
    ]) {
      try {
        settle()
      } catch (error) {
        console.warn("[Mods] Background turn settlement failed:", error)
      }
    }
  }
}
