import { randomUUID } from "node:crypto"
import type { QuickJSHandle } from "quickjs-emscripten"
import type { ModJson } from "../../../shared/mods/types"
import { ModFunctionError, type FunctionHostReply } from "../../../shared/mods/v2/contracts"
import {
  FunctionUiConstructorActivity,
  type FunctionUiConstructorBranch,
  type FunctionUiConstructorExecution,
  type FunctionUiConstructorReaction,
  type FunctionUiConstructorScope
} from "./ui-constructor-activity"
import type {
  FunctionUiResolveCall,
  FunctionUiResolveConstructorScope,
  FunctionUiResolveDefinition,
  FunctionUiResolveDriver,
  FunctionUiResolveHostReceipt,
  FunctionUiResolvePeer,
  FunctionUiResolvePropsProof,
  FunctionUiResolveReceipt,
  FunctionUiResolveSyncBudget,
  FunctionUiResolveTarget
} from "./ui-resolve-private-types"

export interface FunctionUiConstructorGuest {
  runUiConstructorSync<T>(
    token: string,
    budget: FunctionUiResolveSyncBudget,
    phase: "constructor" | "data" | "reconnect",
    run: () => T
  ): T
  runUiConstructorReaction<T>(token: string, run: () => T): T
  captureUiConstructorActions(props: QuickJSHandle): object
  releaseUiConstructorActions(proof: object): void
  reconnectUiConstructorActions(
    call: FunctionUiResolveCall,
    props: FunctionUiResolvePropsProof,
    output: QuickJSHandle
  ): QuickJSHandle
  queueUiConstructorSettlement(settle: () => void): void
}

/** Bound by the utility's actual assembly host, never by guest metadata or a plugin name. */
export interface FunctionUiConstructorHost {
  captureCurrent(
    target: FunctionUiResolveTarget,
    resident: FunctionUiResolvePeer
  ): FunctionUiResolveHostReceipt
  assertCurrent(definition: FunctionUiResolveDefinition, receipt: FunctionUiResolveReceipt): void
  retain(
    definition: FunctionUiResolveDefinition,
    receipt: FunctionUiResolveReceipt,
    rootIdentity: object
  ): () => void
  /** Synchronous first SDK admission: send main's open receipt before any result can leave VM. */
  admit(
    definition: FunctionUiResolveDefinition,
    receipt: FunctionUiResolveReceipt,
    rootIdentity: object
  ): void
  call(
    definition: FunctionUiResolveDefinition,
    receipt: FunctionUiResolveReceipt,
    rootIdentity: object,
    method: string,
    args: ModJson,
    signal: AbortSignal
  ): Promise<FunctionHostReply>
  drained?(
    definition: FunctionUiResolveDefinition,
    receipt: FunctionUiResolveReceipt,
    rootIdentity: object,
    completion: Promise<void>
  ): void
  /** Closed owner, returned root and only unentered reactions; not a drain or release. */
  quiescent?(
    definition: FunctionUiResolveDefinition,
    receipt: FunctionUiResolveReceipt,
    rootIdentity: object
  ): void
}

interface Root {
  definition: FunctionUiResolveDefinition
  identity: object
  receipt: FunctionUiResolveReceipt
  activity: FunctionUiConstructorScope
  finished: boolean
  admitted: boolean
  failure?: unknown
  actions: Array<() => void>
  peers: Set<FunctionUiResolvePeer>
}
interface Execution {
  id: string
  root: Root
  call: FunctionUiResolveCall
  peer: FunctionUiResolvePeer
  phase: "constructor" | "data" | "reconnect"
  parent?: FunctionUiConstructorExecution
  active: boolean
}
interface Reaction {
  id: string
  root: Root
  call: FunctionUiResolveCall
  peer: FunctionUiResolvePeer
  branch: FunctionUiConstructorBranch
  activity: FunctionUiConstructorReaction
  ran: boolean
  settled: boolean
}

