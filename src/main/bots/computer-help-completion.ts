import { BotDomainError, type BotInteraction } from "../../shared/bot-types"
import {
  botComputerHelpReturn,
  readBotComputerHelp,
  type BotComputerHelpReturn
} from "../../shared/bot-computer-help"
import { canonicalJson } from "./validation"
import type { BotComputerClient } from "./computer-client"
import type { BotStore } from "./store"

type CompletionInput = {
  id: string
  revision: number
  answer: string
  computerHelpTarget?: unknown
}
type Proof = {
  fingerprint: string
  client: BotComputerClient
  expiresAt: number
  pending?: Promise<BotComputerHelpReturn>
  returned?: BotComputerHelpReturn
  timer?: ReturnType<typeof setTimeout>
  dispose(): void
}

/** Only actual successful backend handbacks mint proof. A cached proof collects
 * its database receipt; it never grants control, dispatches input or retries a grant. */
export class BotComputerHelpCompletion {
  private readonly proofs = new Map<string, Proof>()
  constructor(
    private readonly now: () => number,
    private readonly limit = 128
  ) {}
  private retire(id: string, proof: Proof): void {
    if (this.proofs.get(id) !== proof) return
    this.proofs.delete(id)
    proof.dispose()
  }
  async answer(
    input: CompletionInput,
    ports: {
      hostId: string
      dataEpoch: string
      client: BotComputerClient
      interaction(): BotInteraction
      validateRun(): void
      release(returning: BotComputerHelpReturn): Promise<BotComputerHelpReturn>
      commit(input: CompletionInput, returning: BotComputerHelpReturn): BotInteraction
    }
  ): Promise<BotInteraction> {
    const interaction = ports.interaction()
    const card = readBotComputerHelp(interaction.prompt)
    if (!card) throw new BotDomainError("invalid_input", "此请求不是电脑人工帮助")
    if (input.answer !== "done")
      throw new BotDomainError("invalid_input", "请归还对应电脑以继续任务")
    if (
      interaction.status === "answered" &&
      interaction.revision === input.revision + 1 &&
      interaction.answer === "done"
    )
      return interaction
    if (
      interaction.status !== "pending" ||
      interaction.revision !== input.revision ||
      interaction.expiresAt <= this.now()
    )
      throw new BotDomainError("stale_interaction", "此帮助请求已处理或过期")
    if (
      card.hostId !== ports.hostId ||
      card.dataEpoch !== ports.dataEpoch ||
      card.runId !== interaction.runId
    )
      throw new BotDomainError("stale_interaction", "后台或工作区已变化，请重新确认人工帮助")
    ports.validateRun()
    ports.client.throwIfAborted()
    const returning = botComputerHelpReturn.parse(input.computerHelpTarget)
    const target = returning.target
    if (
      returning.backend !== card.backend ||
      target.botId !== card.botId ||
      target.taskRunId !== card.taskRunId ||
      target.generation !== card.generation ||
      target.control !== "human" ||
      target.controlEpoch < card.controlEpoch
    )
      throw new BotDomainError("wrong_target", "请在此帮助请求对应的电脑中完成操作并归还")
    const fingerprint = canonicalJson({
      hostId: ports.hostId,
      dataEpoch: ports.dataEpoch,
      runId: card.runId,
      id: input.id,
      revision: input.revision,
      returning
    })
    for (const [id, proof] of this.proofs)
      if (proof.client.aborted || (!proof.pending && proof.expiresAt <= this.now()))
        this.retire(id, proof)
    let proof = this.proofs.get(input.id)
    if (proof && (proof.fingerprint !== fingerprint || proof.client !== ports.client))
      throw new BotDomainError("nonce_conflict", "此帮助请求正在由另一控制权归还处理")
    if (!proof) {
      if (this.proofs.size >= this.limit)
        throw new BotDomainError("computer_busy", "人工帮助正在提交，请稍后重试")
      proof = {
        fingerprint,
        client: ports.client,
        expiresAt: Math.min(interaction.expiresAt, this.now() + 60_000),
        dispose: () => {}
      }
      this.proofs.set(input.id, proof)
      const owned = proof
      const onClose = () => this.retire(input.id, owned)
      proof.dispose = () => {
        clearTimeout(owned.timer)
        ports.client.removeEventListener("abort", onClose)
      }
      ports.client.addEventListener("abort", onClose, { once: true })
      // Install the in-flight receipt before calling the backend. Concurrent
      // duplicate RPCs join this same operation; no stale human target is replayed.
      proof.pending = Promise.resolve()
        .then(() => ports.release(returning))
        .then((result) => {
          if (
            result.backend !== returning.backend ||
            result.target.botId !== target.botId ||
            result.target.taskRunId !== target.taskRunId ||
            result.target.generation !== target.generation ||
            result.target.control !== "bot" ||
            result.target.viewId !== target.viewId ||
            result.target.controlEpoch !== target.controlEpoch + 1
          )
            throw new BotDomainError("wrong_target", "电脑归还结果与请求不一致，不能确认完成")
          owned.returned = result
          owned.pending = undefined
          if (this.proofs.get(input.id) === owned) {
            owned.timer = setTimeout(
              () => this.retire(input.id, owned),
              Math.max(0, owned.expiresAt - this.now())
            )
            owned.timer.unref()
          }
          return result
        })
        .catch((error: unknown) => {
          this.retire(input.id, owned)
          throw error
        })
    }
    const returned = proof.returned ?? (await proof.pending!)
    ports.validateRun()
    // Collection of a known successful handback continues if the connection
    // closes now. No client operation or new grant is issued during settlement.
    const result = ports.commit(input, returned)
    this.retire(input.id, proof)
    return result
  }
}
const coordinators = new WeakMap<BotStore, BotComputerHelpCompletion>()
export function botComputerHelpCompletion(store: BotStore): BotComputerHelpCompletion {
  let service = coordinators.get(store)
  if (!service) {
    service = new BotComputerHelpCompletion(() => store.now())
    coordinators.set(store, service)
  }
  return service
}
