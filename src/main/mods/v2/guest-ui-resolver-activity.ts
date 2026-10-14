import { randomUUID } from "node:crypto"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import {
  FunctionUiConstructorActivity,
  type FunctionUiConstructorExecution,
  type FunctionUiConstructorProof,
  type FunctionUiConstructorReaction,
  type FunctionUiConstructorScope
} from "./ui-constructor-activity"

interface Root {
  token: string
  ledger: FunctionUiConstructorActivity
  scope: FunctionUiConstructorScope
  finished: boolean
}
interface Reaction {
  root: Root
  activity: FunctionUiConstructorReaction
  ran: boolean
  settled: boolean
}

/** Load-time resolver continuation proof. It is never a Q drawing or a constructor SDK actor. */
export class FunctionUiResolverActivity {
  private readonly roots = new Map<string, Root>()
  private readonly reactions = new Map<string, Reaction>()
  private current?: { root: Root; execution: FunctionUiConstructorExecution }

  constructor(private readonly queueSettlement: (settle: () => void) => void) {}

  begin(
    token: string,
    ledger: FunctionUiConstructorActivity,
    proof: FunctionUiConstructorProof
  ): void {
    if (this.roots.has(token)) throw new ModFunctionError("MODS_UI_RESOLVE_FRAME")
    const root: Root = { token, ledger, scope: ledger.begin(proof), finished: false }
    this.roots.set(token, root)
    void ledger.whenDrained(root.scope).then(
      () => this.roots.delete(token),
      () => undefined
    )
  }

  hasRoot(token: string): boolean {
    return this.roots.has(token)
  }
  hasReaction(id: string): boolean {
    return this.reactions.has(id)
  }
  get stats() {
    return Object.freeze({ roots: this.roots.size, reactions: this.reactions.size })
  }

  private root(token: string): Root {
    const root = this.roots.get(token)
    if (!root) throw new ModFunctionError("MODS_UI_RESOLVE_FRAME")
    root.ledger.assertCurrent(root.scope)
    return root
  }

  private parent(root: Root): FunctionUiConstructorExecution | undefined {
    return this.current?.root === root ? this.current.execution : undefined
  }

  call(token: string) {
    const root = this.root(token)
    const branch = root.ledger.admitBranch(root.scope, this.parent(root))
    let host: ReturnType<FunctionUiConstructorActivity["holdHost"]> | undefined
    let reply: ReturnType<FunctionUiConstructorActivity["holdReplyJob"]> | undefined
    try {
      host = root.ledger.holdHost(branch)
      reply = root.ledger.holdReplyJob(branch)
    } catch (error) {
      if (host) root.ledger.finishWork(host)
      root.ledger.settleBranch(branch)
      root.ledger.revoke(root.scope, error)
      throw error
    }
    if (!host || !reply) throw new ModFunctionError("MODS_UI_RESOLVE_FRAME")
    const actualHost = host,
      actualReply = reply
    let replied = false
    return {
      hostFinally: () => root.ledger.finishWork(actualHost),
      reply: (run: () => void) => {
        try {
          root.ledger.runReplyJob(actualReply, () => run())
        } finally {
          this.queueSettlement(() => {
            if (replied) return
            replied = true
            root.ledger.finishWork(actualReply)
            root.ledger.settleBranch(branch)
          })
        }
      },
      discard: () => {
        if (replied) return
        replied = true
        root.ledger.finishWork(actualReply)
        root.ledger.settleBranch(branch)
      }
    }
  }

  reserveReaction(token: string): string {
    const root = this.root(token)
    const parent = this.parent(root)
    const branch = root.ledger.admitBranch(root.scope, parent)
    let activity: FunctionUiConstructorReaction
    try {
      activity = root.ledger.registerReaction(branch, parent)
    } catch (error) {
      root.ledger.settleBranch(branch)
      root.ledger.revoke(root.scope, error)
      throw error
    }
    root.ledger.settleBranch(branch)
    const id = randomUUID()
    this.reactions.set(id, { root, activity, ran: false, settled: false })
    return id
  }

  runReaction<T>(id: string, run: (frameToken: string) => T): T {
    const reaction = this.reactions.get(id)
    if (!reaction || reaction.ran || reaction.settled)
      throw new ModFunctionError("MODS_UI_RESOLVE_REACTION")
    reaction.ran = true
    return reaction.root.ledger.runReaction(reaction.activity, (execution) => {
      const previous = this.current
      this.current = { root: reaction.root, execution }
      try {
        return run(reaction.root.token)
      } finally {
        this.current = previous
      }
    })
  }

  settleReaction(id: string): void {
    const reaction = this.reactions.get(id)
    if (!reaction || reaction.settled) return
    this.queueSettlement(() => {
      if (reaction.settled) return
      reaction.settled = true
      reaction.root.ledger.settleReaction(reaction.activity)
      this.reactions.delete(id)
    })
  }

  drain(token: string): Promise<void> {
    const root = this.root(token)
    if (!root.finished) {
      root.finished = true
      root.ledger.finishCall(root.scope)
    }
    return root.ledger.whenDrained(root.scope)
  }

  cancel(token: string, reason: unknown): void {
    const root = this.roots.get(token)
    if (!root) return
    root.ledger.revoke(root.scope, reason)
    if (!root.finished) {
      root.finished = true
      root.ledger.finishCall(root.scope)
    }
  }

  /** Real VM disposal, not timeout, proves that guest jobs can no longer execute. */
  dispose(): void {
    for (const root of this.roots.values())
      this.cancel(root.token, new ModFunctionError("MODS_UNLOADED"))
    for (const [id, reaction] of this.reactions) {
      if (!reaction.settled) reaction.root.ledger.settleReaction(reaction.activity)
      this.reactions.delete(id)
    }
  }
}