/** Utility-local host driver. Main must allocate its immutable global quota before binding it. */
export class FunctionUiConstructorBridge implements FunctionUiResolveDriver {
  private readonly guests = new WeakMap<FunctionUiResolvePeer, FunctionUiConstructorGuest>()
  private readonly executions = new Map<string, Execution>()
  private readonly reactions = new Map<string, Reaction>()
  private readonly roots = new Set<Root>()
  private current?: Execution
  private closed = false

  constructor(
    private readonly host: FunctionUiConstructorHost,
    readonly activity = new FunctionUiConstructorActivity()
  ) {}

  bindGuest(peer: FunctionUiResolvePeer, guest: FunctionUiConstructorGuest): void {
    if (this.closed || this.guests.has(peer)) throw this.error()
    peer.assertCurrent()
    this.guests.set(peer, guest)
  }

  private error(): ModFunctionError {
    return new ModFunctionError("MODS_UI_CONSTRUCTOR_SCOPE")
  }

  private guest(peer: FunctionUiResolvePeer): FunctionUiConstructorGuest {
    const guest = this.guests.get(peer)
    if (!guest || this.closed) throw this.error()
    peer.assertCurrent()
    return guest
  }

  private guard(root: Root, definition = root.definition): void {
    if (root.failure !== undefined) throw root.failure
    try {
      if (this.closed) throw this.error()
      this.activity.assertCurrent(root.activity)
      definition.assertCurrent()
      root.receipt.assertCurrent()
      root.receipt.signal.throwIfAborted()
      this.host.assertCurrent(definition, root.receipt)
    } catch (error) {
      root.failure ??= error
      this.activity.revoke(root.activity, error)
      throw error
    }
  }

  captureCurrent(target: FunctionUiResolveTarget, resident: FunctionUiResolvePeer) {
    // A queued continuation has the original Q, even if a newer drawing is now ambient.
    const current = this.current
    if (current) {
      this.guard(current.root, current.call.definition)
      if (current.call.target !== target) throw this.error()
      return current.root.receipt
    }
    return this.host.captureCurrent(target, resident)
  }

  createConstructorScope(
    definition: FunctionUiResolveDefinition,
    receipt: FunctionUiResolveReceipt
  ): FunctionUiResolveConstructorScope {
    if (this.closed) throw this.error()
    const identity = Object.freeze({})
    const root: Root = {
      definition,
      identity,
      receipt,
      finished: false,
      admitted: false,
      actions: [],
      peers: new Set([definition.peer, receipt.consumer]),
      activity: this.activity.begin({
        actor: definition,
        receipt,
        signal: receipt.signal,
        assertCurrent: () => {
          definition.assertCurrent()
          receipt.assertCurrent()
          this.host.assertCurrent(definition, receipt)
        },
        retain: () => this.host.retain(definition, receipt, identity),
        quiescent: () => {
          if (root.finished && root.admitted && receipt.signal.aborted)
            this.host.quiescent?.(definition, receipt, identity)
        }
      })
    }
    this.roots.add(root)
    const completion = this.activity.whenDrained(root.activity)
    void completion.then(
      () => this.roots.delete(root),
      () => undefined
    )
    try {
      this.host.drained?.(definition, receipt, identity, completion)
    } catch (error) {
      root.failure = error
      this.activity.revoke(root.activity, error)
      try {
        for (const release of root.actions.splice(0)) release()
      } finally {
        this.activity.finishCall(root.activity)
      }
      throw error
    }
    const finish = (error?: unknown) => {
      if (root.finished) return
      root.finished = true
      if (error !== undefined) {
        root.failure ??= error
        this.activity.revoke(root.activity, error)
      }
      try {
        for (const release of root.actions.splice(0)) release()
      } finally {
        this.activity.finishCall(root.activity)
      }
    }
    return {
      assertCurrent: () => this.guard(root),
      runSync: <T>(
        call: FunctionUiResolveCall,
        peer: FunctionUiResolvePeer,
        budget: FunctionUiResolveSyncBudget,
        phase: Execution["phase"],
        run: () => T
      ): T => {
        const parent = this.current
        if (parent && parent.phase !== "constructor" && phase === "constructor") {
          root.failure ??= new ModFunctionError("MODS_UI_RESOLVE_DATA_REENTRY")
          throw root.failure
        }
        const execution: Execution = { id: randomUUID(), root, call, peer, phase, active: true }
        root.peers.add(peer)
        root.peers.add(call.definition.peer)
        return this.run(execution, () =>
          this.guest(peer).runUiConstructorSync(execution.id, budget, phase, run)
        )
      },
      finishNormal: () => finish(),
      finishFailure: (error) => finish(error)
    }
  }

