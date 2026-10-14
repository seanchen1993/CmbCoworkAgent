import { randomUUID } from "node:crypto"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import {
  parseFunctionMarkdown,
  validateFunctionMarkdownProps,
  type FunctionMarkdownLeafProps
} from "../../../shared/mods/v2/markdown"
import {
  functionMarkdownLinkAddressKey,
  validateFunctionMarkdownLinkAction,
  type FunctionMarkdownLinkAction,
  type FunctionMarkdownLinkAddress,
  type FunctionMarkdownLinkOutcome,
  type FunctionMarkdownLinkSidecar
} from "../../../shared/mods/v2/markdown-links"
import type { FunctionUiElement } from "../../../shared/mods/v2/ui"

const MAX_LEAVES = 4096
const MAX_TARGETS = 4096
const MAX_INTENTS = 4096

export interface NativeMarkdownCallback {
  /** A native retained callback binding. A wire handle is not this identity. */
  identity: object
  run(href: string, intentId: string): Promise<void>
}

export interface NativeMarkdownLeaf {
  nodePath: readonly number[]
  props: FunctionMarkdownLeafProps
  callback?: NativeMarkdownCallback
}

export interface NativeMarkdownPublication {
  owner: object
  epoch: object
  contentFingerprint: string
  address: FunctionMarkdownLinkAddress
  assertCurrent(): void
}

interface Leaf {
  nonce: string
  fingerprint: string
  nodePath: number[]
  hrefs: ReadonlySet<string>
  callback?: NativeMarkdownCallback
  takeover?: ReadonlySet<string>
}

/** Traverse final protected content using actual child-index paths. */
export function nativeMarkdownLeaves(
  tree: FunctionUiElement,
  callbackOf?: (
    node: Extract<FunctionUiElement, { type: "Markdown" }>
  ) => NativeMarkdownCallback | undefined
): NativeMarkdownLeaf[] {
  const leaves: NativeMarkdownLeaf[] = []
  const visit = (node: FunctionUiElement | string, nodePath: number[]) => {
    if (typeof node === "string" || node.type === "engine") return
    if (node.type === "Markdown") {
      const callback = callbackOf?.(node)
      leaves.push({ nodePath, props: node.props, ...(callback ? { callback } : {}) })
      return
    }
    node.children?.forEach((child, index) => visit(child, [...nodePath, index]))
  }
  visit(tree, [])
  return leaves
}

interface Publication {
  binding: NativeMarkdownPublication
  addressKey: string
  leaves: Leaf[]
}

interface Intent {
  publication: Publication
  payload: string
  pending: boolean
  result: Promise<FunctionMarkdownLinkOutcome>
}

interface OwnerState {
  current?: Publication
  intents: Map<string, Intent>
}

export interface FunctionMarkdownPublicationPlan {
  readonly markdownLinks: readonly FunctionMarkdownLinkSidecar[]
}

interface Prepared {
  previous?: Publication
  next: Publication
  assertCurrent(): void
}

declare const nativeMarkdownBatch: unique symbol
export interface FunctionMarkdownPublicationBatch {
  readonly [nativeMarkdownBatch]: true
}

function stale(): never {
  throw new ModFunctionError("MODS_UI_MARKDOWN_STALE")
}

/** Main-only publication ledger. No guest data can register a native owner or callback. */
export class FunctionMarkdownLinkRegistry {
  private readonly owners = new Map<object, OwnerState>()
  private readonly nonces = new Map<string, { publication: Publication; leaf: Leaf }>()
  private readonly prepared = new WeakMap<FunctionMarkdownPublicationPlan, Prepared>()
  private readonly batches = new WeakMap<object, readonly FunctionMarkdownPublicationPlan[]>()
  private closed = false

