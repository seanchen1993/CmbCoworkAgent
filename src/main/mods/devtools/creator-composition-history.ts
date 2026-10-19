import { createHash, randomUUID } from "node:crypto"
import { parseClawProfile, type ClawProfile } from "../../../shared/mods/claw"
import type { DevelopmentScope } from "../v2/development-session"
import type { CompositionSaveIntent } from "./creator-composition-save"

type Profile = ClawProfile | null
interface Settings {
  getSetting(key: string, fallback?: string): string
  compareAndSetSetting(key: string, expected: string | undefined, value: string): boolean
}
interface Receipt {
  id: string
  scope: string
  identity: string
  bindingRevision: number
  profile: Profile
  undo: Profile[]
  phase: "pending" | "active"
  savedName?: string
}
interface Saved {
  name: string
  revision: number
  updatedAt: number
  profile: ClawProfile
}
interface State {
  version: 1
  revision: number
  receipts: Receipt[]
  saved: Saved[]
  saveIntents?: CompositionSaveIntent[]
}
export interface CompositionHistoryToken {
  workspace: string
  id: string
  previous?: Receipt
}
const scopeKey = (scope: DevelopmentScope) => JSON.stringify(scope)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Selection snapshots only. This journal neither restores grants nor stores/replays actions. */
export class CreatorCompositionHistory {
  constructor(private readonly settings: Settings) {}
  private key(workspace: string) {
    return `mods-creator-composition-v1:${createHash("sha256").update(workspace).digest("hex")}`
  }
  private read(workspace: string): { raw?: string; state: State } {
    const value = this.settings.getSetting(this.key(workspace), "__absent__")
    if (value === "__absent__")
      return { state: { version: 1, revision: 0, receipts: [], saved: [] } }
    if (Buffer.byteLength(value) > 8 * 1024 * 1024) throw Error("COMPOSITION_HISTORY_INVALID")
    const state = JSON.parse(value) as State
    if (
      state.version !== 1 ||
      !Number.isSafeInteger(state.revision) ||
      state.revision < 0 ||
      !Array.isArray(state.receipts) ||
      state.receipts.length > 64 ||
      !Array.isArray(state.saved) ||
      state.saved.length > 24
    )
      throw Error("COMPOSITION_HISTORY_INVALID")
    for (const receipt of state.receipts) {
      if (
        !receipt.id ||
        !receipt.scope ||
        !receipt.identity ||
        !Number.isSafeInteger(receipt.bindingRevision) ||
        !["pending", "active"].includes(receipt.phase) ||
        !Array.isArray(receipt.undo) ||
        receipt.undo.length > 16
      )
        throw Error("COMPOSITION_HISTORY_INVALID")
      receipt.profile = receipt.profile === null ? null : parseClawProfile(receipt.profile)
      receipt.undo = receipt.undo.map((profile) =>
        profile === null ? null : parseClawProfile(profile)
      )
    }
    for (const saved of state.saved) {
      this.name(saved.name)
      if (
        !Number.isSafeInteger(saved.revision) ||
        saved.revision < 1 ||
        !Number.isFinite(saved.updatedAt)
      )
        throw Error("COMPOSITION_HISTORY_INVALID")
      saved.profile = parseClawProfile(saved.profile)
    }
    if (state.saveIntents !== undefined) {
      if (!Array.isArray(state.saveIntents) || state.saveIntents.length > 64)
        throw Error("COMPOSITION_HISTORY_INVALID")
      for (const intent of state.saveIntents) {
        this.name(intent.name)
        // Old records used compiledDigest for the trial identity. They carry no resumable
        // native approval; normalize only that observation, never manufacture a formal hash.
        if (Array.isArray(intent.dependencies))
          for (const dependency of intent.dependencies) {
            const legacy = dependency as typeof dependency & { compiledDigest?: unknown }
            if (
              legacy.activeTrialCompiledDigest === undefined &&
              typeof legacy.compiledDigest === "string"
            )
              legacy.activeTrialCompiledDigest = legacy.compiledDigest
            delete legacy.compiledDigest
          }
        if (
          !intent.id ||
          !intent.identity ||
          !intent.scope?.threadId ||
          intent.scope.workspace !== workspace ||
          !intent.scope.incarnation ||
          !Number.isSafeInteger(intent.revision) ||
          intent.revision < 0 ||
          !["needs-reuse", "needs-approval", "saved", "failed", "unknown", "cancelled"].includes(
            intent.phase
          ) ||
          !Array.isArray(intent.dependencies) ||
          (!intent.dependencies.length && intent.phase !== "saved") ||
          intent.dependencies.length > 32 ||
          !Array.isArray(intent.completed) ||
          intent.completed.some((id) => typeof id !== "string") ||
          intent.dependencies.some(
            (item) =>
              !item.draftId ||
              !Number.isSafeInteger(item.revision) ||
              item.revision < 1 ||
              !/^[a-f0-9]{64}$/.test(item.bundleDigest) ||
              !/^[a-f0-9]{64}$/.test(item.activeTrialCompiledDigest)
          ) ||
          (intent.nativeReuseCompiledDigest !== undefined &&
            !/^[a-f0-9]{64}$/.test(intent.nativeReuseCompiledDigest))
        )
          throw Error("COMPOSITION_HISTORY_INVALID")
        intent.expected = intent.expected === null ? null : parseClawProfile(intent.expected)
      }
    }
    return { raw: value, state }
  }
  private write(workspace: string, change: (state: State) => void): void {
    const { raw, state } = this.read(workspace)
    change(state)
    state.revision++
    const text = JSON.stringify(state)
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw Error("COMPOSITION_HISTORY_CAPACITY")
    if (!this.settings.compareAndSetSetting(this.key(workspace), raw, text))
      throw Error("COMPOSITION_HISTORY_CHANGED")
  }
  private name(name: string): void {
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.trim() !== name ||
      name.length > 80 ||
      // eslint-disable-next-line no-control-regex -- Persisted template names cannot contain controls.
      /[\u0000-\u001f]/.test(name)
    )
      throw Error("COMPOSITION_SAVED_NAME_INVALID")
  }
  current(scope: DevelopmentScope, identity: string, revision: number, profile: Profile) {
    const receipt = this.read(scope.workspace).state.receipts.find(
      (item) => item.scope === scopeKey(scope)
    )
    return receipt?.phase === "active" &&
      receipt.identity === identity &&
      receipt.bindingRevision === revision &&
      same(receipt.profile, profile)
      ? structuredClone(receipt)
      : undefined
  }
  prepare(
    scope: DevelopmentScope,
    identity: string,
    revision: number,
    before: Profile,
    profile: Profile,
    undo = false,
    savedName?: string,
    beforeBindingRevision?: number
  ): CompositionHistoryToken {
    const id = randomUUID()
    let previous: Receipt | undefined
    this.write(scope.workspace, (state) => {
      previous = state.receipts.find((item) => item.scope === scopeKey(scope))
      const matches =
        previous?.phase === "active" &&
        previous.identity === identity &&
        same(previous.profile, before) &&
        (beforeBindingRevision === undefined || previous.bindingRevision === beforeBindingRevision)
      if (undo && (!matches || !previous!.undo.length)) throw Error("COMPOSITION_UNDO_STALE")
      const stack = undo
        ? previous!.undo.slice(0, -1)
        : [...(matches ? previous!.undo : []), before].slice(-16)
      const receipt: Receipt = {
        id,
        scope: scopeKey(scope),
        identity,
        bindingRevision: revision,
        profile: structuredClone(profile),
        undo: structuredClone(stack),
        phase: "pending",
        ...(savedName ? { savedName } : {})
      }
      state.receipts = [
        ...state.receipts.filter((item) => item.scope !== scopeKey(scope)),
        receipt
      ].slice(-64)
    })
    return { workspace: scope.workspace, id, previous }
  }
  activate(token: CompositionHistoryToken): void {
    this.write(token.workspace, (state) => {
      const receipt = state.receipts.find((item) => item.id === token.id)
      if (!receipt || receipt.phase !== "pending") throw Error("COMPOSITION_HISTORY_CHANGED")
      receipt.phase = "active"
    })
  }
  abandon(token: CompositionHistoryToken): void {
    this.write(token.workspace, (state) => {
      const receipt = state.receipts.find((item) => item.id === token.id)
      if (receipt?.phase !== "pending") return
      state.receipts = state.receipts.filter((item) => item.id !== token.id)
      if (token.previous) state.receipts.push(token.previous)
    })
  }
  attachSavedName(
    scope: DevelopmentScope,
    identity: string,
    revision: number,
    profile: Profile,
    name: string
  ): void {
    if (!this.current(scope, identity, revision, profile)) return
    this.write(scope.workspace, (state) => {
      const current = state.receipts.find((item) => item.scope === scopeKey(scope))
      if (
        current?.phase !== "active" ||
        current.identity !== identity ||
        current.bindingRevision !== revision ||
        !same(current.profile, profile)
      )
        throw Error("COMPOSITION_HISTORY_CHANGED")
      current.savedName = name
    })
  }
  list(workspace: string) {
    return this.read(workspace).state.saved.map(({ name, revision, updatedAt }) => ({
      name,
      revision,
      updatedAt
    }))
  }
  load(workspace: string, name: string, revision: number): ClawProfile {
    this.name(name)
    const saved = this.read(workspace).state.saved.find((item) => item.name === name)
    if (!saved || saved.revision !== revision) throw Error("COMPOSITION_SAVED_CHANGED")
    return structuredClone(saved.profile)
  }
  assertSaveAvailable(workspace: string, name: string, revision: number) {
    this.name(name)
    const saved = this.read(workspace).state.saved
    const old = saved.find((item) => item.name === name)
    if (!Number.isSafeInteger(revision) || revision < 0 || (old?.revision ?? 0) !== revision)
      throw Error("COMPOSITION_SAVED_CHANGED")
    if (!old && saved.length >= 24) throw Error("COMPOSITION_SAVED_CAPACITY")
  }
  saveIntent(scope: DevelopmentScope): CompositionSaveIntent | undefined {
    const intent = this.read(scope.workspace).state.saveIntents?.find(
      (item) => scopeKey(item.scope) === scopeKey(scope)
    )
    return intent ? structuredClone(intent) : undefined
  }
  putSaveIntent(intent: CompositionSaveIntent) {
    this.name(intent.name)
    this.write(intent.scope.workspace, (state) => {
      state.saveIntents = [
        ...(state.saveIntents ?? []).filter(
          (item) => scopeKey(item.scope) !== scopeKey(intent.scope)
        ),
        structuredClone(intent)
      ].slice(-64)
    })
  }
  save(workspace: string, name: string, revision: number, profile: ClawProfile) {
    this.name(name)
    let next = 0
    this.write(workspace, (state) => {
      const old = state.saved.find((item) => item.name === name)
      if ((old?.revision ?? 0) !== revision) throw Error("COMPOSITION_SAVED_CHANGED")
      if (!old && state.saved.length >= 24) throw Error("COMPOSITION_SAVED_CAPACITY")
      next = revision + 1
      state.saved = [
        ...state.saved.filter((item) => item.name !== name),
        { name, revision: next, updatedAt: Date.now(), profile: parseClawProfile(profile) }
      ]
    })
    return { name, revision: next }
  }
}