  private run<T>(execution: Execution, run: () => T): T {
    this.guard(execution.root, execution.call.definition)
    const previous = this.current
    this.current = execution
    this.executions.set(execution.id, execution)
    try {
      const result = run()
      this.guard(execution.root, execution.call.definition)
      return result
    } catch (error) {
      execution.root.failure ??= error
      this.activity.revoke(execution.root.activity, error)
      throw error
    } finally {
      execution.active = false
      this.executions.delete(execution.id)
      this.current = previous
    }
  }

  /** Called by every native SDK route before it can fall back to an ordinary frame. */
  assertEffectsAllowed(): void {
    if (!this.current) return
    if (this.current.phase !== "constructor") {
      const error = new ModFunctionError("MODS_UI_RESOLVE_DATA_EFFECT")
      this.current.root.failure ??= error
      this.activity.revoke(this.current.root.activity, error)
      throw error
    }
    this.guard(this.current.root, this.current.call.definition)
  }

  private execution(peer: FunctionUiResolvePeer, token: string): Execution {
    const execution = this.executions.get(token)
    if (
      !execution?.active ||
      execution !== this.current ||
      execution.peer !== peer ||
      execution.call.definition.peer !== peer ||
      execution.phase !== "constructor"
    )
      throw this.error()
    this.assertEffectsAllowed()
    return execution
  }

  private ensureAdmission(root: Root): void {
    if (root.admitted) return
    this.host.admit(root.definition, root.receipt, root.identity)
    root.admitted = true
  }

  call(
    peer: FunctionUiResolvePeer,
    token: string,
    method: string,
    args: ModJson,
    callerSignal?: AbortSignal
  ) {
    const execution = this.execution(peer, token)
    const root = execution.root
    const branch = this.activity.admitBranch(root.activity, execution.parent)
    let hostWork: ReturnType<FunctionUiConstructorActivity["holdHost"]> | undefined
    let replyWork: ReturnType<FunctionUiConstructorActivity["holdReplyJob"]> | undefined
    try {
      hostWork = this.activity.holdHost(branch)
      replyWork = this.activity.holdReplyJob(branch)
      this.ensureAdmission(root)
    } catch (error) {
      if (replyWork) this.activity.finishWork(replyWork)
      if (hostWork) this.activity.finishWork(hostWork)
      this.activity.settleBranch(branch)
      root.failure ??= error
      this.activity.revoke(root.activity, error)
      throw error
    }
    if (!hostWork || !replyWork) throw this.error()
    const actualHostWork = hostWork
    const actualReplyWork = replyWork
    const ownerSignal = this.activity.signal(root.activity)
    const signal = callerSignal ? AbortSignal.any([ownerSignal, callerSignal]) : ownerSignal
    const result = Promise.resolve()
      .then(() => {
        this.guard(root, execution.call.definition)
        signal.throwIfAborted()
        return this.host.call(
          execution.call.definition,
          root.receipt,
          root.identity,
          method,
          args,
          signal
        )
      })
      .then((value) => {
        signal.throwIfAborted()
        this.guard(root, execution.call.definition)
        return value
      })
      .finally(() => this.activity.finishWork(actualHostWork))
    // Consumers retain the rejection; an unused native receipt must not become unhandled.
    void result.catch(() => undefined)
    let replyFinished = false
    const queueSettlement = (): void => {
      const guest = this.guests.get(peer)
      if (!guest) throw this.error()
      guest.queueUiConstructorSettlement(() => {
        if (replyFinished) return
        replyFinished = true
        this.activity.finishWork(actualReplyWork)
        this.activity.settleBranch(branch)
      })
    }
    return {
      signal,
      result,
      reply: (run: () => void): void => {
        try {
          this.activity.runReplyJob(actualReplyWork, () => run())
        } finally {
          queueSettlement()
        }
      },
      discard: (): void => {
        if (replyFinished) return
        replyFinished = true
        this.activity.finishWork(actualReplyWork)
        this.activity.settleBranch(branch)
      }
    }
  }