  prepare(
    binding: NativeMarkdownPublication,
    input: readonly NativeMarkdownLeaf[]
  ): FunctionMarkdownPublicationPlan {
    if (this.closed) stale()
    binding.assertCurrent()
    const previous = this.owners.get(binding.owner)?.current
    const address = Object.freeze({ ...binding.address })
    const addressKey = functionMarkdownLinkAddressKey(address)
    const previousLeaves =
      previous?.binding.epoch === binding.epoch && previous.addressKey === addressKey
        ? new Map(previous.leaves.map((leaf) => [leaf.fingerprint, leaf]))
        : new Map<string, Leaf>()
    const paths = new Set<string>()
    let targets = 0
    if (input.length > MAX_LEAVES) throw new ModFunctionError("MODS_UI_MARKDOWN_LIMIT")
    const leaves = input.map((source): Leaf => {
      if (
        source.nodePath.length > 128 ||
        source.nodePath.some((index) => !Number.isSafeInteger(index) || index < 0 || index > 4096)
      )
        throw new ModFunctionError("MODS_UI_MARKDOWN_INVALID")
      const path = JSON.stringify(source.nodePath)
      if (paths.has(path)) throw new ModFunctionError("MODS_UI_MARKDOWN_INVALID")
      paths.add(path)
      validateFunctionMarkdownProps(source.props, Boolean(source.callback))
      const props = source.props
      const fingerprint = JSON.stringify([
        source.nodePath,
        props.text,
        props.key ?? null,
        props.dimColor ?? false,
        props.pressableLinks ?? null
      ])
      const parsed = previousLeaves.get(fingerprint)
      // Reuse only the private pure-parser result. Every native proof and quota still runs.
      const hrefs = parsed?.hrefs ?? new Set(parseFunctionMarkdown(props.text).hrefs)
      targets += hrefs.size
      if (targets > MAX_TARGETS) throw new ModFunctionError("MODS_UI_MARKDOWN_LIMIT")
      const prior = parsed?.callback?.identity === source.callback?.identity ? parsed : undefined
      return {
        nonce: prior?.nonce ?? randomUUID(),
        fingerprint,
        nodePath: [...source.nodePath],
        hrefs,
        ...(source.callback ? { callback: { ...source.callback } } : {}),
        ...(props.pressableLinks ? { takeover: new Set(props.pressableLinks) } : {})
      }
    })
    binding.assertCurrent()
    const unchanged =
      previous?.binding.epoch === binding.epoch &&
      previous.binding.contentFingerprint === binding.contentFingerprint &&
      previous.addressKey === addressKey &&
      previous.leaves.length === leaves.length &&
      previous.leaves.every((leaf, index) => leaf.nonce === leaves[index].nonce)
    // A changed frame invalidates every old address, including unchanged siblings.
    if (!unchanged) for (const leaf of leaves) leaf.nonce = randomUUID()
    const next: Publication = unchanged
      ? previous
      : { binding: { ...binding, address }, addressKey, leaves }
    const plan = Object.freeze({
      markdownLinks: Object.freeze(
        next.leaves.map((leaf) =>
          Object.freeze({ nodePath: Object.freeze([...leaf.nodePath]), nonce: leaf.nonce })
        )
      )
    })
    this.prepared.set(plan, { previous, next, assertCurrent: binding.assertCurrent })
    return plan
  }

  /** Call once for the entire candidate batch before any parent or Client adoption. */
  assertPrepared(
    plans: readonly FunctionMarkdownPublicationPlan[]
  ): FunctionMarkdownPublicationBatch {
    if (this.closed) stale()
    const replacements = new Map<object, Publication>()
    for (const plan of plans) {
      const candidate = this.prepared.get(plan)
      if (!candidate || replacements.has(candidate.next.binding.owner)) stale()
      candidate.assertCurrent()
      candidate.next.binding.assertCurrent()
      if (this.owners.get(candidate.next.binding.owner)?.current !== candidate.previous) stale()
      replacements.set(candidate.next.binding.owner, candidate.next)
    }
    let leaves = 0
    let targets = 0
    const owners = new Set([...this.owners.keys(), ...replacements.keys()])
    for (const owner of owners) {
      const publication = replacements.get(owner) ?? this.owners.get(owner)?.current
      leaves += publication?.leaves.length ?? 0
      for (const leaf of publication?.leaves ?? []) targets += leaf.hrefs.size
    }
    if (leaves > MAX_LEAVES || targets > MAX_TARGETS)
      throw new ModFunctionError("MODS_UI_MARKDOWN_LIMIT")
    const batch = Object.freeze({}) as FunctionMarkdownPublicationBatch
    this.batches.set(batch, [...plans])
    return batch
  }

  /** Synchronous, after all candidate preflights; invokes no plugin or asynchronous work. */
  commit(plans: readonly FunctionMarkdownPublicationPlan[]): void {
    this.commitPrepared(this.assertPrepared(plans))
  }

  /** Final adoption after the whole batch preflight; no external guards can throw mid-adoption. */
  commitPrepared(batch: FunctionMarkdownPublicationBatch): void {
    const plans = this.batches.get(batch)
    if (!plans) stale()
    for (const plan of plans) {
      const candidate = this.prepared.get(plan)
      if (
        !candidate ||
        this.closed ||
        this.owners.get(candidate.next.binding.owner)?.current !== candidate.previous
      )
        stale()
    }
    this.batches.delete(batch)
    for (const plan of plans) {
      const { next } = this.prepared.get(plan)!
      const state = this.owners.get(next.binding.owner) ?? { intents: new Map<string, Intent>() }
      if (state.current === next) {
        this.prepared.delete(plan)
        continue
      }
      this.removePublication(state)
      if (!next.leaves.length) {
        if (state.intents.size) this.owners.set(next.binding.owner, state)
        else this.owners.delete(next.binding.owner)
        this.prepared.delete(plan)
        continue
      }
      state.current = next
      this.owners.set(next.binding.owner, state)
      for (const leaf of next.leaves) this.nonces.set(leaf.nonce, { publication: next, leaf })
      this.prepared.delete(plan)
    }
  }

  discard(plan: FunctionMarkdownPublicationPlan): void {
    this.prepared.delete(plan)
  }

  private removePublication(state: OwnerState): void {
    for (const leaf of state.current?.leaves ?? []) this.nonces.delete(leaf.nonce)
    // Pending native work retains its slot until its real finally runs.
    for (const [id, intent] of state.intents) if (!intent.pending) state.intents.delete(id)
    state.current = undefined
  }

  retire(owner: object): void {
    const state = this.owners.get(owner)
    if (!state) return
    this.removePublication(state)
    if (!state.intents.size) this.owners.delete(owner)
  }

  invoke(
    input: unknown,
    assertSender: () => void,
    open: (href: string, assertCurrent: () => void) => Promise<FunctionMarkdownLinkOutcome>,
    runCallback: (run: () => Promise<void>) => Promise<void> = (run) => run()
  ): Promise<FunctionMarkdownLinkOutcome> {
    validateFunctionMarkdownLinkAction(input)
    const action: FunctionMarkdownLinkAction = input
    const found = this.nonces.get(action.nonce)
    if (this.closed || !found) stale()
    const { publication, leaf } = found
    const state = this.owners.get(publication.binding.owner)
    const assertCurrent = () => {
      assertSender()
      publication.binding.assertCurrent()
      if (
        this.closed ||
        state?.current !== publication ||
        this.nonces.get(action.nonce)?.publication !== publication ||
        functionMarkdownLinkAddressKey(action.address) !== publication.addressKey ||
        !leaf.hrefs.has(action.href)
      )
        stale()
    }
    assertCurrent()
    const payload = JSON.stringify([publication.addressKey, action.nonce, action.href])
    const prior = state!.intents.get(action.intentId)
    if (prior) {
      if (prior.payload !== payload) throw new ModFunctionError("MODS_UI_INTENT_CONFLICT")
      return prior.result
    }
    if (state!.intents.size >= MAX_INTENTS) throw new ModFunctionError("MODS_UI_INTENT_LIMIT")
    const callback =
      leaf.callback && (!leaf.takeover || leaf.takeover.has(action.href))
        ? leaf.callback
        : undefined
    const result = Promise.resolve()
      .then(async () => {
        assertCurrent()
        if (callback) {
          // The original native action owns callback retention and intentional redraws.
          await runCallback(() => {
            assertCurrent()
            return callback.run(action.href, action.intentId)
          })
          assertSender()
          return { state: "handled" } as const
        }
        const result = await open(action.href, assertCurrent)
        assertCurrent()
        return result
      })
      .finally(() => {
        intent.pending = false
        if (state!.current !== publication) state!.intents.delete(action.intentId)
        if (!state!.current && !state!.intents.size) this.owners.delete(publication.binding.owner)
      })
    const intent: Intent = { publication, payload, pending: true, result }
    state!.intents.set(action.intentId, intent)
    return intent.result
  }

  close(): void {
    this.closed = true
    for (const owner of this.owners.keys()) this.retire(owner)
  }
}