  reserveReaction(peer: FunctionUiResolvePeer, token: string): string {
    const execution = this.execution(peer, token)
    const branch = this.activity.admitBranch(execution.root.activity, execution.parent)
    let reaction: FunctionUiConstructorReaction | undefined
    try {
      reaction = this.activity.registerReaction(branch, execution.parent)
      this.ensureAdmission(execution.root)
    } catch (error) {
      if (reaction) this.activity.settleReaction(reaction)
      this.activity.settleBranch(branch)
      execution.root.failure ??= error
      this.activity.revoke(execution.root.activity, error)
      throw error
    }
    if (!reaction) throw this.error()
    this.activity.settleBranch(branch)
    const id = randomUUID()
    this.reactions.set(id, {
      id,
      branch,
      activity: reaction,
      root: execution.root,
      call: execution.call,
      peer,
      ran: false,
      settled: false
    })
    return id
  }

  runReaction<T>(peer: FunctionUiResolvePeer, id: string, run: () => T): T {
    const reaction = this.reactions.get(id)
    if (!reaction || reaction.peer !== peer || reaction.ran || reaction.settled) throw this.error()
    reaction.ran = true
    return this.activity.runReaction(reaction.activity, (parent) => {
      const execution: Execution = {
        id: randomUUID(),
        root: reaction.root,
        call: reaction.call,
        peer,
        phase: "constructor",
        parent,
        active: true
      }
      return this.run(execution, () => this.guest(peer).runUiConstructorReaction(execution.id, run))
    })
  }

  settleReaction(peer: FunctionUiResolvePeer, id: string): void {
    const reaction = this.reactions.get(id)
    if (!reaction || reaction.peer !== peer || reaction.settled) return
    const guest = this.guests.get(peer)
    if (!guest) throw this.error()
    guest.queueUiConstructorSettlement(() => {
      if (reaction.settled) return
      reaction.settled = true
      this.activity.settleReaction(reaction.activity)
      this.reactions.delete(id)
    })
  }

  captureActions(call: FunctionUiResolveCall, originalProps: QuickJSHandle): object {
    const guest = this.guest(call.resident)
    const proof = guest.captureUiConstructorActions(originalProps)
    const root = this.current?.root
    if (!root) {
      guest.releaseUiConstructorActions(proof)
      throw this.error()
    }
    root.actions.push(() => guest.releaseUiConstructorActions(proof))
    return proof
  }

  reconnect(
    call: FunctionUiResolveCall,
    proof: FunctionUiResolvePropsProof,
    output: QuickJSHandle
  ): QuickJSHandle {
    proof.assertCurrent()
    return this.guest(call.resident).reconnectUiConstructorActions(call, proof, output)
  }

  /** Actual VM disposal settles guest jobs; ignored-abort host work still waits for finally. */
  disposePeer(peer: FunctionUiResolvePeer): void {
    for (const root of this.roots) {
      if (!root.peers.has(peer)) continue
      root.failure ??= this.error()
      this.activity.revoke(root.activity, root.failure)
    }
    for (const reaction of this.reactions.values()) {
      if (reaction.peer !== peer || reaction.settled) continue
      reaction.settled = true
      this.activity.revoke(reaction.root.activity, this.error())
      this.activity.settleReaction(reaction.activity)
      this.reactions.delete(reaction.id)
    }
  }

  close(): void {
    this.closed = true
    this.activity.close(this.error())
  }
}
